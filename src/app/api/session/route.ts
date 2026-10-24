import { NextResponse } from 'next/server';

import {
  cleanupExpiredSessions,
  createUniquePairCode,
  DatabaseUnavailableError,
  insertSession,
  SDP_MAX_LENGTH,
} from '@/lib/session';
import { allowRequest, clientIp } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/session —— 电脑端创建会话,返回不重复的 6 位配对码 */
export async function POST(request: Request) {
  // 创建会话会消耗配对码空间(总共只有 100 万种),必须限速,
  // 否则同一网络里的任何设备都能用脚本批量建会话/穷举。
  if (!allowRequest(clientIp(request), 'create')) {
    return NextResponse.json(
      { error: '创建会话过于频繁,请稍后再试。' },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }

  let offer: string | null = null;

  try {
    const body: unknown = await request.json();
    if (body && typeof body === 'object' && 'offer' in body) {
      const raw = (body as { offer?: unknown }).offer;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'string') {
          return NextResponse.json({ error: 'offer 必须是字符串' }, { status: 400 });
        }
        if (raw.length > SDP_MAX_LENGTH) {
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
    return errorResponse(error, 'POST');
  }
}

/**
 * 统一的错误响应。
 *
 * 刻意**不**把驱动的原始错误回给客户端:postgres.js 的 error.message 里通常含
 * host / port / dbname / user,而 /api/health 这类接口没有鉴权。完整错误写服务端日志,
 * 客户端只拿到固定文案 + 一个 requestId,用户报障时凭 id 就能定位到具体那一行。
 */
function errorResponse(error: unknown, method: string): NextResponse {
  if (error instanceof DatabaseUnavailableError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }

  const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  console.error(`[api/session] ${method} 失败 [${requestId}]:`, error);

  return NextResponse.json(
    { error: '信令服务暂时不可用,请稍后重试。', requestId },
    { status: 500 },
  );
}
