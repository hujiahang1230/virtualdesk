import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

/**
 * PostgreSQL 连接(懒加载单例)。
 *
 * 只有真正执行查询时才会建立连接,因此 `next build` 期间不会去连数据库。
 * 连接串**只**从环境变量 DATABASE_URL 读取,示例见 .env.example。
 *
 * 刻意不在源码里留默认连接串:仓库是交付物,写死的口令会跟着代码一起分发。
 * 未配置时由 requireDb() / getSql() 抛出明确的错误,而不是悄悄连上一个默认库。
 */
const globalForDb = globalThis as unknown as {
  __virtualdeskSql?: ReturnType<typeof postgres>;
  __virtualdeskDb?: ReturnType<typeof drizzle<typeof schema>>;
};

export function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** 未配置时返回空串 —— 调用方必须先过 hasDatabaseUrl() 或捕获 getSql() 的异常 */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? '';
}

/** 打日志用:把密码换成 *** */
export function maskedDatabaseUrl(): string {
  try {
    const url = new URL(databaseUrl());
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return '(DATABASE_URL 无法解析)';
  }
}

/** 拿到一个 postgres.js 客户端,用于健康检查这类轻量查询 */
export function getSql(): ReturnType<typeof postgres> {
  if (!hasDatabaseUrl()) {
    throw new Error('未配置 DATABASE_URL,无法连接 PostgreSQL。请参考 .env.example。');
  }
  if (!globalForDb.__virtualdeskSql) {
    globalForDb.__virtualdeskSql = postgres(databaseUrl(), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return globalForDb.__virtualdeskSql;
}

/** 拿到带 schema 的 drizzle 实例;调用它不会立刻建立连接。 */
export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!globalForDb.__virtualdeskDb) {
    globalForDb.__virtualdeskDb = drizzle(getSql(), { schema });
  }
  return globalForDb.__virtualdeskDb;
}

export { schema };
