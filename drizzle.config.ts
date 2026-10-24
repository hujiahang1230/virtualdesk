import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置(用于 npm run db:push / db:generate / db:studio)。
 *
 * 连接串只从环境变量 DATABASE_URL 读取。
 *
 * 兜底值**不含任何凭据**,而且只在 db:generate(纯读 schema,不连库)时用得上 ——
 * drizzle-kit 需要一个语法合法的连接串才能启动,但 generate 阶段根本不会去连。
 * 真正会连库的 db:push / db:studio 走 scripts/db-setup.mjs 或用户自己的 DATABASE_URL。
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://127.0.0.1:5432/virtualdesk',
  },
  strict: true,
  verbose: true,
});
