/**
 * local-models.ts — 本地语音识别模型的「清单」与「缺失判断」。
 *
 * 为什么需要这份清单：本地引擎要跑起来，光有代码不够，还得有模型权重（几百 MB，不进仓库）。
 * 所以必须回答三个问题，而这个文件就是那三处唯一的事实来源：
 *   1. **要哪些文件**（每个模型的完整文件清单 + 大小 + sha256）
 *   2. **从哪儿取**（源站；国内直连 GitHub/HF 常失败，所以默认走镜像并支持回退）
 *   3. **还缺什么**（需要什么 − 本地已有的；见 requiredLocalModelIds / inspectLocalModel）
 *
 * 体积数字与校验值来自模型源（生成时取的），**不要手改**；换模型版本时重新生成整份清单。
 * 界面上的"约 XX MB"一律由这里求和得出，不许在 UI 里硬编码。
 */

export interface LocalModelFile {
  /** 目录内的文件名（不含目录） */
  name: string;
  size: number;
  sha256: string;
}

export interface LocalModelSpec {
  /** 内部 id，与插件的 LOCAL_ASR_MODELS 对应（标点用 'punct'） */
  id: string;
  /** 本地目录名：与模型源仓库同名，便于对照排查 */
  dir: string;
  /** 源站上的仓库路径（hf / hf-mirror 的 <owner>/<repo>） */
  repo: string;
  /**
   * 角色：
   *   asr         —— 识别模型，用户可选
   *   punctuation —— 标点模型，**两种识别模型共用同一份**
   */
  role: 'asr' | 'punctuation';
  files: LocalModelFile[];
}

export interface LocalModelSource {
  id: string;
  label: string;
  base: string;
}

/** 标点模型的 id（共享件，选任一识别模型都要它） */
export const PUNCT_MODEL_ID = 'punct';

/**
 * 源站顺序即默认优先级：**国内镜像优先**（README 里就注明 GitHub 的 release 资产在国内常取不到），
 * 失败再回退到官方源。两个源的文件是同一份内容，sha256 相同。
 */
export const LOCAL_MODEL_SOURCES: LocalModelSource[] = [
  { id: 'hf-mirror', label: '国内镜像（hf-mirror）', base: 'https://hf-mirror.com' },
  { id: 'huggingface', label: 'Hugging Face（官方）', base: 'https://huggingface.co' },
];

export const LOCAL_MODEL_SPECS: LocalModelSpec[] = [
  {
    id: 'zh-14M',
    dir: 'sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23',
    role: 'asr',
    files: [
      { name: "tokens.txt", size: 48697, sha256: "8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac" },
      { name: "encoder-epoch-99-avg-1.int8.onnx", size: 21621684, sha256: "1c556ea57cec304e55ec4b72e52c1cc098bb01476ed7d90f3de939fe126487b1" },
      { name: "decoder-epoch-99-avg-1.int8.onnx", size: 1888682, sha256: "22f123bb8cba9b38974b3df18a3f45e7081f4985ebb2e075d9f21f618c468bbf" },
      { name: "joiner-epoch-99-avg-1.int8.onnx", size: 1795562, sha256: "a7cf9d82757bdcf786059454495a9ca95e4bd7347f72473fc08d794475c36169" },
    ],
  },
  {
    id: 'bilingual',
    dir: 'sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    repo: 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20',
    role: 'asr',
    files: [
      { name: "tokens.txt", size: 56317, sha256: "a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3" },
      { name: "encoder-epoch-99-avg-1.int8.onnx", size: 181895032, sha256: "8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b" },
      { name: "decoder-epoch-99-avg-1.int8.onnx", size: 13091040, sha256: "1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa" },
      { name: "joiner-epoch-99-avg-1.int8.onnx", size: 3228404, sha256: "1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0" },
    ],
  },
  {
    id: PUNCT_MODEL_ID,
    dir: 'sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12',
    repo: 'csukuangfj/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12',
    role: 'punctuation',
    files: [
      { name: "model.onnx", size: 294372519, sha256: "e93593a6dbd69a07f8734ef269dbe861a379755f8d1c8354719432116f2c44bd" },
    ],
  },
];

