import { NextResponse } from 'next/server';

import {
  cleanupExpiredSessions,
  createUniquePairCode,
  DatabaseUnavailableError,
  insertSession,
} from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/session —— 电脑端创建会话,返回不重复的 6 位配对码 */
export async function POST(request: Request) {
  let offer: string | null = null;

  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && 'offer' in body) {
      const raw = (body as { offer?: unknown }).offer;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'string') {
          return NextResponse.json({ error: 'offer 必须是字符串' }, { status: 400 });
        }
        if (raw.length > 200_000) {
          return NextResponse.json({ error: 'offer 体积超出限制' }, { status: 413 });
        }
        offer = raw;
      }
    }
  } catch {
    // 允许空请求体:此时先建空会话,offer 稍后通过 PUT 写入
    offer = null;
  }

  try {
    // 顺手清理 2 小时前的旧会话
    const removed = await cleanupExpiredSessions();
    const code = await createUniquePairCode();
    await insertSession(code, offer);
    return NextResponse.json({ code, removed }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof DatabaseUnavailableError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  const message = error instanceof Error ? error.message : '未知错误';
  console.error('[api/session] POST 失败:', message);
  return NextResponse.json(
    { error: '创建会话失败,请检查数据库连接(DATABASE_URL)。', detail: message },
    { status: 500 },
  );
}
