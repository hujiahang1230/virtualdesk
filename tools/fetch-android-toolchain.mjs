/**
 * 把 Android 构建工具链取到项目目录(.android-build/)。
 *
 * 背景:本机只有 JRE 1.8(没有 javac),也没有 Android SDK,而 Gradle 官方源
 * (services.gradle.org)在本机网络下不可达。所以不走 Gradle,改用
 * 「现成 JDK + Android build-tools + 手工调用 aapt2/d8/apksigner」这条路。
 *
 * JDK 复用机器上 JetBrains IDE 自带的 JBR(含完整 javac),省掉 178MB 下载;
 * 其余包从腾讯云镜像取 —— dl.google.com 在本机会在大文件传输时被重置。
 *
 * 用法:
 *   node --use-system-ca tools/fetch-android-toolchain.mjs
 *
 * 必须带 --use-system-ca:本机对镜像站的证书链依赖 Windows 根证书库。
 *
 * 产出的目录布局(与官方 SDK 一致,便于手工调用工具):
 *   .android-build/sdk/platform-tools/      adb.exe
 *   .android-build/sdk/build-tools/34.0.0/  aapt2.exe / d8.bat / apksigner.bat
 *   .android-build/sdk/platforms/android-34/android.jar
 */

import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { inflateRawSync } from 'node:zlib';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(projectRoot, '.android-build');
const downloads = join(base, 'downloads');
const sdk = join(base, 'sdk');

const MIRROR = 'https://mirrors.cloud.tencent.com/AndroidSDK/';

const PACKAGES = [
  { name: 'commandlinetools', file: 'commandlinetools-win-11076708_latest.zip', min: 50_000_000 },
  { name: 'platform-tools', file: 'platform-tools_r34.0.5-windows.zip', min: 2_000_000 },
  { name: 'build-tools', file: 'build-tools_r34-windows.zip', min: 30_000_000 },
  { name: 'platform-34', file: 'platform-34-ext7_r03.zip', min: 20_000_000 },
];

mkdirSync(downloads, { recursive: true });
mkdirSync(sdk, { recursive: true });

// ------------------------------------------------------------------ 下载

function download(url, dest, minBytes, attempt = 1, depth = 0) {
  return new Promise((resolve) => {
    if (existsSync(dest) && statSync(dest).size >= minBytes) {
      console.log(`  已存在,跳过 (${(statSync(dest).size / 1048576).toFixed(1)} MiB)`);
      return resolve(true);
    }
    if (depth > 6) return resolve(false);

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return resolve(false);
    }

    const request = https.request(
      {
        host: parsed.host,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'virtualdesk-toolchain' },
        timeout: 120_000,
      },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          const next = response.headers.location.startsWith('http')
            ? response.headers.location
            : 'https://' + parsed.host + response.headers.location;
          return download(next, dest, minBytes, attempt, depth + 1).then(resolve);
        }
        if (response.statusCode !== 200) {
          response.resume();
          console.error(`  HTTP ${response.statusCode}`);
          return resolve(false);
        }

        let received = 0;
        let lastPercent = -1;
        const file = createWriteStream(dest);
        response.on('data', (chunk) => {
          received += chunk.length;
          const percent = Math.floor(received / minBytes * 100);
          if (percent >= lastPercent + 25) {
            lastPercent = percent;
            console.log(`    ${(received / 1048576).toFixed(1)} MiB`);
          }
        });
        response.pipe(file);

        file.on('finish', () => {
          file.close();
          if (received < minBytes) {
            console.error(`  文件过小(${received} 字节),可能被截断`);
            rmSync(dest, { force: true });
            return resolve(attempt < 3 ? retry(url, dest, minBytes, attempt) : false);
          }
          console.log(`  完成 (${(received / 1048576).toFixed(1)} MiB)`);
          resolve(true);
        });

        file.on('error', () => resolve(attempt < 3 ? retry(url, dest, minBytes, attempt) : false));

        // 传输中途被重置:重试
        response.on('aborted', () => {
          file.close();
          rmSync(dest, { force: true });
          resolve(attempt < 3 ? retry(url, dest, minBytes, attempt) : false);
        });
      },
    );

    request.on('error', (error) => {
      console.error('  ' + (error.code ?? error.message));
      rmSync(dest, { force: true });
      resolve(attempt < 3 ? retry(url, dest, minBytes, attempt) : false);
    });
    request.on('timeout', () => {
      request.destroy();
      console.error('  超时');
      rmSync(dest, { force: true });
      resolve(attempt < 3 ? retry(url, dest, minBytes, attempt) : false);
    });
    request.end();
  });
}

