/**
 * pcm16.ts — 把浏览器采集到的浮点音频转成识别引擎要的 16 位 PCM
 *
 * 识别引擎（sherpa-onnx）只吃 16kHz 单声道 int16。
 * 浏览器麦克风通常是 48kHz，我们用 `new AudioContext({ sampleRate: 16000 })`
 * 让浏览器直接按 16k 采集；但并不是所有平台都认这个参数，所以这里再兜一层
 * 线性插值重采样，保证 48k 进来也能正确送出去。
 *
 * 分块之间要保持连续：重采样不是整数倍，块边界会留下小数位置，
 * 用 `pending` 把它带到下一块，否则每块接缝处会累积漂移。
 */

/** Float32 [-1,1] → int16 LE */
function floatToPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(s * 32767), true);
  }
  return buffer;
}

/**
 * 造一个转换器。返回的函数每喂一块 Float32，就回一块 int16 LE 的 ArrayBuffer
 * （不足以产出一个采样点时返回 null）。
 */
export function createPcm16Converter(inputRate: number, targetRate: number) {
  const ratio = inputRate === targetRate ? 1 : inputRate / targetRate;
  let pending = 0;

  return function convert(input: Float32Array): ArrayBuffer | null {
    if (!input.length) return null;
    if (ratio === 1) return floatToPcm16(input);

    const out: number[] = [];
    let pos = pending;
    while (Math.ceil(pos) < input.length) {
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = input[i0];
      const b = i0 + 1 < input.length ? input[i0 + 1] : a;
      out.push(a + (b - a) * frac);
      pos += ratio;
    }
    pending = pos - input.length;
    if (pending < 0) pending = 0;
    if (out.length === 0) return null;
    return floatToPcm16(Float32Array.from(out));
  };
}
