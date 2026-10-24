import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/displays —— 显示器列表
 *
 * 枚举显示器必须走操作系统 API(便携版宿主用 EnumDisplayMonitors / EnumDisplayDevices),
 * 浏览器出于安全限制不提供任何等价能力,所以 Web 模式永远拿不到列表。
 *
 * 这里返回**结构合法但语义明确**的空列表,而不是 404,是为了让前端能区分三件事:
 *   - 只有一块物理屏        → displays.length === 1
 *   - 我查不到显示器(本文件) → displays.length === 0 && reason === 'browser-unsupported'
 *   - 宿主太老,没这个接口   → 请求失败,前端按"未知"处理
 *
 * 少了这个 reason,开发模式下会把"查不到"误报成"只检测到 1 块屏幕 · 当前只能镜像"。
 *
 * 副屏引导、采集后核对等依赖显示器列表的逻辑请见 src/lib/share-target.ts。
 */
export async function GET() {
  return NextResponse.json({
    displays: [],
    count: 0,
    canExtend: false,
    recommendedIndex: null,
    recommendedSize: null,
    reason: 'browser-unsupported',
  });
}