function retry(url, dest, minBytes, attempt) {
  console.log(`  第 ${attempt + 1} 次重试…`);
  return new Promise((resolve) => setTimeout(resolve, 1500 * attempt))
    .then(() => download(url, dest, minBytes, attempt + 1));
}

// ------------------------------------------------------------------ 解压
// Node 没有内置 unzip,而 spawn 子进程在本沙箱里受限(管道 EPERM),
// 所以直接读 ZIP 结构 + zlib.inflateRawSync 解压(只处理 store/deflate,足够)。

function extractZip(zipPath, destDir) {
  const buffer = readFileSync(zipPath);

  // 找 End of Central Directory(签名 0x06054b50),从尾部往前搜
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip:' + zipPath);

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);

  let files = 0;
  for (let n = 0; n < entryCount; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    const target = join(destDir, name);
    if (name.endsWith('/')) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });

    // 本地文件头:签名 0x04034b50,其后 26 字节再跟文件名与扩展字段
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) writeFileSync(target, raw);
    else if (method === 8) writeFileSync(target, inflateRawSync(raw, { maxOutputLength: uncompressedSize || undefined }));
    else continue;

    files += 1;
  }

  return files;
}

/** 把解压出来的目录搬成官方 SDK 的布局 */
function arrange(extractedDir, expectedSubdir, finalPath) {
  if (existsSync(finalPath)) {
    rmSync(finalPath, { recursive: true, force: true });
  }
  mkdirSync(dirname(finalPath), { recursive: true });

  if (existsSync(join(extractedDir, expectedSubdir))) {
    renameSync(join(extractedDir, expectedSubdir), finalPath);
    return true;
  }

  // 兜底:解压目录里只有一个子目录时直接用它
  const children = readdirSync(extractedDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (children.length === 1) {
    renameSync(join(extractedDir, children[0].name), finalPath);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ 主流程

console.log('Android 构建工具链 → ' + base);
console.log('');

for (const pkg of PACKAGES) {
  console.log(`[${pkg.name}] ${pkg.file}`);
  const dest = join(downloads, pkg.file);
  const ok = await download(MIRROR + pkg.file, dest, pkg.min);
  if (!ok) {
    console.error(`  失败:${pkg.name}`);
    process.exit(1);
  }
}

console.log('');
console.log('解压并整理目录…');

const work = join(base, 'tmp');
const targets = [
  { pkg: 'platform-tools', sub: 'platform-tools', final: join(sdk, 'platform-tools') },
  { pkg: 'build-tools', sub: 'android-14', final: join(sdk, 'build-tools', '34.0.0') },
  { pkg: 'platform-34', sub: 'android-34-ext7', final: join(sdk, 'platforms', 'android-34') },
  { pkg: 'commandlinetools', sub: 'cmdline-tools', final: join(sdk, 'cmdline-tools', 'latest') },
];

for (const target of targets) {
  const pkg = PACKAGES.find((p) => p.name === target.pkg);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  console.log(`  ${target.pkg}`);
  const count = extractZip(join(downloads, pkg.file), work);
  const moved = arrange(work, target.sub, target.final);
  console.log(moved ? `    ${count} 个文件 → ${target.final}` : '    ⚠ 目录结构异常,未能整理');
}

rmSync(work, { recursive: true, force: true });

// ------------------------------------------------------------------ 校验

console.log('');
console.log('校验关键工具:');
const checks = [
  ['adb', join(sdk, 'platform-tools', 'adb.exe')],
  ['aapt2', join(sdk, 'build-tools', '34.0.0', 'aapt2.exe')],
  ['d8', join(sdk, 'build-tools', '34.0.0', 'd8.bat')],
  ['apksigner', join(sdk, 'build-tools', '34.0.0', 'apksigner.bat')],
  ['zipalign', join(sdk, 'build-tools', '34.0.0', 'zipalign.exe')],
  ['android.jar', join(sdk, 'platforms', 'android-34', 'android.jar')],
];

let allOk = true;
for (const [name, path] of checks) {
  const ok = existsSync(path);
  if (!ok) allOk = false;
  console.log(`  ${ok ? '✅' : '❌'} ${name.padEnd(12)} ${path}`);
}

console.log('');
if (!allOk) {
  console.error('有组件缺失,请检查上面的路径。');
  process.exit(1);
}
console.log('工具链就绪。下一步:node tools/build-apk.mjs');
