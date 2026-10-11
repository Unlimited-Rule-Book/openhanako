// server.mjs — 本地流式语音识别 sidecar（sherpa-onnx）
//
// 为什么单独一个进程：sherpa-onnx 是原生模块，Electron 的 ABI 跟 Node 24 不一致，
// 直接在主进程里 require 大概率要 electron-rebuild、打包时也容易出问题。独立进程
// 彻底绕开这一点，还能单独调试、单独换引擎。
//
// ── 对外契约（前端只需要认这三种事件，底下用什么引擎都无所谓）──
//
//   客户端 → 服务端
//     {"type":"start","sampleRate":16000}   开一条识别流
//     二进制帧                                16kHz 单声道 int16 LE PCM
//     {"type":"end"}                          收尾，把剩下的音频解完
//     {"type":"reset"}                        丢弃当前句、重开一条流
//     {"type":"ping"}
//
//   服务端 → 客户端
//     {"type":"started","sampleRate":16000}
//     {"type":"partial","segmentId":n,"text":"…","revision":bool}
//     {"type":"endpoint","segmentId":n,"text":"…"}
//     {"type":"final","text":"…","segments":[…],"stats":{…}}
//     {"type":"reset_ok"} / {"type":"pong"} / {"type":"error","message":"…"}
//
// ── 两个关键设计（都是为了让前端能适配不同引擎）──
//
// 1. partial 永远给「当前这一句到目前为止的完整文本」，客户端做**整段替换**。
//    这样"单调增长型"引擎（本地 zipformer，实测回退率 0%）和"可回溯修订型"
//    引擎（云端 LLM 式识别，会把已输出的字改掉）能塞进**同一套前端逻辑**，
//    前端不需要知道引擎是哪一种。
//
// 2. `revision` 是专门留给前端的适配口：true 表示这次相对上一次**改写了已经
//    输出的内容**。前端可以据此做"跳变"的视觉提示；如果引擎从不改写，它永远是
//    false，前端就当没这回事。将来若确认引擎永远不回退，两个层次可以合并成一个，
//    但接口不用改。

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { normalizeChineseNumbers } from './itn-zh.mjs';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 模型根目录：默认在脚本同级的 models/（开发时的习惯），
// 但**允许父进程用环境变量覆盖** —— 打包后模型要放在应用数据目录里
// （安装目录可能只读，且更新/卸载会清掉），所以必须能改。
const MODELS_ROOT = process.env.HANA_ASR_MODELS_ROOT || path.join(__dirname, 'models');
const DEFAULT_MODEL_DIR = path.join(
  MODELS_ROOT, 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
);
const DEFAULT_PORT = 8766;
const SAMPLE_RATE = 16000;

const LOOPBACK_WEB_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

/**
 * WS 来源校验：只接受本机前端。口径与 server/http/cors-policy.ts 保持一致 ——
 *   · file://（Electron 生产前端）、null、loopback（开发前端）放行；
 *   · 没有 Origin 头也放行：浏览器发起的连接一定带 Origin，缺这个头只可能是
 *     本机 node 客户端（例如服务端自己的探活），不算跨站请求；
 *   · 其余来源一律拒绝 —— 否则任意网页都能用一行 JS 连上本机识别服务。
 *
 * file:// 用**前缀**判定而不是精确等于 "file://"：本地 HTML 文档的 Origin 还可能
 * 带上完整路径（如 "file:///D:/app/index.html"），精确匹配会把这些漏掉。
 * 放宽到前缀不会引入跨站风险 —— Origin 由浏览器填写、脚本无法伪造，远程网页只会带
 * 自己的 http(s) 源，永远变不成 file://。导出仅为单元测试可直接引用（不影响直接运行）。
 */
export function isAllowedOrigin(origin) {
  const value = String(origin ?? '');
  if (!value) return true;
  if (value === 'null') return true;
  if (value === 'file://' || value.startsWith('file:///')) return true;
  return LOOPBACK_WEB_ORIGIN.test(value);
}

