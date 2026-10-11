import { describe, expect, it } from 'vitest';

/**
 * asr-sidecar 的 WS 来源校验 isAllowedOrigin。
 *
 * 为什么单独测它：这个函数守的是"任意网页能否连上本机识别服务"这条安全边界，
 * 而它住在 tools/asr-sidecar/server.mjs（既是可直接运行的服务入口、也给本测试引用）。
 * 这里不拉起 sidecar 进程，只引用那个纯函数。
 *
 * server.mjs 顶层会 `require('sherpa-onnx-node')`（原生模块）。没装 sidecar 依赖的
 * 环境（CI 上很常见）加载会失败 —— 用动态 import + try/catch 兜住，拿不到函数就整体
 * 跳过，与同目录其它 sidecar 测试"缺依赖即跳过"的策略一致，不让 CI 变红。
 */
let isAllowedOrigin: ((origin: string | null | undefined) => boolean) | null = null;
try {
  ({ isAllowedOrigin } = await import('../tools/asr-sidecar/server.mjs'));
} catch {
  isAllowedOrigin = null;
}

const allow = (origin: string | null | undefined) => isAllowedOrigin!(origin);

describe.skipIf(!isAllowedOrigin)('asr-sidecar isAllowedOrigin（WS 来源校验）', () => {
  it('file:// 放行：精确形态和带路径的本地文档起源都认', () => {
    expect(allow('file://')).toBe(true);
    expect(allow('file:///')).toBe(true);
    expect(allow('file:///D:/app/index.html')).toBe(true);
  });

  it('null（字符串 "null"）放行', () => {
    expect(allow('null')).toBe(true);
  });

  it('本机 web 起源（开发前端）放行', () => {
    expect(allow('http://localhost:5173')).toBe(true);
    expect(allow('http://127.0.0.1:5173')).toBe(true);
  });

  it('没有 Origin 头放行（浏览器发起一定带 Origin，缺这个头只可能是本机 node 客户端）', () => {
    expect(allow(undefined)).toBe(true);
    expect(allow(null)).toBe(true);
    expect(allow('')).toBe(true);
  });

  it('其余来源一律拒绝', () => {
    expect(allow('http://evil.example')).toBe(false);
    expect(allow('https://evil.example')).toBe(false);
    // 关键：不能用"包含 localhost 字样"误放行 —— 必须是 loopback 主机本身。
    expect(allow('http://localhost.evil.example')).toBe(false);
  });
});
