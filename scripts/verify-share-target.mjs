/**
 * 共享目标判定的单元测试。
 *
 * 为什么需要它:开发机只有一块物理屏,`canExtend=true` 的分支在浏览器里永远走不到,
 * 但那正是用户装了虚拟显示驱动之后唯一会走的路径。这里用构造数据把每个分支都覆盖。
 *
 * 用法:node scripts/verify-share-target.mjs
 */
import { checkShareTarget } from '../src/lib/share-target.ts';

let passed = 0;
let failed = 0;

function test(name, actual, expectedKind, mustContain = []) {
  const kindOk = actual?.kind === expectedKind;
  const textOk = mustContain.every((s) => (actual?.text ?? '').includes(s));
  const ok = kindOk && textOk;
  if (ok) {
    passed += 1;
    console.log(`✓ ${name}`);
  } else {
    failed += 1;
    console.log(`✗ ${name}`);
    console.log(`    期望 kind=${expectedKind},实际 ${actual?.kind ?? '(null)'}`);
    if (!textOk) console.log(`    文案缺少:${mustContain.join(' / ')}`);
    console.log(`    实际文案:${actual?.text ?? '(null)'}`);
  }
}

const mk = (width, height, primary, likelyVirtual = false, index = 0) => ({
  index,
  device: `\\\\.\\DISPLAY${index + 1}`,
  description: likelyVirtual ? 'Virtual Display' : 'Generic PnP Monitor',
  x: 0,
  y: 0,
  width,
  height,
  primary,
  likelyVirtual,
});

const single = {
  displays: [mk(1920, 1080, true)],
  count: 1,
  canExtend: false,
  recommendedIndex: null,
  recommendedSize: null,
};

const dual = {
  displays: [mk(1920, 1080, true), mk(1200, 1920, false, true, 1)],
  count: 2,
  canExtend: true,
  recommendedIndex: 1,
  recommendedSize: '1200×1920',
};

const dualSameSize = {
  displays: [mk(1920, 1080, true), mk(1920, 1080, false, true, 1)],
  count: 2,
  canExtend: true,
  recommendedIndex: 1,
  recommendedSize: '1920×1080',
};

// ---------- 单屏:只能是镜像 ----------
test('只有 1 块屏时提示是镜像',
  checkShareTarget({ width: 1920, height: 1080, surface: 'monitor' }, single),
  'warn', ['1 块屏幕', '镜像']);

// ---------- 双屏:选对了 ----------
test('共享了扩展屏 → 判定为正确',
  checkShareTarget({ width: 1200, height: 1920, surface: 'monitor' }, dual),
  'ok', ['已共享扩展屏', '1200×1920']);

// ---------- 双屏:选错了(共享主屏)----------
test('共享了主屏 → 警告是镜像',
  checkShareTarget({ width: 1920, height: 1080, surface: 'monitor' }, dual),
  'warn', ['主屏', '镜像', '1200×1920']);

// ---------- 双屏但分辨率相同:不能断言 ----------
test('主屏与扩展屏同分辨率 → 只给软提示',
  checkShareTarget({ width: 1920, height: 1080, surface: 'monitor' }, dualSameSize),
  'hint', ['无法自动判断']);

// ---------- 共享了窗口 ----------
test('共享窗口 → 警告不是整块屏',
  checkShareTarget({ width: 800, height: 600, surface: 'window' }, dual),
  'warn', ['窗口', '整块屏幕']);

test('共享标签页 → 警告不是整块屏',
  checkShareTarget({ width: 1280, height: 720, surface: 'browser' }, dual),
  'warn', ['浏览器标签页']);

// ---------- 分辨率对不上任何一块 ----------
test('分辨率与所有显示器都不符 → 软提示',
  checkShareTarget({ width: 1000, height: 700, surface: 'monitor' }, dual),
  'hint', ['都不完全一致']);

// ---------- 拿不到显示器信息:不判断 ----------
test('没有显示器数据 → 不产生结论',
  checkShareTarget({ width: 1920, height: 1080, surface: 'monitor' }, null),
  undefined);

test('显示器列表为空 → 不产生结论',
  checkShareTarget({ width: 1920, height: 1080, surface: 'monitor' }, {
    displays: [], count: 0, canExtend: false, recommendedIndex: null, recommendedSize: null,
  }),
  undefined);

// ---------- 横屏副屏也对 ----------
test('横屏扩展屏(1920×1200)也能正确识别',
  checkShareTarget({ width: 1920, height: 1200, surface: 'monitor' }, {
    displays: [mk(1920, 1080, true), mk(1920, 1200, false, true, 1)],
    count: 2,
    canExtend: true,
    recommendedIndex: 1,
    recommendedSize: '1920×1200',
  }),
  'ok', ['1920×1200']);

console.log(`\n结果:${passed}/${passed + failed} 通过`);
process.exit(failed === 0 ? 0 : 1);
