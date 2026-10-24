import { eq, lt } from 'drizzle-orm';

import { getDb, hasDatabaseUrl } from '@/db';
import { signalSessions } from '@/db/schema';
import { PAIR_CODE_LENGTH, SESSION_TTL_MS } from '@/lib/rtc';

/** 配对码字符集:纯数字,避免平板上输入歧义 */
const CODE_ALPHABET = '0123456789';

/**
 * 单个会话描述(SDP)的大小上限。
 *
 * 之前这个数字在 session/route.ts 与 session/[code]/route.ts 各写了一份,
 * 免安装版那边还有第三份(WebHost.cs 的 SdpMaxLength)。三处一旦漂移,
 * 就会出现"Web 模式收下了、便携版拒收"这种只在换运行时才暴露的问题。
 */
export const SDP_MAX_LENGTH = 200_000;

/** 数据库不可用 / 未配置连接串时抛出,由路由转换成 503 */
export class DatabaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export interface SessionSnapshot {
  code: string;
  offer: string | null;
  answer: string | null;
  createdAt: string;
}

export function isValidPairCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === PAIR_CODE_LENGTH &&
    /^\d+$/.test(value)
  );
}

export function generatePairCode(): string {
  let code = '';
  const bytes = new Uint8Array(PAIR_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function requireDb() {
  if (!hasDatabaseUrl()) {
    throw new DatabaseUnavailableError('未配置 DATABASE_URL,无法访问 PostgreSQL。');
  }
  return getDb();
}

/** 清理 2 小时前的旧会话,返回删除条数 */
export async function cleanupExpiredSessions(): Promise<number> {
  const db = requireDb();
  const cutoff = new Date(Date.now() - SESSION_TTL_MS);
  const deleted = await db
    .delete(signalSessions)
    .where(lt(signalSessions.createdAt, cutoff))
    .returning({ code: signalSessions.code });
  return deleted.length;
}

/** 生成一个当前库中不存在的 6 位配对码 */
export async function createUniquePairCode(maxAttempts = 12): Promise<string> {
  const db = requireDb();
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generatePairCode();
    const existing = await db
      .select({ code: signalSessions.code })
      .from(signalSessions)
      .where(eq(signalSessions.code, code))
      .limit(1);
    if (existing.length === 0) return code;
  }
  throw new Error('生成配对码失败:短时间内冲突过多,请重试。');
}

export async function insertSession(code: string, offer: string | null): Promise<void> {
  const db = requireDb();
  await db.insert(signalSessions).values({ code, offer });
}

export async function getSession(code: string): Promise<SessionSnapshot | null> {
  const db = requireDb();
  const rows = await db
    .select({
      code: signalSessions.code,
      offer: signalSessions.offer,
      answer: signalSessions.answer,
      createdAt: signalSessions.createdAt,
    })
    .from(signalSessions)
    .where(eq(signalSessions.code, code))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    code: row.code,
    offer: row.offer,
    answer: row.answer,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 写入 offer 或 answer。
 * 写入 offer 时清空旧的 answer,避免平板端拿到上一轮的过期应答。
 */
export async function updateSessionSignal(
  code: string,
  type: 'offer' | 'answer',
  sdp: string,
): Promise<boolean> {
  const db = requireDb();
  const updated = await db
    .update(signalSessions)
    .set(
      type === 'offer'
        ? { offer: sdp, answer: null }
        : { answer: sdp },
    )
    .where(eq(signalSessions.code, code))
    .returning({ code: signalSessions.code });
  return updated.length > 0;
}
