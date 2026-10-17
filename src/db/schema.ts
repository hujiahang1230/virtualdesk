import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * WebRTC 信令会话表。
 *
 * 服务器只负责在电脑端(/host)与平板端(/view)之间中转一次 SDP 交换:
 * 电脑端写入 offer,平板端读取 offer 后写入 answer,电脑端再读取 answer。
 * 音视频数据完全不经过服务器,走 P2P(见 src/lib/rtc.ts)。
 */
export const signalSessions = pgTable(
  'signal_sessions',
  {
    /** 6 位数字配对码,形如 "042317" */
    code: text('code').primaryKey(),
    /** 电脑端生成的 SessionDescription(JSON 字符串) */
    offer: text('offer'),
    /** 平板端生成的 SessionDescription(JSON 字符串) */
    answer: text('answer'),
    /** 会话创建时间,用于清理 2 小时前的旧会话 */
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('signal_sessions_created_at_idx').on(table.createdAt)],
);

export type SignalSession = typeof signalSessions.$inferSelect;
export type NewSignalSession = typeof signalSessions.$inferInsert;
