/**
 * 后端接口地址解析。
 *
 * 这个页面有两套运行方式,接口路径需要分别处理:
 *
 * 1. Next 服务托管(npm run dev / next start)
 *    接口就是同源下的 /api/*,直接用相对路径即可。
 *
 * 2. C# 宿主托管(单文件 exe)
 *    页面是静态导出的,没有 Next 路由,接口由 C# 侧提供,并且挂在一个随机端口上
 *    (不能占用 80,否则和用户机器上的其他服务打架)。
 *    宿主会在返回 HTML 时注入 window.__VIRTUALDESK_API_BASE__,这里优先用它。
 *
 * 探测顺序刻意不依赖端口号:用户完全可能恰好用 38471 跑开发服务,
 * 那样按端口判断就会误判。
 */

const API_BASE_FLAG = '__VIRTUALDESK_API_BASE__';
const HOST_FLAG = '__VIRTUALDESK_HOST__';

function readInjectedBase(): string | null {
  if (typeof window === 'undefined') return null;
  const injected = (window as unknown as Record<string, unknown>)[API_BASE_FLAG];
  return typeof injected === 'string' && injected.length > 0 ? injected : null;
}

/** 是否由 C# 宿主托管 */
export function isHostedByApp(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as Record<string, unknown>)[HOST_FLAG] === 'desktop';
}

/**
 * 把接口路径解析成可请求的地址。
 * @param path 以 /api 开头的路径,例如 /api/session/123456
 */
export function apiUrl(path: string): string {
  const base = readInjectedBase();
  if (base) return base.replace(/\/$/, '') + path;
  // 同源托管:相对路径交给浏览器
  return path;
}

/** 带接口地址解析的 fetch */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), init);
}
