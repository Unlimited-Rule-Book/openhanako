/**
 * asr-model-downloader.ts — 本地语音识别模型的下载器。
 *
 * 设计要点（每条都对应一个具体的坑）：
 *
 * 1. **按"缺失集合"下载**：调用方给的是"要哪些模型"，这里自己算"哪些文件还没有"。
 *    这样"标点模型不重复下载"是天然的 —— 不需要记"下过没有"的标志位，
 *    **以磁盘现状为准**（标志位会因为崩溃/回滚而与现实不一致）。
 *
 * 2. **先落 .part 再改名**：下载中的文件永远不叫正式名字。
 *    于是"残缺文件被当成已安装"这种事故不会发生；取消/失败留下的 .part 也不影响判断。
 *
 * 3. **断点续传**：.part 已存在就带 `Range` 接着下。
 *    标点模型是单个 294 MB 的大文件，没有续传的话断在 90% 就得从头来。
 *    源站不支持 Range（返回 200 而不是 206）时自动退化为重下。
 *
 * 4. **镜像回退**：一个文件在当前源上失败就换下一个源；文件之间独立。
 *    国内直连 huggingface 常失败，所以默认源是 hf-mirror（见 local-models.ts）。
 *
 * 5. **下完必校验 sha256**：不校验就不知道拿到的是不是完整/正确的权重，
 *    而 sidecar 拿着坏权重起不来时，报错信息对用户毫无意义。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LOCAL_MODEL_SOURCES,
  LOCAL_MODEL_SPECS,
  getLocalModelSpec,
  inspectLocalModel,
  modelFileUrl,
  type LocalModelSource,
  type LocalModelSpec,
} from '../core/speech-recognition/local-models.ts';

const PART_SUFFIX = '.part';
const CHUNK_LOG_INTERVAL_MS = 1000;
/**
 * 多久没有任何字节就认为这条连接已经死了。
 *
 * 为什么必须有它：**网线拔掉时 TCP 不会立刻报错**，请求就那么挂着 ——
 * 界面永远显示"下载中"，用户既不知道出了事，也等不到重试入口。
 * （实测：拔网后进度停住但不报错，插回网线同一条请求又继续传。）
 */
const DEFAULT_STALL_TIMEOUT_MS = 20_000;

interface DownloadPlanItem {
  spec: LocalModelSpec;
  file: { name: string; size: number; sha256: string };
  targetPath: string;
}

export interface AsrModelStatusEntry {
  id: string;
  state: 'ready' | 'missing' | 'partial';
  /** 还差的字节数（已装好就是 0） */
  missingBytes: number;
  /** 还缺哪些文件（界面据此直接告诉用户"还需要什么"，不必等他拖完才知道） */
  missing: string[];
  totalBytes: number;
}

export interface AsrModelDownloadState {
  /** 正在下载的模型 id 列表（空数组表示没在下载） */
  ids: string[];
  /** 已下字节 / 总字节（进度条用） */
  received: number;
  total: number;
  /** 当前使用的源 */
  sourceId: string | null;
  /** 当前正在下的文件（便于排查"卡在哪个大文件上"） */
  currentFile: string | null;
  /** 失败原因；null 表示没出错 */
  error: string | null;
  /** 是否已被取消 */
  cancelled: boolean;
}

