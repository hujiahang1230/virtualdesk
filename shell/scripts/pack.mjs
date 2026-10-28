/**
 * 打包单文件免安装 exe。
 *
 * 为什么是两个 exe 组装成一个:
 *   .NET 单文件发布在"含原生库"或"启用压缩"时,启动瞬间必须把内容解压到磁盘,
 *   默认目标是 %TEMP%\.net\<应用名>。受控环境里 %TEMP% 可能连目录都建不出来:
 *     Failure processing application bundle.
 *     Failed to create directory [...\Temp\.net\...] Error code: 5
 *   这段解压发生在托管代码之前,所以只能在更早的地方指定目录 ——
 *   也就是一个原生启动器(先设 DOTNET_BUNDLE_EXTRACT_BASE_DIR,再拉起内部 exe)。
 *
 * 流程:
 *   1. 生成前端嵌入包 shell/web.zip
 *   2. dotnet publish 自包含单文件 → virtualdesk-core.exe
 *   3. 编译原生启动器(MinGW g++)→ virtualdesk.exe
 *   4. 校验产物:只有这两个文件,体积在预期范围内
 *
 * 用法:
 *   node shell/scripts/pack.mjs            # 完整流程
 *   node shell/scripts/pack.mjs --no-web   # 跳过前端重建(前端没改时省时间)
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(here, '..');
const projectRoot = resolve(shellDir, '..');
const distDir = join(shellDir, 'dist');
const zipPath = join(shellDir, 'web.zip');
const launcherDir = join(shellDir, 'launcher');
const skipWeb = process.argv.includes('--no-web');

const CORE_NAME = 'virtualdesk-core.exe';
const ENTRY_NAME = 'virtualdesk.exe';

/** MinGW g++ 候选位置 */
const GXX_CANDIDATES = [
  process.env.VD_GXX,
  'F:\\Mingw\\mingw64\\bin\\g++.exe',
  'C:\\mingw64\\bin\\g++.exe',
  'g++',
].filter(Boolean);

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MiB';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: true, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} 失败,退出码 ${result.status}`);
  }
}

function findGxx() {
  for (const candidate of GXX_CANDIDATES) {
    if (candidate === 'g++') continue;
    if (existsSync(candidate)) return candidate;
  }
  // 交给 PATH
  const probe = spawnSync('g++', ['--version'], { encoding: 'utf8', shell: true });
  if (probe.status === 0) return 'g++';
  throw new Error('找不到可用的 g++。请设置 VD_GXX 指向 MinGW 的 g++.exe。');
}

// 1) 前端嵌入包
if (skipWeb) {
  if (!existsSync(zipPath)) throw new Error('没有现成的 web.zip,不能跳过前端构建');
  console.log('[pack] 跳过前端构建,复用 ' + zipPath);
} else {
  console.log('[pack] 构建前端嵌入包…');
  run('node', [join(shellDir, 'scripts', 'build-web.mjs')], { cwd: projectRoot });
}
if (!existsSync(zipPath)) throw new Error('缺少 web.zip:' + zipPath);
console.log(`[pack] 嵌入包 ${mb(statSync(zipPath).size)}`);

// 1.5) 平板端 APK(嵌入进 exe,让程序能自己把 App 装到平板上)
//
// 只在 APK 缺失、或 Java 源码比 APK 新时才重建 —— 构建 APK 需要
// .android-build 里的工具链(用 tools/fetch-android-toolchain.mjs 获取)。
const apkPath = join(projectRoot, 'tools', 'apk', 'virtualdesk-viewer.apk');
const javaSource = join(projectRoot, 'android', 'app', 'src', 'main', 'java',
  'com', 'virtualdesk', 'viewer', 'MainActivity.java');
