/**
 * asr-model-import.ts — 把用户已有的模型文件"导入"到模型目录。
 *
 * 这是「我已有模型文件」那条路的后端。设计上的两个关键决定：
 *
 * 1. **不靠目录名/文件名认，靠内容指纹认。**
 *    用户手上那份可能是 `models` 目录、可能是别人给的压缩包、也可能文件夹被重命名过。
 *    我们只按 **大小 + sha256** 与清单比对 —— 命中就归位到正确的目录名与文件名。
 *    于是"文件名必须对齐"这个负担从用户身上彻底移走（那是这条功能最容易劝退人的地方）。
 *
 * 2. **只搬路径，不搬内容。**
 *    渲染层通过 Electron 的 `getPathForFile` 拿到**真实磁盘路径**，这里直接读写那些路径。
 *    GB 级的权重文件既不进内存、也不过 HTTP —— 所以没有超时、没有内存峰值、
 *    也不需要在 HTTP 层做流式上传。
 *
 * 支持的输入：普通文件、目录（递归）、`.zip`（用系统自带 `tar` 解，零依赖）。
 * 不支持 `.rar` / `.7z`（需要外部二进制），调用方会得到明确的提示文案。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  LOCAL_MODEL_SPECS,
  inspectLocalModel,
  type LocalModelSpec,
} from '../core/speech-recognition/local-models.ts';

/** 压缩包体积上限：够用（最大的标点模型 281MB），又能挡住"误拖了个大文件" */
const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 10 * 60 * 1000;

export interface ImportOutcome {
  /** 已就位的模型 id（该模型的**全部**文件都齐了） */
  placed: string[];
  /** 缺文件的模型：还差哪些文件名 */
  incomplete: Array<{ id: string; missing: string[] }>;
  /** 认不出来的文件（连大小都对不上清单） */
  unrecognized: string[];
  /** 压缩包没解开之类的问题，逐条给用户看 */
  errors: string[];
}

function sha256Of(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** 清掉某个模型目录里遗留的 .part（只在"该模型已就绪"时调用：那时它不可能是续传所需的） */
function cleanStaleParts(spec: LocalModelSpec, modelsRoot: string) {
  const dir = path.join(modelsRoot, spec.dir);
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.part')) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch {
    // 清不掉不影响导入已经成功这个事实，静默即可
  }
}

function walk(dirPath: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/** 解压到临时目录。用系统自带 `tar`（Win10+/macOS/Linux 都有 bsdtar，能解 zip），不引新依赖。 */
async function extractArchive(archivePath: string, tempRoot: string): Promise<string[]> {
  const { size } = fs.statSync(archivePath);
  if (size > MAX_ARCHIVE_BYTES) {
    throw new Error(`压缩包超过 ${Math.round(MAX_ARCHIVE_BYTES / 1073741824)} GB，请先解压再拖进来`);
  }
  const target = fs.mkdtempSync(path.join(tempRoot, 'asr-import-'));
  await new Promise<void>((resolve, reject) => {
    execFile('tar', ['-xf', archivePath, '-C', target], { timeout: EXTRACT_TIMEOUT_MS }, (err) => {
      if (err) reject(new Error(`解压失败（${path.basename(archivePath)}）：${err.message}`));
      else resolve();
    });
  });
  const files = walk(target);
  // 防"压缩包炸弹式路径穿越"：解出来的文件必须都在临时目录里
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!resolved.startsWith(path.resolve(target) + path.sep)) {
      throw new Error('压缩包里有越界路径，已拒绝解压');
    }
  }
  return files;
}