export function createAsrModelDownloader({
  modelsRoot,
  fetchImpl = globalThis.fetch,
  log = () => {},
  specs = LOCAL_MODEL_SPECS,
  stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
}: {
  modelsRoot: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /**
   * 模型清单。默认用真实清单；**测试时注入假清单** ——
   * 否则要验证下载逻辑就得真下几百 MB 权重，测试就没法跑了。
   */
  specs?: LocalModelSpec[];
  /** 卡死超时（毫秒）。测试里调小，正式用默认值。 */
  stallTimeoutMs?: number;
}) {
  const specById = (id: string) => specs.find((spec) => spec.id === id);
  let controller: AbortController | null = null;
  let state: AsrModelDownloadState | null = null;

  const exists = (p: string) => fs.existsSync(p);
  const sizeOf = (p: string) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return -1;
    }
  };

  function modelStatus(): AsrModelStatusEntry[] {
    return specs.map((spec) => {
      const inspected = inspectLocalModel(spec, modelsRoot, exists, sizeOf);
      return {
        id: spec.id,
        state: inspected.state,
        missingBytes: inspected.bytes,
        missing: inspected.missing,
        totalBytes: spec.files.reduce((sum, f) => sum + f.size, 0),
      };
    });
  }

  /** 只挑**还差的文件**组装下载计划 —— "已有则跳过"就靠这一步 */
  function buildPlan(ids: string[]): DownloadPlanItem[] {
    const plan: DownloadPlanItem[] = [];
    for (const id of ids) {
      const spec = specById(id);
      if (!spec) continue;
      const inspected = inspectLocalModel(spec, modelsRoot, exists, sizeOf);
      if (inspected.state === 'ready') continue;
      for (const file of spec.files) {
        if (!inspected.missing.includes(file.name)) continue;
        plan.push({
          spec,
          file,
          targetPath: path.join(modelsRoot, spec.dir, file.name),
        });
      }
    }
    return plan;
  }

  /** 源顺序：指定的源排第一，然后按默认优先级补齐其余（保证"换镜像"一定有下一个可试） */
  function orderedSources(preferredId?: string | null): LocalModelSource[] {
    const preferred = LOCAL_MODEL_SOURCES.filter((s) => s.id === preferredId);
    const rest = LOCAL_MODEL_SOURCES.filter((s) => s.id !== preferredId);
    return [...preferred, ...rest];
  }

  /** 把某个文件的内容喂进已有的哈希（续传时用：先补算已下部分的字节） */
  async function hashFileInto(filePath: string, hash: crypto.Hash): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve());
      stream.on('error', reject);
    });
  }

  /**
   * 下一个文件。成功返回 true；这个源失败返回 false（由调用方换源）。
   * 这里**不抛异常**：换源是正常流程，不该用异常来表达。
   */
  async function downloadFromSource(item: DownloadPlanItem, source: LocalModelSource): Promise<boolean> {
    const url = modelFileUrl(source, item.spec, item.file.name);
    const partPath = item.targetPath + PART_SUFFIX;
    fs.mkdirSync(path.dirname(item.targetPath), { recursive: true });

    // 已有 .part → 尝试断点续传
    let resumeFrom = exists(partPath) ? sizeOf(partPath) : 0;
    if (resumeFrom > item.file.size) resumeFrom = 0; // 半包比目标还大：不正常，重下

    const headers: Record<string, string> = {};
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    // 这一条请求自己的 controller：卡死只让**当前源**失败、换下一个源，
    // 而不是把整单判成"用户取消"（两者要分得清：一个该给重试入口，一个不该）。
    const request = new AbortController();
    const linkGlobalAbort = () => request.abort();
    controller?.signal.addEventListener('abort', linkGlobalAbort, { once: true });
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stalled = false;
    const armStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => { stalled = true; request.abort(); }, stallTimeoutMs);
    };
    const disarmStall = () => {
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
    };

    let response: Response;
    try {
      armStall();
      response = await fetchImpl(url, { headers, signal: request.signal });
      disarmStall();
    } catch (err: any) {
      disarmStall();
      if (controller?.signal.aborted) throw err; // 用户取消：往上抛，由 start 收尾
      log(`[asr-models] ${source.id} ${stalled ? `连接卡住（${stallTimeoutMs}ms 无数据）` : '请求失败'}：${err?.message || err}`);
      controller?.signal.removeEventListener('abort', linkGlobalAbort);
      return false;
    }

    if (response.status === 416) {
      // Range 越界：.part 大小与本文件不一致，删掉重来
      fs.rmSync(partPath, { force: true });
      resumeFrom = 0;
      try {
        response = await fetchImpl(url, { signal: request.signal });
      } catch {
        controller?.signal.removeEventListener('abort', linkGlobalAbort);
        return false;
      }
    }
    if (!response.ok) {
      log(`[asr-models] ${source.id} 返回 ${response.status}：${item.file.name}`);
      return false;
    }
    // 源站不支持 Range（返回 200）→ 它给的是整份，那就从头写
    const isPartial = response.status === 206;
    const writeFrom = isPartial ? resumeFrom : 0;

    // ── 进度记账的不变式（改这段之前先读这里）──────────────────────────
    //   1. 进度必须等于**盘上真实已有的字节数**：所以续传时要把已有部分计入，
    //      否则界面从 0 开始显示，用户以为在从头重下。
    //   2. **本次尝试加了多少，退出时就要恰好回退多少**（addedThisAttempt）。
    //      少了它会虚高；多了会凭空掉进度。
    //   为什么必须显式记账：换源/重试时，下一个尝试会通过 writeFrom **重新计入**
    //   盘上已有的部分 —— 如果失败那次不减掉自己加过的，同一批字节就被计了两遍。
    let addedThisAttempt = 0;
    const addProgress = (bytes: number) => {
      if (!state || bytes <= 0) return;
      state.received += bytes;
      addedThisAttempt += bytes;
    };
    const rollbackProgress = () => {
      if (!state) return;
      state.received -= addedThisAttempt;
      addedThisAttempt = 0;
    };

    if (state) state.currentFile = `${item.spec.id}/${item.file.name}`;
    // 续传：盘上已有的部分计入进度（不支持 Range 时 writeFrom 为 0，自然不加）
    addProgress(writeFrom);

    // 续传要"先证明真的能续"：把盘上已有的部分喂进哈希（不能喂它的摘要——那样校验值必然对不上）。
    // 但**读不动就不能假装能续**（文件被清掉 / 正被别的进程写 / 权限问题）：
    // 这时必须退化成"从零开始"，否则最终会以"校验不符"这种看不懂的方式失败，
    // 而那个报错完全指不到真实原因。读失败本身也不该逃逸成未处理异常。
    const hash = crypto.createHash('sha256');
    let resumeBytes = 0;
    if (writeFrom > 0) {
      try {
        await hashFileInto(partPath, hash);
        resumeBytes = writeFrom;
      } catch {
        log(`[asr-models] ${item.file.name}：已有片段读不动，改为从头下载`);
        resumeBytes = 0;
      }
    }
    // 写流**惰性创建**：等真的收到第一块数据才落盘。
    // 为什么不能提前建：请求可能根本拿不到数据（用户取消、连接卡死），
    // 那时这个流会被 destroy，而它的 open 失败**没人接**，就变成未捕获异常 ——
    // 现象是测试/进程里冒出一个莫名其妙的 ENOENT，且指不到真正的原因。
    // 另外这里必须自己挂 error 监听：Node 的流只要没有 error 监听，出错就是抛全局。
    let out: fs.WriteStream | null = null;
    let streamError: Error | null = null;
    const ensureOut = () => {
      if (!out) {
        out = fs.createWriteStream(partPath, { flags: resumeBytes > 0 ? 'a' : 'w' });
        out.on('error', (err) => { streamError = err as Error; });
      }
      return out;
    };
    if (resumeBytes !== writeFrom) {
      // 从头写：先前按续传记的那部分进度要撤回（addProgress 记的是 writeFrom）
      if (state && writeFrom > 0) {
        state.received -= writeFrom;
        addedThisAttempt -= writeFrom;
      }
    }

    let lastLog = Date.now();
    try {
      const body = response.body as unknown as AsyncIterable<Uint8Array> | null;
      if (!body) throw new Error('响应没有 body');
      for await (const chunk of body) {
        armStall(); // 每收到一块就重新计时：只要还有数据进来就不算卡死
        const buf = Buffer.from(chunk);
        hash.update(buf);
        const stream = ensureOut();
        if (!stream.write(buf)) {
          await new Promise<void>((resolve) => stream.once('drain', () => resolve()));
        }
        addProgress(buf.length);
        if (Date.now() - lastLog > CHUNK_LOG_INTERVAL_MS) {
          lastLog = Date.now();
          log(`[asr-models] ${item.file.name} ${Math.round((state?.received || 0) / 1048576)}MB/${Math.round((state?.total || 0) / 1048576)}MB`);
        }
      }
      await new Promise<void>((resolve, reject) => {
        if (!out) return resolve();
        out.end((err?: Error) => (err ? reject(err) : resolve()));
      });
      disarmStall();
      if (streamError) throw streamError; // 落盘出错：按这个源失败处理（下面会换源）
    } catch (err) {
      out?.destroy();
      disarmStall();
      controller?.signal.removeEventListener('abort', linkGlobalAbort);
      if (controller?.signal.aborted) throw err; // 用户取消：往上抛
      log(`[asr-models] ${source.id} ${stalled ? `连接卡住（${stallTimeoutMs}ms 无数据）` : '传输中断'}：${(err as Error)?.message || err}`);
      rollbackProgress(); // 盘上的 .part 还在，交给下一次尝试通过 writeFrom 重新计入
      return false; // 保留 .part 供下次续传
    }

    // 校验：大小 + sha256。任一不符就当这个源不可信，换下一个源重试。
    const actualSize = sizeOf(partPath);
    const actualHash = hash.digest('hex');
    if (actualSize !== item.file.size || actualHash !== item.file.sha256) {
      log(`[asr-models] ${source.id} 校验不符：${item.file.name}（大小 ${actualSize}/${item.file.size}）`);
      fs.rmSync(partPath, { force: true }); // 不可信的部分不能留着续传
      rollbackProgress(); // 与所有其它退出路径用同一套回退逻辑，不再各算各的
      return false;
    }

    controller?.signal.removeEventListener('abort', linkGlobalAbort);
    fs.renameSync(partPath, item.targetPath);
    log(`[asr-models] 完成 ${item.spec.id}/${item.file.name}`);
    return true;
  }

  async function start({ ids, sourceId }: { ids: string[]; sourceId?: string | null }) {
    // 判据必须是"有没有活跃的 controller"，**不能是 state 非空**：
    // state 在失败/取消后会保留（供界面显示三出口），拿它当"进行中"会让
    // 「重试」「换镜像」被自己挡掉 —— 而且 start 是 async，抛错变成被拒的 Promise，
    // 路由那层的 409 根本不会触发，表现为"点了没反应"。
    if (controller) throw new Error('已有模型下载在进行中');
    const plan = buildPlan(ids);
    if (plan.length === 0) return { alreadyInstalled: true };

    const sources = orderedSources(sourceId);
    state = {
      ids: [...ids],
      received: 0,
      total: plan.reduce((sum, item) => sum + item.file.size, 0),
      sourceId: sources[0]?.id ?? null,
      currentFile: null,
      error: null,
      cancelled: false,
    };
    controller = new AbortController();
    log(`[asr-models] 开始下载 ${plan.length} 个文件，共 ${Math.round(state.total / 1048576)}MB`);

    let failed = false;
    try {
      for (const item of plan) {
        let ok = false;
        for (const source of sources) {
          if (state) state.sourceId = source.id;
          ok = await downloadFromSource(item, source);
          if (ok) break;
          log(`[asr-models] 换源重试：${source.id} → ${item.file.name}`);
        }
        if (!ok) {
          // 每个文件大小为 0 的极端情况（清单里不会有）不算失败
          throw new Error(`下载失败：${item.file.name}（已试过 ${sources.length} 个源）`);
        }
      }
    } catch (err: any) {
      failed = true;
      if (state) {
        if (controller.signal.aborted) state.cancelled = true;
        else state.error = err?.message || String(err);
      }
      log(`[asr-models] 结束（${state?.cancelled ? '已取消' : state?.error}）`);
    } finally {
      controller = null;
    }
    // 状态语义：download 只承载「进行中」和「待处理的失败」（error/cancelled，供
    // 界面显示重试/换镜像/指定目录三出口）。**成功没有任何待处理信息**——"装好了"
    // 这个事实由模型清单状态（ready）表达，界面据此显示"就绪"。
    // 之前成功后也保留 state，ids 非空又无 error/cancelled，前端据此判定"下载中"，
    // 于是永远卡在 100%。
    if (!failed) state = null;
    return { state: getState() };
  }

  function getState(): AsrModelDownloadState {
    return state ?? {
      ids: [],
      received: 0,
      total: 0,
      sourceId: null,
      currentFile: null,
      error: null,
      cancelled: false,
    };
  }

  function cancel() {
    if (!controller) return false;
    controller.abort();
    if (state) state.cancelled = true;
    return true;
  }

  /** 下载结束（成功/失败/取消）后清掉状态，让界面回到"可以再点一次" */
  function clearState() {
    if (controller) return false;
    state = null;
    return true;
  }

  /** 是否真的有下载在跑（供路由做 409 判断；与 getState() 的"待处理失败"区分开） */
  function isRunning() {
    return controller !== null;
  }

  return { modelStatus, start, cancel, getState, clearState, buildPlan, isRunning };
}
