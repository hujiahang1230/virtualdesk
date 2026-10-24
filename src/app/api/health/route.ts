import { NextResponse } from 'next/server';

import { getSql, hasDatabaseUrl, maskedDatabaseUrl } from '@/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/health —— 存活探测;顺便检查 PostgreSQL 是否可用 */
export async function GET() {
  const startedAt = Date.now();
  const base = {
    status: 'ok' as 'ok' | 'degraded',
    service: 'virtualdesk',
    time: new Date().toISOString(),
  };

  if (!hasDatabaseUrl()) {
    return NextResponse.json(
      {
        ...base,
        status: 'degraded',
        database: { configured: false, reachable: false, target: null },
        hint: '未配置 DATABASE_URL,信令接口将返回 503。请参考 .env.example 配置 PostgreSQL 连接串。',
      },
      { status: 200 },
    );
  }

  try {
    await getSql()`select 1`;
    return NextResponse.json({
      ...base,
      database: {
        configured: true,
        reachable: true,
        target: maskedDatabaseUrl(),
        checkedInMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    // 刻意**不**把原始错误回给客户端:postgres.js 的 error.message 里含
    // host / port / dbname / user,而这个接口没有任何鉴权、局域网里可直接访问。
    // 完整错误写服务端日志,客户端拿 requestId,报障时凭它定位。
    const requestId = `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    console.error(`[api/health] 数据库探测失败 [${requestId}]:`, error);

    return NextResponse.json(
      {
        ...base,
        status: 'degraded',
        database: { configured: true, reachable: false, target: maskedDatabaseUrl() },
        hint: '数据库不可达,请确认 PostgreSQL 已启动且 DATABASE_URL 正确。',
        requestId,
      },
      { status: 503 },
    );
  }
}