export function createAsrModelImporter({
  modelsRoot,
  specs = LOCAL_MODEL_SPECS,
  log = () => {},
  onFilesChanged = () => {},
}: {
  modelsRoot: string;
  /** 模型清单（测试注入假清单；正式用真实清单） */
  specs?: LocalModelSpec[];
  log?: (msg: string) => void;
  /**
   * 本次导入**真的写了文件**时回调一次。
   *
   * 存在的理由（一条通用规则，不是为某个流程打的补丁）：
   * **任何改变"模型文件集合"的操作，都会让"上次下载的结论"失效。**
   * 下载成功那条路已经这么做了（状态置空）；导入这条路原来没有 ——
   * 于是用户"下载到一半取消 → 自己导入补好 → 又把文件删掉"之后，
   * 界面会拿那次早已作废的"下载已取消"来解释当前状况，显示成"下载失败"，
   * 而当前真实情况只是"缺文件"而已。
   */
  onFilesChanged?: () => void;
}) {
  /**
   * 导入一批路径。返回结构是"给用户看的"：哪些成了、哪些还缺什么、哪些认不出来。
   */
  async function importPaths(inputPaths: string[]): Promise<ImportOutcome> {
    const outcome: ImportOutcome = { placed: [], incomplete: [], unrecognized: [], errors: [] };
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-import-'));

    try {
      // 1) 把用户给的东西摊平成"候选文件列表"（目录递归 / 压缩包解压 / 普通文件直接用）
      const candidates: string[] = [];
      for (const inputPath of inputPaths) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(inputPath);
        } catch {
          outcome.errors.push(`找不到：${inputPath}`);
          continue;
        }
        if (stat.isDirectory()) {
          candidates.push(...walk(inputPath));
        } else if (/\.zip$/i.test(inputPath)) {
          try {
            candidates.push(...(await extractArchive(inputPath, tempRoot)));
          } catch (err: any) {
            outcome.errors.push(err?.message || String(err));
          }
        } else if (/\.(rar|7z)$/i.test(inputPath)) {
          outcome.errors.push(`${path.basename(inputPath)}：暂不支持 rar/7z，请先解压成文件夹再拖进来`);
        } else if (stat.isFile()) {
          candidates.push(inputPath);
        }
      }

      // 2) 按 **大小** 先筛（免得不该算哈希的也去算），大小对上了再算 sha256 确认。
      //    这一步是"靠内容认模型"的核心：文件名完全被忽略。
      const wanted = specs.flatMap((spec) => spec.files.map((file) => ({ spec, file })));
      const matched = new Map<string, string>(); // `${specId}/${fileName}` → 源文件路径
      for (const candidate of candidates) {
        let size: number;
        try {
          size = fs.statSync(candidate).size;
        } catch {
          continue;
        }
        const sameSize = wanted.filter((entry) => entry.file.size === size
          && !matched.has(`${entry.spec.id}/${entry.file.name}`));
        if (sameSize.length === 0) {
          outcome.unrecognized.push(path.basename(candidate));
          continue;
        }
        const digest = await sha256Of(candidate);
        const hit = sameSize.find((entry) => entry.file.sha256 === digest);
        if (!hit) {
          outcome.unrecognized.push(path.basename(candidate));
          continue;
        }
        matched.set(`${hit.spec.id}/${hit.file.name}`, candidate);
        log(`[asr-import] 命中 ${hit.spec.id}/${hit.file.name} ← ${path.basename(candidate)}`);
      }

      // 3) 就位：复制（**不移动** —— 用户的原始文件保持不动，导入失败也不会毁掉他的备份）
      for (const spec of specs) {
        for (const file of spec.files) {
          const source = matched.get(`${spec.id}/${file.name}`);
          if (!source) continue;
          const targetDir = path.join(modelsRoot, spec.dir);
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(source, path.join(targetDir, file.name));
        }
        // 4) 判定**按盘上真实状态**，而不是"这一批给了什么"。
        //    用户完全可能分两次拖（先 3 个 onnx、再 tokens）——
        //    如果只看这一批，第二次会误报"还缺 3 个文件"，而其实一个都不缺。
        //    这里的判据与下载器、与界面用的是**同一套**（inspectLocalModel + 清单）。
        const after = inspectLocalModel(spec, modelsRoot, fs.existsSync, (filePath) => {
          try { return fs.statSync(filePath).size; } catch { return -1; }
        });
        if (after.state === 'ready') {
          outcome.placed.push(spec.id);
          // 这个模型已经齐了 —— 目录里遗留的 .part（以前中断的下载）此刻只是垃圾：
          // 它占着几百 MB，还会让用户以为"是不是还没下完"。
          // 判据是确定的（模型已就绪 = 不再需要续传），所以清掉它不需要问任何人。
          cleanStaleParts(spec, modelsRoot);
        } else if (after.state === 'partial') {
          outcome.incomplete.push({ id: spec.id, missing: after.missing });
        }
      }

      // 只要真的动过文件就通知一次（什么都没命中就没什么可通知的）
      if (outcome.placed.length > 0 || outcome.incomplete.length > 0) onFilesChanged();

      return outcome;
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }

  return { importPaths };
}
