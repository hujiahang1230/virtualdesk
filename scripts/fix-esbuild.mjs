/**
 * esbuild 的安装脚本(postinstall)在部分受限环境(例如沙箱里禁止子进程管道)会失败,
 * 导致 esbuild/bin/esbuild.exe 缺失,drizzle-kit 无法运行。
 *
 * 这个脚本把已安装的 @esbuild/<platform>-<arch> 包里的可执行文件补到 esbuild/bin/ 下,
 * 幂等:已经存在就跳过;正常环境下它什么都不做。
 *
 * 用法:node scripts/fix-esbuild.mjs [项目根目录]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(process.argv[2] ?? join(here, '..'));

const platformPkgName = `@esbuild/${process.platform}-${process.arch}`;
const exeName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';

function readVersion(pkgJsonPath) {
  try {
    const match = readFileSync(pkgJsonPath, 'utf8').match(/"version"\s*:\s*"([^"]+)"/);
    return match ? match[1] : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 在 node_modules 树里找出所有已安装的 esbuild 包 */
function findEsbuildPackages(root, depth = 0, found = []) {
  if (depth > 6 || !existsSync(root)) return found;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = join(root, entry.name);

    if (entry.name === 'esbuild' && existsSync(join(full, 'bin'))) {
      const pkgJson = join(full, 'package.json');
      if (existsSync(pkgJson)) found.push({ dir: full, version: readVersion(pkgJson) });
      continue;
    }

    if (entry.name === 'node_modules' || entry.name === '.pnpm' || entry.name.startsWith('@')) {
      findEsbuildPackages(full, depth + 1, found);
    }
  }

  return found;
}

/** 在平台包里找出可执行文件 */
function findBinary(root, depth = 0) {
  if (depth > 8 || !existsSync(root)) return null;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const nested = findBinary(full, depth + 1);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === exeName) {
      return full;
    }
  }
  return null;
}

const esbuildPackages = findEsbuildPackages(projectRoot);
if (esbuildPackages.length === 0) {
  console.log('[fix-esbuild] 没有找到 esbuild,跳过。');
  process.exit(0);
}

const platformRoot = join(projectRoot, 'node_modules', ...platformPkgName.split('/'));
const candidates = [
  existsSync(platformRoot) ? platformRoot : null,
  join(projectRoot, 'node_modules'),
  join(projectRoot, 'node_modules', '.pnpm'),
].filter(Boolean);

let copied = 0;
for (const pkg of esbuildPackages) {
  const target = join(pkg.dir, 'bin', exeName);
  if (existsSync(target)) continue;

  let source = null;
  for (const candidate of candidates) {
    source = findBinary(candidate);
    if (source) break;
  }

  if (!source) {
    console.log(`[fix-esbuild] 未找到 ${platformPkgName} 的可执行文件,跳过 esbuild@${pkg.version}`);
    continue;
  }

  mkdirSync(join(pkg.dir, 'bin'), { recursive: true });
  copyFileSync(source, target);
  console.log(`[fix-esbuild] 补齐 esbuild@${pkg.version} -> ${target}`);
  copied += 1;
}

console.log(`[fix-esbuild] 完成(copied=${copied}, found=${esbuildPackages.length})`);
