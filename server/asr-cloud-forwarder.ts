// asr-cloud-forwarder.ts — 云端语音识别（百炼 paraformer-realtime）的服务端转发
//
// 为什么要在服务端转发：云厂商的 API Key 绝不能下发到渲染层（前端能跑任意脚本，
// 拿到 key 等于白给）。所以渲染层连服务端本机的 ws 端点，服务端再拿自己的 key 去
// 连百炼，双向转发音频帧与识别结果，并把百炼的事件映射成和本地 sidecar 一样的
// partial / endpoint / final 协议 —— 前端一套代码，本地云端通吃。
//
// 百炼协议（run-task / finish-task / result-generated）与字段路径：
//   payload.output.sentence.text       识别文本（整句，增长型）
//   payload.output.sentence.sentence_end  true=最终结果，false=中间结果
// 详见阿里云《实时语音识别（Paraformer）服务端事件》。

import { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import { DEFAULT_CLOUD_STREAM_MODEL_ID } from "../shared/speech-input.ts";

// 百炼实时语音识别的 WS 端点。可被环境变量覆盖：一是内网/代理/私有部署要换地址，
// 二是测试与本地联调能用模拟的上游（真实地址是硬编码的话就没办法替换）。
// 注意：lib/providers/dashscope.ts 里那个是 **HTTP** baseUrl（compatible-mode），
// 跟这里的 WS 推理地址不是一回事，别用错。
const DASHSCOPE_WS_URL = process.env.HANA_DASHSCOPE_WS_URL
  || "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
const SAMPLE_RATE = 16000;

export function createAsrCloudForwarder({
  getApiKey,
  log = () => {},
}: {
  getApiKey: () => string | undefined;
  log?: (msg: string) => void;
}) {
  const wss = new WebSocketServer({ noServer: true });

  function handleUpgrade(req: any, socket: any, head: any) {
    // 用哪个型号由 /api/asr/stream 那个路由决定并写进 URL query（见 server/index.ts）：
    // 它已经校验过"这个型号有执行实现、且在供应商的可用列表里"，所以这里不再重复校验，
    // 取不到时才退回兜底默认值。
    let model = DEFAULT_CLOUD_STREAM_MODEL_ID;
    try {
      const url = new URL(String(req?.url ?? "/"), `http://${req?.headers?.host ?? "127.0.0.1"}`);
      const requested = url.searchParams.get("model");
      if (requested) model = requested;
    } catch { /* URL 畸形就用默认型号 */ }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => handleClient(ws, model));
  }

  function handleClient(ws: WebSocket, model: string) {
    let upstream: WebSocket | null = null;
    const taskId = randomUUID();
    let started = false;
    // 客户端已经要求收尾，但还没到"能发 finish-task"的时机（run-task 尚未被应答）。
    // 以前这里只用一个 readyState 判断就决定发不发，于是 end 早于 task-started 时要么
    // 抢跑、要么静默丢弃；用标志把"要收尾"这个意图先记住，等时机到了再补。
    let endRequested = false;
    // finish-task 的幂等闸：无论哪条路径触发，都只能发一次。
    let finishSent = false;
    let segmentId = 0;
    let lastText = "";
    let ended = false;
    // task-started 之前到达的音频要先攒着。百炼必须先收到 run-task 的响应才接受音频，
    // 而前端在 websocket 一连上就开始推流了 —— 直接丢弃会让用户**开头的几个字凭空消失**
    // （表现为"我明明说了，但第一个词没了"）。攒住等握手完成再补发。
    const pendingAudio: Buffer[] = [];
    const MAX_PENDING_AUDIO = 300;   // 每片约 100ms，300 片 ≈ 30 秒，防内存无上限

    const send = (msg: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const fail = (message: string) => {
      if (!ended) send({ type: "error", message });
    };

    // 发 finish-task 的唯一出口 —— end 分支、task-started 分支、上游 open 都走这里，
    // 避免三处各写一遍条件与字段、日后改一处漏两处（漂移）。
    // 两个必答条件：
    //   · started        —— 百炼要求 run-task 被应答（task-started）后才接受 finish-task，
    //                       抢跑会被协议校验判 task-failed，整轮收尾报废；
    //   · 上游还 OPEN     —— 连接没建好（CONNECTING）或已断开时写进去只会丢。
    const sendFinishTask = () => {
      if (finishSent || !started || ended) return;
      if (!upstream || upstream.readyState !== upstream.OPEN) return;
      upstream.send(JSON.stringify({
        header: { action: "finish-task", task_id: taskId, streaming: "duplex" },
        // 坑：payload 必须带 input 字段，否则百炼协议校验直接 task-failed
        //（"Missing required parameter 'payload.input'"）—— 掐断收尾全链路报废。
        payload: { input: {} },
      }));
      finishSent = true;
    };

    const apiKey = getApiKey();
    if (!apiKey) {
      fail("未配置百炼（DashScope）API Key，请到「设置 → 模型」里配置阿里云百炼");
      ws.close();
      return;
    }

    upstream = new WebSocket(DASHSCOPE_WS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    upstream.on("open", () => {
      upstream?.send(JSON.stringify({
        header: { action: "run-task", task_id: taskId, streaming: "duplex" },
        payload: {
          task_group: "audio",
          task: "asr",
          function: "recognition",
          // 型号来自设置里选中的流式模型（经 /api/asr/stream 校验后写进 URL）
          model,
          parameters: {
            format: "pcm",
            sample_rate: SAMPLE_RATE,
            language_hints: ["zh", "en"],
            // 断句方式（阿里云文档：仅 v2 支持）
            //   默认走 VAD 断句：静音超过 max_sentence_silence（默认 800~1300ms）就判定
            //   句末 —— 用户"稍微停顿一下"就被硬加一个句号，体验很差。
            //   开语义断句会**关闭 VAD 断句**，改由模型按语义判断句子结束，
            //   不会因为单纯停顿就断句（这就是微信语音那种"标点跟着语义走"的体验）。
            //   代价：句子更长、提交更晚一点，对"说一句提交一句"的听写场景反而更合适。
            semantic_punctuation_enabled: true,
            // 标点由云端模型自己产出 —— 我们**不做**任何标点后处理，
            // 本地那套标点模型 + 数字规整只服务于本地引擎（它不产标点）。
            punctuation_prediction_enabled: true,
            // 备注：max_sentence_silence 只在 semantic_punctuation_enabled=false 时生效。
            // 若将来要回退 VAD 模式，把它调大（如 3000）也能减少"停顿即句号"。
          },
          input: {},
        },
      }));
      // 这里**不**接 sendFinishTask：open 时 started 必然还是 false，调了也只会被挡回来。
      // "end 早于 open" 那条路径由 task-started 分支补发（见下面的 endRequested 处理）——
      // 留一个永远跑不到的分支，比不写更容易误导后来改代码的人。
    });

    upstream.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      const event = msg?.header?.event;
      if (event === "task-started") {
        started = true;
        send({ type: "started", sampleRate: SAMPLE_RATE });
        // 把握手期间攒下的音频按原顺序补发，一个字都不丢
        for (const chunk of pendingAudio) {
          if (upstream?.readyState === upstream.OPEN) upstream.send(chunk);
        }
        pendingAudio.length = 0;
        // 收尾请求如果早于 task-started 到达（含上游还在 CONNECTING 就被丢掉的老问题），
        // 到这里补一次：此刻 run-task 已被应答，才轮到我们发 finish-task。
        if (endRequested) sendFinishTask();
      } else if (event === "result-generated") {
        const sentence = msg?.payload?.output?.sentence;
        if (!sentence || sentence.heartbeat) return;
        const text = String(sentence.text ?? "");
        if (!text) return;
        if (sentence.sentence_end === true) {
          // 最终结果 → endpoint。百炼自带标点/数字规整，text 直接可用。
          send({ type: "endpoint", segmentId, text, raw: text });
          segmentId += 1;
          lastText = "";
        } else {
          // 中间结果 → partial（百炼给的是"整句当前文本"，前端整段替换）
          const revision = lastText !== "" && !text.startsWith(lastText);
          lastText = text;
          send({ type: "partial", segmentId, text, revision });
        }
      } else if (event === "task-finished") {
        ended = true;
        // final 只带 pending（还没落成 endpoint 的最后一段）。以前这里还带
        // text: segments.join("") 与 segments，但前端只消费 pending —— text 是个
        // 没有消费者的字段，而且这种拼接会把英文单词之间本应有的空格吃掉
        // （"hello"+"world" → "helloworld"）。与其留一个"看起来能用其实是坏的"
        // 字段，不如删掉：需要完整文本时前端用 endpoint 的累积即可。
        send({ type: "final", pending: lastText || "" });
        // 不主动关 ws：等前端在 final 后 abort；close 事件里统一收 upstream。
      } else if (event === "task-failed") {
        // 先把手头已识别的文字还给前端（final 带 pending），再报错 —— 顺序不能反：
        // 前端收到 error 会收尾连接，final 若晚到就发不出去了。ended 最后置位，
        // 否则下面的 error 会被自己的 `if (!ended)` 拦截（打补丁时踩过的坑）。
        send({ type: "final", pending: lastText || "" });
        send({ type: "error", message: msg?.header?.error_message || "云端识别失败" });
        ended = true;
      }
    });

    upstream.on("error", () => fail("连接云端识别服务失败"));
    upstream.on("close", () => { if (!ended) fail("云端识别服务已断开"); });

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // 音频帧直通（前端已按 16k int16 PCM 采好）。
        // 只要任务还没 started 就先入队：这段时间既包含"上游还在 CONNECTING"（新建
        // WebSocket 到握手完成），也包含"OPEN 了但 run-task 还没被应答"。以前这里
        // 只按 `readyState === OPEN` 放行，于是 CONNECTING 窗口里的音频被直接丢弃
        // —— 用户"开头说的几个字凭空消失"。放宽成"未 started 就入队"，等 task-started
        // 时按原顺序统一补发（补发见下面 task-started 分支）。
        if (!started) {
          if (pendingAudio.length < MAX_PENDING_AUDIO) pendingAudio.push(data as Buffer);
          return;
        }
        // started 之后上游必然已 OPEN；若已断开就丢弃，别再往死连接里写。
        if (upstream?.readyState === upstream.OPEN) upstream.send(data);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg?.type === "end") {
        // 先记住"客户端要收尾"，再由 sendFinishTask 决定现在能不能发：只有 run-task
        // 已被应答（started）才轮到我们；否则挂着等 task-started 补发。
        // 老实现只看 readyState，CONNECTING 期到达的 end 被静默丢弃 —— 这一轮永远不发
        // finish-task，最后一段拿不到标点/数字规整，只能靠前端兜底计时器收尾。
        endRequested = true;
        sendFinishTask();
      }
    });

    ws.on("close", () => {
      ended = true;
      try { upstream?.close(); } catch { /* 已关 */ }
    });
    ws.on("error", () => {});
  }

  return { handleUpgrade };
}