const manifestSource = join(projectRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

function apkNeedsBuild() {
  if (!existsSync(apkPath)) return true;
  const apkTime = statSync(apkPath).mtimeMs;
  for (const source of [javaSource, manifestSource]) {
    if (existsSync(source) && statSync(source).mtimeMs > apkTime) return true;
  }
  return false;
}

if (apkNeedsBuild()) {
  const toolchain = join(projectRoot, '.android-build', 'sdk', 'build-tools', '34.0.0', 'aapt2.exe');
  if (!existsSync(toolchain)) {
    console.warn('[pack] ⚠ 缺少 Android 工具链,跳过 APK 构建。');
    console.warn('       先运行:node --use-system-ca tools/fetch-android-toolchain.mjs');
    console.warn('       当前 exe 将不包含平板 App,需要手动装 APK。');
  } else {
    console.log('[pack] 构建平板端 APK…');
    run('node', [join(projectRoot, 'tools', 'build-apk.mjs')], { cwd: projectRoot });
  }
} else {
  console.log('[pack] 复用现有 APK:' + apkPath);
}
if (existsSync(apkPath)) console.log(`[pack] 平板 APK ${(statSync(apkPath).size / 1024).toFixed(1)} KiB`);

// 2) 自包含单文件发布
//
// 清理 dist 时逐项删:如果上一轮留下的数据目录被系统/杀软锁住,
// 直接 rmSync 整个目录会 EPERM,进而把整个打包流程卡死。
// 这里改成"能删就删,删不掉就跳过",让 publish 去覆盖文件。
console.log('[pack] 发布内部程序(自包含单文件)…');
mkdirSync(distDir, { recursive: true });
for (const entry of readdirSync(distDir, { withFileTypes: true })) {
  const target = join(distDir, entry.name);
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[pack] ⚠ 无法清理 ${entry.name}(${error.code ?? 'unknown'}),继续打包`);
  }
}

run(
  'dotnet',
  ['publish', join(shellDir, 'VirtualDesk.Shell.csproj'), '-c', 'Release', '-o', distDir, '--nologo'],
  { cwd: shellDir },
);

const corePath = join(distDir, CORE_NAME);
if (!existsSync(corePath)) {
  throw new Error(`发布产物里没有 ${CORE_NAME},实际内容:` +
    readdirSync(distDir).join(', '));
}
console.log(`[pack] 内部程序 ${mb(statSync(corePath).size)}`);

// 3) 编译原生启动器
console.log('[pack] 编译原生启动器…');
const gxx = findGxx();
console.log('[pack] 使用编译器:' + gxx);
run(gxx, [
  '-std=c++20', '-O2', '-municode', '-mwindows',
  '-static', '-static-libgcc', '-static-libstdc++',
  '-o', join(launcherDir, 'launcher.exe'),
  join(launcherDir, 'launcher.cpp'),
  '-lole32', '-lshell32', '-luser32', '-ladvapi32',
]);

const builtLauncher = join(launcherDir, 'launcher.exe');
if (!existsSync(builtLauncher)) throw new Error('启动器编译失败');

const entryPath = join(distDir, ENTRY_NAME);
copyFileSync(builtLauncher, entryPath);
console.log(`[pack] 启动器 ${mb(statSync(entryPath).size)}`);

// 4) 校验
const files = readdirSync(distDir, { withFileTypes: true }).filter((e) => e.isFile());
const names = files.map((f) => f.name).sort();
console.log('\n[pack] 产物:');
for (const name of names) {
  console.log(`  ${name}  ${mb(statSync(join(distDir, name)).size)}`);
}

const expected = [CORE_NAME, ENTRY_NAME].sort();
const unexpected = names.filter((n) => !expected.includes(n));
if (unexpected.length > 0) {
  console.warn('[pack] ⚠ 出现了预期之外的文件: ' + unexpected.join(', '));
}

const total = files.reduce((sum, f) => sum + statSync(join(distDir, f.name)).size, 0);
console.log(`\n[pack] 合计 ${mb(total)}`);

if (total > 140 * 1024 * 1024) {
  throw new Error(`产物体积异常(${mb(total)}),请检查单文件与压缩配置。`);
}
if (total < 5 * 1024 * 1024) {
  throw new Error(`产物体积异常偏小(${mb(total)}),可能没有自包含运行时。`);
}

console.log('[pack] 完成。把 dist 整个目录拷走,双击「' + ENTRY_NAME + '」即可运行。');
console.log('[pack] 不需要 Node / PostgreSQL / .NET 运行时。');
