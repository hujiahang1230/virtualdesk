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
    const detail = error instanceof Error ? error.message : '未知错误';
    return NextResponse.json(
      {
        ...base,
        status: 'degraded',
        database: { configured: true, reachable: false, target: maskedDatabaseUrl() },
        detail,
      },
      { status: 503 },
    );
  }
}
