/**
 * 模型导入：把用户已有的文件"认出来并归位"。
 *
 * 这里盯的是这条功能最核心的承诺 —— **不靠目录名/文件名认，靠内容指纹认**。
 * 所以测试刻意把文件放在**乱名字的目录**里、甚至**改掉文件名**，
 * 只要内容还是那份内容，就必须能被正确识别并归位到清单里的目录名。
 *
 * 另外两条边界也要守住：
 *   · 只给了一部分文件 → 要准确报出"还缺哪个文件"（用户照着补就行）
 *   · 完全无关的文件 → 要归到"认不出来"，而不是静默失败
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAsrModelImporter } from '../server/asr-model-import.ts';

let sandbox = '';
let modelsRoot = '';
let sourceDir = '';

const A = Buffer.from('aaaa-aaaa-aaaa');
const B = Buffer.from('bbbbbbbbbbbbbbbbbbbb');
const sha = (buf: Buffer) => crypto.createHash('sha256').update(buf).digest('hex');

const specs = [
  {
    id: 'asr-model',
    dir: 'official-dir-name',
    repo: 'fake/asr',
    role: 'asr' as const,
    files: [
      { name: 'encoder.onnx', size: A.length, sha256: sha(A) },
      { name: 'tokens.txt', size: B.length, sha256: sha(B) },
    ],
  },
];

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-import-test-'));
  modelsRoot = path.join(sandbox, 'models');
  sourceDir = path.join(sandbox, 'source');
  fs.mkdirSync(sourceDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function writeSourceFile(relativePath: string, content: Buffer) {
  const full = path.join(sourceDir, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

describe('模型导入', () => {
  it('目录名与文件名都乱来，只要内容对就能认出来并归位到清单里的目录名', async () => {
    // 用户手上的样子：目录叫「新建文件夹 (3)」，文件被重命名过
    writeSourceFile('新建文件夹 (3)/随便一个名字.bin', A);
    writeSourceFile('新建文件夹 (3)/另一个名字.bin', B);

    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([sourceDir]);

    expect(outcome.placed).toEqual(['asr-model']);
    expect(outcome.unrecognized).toEqual([]);
    // 归位到了**清单里的**目录名与文件名，而不是用户那边的名字
    expect(fs.readFileSync(path.join(modelsRoot, 'official-dir-name', 'encoder.onnx')).equals(A)).toBe(true);
    expect(fs.readFileSync(path.join(modelsRoot, 'official-dir-name', 'tokens.txt')).equals(B)).toBe(true);
  });

  it('只给了一部分 → 准确报出还缺哪个文件（用户照着补）', async () => {
    writeSourceFile('a/encoder.onnx', A);

    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([sourceDir]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.incomplete).toEqual([{ id: 'asr-model', missing: ['tokens.txt'] }]);
  });

  it('完全无关的文件归到"认不出来"，不静默丢弃', async () => {
    writeSourceFile('random/readme.txt', Buffer.from('跟模型无关的内容'));

    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([sourceDir]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.incomplete).toEqual([]);
    expect(outcome.unrecognized).toEqual(['readme.txt']);
  });

  it('大小相同但内容不同 → 必须靠 sha256 挡住（不能只比大小就归位）', async () => {
    // 与 A **同样长度**的假货：只比大小的话会被误判成命中，所以必须靠 sha256 挡住
    const sameSize: Buffer = Buffer.from('z'.repeat(A.length));
    expect(sameSize.length).toBe(A.length);
    writeSourceFile('fake/encoder.onnx', sameSize);

    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([sourceDir]);

    expect(outcome.placed).toEqual([]);
    expect(outcome.unrecognized.length).toBe(1);
    expect(fs.existsSync(path.join(modelsRoot, 'official-dir-name', 'encoder.onnx'))).toBe(false);
  });

  it('rar / 7z 给出明确的"请先解压"，而不是含糊失败', async () => {
    const rarPath = writeSourceFile('x.rar', Buffer.from('not really rar'));

    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([rarPath]);

    expect(outcome.errors.join(' ')).toContain('rar');
    expect(outcome.errors.join(' ')).toContain('解压');
  });

  it('找不到的路径会逐条说明，而不是整体崩掉', async () => {
    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([path.join(sandbox, '并不存在')]);

    expect(outcome.errors.length).toBe(1);
    expect(outcome.errors[0]).toContain('找不到');
  });

  it('分两次拖：第二次不能把第一次已经放好的文件当成"还缺"（用户实测到的 bug）', async () => {
    const importer = createAsrModelImporter({ modelsRoot, specs });

    // 第一次只给了 encoder
    writeSourceFile('batch1/encoder.onnx', A);
    const first = await importer.importPaths([path.join(sourceDir, 'batch1')]);
    expect(first.placed).toEqual([]);
    expect(first.incomplete).toEqual([{ id: 'asr-model', missing: ['tokens.txt'] }]);

    // 第二次只给 tokens —— 判定必须看**盘上真实状态**：encoder 上一轮已经就位了
    writeSourceFile('batch2/tokens.txt', B);
    const second = await importer.importPaths([path.join(sourceDir, 'batch2')]);
    expect(second.placed).toEqual(['asr-model']);
    expect(second.incomplete).toEqual([]);
    // 两次拖进来的东西要能合到一个目录里，且四个文件都在
    expect(fs.readFileSync(path.join(modelsRoot, 'official-dir-name', 'encoder.onnx')).equals(A)).toBe(true);
    expect(fs.readFileSync(path.join(modelsRoot, 'official-dir-name', 'tokens.txt')).equals(B)).toBe(true);
  });

  it('模型补齐后，遗留的 .part（中断下载的半包）应被清掉，不再占着几百 MB', async () => {
    // 先造一个"下载中断"的现场：目标目录里有一个半包
    const dir = path.join(modelsRoot, 'official-dir-name');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'encoder.onnx.part'), Buffer.from('half-downloaded'));

    // 用户把完整的模型导入进来
    writeSourceFile('full/encoder.onnx', A);
    writeSourceFile('full/tokens.txt', B);
    const importer = createAsrModelImporter({ modelsRoot, specs });
    const outcome = await importer.importPaths([sourceDir]);

    expect(outcome.placed).toEqual(['asr-model']);
    expect(fs.existsSync(path.join(dir, 'encoder.onnx'))).toBe(true);
    // 半包此时只是垃圾：模型已就绪，不需要它续传
    expect(fs.existsSync(path.join(dir, 'encoder.onnx.part'))).toBe(false);
  });

  it('导入真的写了文件 → 通知"模型文件集合变了"（让上次下载的结论作废）', async () => {
    const onFilesChanged = vi.fn();
    const importer = createAsrModelImporter({ modelsRoot, specs, onFilesChanged });
    writeSourceFile('ok/encoder.onnx', A);

    await importer.importPaths([sourceDir]);

    expect(onFilesChanged).toHaveBeenCalledTimes(1);
  });

  it('什么都没命中（没动过文件）→ 不应通知，免得把无关的下载结论也作废掉', async () => {
    const onFilesChanged = vi.fn();
    const importer = createAsrModelImporter({ modelsRoot, specs, onFilesChanged });
    writeSourceFile('junk/readme.txt', Buffer.from('跟模型无关'));

    await importer.importPaths([sourceDir]);

    expect(onFilesChanged).not.toHaveBeenCalled();
  });
});
