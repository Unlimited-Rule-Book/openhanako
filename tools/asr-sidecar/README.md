# asr-sidecar — 本地流式语音识别

OpenHanako 的语音输入需要一个**本地、离线、流式**的识别引擎。这个目录就是它的独立进程。

## 为什么单独一个进程

`sherpa-onnx` 是原生模块，它的 ABI 跟 Electron 的对不上（Electron 42 vs Node 24），直接在主进程里 `require` 大概率要 electron-rebuild、打包时也容易出问题。拆成独立进程能彻底绕开，还能单独调试、单独换引擎。

目录自带 `package.json`，**不污染主项目的依赖**，将来合并上游时冲突面最小。

## 第一次使用

```bash
cd tools/asr-sidecar
npm install
```

然后下载模型（约 25MB）。**GitHub 的 release 资产在国内经常取不到，用 hf-mirror**：

```bash
# 基础地址
# https://hf-mirror.com/csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/resolve/main/<文件名>

# 需要的文件，放到 models/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23/
tokens.txt
encoder-epoch-99-avg-1.int8.onnx
decoder-epoch-99-avg-1.int8.onnx
joiner-epoch-99-avg-1.int8.onnx
test_wavs/0.wav          # 验证用，可选
```

模型权重目录已在本地忽略（`.git/info/exclude`），不会进版本库。

## 运行

```bash
node server.mjs                              # 默认监听 ws://127.0.0.1:8766
node server.mjs --port 8766                  # 指定端口（--port 0 = 随机空闲端口）
node server.mjs --punctuation off            # 关掉标点后处理
node server.mjs --itn off                    # 关掉数字规整（中文数字 → 阿拉伯数字）
node server.mjs --silence 1.2                # 停顿多久算说完（秒，默认 0.8）
```

只绑 `127.0.0.1` —— 这是本机能力，不对外暴露。

> **注意 stdin（生命线）**：sidecar 把 stdin 当作父进程的生命线 —— 一旦 stdin 关闭
> （读到 EOF），它会主动退出，免得应用被强杀后残留一个抱着几百 MB 模型的孤儿进程
> （实现见 `server.mjs` 里 `process.stdin.on('end'/'close')` 那段）。
> - 在终端里手敲上面几条命令时 stdin 是 TTY，不会有 EOF，**用法不变**，照常常驻。
> - 但如果把 stdin 接到空/已关闭的输入上（例如 `node server.mjs < /dev/null`、
>   `cat /dev/null | node server.mjs`），或在没有终端的 CI / `nohup` 环境里直接跑，
>   它会在启动后**立刻退出**。这是预期行为、不是崩溃；需要常驻时保留一个打开的
>   stdin 即可（直接在终端里跑就行）。

### 句末后处理

本地识别模型有两处先天不足，都在**句末**补上（partial 保持原始输出，句内不做）：

| 项 | 缺什么 | 怎么补 |
|---|---|---|
| **标点** | 模型不产标点 | 官方中文标点模型 `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12`（281MB），见下 |
| **数字** | 只出汉字数字（三百六十五） | 自己的保守规则 `itn-zh.mjs`（**不用**官方 `itn_zh_number.fst`，它会过度转换） |

顺序：先数字规整，再标点。任一步失败都退回原文，**绝不丢字**。

**为什么不用官方 ITN 规则文件**：实测它把 `这一轮` 改成 `这1轮` —— 中文里这种说法本来就该用汉字。
自己写的规则只转"至少两个字"的数字串，单字数字一律不动，于是 `三个问题`、`第一次`、`一心一意` 都不会被误伤。
规则文件里带了 26 条用例（含 13 条"不该改"的反例）。

**端点检测参数**（实测调过）：
- `--silence`（默认 0.8s）：停顿多久算说完。太灵敏会在句子中间断句，标点跟着插错地方。
- 一句话最长 20 秒（sherpa 默认只有 5 秒，**正常说一句话经常超过 5 秒，会在中间硬切** —— 这是实测踩到的坑）。

