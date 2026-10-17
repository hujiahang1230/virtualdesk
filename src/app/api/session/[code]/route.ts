import { NextResponse } from 'next/server';

import { DatabaseUnavailableError, getSession, isValidPairCode, updateSessionSignal } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ code: string }> };

interface PutBody {
  type: 'offer' | 'answer';
  sdp: string;
}

/** GET /api/session/[code] —— 返回该会话的 offer 与 answer,不存在返回 404 */
export async function GET(_request: Request, context: RouteContext) {
  const { code } = await context.params;

  if (!isValidPairCode(code)) {
    return NextResponse.json({ error: '配对码必须是 6 位数字' }, { status: 400 });
  }

  try {
    const session = await getSession(code);
    if (!session) {
      return NextResponse.json({ error: '会话不存在或已过期' }, { status: 404 });
    }
    return NextResponse.json(session);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('[api/session] GET 失败:', message);
    return NextResponse.json(
      { error: '读取会话失败,请检查数据库连接(DATABASE_URL)。', detail: message },
      { status: 500 },
    );
  }
}

const SDP_MAX_LENGTH = 200_000;

/**
 * 校验请求体:{ type: "offer"|"answer", sdp: string }
 *
 * 关于 sdp 字段:客户端提交的是 `JSON.stringify({ type, sdp })`,也就是"编码后的字符串",
 * 服务器原样存取,不做二次编码。这里先把 sdp 解回会话描述再做合法性检查,
 * 同时也容忍直接提交裸 SDP 的写法。
 */
function parseBody(body: unknown): { ok: true; value: PutBody } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: '请求体必须是 JSON 对象' };
  }

  const { type, sdp } = body as { type?: unknown; sdp?: unknown };

  if (type !== 'offer' && type !== 'answer') {
    return { ok: false, error: 'type 必须是 "offer" 或 "answer"' };
  }
  if (typeof sdp !== 'string') {
    return { ok: false, error: 'sdp 必须是字符串' };
  }
  if (sdp.length === 0) {
    return { ok: false, error: 'sdp 不能为空' };
  }
  if (sdp.length > SDP_MAX_LENGTH) {
    return { ok: false, error: 'sdp 体积超出限制(200KB)' };
  }

  // 取出真正的会话描述:优先按 { type, sdp } 解析,失败则当成裸 SDP
  let description = sdp;
  let innerType: unknown = undefined;
  try {
    const parsed: unknown = JSON.parse(sdp);
    if (parsed && typeof parsed === 'object') {
      const candidate = parsed as { type?: unknown; sdp?: unknown };
      if (typeof candidate.sdp === 'string') {
        description = candidate.sdp;
        innerType = candidate.type;
      }
    }
  } catch {
    // 裸 SDP,保持原样
  }

  if (innerType !== undefined && innerType !== type) {
    return { ok: false, error: 'sdp 内部的 type 与请求体的 type 不一致' };
  }

  if (!description.trimStart().startsWith('v=')) {
    return { ok: false, error: 'sdp 不是合法的会话描述(应以 v= 开头)' };
  }
  if (!/(^|\r?\n)m=/.test(description)) {
    return { ok: false, error: 'sdp 缺少 m= 媒体行' };
  }
  if (type === 'answer' && !/(^|\r?\n)a=setup:/.test(description)) {
    return { ok: false, error: 'sdp 不是合法的应答(缺少 a=setup:)' };
  }

  return { ok: true, value: { type, sdp } };
}

/** PUT /api/session/[code] —— 写入 offer 或 answer(写入 offer 时清空旧 answer) */
export async function PUT(request: Request, context: RouteContext) {
  const { code } = await context.params;

  if (!isValidPairCode(code)) {
    return NextResponse.json({ error: '配对码必须是 6 位数字' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  const { type, sdp } = parsed.value;

  try {
    const updated = await updateSessionSignal(code, type, sdp);
    if (!updated) {
      return NextResponse.json({ error: '会话不存在或已过期' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, code, type });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const message = error instanceof Error ? error.message : '未知错误';
    console.error('[api/session] PUT 失败:', message);
    return NextResponse.json(
      { error: '写入信令失败,请检查数据库连接(DATABASE_URL)。', detail: message },
      { status: 500 },
    );
  }
}