export function getLocalModelSpec(id: string): LocalModelSpec | undefined {
  return LOCAL_MODEL_SPECS.find((spec) => spec.id === id);
}

/** 某个识别模型要跑起来，需要本地具备哪些模型（识别模型本身 + 共享的标点模型） */
export function requiredLocalModelIds(asrModelId: string): string[] {
  const spec = getLocalModelSpec(asrModelId);
  if (!spec || spec.role !== 'asr') return [];
  return spec.id === PUNCT_MODEL_ID ? [spec.id] : [spec.id, PUNCT_MODEL_ID];
}

/** 模型合计体积（"约 XX MB"由这里算，不在界面里写死） */
export function totalSizeOf(id: string): number {
  return (getLocalModelSpec(id)?.files || []).reduce((sum, file) => sum + file.size, 0);
}

/** 一个文件在两个源上的地址（路径结构一致，只有 base 不同） */
export function modelFileUrl(source: LocalModelSource, spec: LocalModelSpec, fileName: string): string {
  return `${source.base}/${spec.repo}/resolve/main/${fileName}`;
}

/**
 * 模型根目录。三种情形，**顺序不能颠倒**：
 *   1. 环境变量覆盖（`HANA_ASR_MODELS_ROOT`）—— 测试/自定义用：指向一个空目录就能完整验证下载流程，
 *      不必碰真模型；也是"用户指定本地模型目录"那个能力的落地形态。
 *   2. 打包后 → 应用数据目录（`{HANA_HOME}/asr-models`）。
 *      **绝不能放在安装目录里**：那里可能只读，而且更新/卸载会把模型一起清掉（用户就白下了）。
 *   3. 开发 → 仓库里的 `tools/asr-sidecar/models`（沿用现状，开发者手上那份模型照旧能用）。
 *
 * ⚠️ 第 2、3 条**必须靠显式标记区分**，不能靠"目录存不存在"来猜：
 * 打包产物里同样有 `tools/asr-sidecar/`（只是没有 models），用"猜"会把模型目录定到只读位置。
 * 标记由桌面主进程注入（`HANA_PACKAGED=1`）。
 */
export function resolveModelsRoot({
  rootDir,
  hanakoHome,
  packaged = false,
  env,
}: {
  rootDir: string;
  hanakoHome?: string | null;
  packaged?: boolean;
  env?: Record<string, string | undefined>;
}): string {
  const override = env?.HANA_ASR_MODELS_ROOT;
  if (override && String(override).trim()) return String(override).trim();
  if (packaged && hanakoHome) return `${hanakoHome}/asr-models`;
  return `${rootDir}/tools/asr-sidecar/models`;
}

export type LocalModelInstallState = 'ready' | 'missing' | 'partial';

/**
 * 判断某个模型在本地的状态。
 *
 * 判据是**逐个文件存在且大小一致**（不做 sha256 —— 那太慢，是下载后的校验手段）。
 * 只要有一个文件缺失或大小不对，就当"没装好"：宁可让用户重下一次，
 * 也不要拿一个残缺目录去起 sidecar（那样报错很难懂）。
 */
export function inspectLocalModel(
  spec: LocalModelSpec,
  modelsRoot: string,
  exists: (path: string) => boolean,
  sizeOf: (path: string) => number,
): { state: LocalModelInstallState; missing: string[]; bytes: number } {
  const missing: string[] = [];
  let bytes = 0;
  for (const file of spec.files) {
    const filePath = `${modelsRoot}/${spec.dir}/${file.name}`;
    if (!exists(filePath) || sizeOf(filePath) !== file.size) missing.push(file.name);
  }
  for (const file of spec.files) {
    if (missing.includes(file.name)) bytes += file.size;
  }
  if (missing.length === 0) return { state: 'ready', missing, bytes: 0 };
  if (missing.length === spec.files.length) return { state: 'missing', missing, bytes };
  return { state: 'partial', missing, bytes };
}
