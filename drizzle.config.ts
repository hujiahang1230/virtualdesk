import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit 配置(用于 npm run db:push / db:generate / db:studio)。
 * 连接串从环境变量 DATABASE_URL 读取,默认值仅用于本地开发。
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/virtualdesk',
  },
  strict: true,
  verbose: true,
});
