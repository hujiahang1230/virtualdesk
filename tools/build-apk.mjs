/**
 * 手工构建 Android APK(不使用 Gradle)。
 *
 * 为什么不用 Gradle:本机 services.gradle.org 不可达,而且 Gradle + AGP 会再拉
 * 几百 MB 依赖。这里用官方 build-tools 里的工具按最朴素的顺序拼出来:
 *
 *   aapt2 link  →  产出带二进制清单与资源表的 APK
 *   javac       →  编译 Java(必须 --release 17:本机 javac 是 25,
 *                  d8 8.2 不认过新的 class 文件版本)
 *   d8          →  class → classes.dex
 *   重打包      →  把 classes.dex 塞进 APK(自己写 ZIP 读写,避免依赖)
 *   zipalign    →  4 字节对齐
 *   apksigner   →  用本地调试证书签名
 *
 * 用法:
 *   node tools/build-apk.mjs
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = join(projectRoot, '.android-build');
const sdk = join(base, 'sdk');
const buildTools = join(sdk, 'build-tools', '34.0.0');
const platformJar = join(sdk, 'platforms', 'android-34', 'android.jar');

const androidDir = join(projectRoot, 'android', 'app', 'src', 'main');
const manifest = join(androidDir, 'AndroidManifest.xml');
const javaRoot = join(androidDir, 'java');

const out = join(projectRoot, 'tools', 'apk');
const work = join(out, 'work');

const JAVA_HOME = process.env.VD_JAVA_HOME || 'F:\\C#Rider\\JetBrains Rider 2026.2.0.2\\jbr';
const javac = join(JAVA_HOME, 'bin', 'javac.exe');
const java = join(JAVA_HOME, 'bin', 'java.exe');
const keytool = join(JAVA_HOME, 'bin', 'keytool.exe');

const MIN_SDK = '26';
const TARGET_SDK = '34';

function fail(message) {
  console.error('\n构建失败:' + message);
  process.exit(1);
}

function check(path, label) {
  if (!existsSync(path)) fail(`${label} 不存在:${path}`);
}

/** 运行外部程序。stdio 必须 inherit —— 沙箱里管道会 EPERM */
function run(command, args, label) {
  console.log(`\n→ ${label}`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    cwd: projectRoot,
    env: { ...process.env, JAVA_HOME },
  });
  if (result.error) fail(`${label} 无法启动:${result.error.message}`);
  if (result.status !== 0) fail(`${label} 退出码 ${result.status}`);
}

// ------------------------------------------------------------------ CRC32 / ZIP

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 读 zip,保留每个条目**原始的压缩方式与压缩后字节**。
 *
 * 为什么不能像最初那样全部解压再用 deflate 重写:
 *   Android 11+（targetSdk ≥ 30）要求 `resources.arsc` 必须**不压缩**且 4 字节对齐,
 *   否则安装直接失败:
 *     Failure [-124: ... requires the resources.arsc of installed APKs to be stored
 *                uncompressed and aligned on a 4-byte boundary]
 *   aapt2 产出的 APK 里 resources.arsc 本来就是 stored,重写时把它压了就会破坏这个约定。
 *   所以这里原样搬运,只对新增的 entries 才算压缩。
 */
function readZip(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66000); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) fail('aapt2 产物不是有效 zip');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = [];

  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue;

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;

    entries.push({
      name,
      method,
      crc,
      uncompressedSize,
      raw: Buffer.from(buffer.subarray(start, start + compressedSize)),
    });
  }

  return entries;
}

/** 写 zip:保留既有条目的压缩方式;新增条目用 deflate */
function writeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const isStored = entry.method === 0;
    const payload = isStored ? entry.raw : entry.raw; // 两种都是原始压缩字节
    const crc = entry.crc;
    const uncompressedSize = entry.uncompressedSize;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);

    locals.push(local, payload);

    const dir = Buffer.alloc(46 + nameBytes.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(entry.method, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(payload.length, 20);
    dir.writeUInt32LE(uncompressedSize, 24);
    dir.writeUInt16LE(nameBytes.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    nameBytes.copy(dir, 46);

    central.push(dir);
    offset += local.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/** 把一段明文包装成 deflate 条目 */
function deflatedEntry(name, data) {
  return {
    name,
    method: 8,
    crc: crc32(data),
    uncompressedSize: data.length,
    raw: deflateRawSync(data),
  };
}

/** 递归收集 .java 与 .class */
function collect(dir, suffix) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) results.push(...collect(full, suffix));
    else if (item.name.endsWith(suffix)) results.push(full);
  }
  return results;
}

// ------------------------------------------------------------------ 主流程

// APK 版本号。
//
// 为什么需要它:PC 端决定"要不要重装平板 App"时,如果按文件哈希比较,
// 那么每次重新构建(哪怕只改一行注释)哈希都会变,平板就会被重装一次并弹确认框。
// 改为按 versionCode 比较后,只有**功能真的变了**才需要重装 —— 这才是用户的预期。
// 改平板端功能时把它 +1 即可。
const APK_VERSION_CODE = 5;
const APK_VERSION_NAME = '1.4';