## 协议

**客户端 → 服务端**

| 消息 | 说明 |
|---|---|
| `{"type":"start","sampleRate":16000}` | 开一条识别流 |
| 二进制帧 | 16kHz 单声道 **int16 LE** PCM |
| `{"type":"end"}` | 收尾，把剩余音频解完并回 `final` |
| `{"type":"reset"}` | 丢弃当前句、重开一条流 |
| `{"type":"ping"}` | 心跳 |

**服务端 → 客户端**

| 消息 | 说明 |
|---|---|
| `{"type":"started","sampleRate":16000}` | 已就绪，可以推音频了 |
| `{"type":"partial","segmentId":n,"text":"…","revision":bool}` | 当前这一句的最新文本 |
| `{"type":"endpoint","segmentId":n,"text":"…","raw":"…"}` | 这一句定稿（**已加标点、已转数字**；`raw` 是未处理的原始识别结果） |
| `{"type":"final","text":"…","segments":[…],"stats":{…},"raw":"…"}` | 整轮结束 |
| `{"type":"reset_ok"}` / `{"type":"pong"}` / `{"type":"error","message":"…"}` | 控制响应 |

### 两个设计要点

**1. `partial` 永远给「当前这一句到目前为止的完整文本」，客户端做整段替换。**

不要拼接。这样"单调增长型"引擎（本地 zipformer，实测回退率 0%）和"可回溯修订型"引擎（云端 LLM 式识别，会把已输出的字改掉）能塞进**同一套前端逻辑**，前端不需要知道底下是哪种引擎。

**2. `revision` 是留给前端的适配口。**

`true` 表示这次相对上一次**改写了已经输出的内容**。前端可以据此做"跳变"的视觉提示；如果引擎从不改写，它永远是 `false`，前端就当没这回事。将来若确认引擎永远不回退，预览层与文档层可以合并成一层，但协议不用改。

## 模型选型（本机实测，非第三方传言）

| 模型 | 体积 | 纯中文 | 中英混排 | RTF | 加载 |
|---|---|---|---|---|---|
| **zh-14M** | 25 MB | **最干净** | ❌ 英文变谐音汉字 | **0.028** | 1.0s |
| 双语 zh-en | 188 MB | 更差（重复字） | ✅ 英文全对 | 0.053 | 1.5s |
| zh-xlarge | 740 MB | 出现错词/截断 | 未测 | 0.243 | 7.2s |

**结论：纯中文用 zh-14M，夹英文用双语版。** 大模型不一定更好 —— 换模型时自己跑一遍最靠谱。

## 标点（本地模型不产标点，需要后处理）

用官方中文标点模型 `sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12`（281 MB，中英混排）。

```bash
# 只需 model.onnx 一个文件（词表嵌在 onnx 元数据里，不需要 tokens.txt）
https://hf-mirror.com/csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12/resolve/main/model.onnx
```

```js
const punct = new sherpa.OfflinePunctuation({ model: { ctTransformer: MODEL_PATH } });
const out = punct.addPunct('重点呢想谈三个问题首先呢就是这一轮全球金融动量的表现');
// → '重点呢想谈三个问题，首先呢就是这一轮全球金融动量的表现。'
```

- **方法名是 `addPunct`**，不是 Python 文档里的 `add_punctuation`
- **只在句末跑一次**，句内不要跑（标点会乱跳）
- 实测加载 399ms、单句 5～10ms
- 它**不删口语填充词**（"啊/呢"会保留），那是另一件事

## 已知事实（实测）

| 项 | 值 |
|---|---|
| 模型加载耗时 | 约 450ms |
| 中文识别 | 官方测试音频完全正确 |
| 回退率（干净音频） | 0% —— 逐字增长，不回溯改写 |
| 标点 | **模型不输出标点**；需要的话要另接标点模型（`sherpa-onnx-node` 带 `OnlinePunctuation`） |
| 线程数 | 单线程最快（14M 小模型多线程是负优化） |
