-- 信令会话表:电脑端写入 offer,平板端读取后写入 answer
-- 生成方式与 drizzle-kit 一致;也可以直接 `npm run db:push` 让 drizzle-kit 自动同步

CREATE TABLE IF NOT EXISTS "signal_sessions" (
	"code" text PRIMARY KEY NOT NULL,
	"offer" text,
	"answer" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_sessions_created_at_idx" ON "signal_sessions" USING btree ("created_at");
