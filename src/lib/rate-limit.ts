/**
 * 按来源 IP 的滑动窗口限流,防止 6 位配对码被暴力枚举。
 *
 * 背景:配对码是 6 位数字,总共 100 万种,而且**没有任何鉴权** —— 任何知道码的
 * 设备都能读走 offer、覆盖 answer。不限速的话,一个脚本几分钟就能把整个空间扫完。
 * 免安装版侧有对应的实现(shell/WebHost.cs 的 RateLimiter),两边阈值刻意保持一致。
 *
 * 阈值按"正常使用峰值 + 余量"定,别随手调小,否则会误伤平板端的正常轮询:
 *   - 平板轮询 offer:POLL_INTERVAL_MS = 1200ms → 约 50 次/分钟,留到 60
 *   - 电脑端等 answer:同样的节奏
 *   - 创建会话:人一次,10 次/分钟足够
 *
 * 已知局限(有意接受,记录在 README 的安全章节):
 *   - 状态在进程内存里,重启即清零
 *   - 多实例部署时各算各的,不是全局配额
 *   - 按 IP 计数,NAT 后面多人共用一个出口会被一起限
 *   - 挡不住分布式枚举。要根治需要 schema 层记录失败次数(见 src/db/schema.ts)
 */

/** 创建会话:每个 IP 每分钟 10 次 */
const CREATE_LIMIT = 10;

/** 信令读写(GET / PUT /api/session/[code]):每个 IP 每分钟 60 次 */
const SIGNALING_LIMIT = 60;

const WINDOW_MS = 60_000;

/** 清理阈值:计数器数量超过它就顺手扫一遍过期项,防止字典被一次性 IP 撑大 */
const SWEEP_THRESHOLD = 256;

interface Counter {
  hits: number;
  windowStart: number;
}

const globalForLimit = globalThis as unknown as {
  __virtualdeskRateLimit?: Map<string, Counter>;
};

// 挂在 globalThis 上:dev 模式热更新会反复重建模块,挂在模块作用域会丢失计数
const counters = (globalForLimit.__virtualdeskRateLimit ??= new Map<string, Counter>());

/** 取来源 IP。取不到就返回 null —— 此时按"同一个匿名桶"计数,仍然能限住暴力枚举。 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * 判断这次请求是否放行。
 *
 * @param bucket 'create' 对应 POST /api/session,'signal' 对应 GET|PUT /api/session/[code]
 * @returns false 表示应当返回 429
 */
export function allowRequest(ip: string, bucket: 'create' | 'signal'): boolean {
  const limit = bucket === 'create' ? CREATE_LIMIT : SIGNALING_LIMIT;
  const key = `${ip}|${bucket}`;
  const now = Date.now();

  let counter = counters.get(key);
  if (!counter) {
    counter = { hits: 0, windowStart: now };
    counters.set(key, counter);
  }

  if (now - counter.windowStart >= WINDOW_MS) {
    counter.windowStart = now;
    counter.hits = 0;
  }

  if (counter.hits >= limit) return false;
  counter.hits += 1;

  if (counters.size >= SWEEP_THRESHOLD) sweep(now);
  return true;
}

/** 丢掉 10 分钟没有活动的计数器 */
function sweep(now: number): void {
  for (const [key, counter] of counters) {
    if (now - counter.windowStart > WINDOW_MS * 10) counters.delete(key);
  }
}