/** 建一个识别器。14M 小模型单线程反而最快（多线程同步开销大于收益）。 */
export function createRecognizer({
  modelDir = DEFAULT_MODEL_DIR,
  numThreads = 1,
  trailingSilence = 0.8,
  maxUtterance = 20,
} = {}) {
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      transducer: {
        encoder: path.join(modelDir, 'encoder-epoch-99-avg-1.int8.onnx'),
        decoder: path.join(modelDir, 'decoder-epoch-99-avg-1.int8.onnx'),
        joiner: path.join(modelDir, 'joiner-epoch-99-avg-1.int8.onnx'),
      },
      tokens: path.join(modelDir, 'tokens.txt'),
      numThreads,
      provider: 'cpu',
      modelType: 'zipformer',
    },
    // 端点检测：短句靠静音判尾，长句靠 rule3 强制切，避免一句话无限长。
    //   trailingSilence：停顿多久算说完了。太灵敏会在句子中间断句（标点也跟着插错地方），
    //     太迟钝则要等很久才提交。0.8 是 sherpa 默认，实际用嘴说话时偏灵敏。
    //   maxUtterance：一句话最长多少秒就强制切。sherpa 默认 5 秒 —— 对听写太短了，
    //     正常说一句话经常超过 5 秒，会在句子中间硬切（实测就是这么被切坏的）。
    //     听写场景放宽到 20 秒，由标点模型负责断句。
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: trailingSilence,
    rule3MinUtteranceLength: maxUtterance,
    decodingMethod: 'greedy_search',
  });
}

/** int16 LE → Float32。sherpa 要的是 [-1, 1] 的浮点样本。 */
export function pcm16ToFloat32(buf) {
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}

const PUNCT_MODEL_DIR = 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12';

/**
 * 句末后处理：数字规整 → 标点。
 *
 * 这两个都是**本地识别模型缺什么就补什么**：
 *   · 本地模型不产标点 → 用官方中文标点模型补
 *   · 本地模型只出汉字数字 → 用自己的保守规则转阿拉伯数字
 * 云端引擎通常两样都自带，所以这一层要能被关掉（--punctuation off / --itn off）。
 *
 * 顺序上先做数字规整再做标点：标点在最后落定，避免标点符号插在数字和量词之间
 * 把规整规则打断。
 *
 * 只在**句末**调用（endpoint / final）。partial 保持原始输出 ——
 * 标点每块都跑会乱跳，数字规整每块都跑会让预览反复跳变。
 */
function createFinalizer({ modelsRoot, punctuation = 'auto', itn = 'auto', log = () => {} }) {
  let punct = null;
  // "这份标点模型加载失败过"的指纹 = mtime + size。
  // 为什么要记指纹、而不是简单记一个布尔"失败过"：用户可能稍后重新下载 / 换掉这个
  // 模型文件，只要文件内容变了就必须允许再试一次；只记布尔会把一次坏文件的失败
  // 变成永久结论（表现为"换了好模型也不生效"）。
  // 为什么要记（而不是每次重试）：标点模型构造要几秒，文件存在但构造抛错时，
  // 老实现每句 finalize 都会重试一遍 → 每句都卡一次。记下指纹后，同一份文件只失败
  // 一次。启动预热（startServer 就绪前调用一次）失败同样落到这里，所以预热失败也
  // 不会被每句重复触发。
  // 注意：文件**不存在**的情况不写指纹 —— 那会退化成"缺模型 = 永久不重试"，
  // 与"用户稍后下载就能生效"的既有语义冲突（见下）。
  let failedFingerprint = null;

  /**
   * 加载标点模型（约 294MB，构造要几秒）。
   *
   * 缓存规则：
   *   1. 加载**成功** → 缓存 punct，后续直接复用（不动）。
   *   2. 文件**不存在** → 不缓存（保留既有语义）：每次都重新查一次路径，用户稍后
   *      下载 / 导入模型后即可生效（stat 很便宜，不缺这点开销）。
   *   3. 文件存在但**构造失败** → 记下该文件的 mtime+size 指纹；同一份文件不再重试、
   *      日志也只打一次。文件变了（指纹改变）才允许重试。
   */
  function loadPunctuation() {
    if (punctuation === 'off') return null;
    if (punct) return punct;
    // 注意：标点模型放在 models 根目录下，**不是** ASR 模型目录里 ——
    // 这里一开始写成了 path.join(modelDir, ...)，导致永远找不到模型、静默跳过标点。
    const modelPath = path.join(modelsRoot, PUNCT_MODEL_DIR, 'model.onnx');
    let stat;
    try {
      stat = fs.statSync(modelPath);
    } catch {
      // 不存在：不打失败指纹，保持"下次仍会重新检查"的语义。
      log(`未找到标点模型，跳过标点（路径：${modelPath}）`);
      return null;
    }
    const fingerprint = `${stat.mtimeMs}:${stat.size}`;
    if (failedFingerprint === fingerprint) {
      // 同一份文件刚刚已经失败过：不重试、不重复打日志，避免每句都卡一次。
      return null;
    }
    try {
      const t0 = Date.now();
      // 词表嵌在 onnx 元数据里，不需要额外的 tokens 文件
      punct = new sherpa.OfflinePunctuation({ model: { ctTransformer: modelPath, numThreads: 1, provider: 'cpu' } });
      failedFingerprint = null;
      log(`标点模型已加载（${Date.now() - t0}ms）`);
    } catch (err) {
      failedFingerprint = fingerprint;
      log(`标点模型加载失败，跳过标点：${err.message}`);
      punct = null;
    }
    return punct;
  }

  function finalize(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return text;
    let out = text;
    if (itn !== 'off') {
      try { out = normalizeChineseNumbers(out); } catch { /* 规整失败就用原文，绝不丢字 */ }
    }
    if (punctuation !== 'off') {
      const p = loadPunctuation();
      if (p) {
        try { out = p.addPunct(out); } catch { /* 标点失败就用原文 */ }
      }
    }
    return out;
  }

  // loadPunctuation 单独暴露：启动时要主动预热（见 startServer），
  // 不能等到第一句话说完才加载，那会让首句卡顿。
  return { finalize, loadPunctuation };
}