console.log('构建 Android APK');
check(manifest, 'AndroidManifest.xml');
check(platformJar, 'android.jar');
check(javac, 'javac(请设置 VD_JAVA_HOME 指向 JDK)');

rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'classes'), { recursive: true });
mkdirSync(out, { recursive: true });

// 1. aapt2 link:清单 + 资源表 → 基础 APK
const baseApk = join(work, 'base.apk');
run(join(buildTools, 'aapt2.exe'), [
  'link',
  '-o', baseApk,
  '-I', platformJar,
  '--manifest', manifest,
  '--min-sdk-version', MIN_SDK,
  '--target-sdk-version', TARGET_SDK,
  '--version-code', String(APK_VERSION_CODE),
  '--version-name', APK_VERSION_NAME,
], 'aapt2 link');

// 2. javac:必须 --release 17,否则 class 文件版本高于 d8 支持范围
const javaFiles = collect(javaRoot, '.java');
if (javaFiles.length === 0) fail('没有找到 Java 源文件');
run(javac, [
  '--release', '17',
  '-encoding', 'UTF-8',
  '-classpath', platformJar,
  '-d', join(work, 'classes'),
  ...javaFiles,
], `javac(${javaFiles.length} 个源文件)`);

// 3. d8:class → classes.dex
const classFiles = collect(join(work, 'classes'), '.class');
if (classFiles.length === 0) fail('javac 没有产出 class 文件');
// d8 要求输出目录事先存在(否则报 "Output must be a .zip or .jar archive or an existing directory")
mkdirSync(join(work, 'dex'), { recursive: true });
run(java, [
  '-cp', join(buildTools, 'lib', 'd8.jar'),
  'com.android.tools.r8.D8',
  '--release',
  '--min-api', MIN_SDK,
  '--lib', platformJar,
  '--output', join(work, 'dex'),
  ...classFiles,
], `d8(${classFiles.length} 个 class)`);

const dexPath = join(work, 'dex', 'classes.dex');
check(dexPath, 'classes.dex');

// 4. 重打包:把 classes.dex 加进 APK(其余条目原样保留压缩方式)
const entries = readZip(readFileSync(baseApk));
entries.push(deflatedEntry('classes.dex', readFileSync(dexPath)));
const unaligned = join(work, 'unaligned.apk');
writeFileSync(unaligned, writeZip(entries));
console.log(`\n→ 重打包完成(${entries.length} 个条目,dex ${(statSync(dexPath).size / 1024).toFixed(0)} KiB)`);

// 校验:resources.arsc 必须是 stored(method 0),否则 Android 11+ 会拒绝安装
const arsc = entries.find((e) => e.name === 'resources.arsc');
if (arsc && arsc.method !== 0) {
  fail('resources.arsc 被压缩了,targetSdk ≥ 30 的 APK 必须保持 stored');
}

// 5. 签名证书(不存在则生成一个本地调试证书)
const keystore = join(base, 'debug.keystore');
if (!existsSync(keystore)) {
  run(keytool, [
    '-genkeypair',
    '-keystore', keystore,
    '-alias', 'virtualdesk',
    '-keyalg', 'RSA',
    '-keysize', '2048',
    '-validity', '10000',
    '-storepass', 'virtualdesk',
    '-keypass', 'virtualdesk',
    '-dname', 'CN=VirtualDesk Viewer',
  ], 'keytool 生成调试证书');
}

// 6. zipalign
const aligned = join(work, 'aligned.apk');
run(join(buildTools, 'zipalign.exe'), ['-f', '-p', '4', unaligned, aligned], 'zipalign');

// 7. apksigner
const signed = join(out, 'virtualdesk-viewer.apk');
run(java, [
  '-jar', join(buildTools, 'lib', 'apksigner.jar'),
  'sign',
  '--ks', keystore,
  '--ks-key-alias', 'virtualdesk',
  '--ks-pass', 'pass:virtualdesk',
  '--key-pass', 'pass:virtualdesk',
  '--out', signed,
  aligned,
], 'apksigner');

// 8. 校验
run(java, [
  '-jar', join(buildTools, 'lib', 'apksigner.jar'),
  'verify', '--verbose', signed,
], 'apksigner verify');

// 9. 把 versionCode 写成旁路文件,供 PC 端嵌入后比较
//
// PC 端判断"要不要重装"时读这个值(而不是文件哈希),这样重新构建但不升版本时
// 平板不会被无故重装。pack.mjs 会把它一并嵌进 exe。
//
// 文件名必须是 "<apk>.version":csproj 里用 $(ApkPath).version 定位这个资源。
const versionFile = signed + '.version';
writeFileSync(versionFile, String(APK_VERSION_CODE), 'utf8');

const size = statSync(signed).size;
const sha = createHash('sha256').update(readFileSync(signed)).digest('hex').slice(0, 16);
console.log('');
console.log('✅ APK 构建完成');
console.log('   路径: ' + signed);
console.log(`   大小: ${(size / 1024).toFixed(1)} KiB   sha256: ${sha}…`);
console.log(`   版本: ${APK_VERSION_NAME} (versionCode ${APK_VERSION_CODE})`);
console.log('   安装: adb install -r "' + signed + '"');
