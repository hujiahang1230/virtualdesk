/**
 * 副屏相关的共享目标判定。
 *
 * 抽成独立模块而不是留在组件里,是为了能脱离浏览器直接测试 ——
 * "检测到 2 块屏时是否选错" 这个分支在只有一块物理屏的开发机上永远走不到,
 * 但它恰恰是用户装了虚拟显示驱动之后必然要走的路径,必须有覆盖。
 */

export interface DisplayEntry {
  index: number;
  device: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  likelyVirtual: boolean;
}

export interface DisplayListResponse {
  displays: DisplayEntry[];
  count: number;
  canExtend: boolean;
  recommendedIndex: number | null;
  recommendedSize: string | null;
  /**
   * 为空表示显示器列表是可信的;"browser-unsupported" 表示当前运行时根本查不到
   * 显示器(Web 模式,见 src/app/api/displays/route.ts)。两者必须分开提示,
   * 否则会把"查不到"说成"只检测到 1 块屏"。
   */
  reason?: 'browser-unsupported';
}

/** 对"这一次共享的目标对不对"的判定结果 */
export type ShareTargetCheck = { kind: 'ok' | 'hint' | 'warn'; text: string } | null;

export interface ShareTarget {
  width: number;
  height: number;
  surface: string | null;
}

/**
 * 判断用户共享的是不是"那块该共享的屏"。
 *
 * 背景:副屏场景要求共享**虚拟显示器**。如果共享的是主屏,平板看到的就是镜像,
 * 但画面完全正常,用户几乎不可能自己发现。浏览器不告诉我们"共享了哪一块",
 * 只给分辨率和 displaySurface,所以这里只能用分辨率做启发式判断。
 *
 * 已知局限:若虚拟屏与主屏分辨率完全相同,仅凭分辨率无法区分 —— 这种情况返回
 * 一条"软提示"而不是断言,避免误报。
 */
export function checkShareTarget(
  picked: ShareTarget,
  list: DisplayListResponse | null,
): ShareTargetCheck {
  if (!list || list.displays.length === 0) return null;

  const sizeText = `${picked.width}×${picked.height}`;

  // 共享的是窗口/标签页 —— 这在副屏场景下是明确错误
  if (picked.surface === 'window' || picked.surface === 'browser') {
    const what = picked.surface === 'browser' ? '浏览器标签页' : '窗口';
    return {
      kind: 'warn',
      text: `你共享的是一个${what},不是整块屏幕。` +
        '副屏需要共享「整块屏幕」,否则桌面不会扩展过去。请停止后重新共享。',
    };
  }

  // 只有一块屏 → 只能是镜像
  if (list.displays.length === 1) {
    return {
      kind: 'warn',
      text: '系统里只检测到 1 块屏幕,所以平板看到的是镜像,不是扩展屏。' +
        '要真正扩展桌面,需要先装一个虚拟显示驱动(步骤见 README)。',
    };
  }

  const primary = list.displays.find((d) => d.primary);
  const others = list.displays.filter((d) => !d.primary);

  const matchesPrimary = Boolean(
    primary && primary.width === picked.width && primary.height === picked.height,
  );
  const matchedOther = others.find(
    (d) => d.width === picked.width && d.height === picked.height,
  );

  // 明确匹配到非主屏 → 正确
  if (matchedOther && !matchesPrimary) {
    return {
      kind: 'ok',
      text: `已共享扩展屏(${sizeText}),平板看到的应该是扩展桌面而不是镜像。`,
    };
  }

  // 只匹配主屏 → 选错了
  if (matchesPrimary && !matchedOther) {
    return {
      kind: 'warn',
      text: `你共享的是主屏(${sizeText}),平板看到的会是镜像。` +
        `请停止后重新共享,并在选择器里挑那块 ${list.recommendedSize ?? '扩展'} 的屏幕。`,
    };
  }

  // 主屏与扩展屏分辨率相同 → 无法区分
  if (matchesPrimary && matchedOther) {
    return {
      kind: 'hint',
      text: `主屏和扩展屏都是 ${sizeText},无法自动判断你选了哪一块。` +
        '如果平板显示的是主屏(镜像)而不是扩展桌面,请重新共享并点另一块。',
    };
  }

  // 分辨率对不上任何一块(窗口、缩放、或浏览器做了调整)
  return {
    kind: 'hint',
    text: `你共享的画面是 ${sizeText},和检测到的显示器分辨率都不完全一致(可能是窗口或缩放导致)。` +
      '如果平板看到的是镜像而不是扩展桌面,请重新共享并选择整块屏幕。',
  };
}