/** 一条连接对应一条识别流。 */
function createSession(recognizer, send, finalize = (t) => t) {
  const stream = recognizer.createStream();
  let lastText = '';
  let segmentId = 0;
  let started = false;
  const segments = [];
  const stats = { partials: 0, revisions: 0, rewrittenChars: 0 };

  function emitPartialIfChanged() {
    const text = recognizer.getResult(stream).text;
    if (!text || text === lastText) return;
    let revision = false;
    if (lastText && !text.startsWith(lastText)) {
      // 新文本不再是旧文本的延长 —— 说明引擎改写了已经吐出去的内容
      revision = true;
      stats.revisions += 1;
      let p = 0;
      while (p < lastText.length && p < text.length && lastText[p] === text[p]) p += 1;
      stats.rewrittenChars += lastText.length - p;
    }
    lastText = text;
    stats.partials += 1;
    send({ type: 'partial', segmentId, text, revision });
  }

  return {
    start(sampleRate) {
      started = true;
      send({ type: 'started', sampleRate });
    },
    handleAudio(buf) {
      if (!started) return;
      stream.acceptWaveform({ samples: pcm16ToFloat32(buf), sampleRate: SAMPLE_RATE });
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      emitPartialIfChanged();
      if (recognizer.isEndpoint(stream)) {
        const raw = recognizer.getResult(stream).text.trim();
        // 句末才做数字规整与标点；raw 一并带上，方便排查"为什么这句话没转成数字"
        const text = finalize(raw);
        if (text) segments.push(text);
        send({ type: 'endpoint', segmentId, text, raw });
        recognizer.reset(stream);
        segmentId += 1;
        lastText = '';
      }
    },
    finish() {
      if (!started) {
        send({ type: 'error', message: 'finish called before start' });
        return;
      }
      stream.inputFinished();
      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const rawTail = recognizer.getResult(stream).text.trim();
      const tail = finalize(rawTail);
      if (tail) segments.push(tail);
      started = false;
      send({
        type: 'final',
        text: segments.join(''),
        segments: segments.slice(),
        stats: { ...stats },
        // pending = 还没作为 endpoint 发出去的那一段（处理后）。前端只需提交它，
        // 之前已经提交过的段落不要重复插入。
        pending: tail,
        raw: rawTail,
      });
    },
    reset() {
      recognizer.reset(stream);
      lastText = '';
      segmentId += 1;
      send({ type: 'reset_ok' });
    },
    dispose() {
      try { stream.free?.(); } catch { /* 释放失败不影响进程退出 */ }
    },
  };
}

/**
 * 启动服务。只绑 127.0.0.1 —— 这是本机能力，不对外暴露。
 * @returns {{port:number, close:()=>Promise<void>, recognizer:any}}
 */
export function startServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  numThreads = 1,
  modelDir = DEFAULT_MODEL_DIR,
  trailingSilence = 0.8,
  maxUtterance = 20,
  punctuation = 'auto',
  itn = 'auto',
  log = () => {},
} = {}) {
  const recognizer = createRecognizer({ modelDir, numThreads, trailingSilence, maxUtterance });
  const { finalize, loadPunctuation } = createFinalizer({ modelsRoot: MODELS_ROOT, punctuation, itn, log });
  // 在宣布"就绪"之前就把标点模型加载好。它是 ~294MB 的大模型，构造要几秒；
  // 若留到第一句话结束才同步加载，首句会明显卡顿（就绪行之前前端不会开始录音，
  // 所以在这里一次性吃掉这段延迟是安全的）。
  loadPunctuation();
  const wss = new WebSocketServer({
    host,
    port,
    // 挡掉跨站网页的连接尝试，只放行本机前端（详见 isAllowedOrigin）。
    verifyClient: (info) => isAllowedOrigin(info.origin),
  });

  wss.on('connection', (ws) => {
    let session = null;
    // 音频早于 start 到达时只报一次错，避免每帧刷屏
    let warnedAudioBeforeStart = false;
    const send = (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    log(`客户端接入，当前连接数 ${wss.clients.size}`);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!session) {
          if (!warnedAudioBeforeStart) {
            warnedAudioBeforeStart = true;
            send({ type: 'error', message: 'audio received before start' });
          }
          return;
        }
        session.handleAudio(data);
        return;
      }
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        send({ type: 'error', message: 'malformed control message' });
        return;
      }
      switch (msg?.type) {
        case 'start':
          // 重复 start（前端重录 / 断线重连）会直接覆盖 session 变量，
          // 旧 session 的原生 stream 不释放就会泄漏（native 内存 + 残留解码状态）。
          // 先把旧的收掉，再开新的。
          session?.dispose();
          session = createSession(recognizer, send, finalize);
          session.start(msg.sampleRate ?? SAMPLE_RATE);
          break;
        case 'end':
          // 必须显式回错：静默忽略会让客户端一直等 final
          if (!session) {
            send({ type: 'error', message: 'end called before start' });
            break;
          }
          session.finish();
          break;
        case 'reset':
          if (!session) {
            send({ type: 'error', message: 'reset called before start' });
            break;
          }
          session.reset();
          break;
        case 'ping':
          send({ type: 'pong' });
          break;
        default:
          send({ type: 'error', message: `unknown message type: ${msg?.type}` });
      }
    });

    const cleanup = () => session?.dispose();
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  });

  return {
    port,
    recognizer,
    wss,
    close: () => new Promise((resolve) => wss.close(resolve)),
  };
}

// 直接 `node server.mjs [--port 8766] [--punctuation off] [--itn off]` 时才启动
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const flagValue = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
      ? process.argv[i + 1]
      : fallback;
  };
  // --port 0 表示"随便给个空闲端口"；真实端口由下面那行打印出来，
  // 父进程（Hana 服务端）靠解析这行拿到端口。
  const port = Number(flagValue('--port', DEFAULT_PORT));
  const punctuation = flagValue('--punctuation', 'auto');
  const itn = flagValue('--itn', 'auto');
  const trailingSilence = Number(flagValue('--silence', 0.8));
  // --model 接受模型目录：绝对路径直接用；裸目录名（父进程传的）解析到 models/ 下。
  // 坑：一开始直接把裸目录名当路径用，createRecognizer 相对 cwd 拼路径找不到模型，
  // sidecar 直接 crash —— 表现为前端"录音失败"。
  const rawModelDir = flagValue('--model', DEFAULT_MODEL_DIR);
  const modelDir = path.isAbsolute(rawModelDir) ? rawModelDir : path.join(MODELS_ROOT, rawModelDir);
  const t0 = Date.now();
  const server = startServer({
    port,
    punctuation,
    itn,
    trailingSilence,
    modelDir,
    log: (m) => console.log(`[asr-sidecar] ${m}`),
  });

  // stdin 是父进程（Hana 服务端）握着的"生命线"管道。应用被强杀时父进程来不及
  // 发 SIGTERM，但它一死，管道的写端就关闭，我们这里会收到 EOF —— 借此主动退出，
  // 免得 sidecar 抱着几百 MB 模型内存变成孤儿进程。
  // 注意：必须 resume()，stdin 默认是暂停的，不恢复流动就永远收不到 'end'。
  process.stdin.on('end', () => process.exit(0));
  process.stdin.on('close', () => process.exit(0));
  process.stdin.resume();

  // 必须在 listening 之后才读端口：构造后立刻读会拿到 null（port 0 时拿到 0），
  // 父进程就会连到一个无效端口。这个坑是被 tests/asr-sidecar-manager.test.ts 抓到的。
  const report = () => {
    const actualPort = server.wss.address()?.port ?? port;
    // 机器可读的就绪行。父进程**优先**认这一行 —— 靠下面那句人类可读文案判定就绪，
    // 只要文案改一个字（翻译、措辞、加个括号）就悄悄失效，而且失效方式是"卡住等超时"，
    // 排查起来要翻到 manager 的正则才知道为什么。
    console.log(JSON.stringify({ asrSidecarReady: true, port: actualPort }));
    console.log(`[asr-sidecar] 模型加载完成（${Date.now() - t0}ms），监听 ws://127.0.0.1:${actualPort}`);
    console.log(`[asr-sidecar] 后处理：数字规整=${itn} 标点=${punctuation}`);
  };
  if (server.wss.address()) report();
  else server.wss.once('listening', report);
}
