/**
 * 把前端静态导出产物压成 web.zip,供 C# 宿主作为嵌入资源打进单文件 exe。
 *
 * 步骤:
 *   1. 把 src/app/api 临时改名成 src/app/_api(Next 会忽略下划线目录)
 *      —— 静态导出不允许存在 API 路由,而这些路由在单文件版里由 C# 提供
 *   2. VD_BUILD_TARGET=static 跑 next build,产物在 out/
 *   3. 把 out/ 压成 shell/web.zip
 *   4. 无论成败都把 API 路由改回来
 *
 * 注意:桌面宿主**不能**放在项目根的 app/ 目录里。
 * Next 会优先把根 app/ 当成路由目录,导致 src/app 被完全忽略,
 * 构建退化成一个空的 pages router(只会导出 /404)。用 shell/ 正是为了避开它。
 *
 * 用法: node shell/scripts/build-web.mjs
 */
import { createWriteStream, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const shellDir = resolve(here, '..');
const projectRoot = resolve(shellDir, '..');

const apiDir = join(projectRoot, 'src', 'app', 'api');
const apiHiddenDir = join(projectRoot, 'src', 'app', '_api');
const outDir = join(projectRoot, 'out');
const zipPath = join(shellDir, 'web.zip');

/** 递归收集文件,返回 { 绝对路径, zip 内相对路径 } */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, acc);
    else acc.push({ full, rel: relative(base, full).split('\\').join('/') });
  }
  return acc;
}

/**
 * 手写 zip(store,不压缩)。
 *
 * 不用系统 tar/Compress-Archive:那些工具在受限环境里会失败,
 * 而且这里只需要最基础的 zip 结构,自己写反而更可控。
 */
async function writeZip(files, target) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.full);
    const nameBytes = Buffer.from(file.rel, 'utf8');
    const crc = crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // 解压所需版本
    local.writeUInt16LE(0x0800, 6); // 文件名按 UTF-8 编码
    local.writeUInt16LE(0, 8); // 压缩方法:0 = store
    local.writeUInt16LE(0, 10); // 修改时间
    local.writeUInt16LE(0x21, 12); // 修改日期(1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // 压缩后大小 = 原始大小
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // 扩展字段长度
    nameBytes.copy(local, 30);

    chunks.push(local, data);
    central.push({ nameBytes, crc, size, offset });
    offset += local.length + size;
  }

  const centralStart = offset;
  for (const entry of central) {
    const header = Buffer.alloc(46 + entry.nameBytes.length);
    header.writeUInt32LE(0x02014b50, 0); // 中央目录签名
    header.writeUInt16LE(20, 4); // 创建版本
    header.writeUInt16LE(20, 6); // 解压所需版本
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt16LE(0x21, 14);
    header.writeUInt32LE(entry.crc, 16);
    header.writeUInt32LE(entry.size, 20);
    header.writeUInt32LE(entry.size, 24);
    header.writeUInt16LE(entry.nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // 扩展字段
    header.writeUInt16LE(0, 32); // 注释
    header.writeUInt16LE(0, 34); // 磁盘号
    header.writeUInt16LE(0, 36); // 内部属性
    header.writeUInt32LE(0, 38); // 外部属性
    header.writeUInt32LE(entry.offset, 42);
    entry.nameBytes.copy(header, 46);
    chunks.push(header);
    offset += header.length;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(offset - centralStart, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);

  await new Promise((resolvePromise, reject) => {
    const stream = createWriteStream(target);
    stream.on('error', reject);
    stream.on('finish', resolvePromise);
    for (const chunk of chunks) stream.write(chunk);
    stream.end(end);
  });
}

/** zip 需要的 CRC-32 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

let apiMoved = false;

function moveApiAside() {
  if (!existsSync(apiDir)) return;
  rmSync(apiHiddenDir, { recursive: true, force: true });
  renameSync(apiDir, apiHiddenDir);
  apiMoved = true;
  console.log('[web] 已临时移出 API 路由 → src/app/_api(静态导出不允许它存在)');
}

function restoreApi() {
  if (!apiMoved) return;
  renameSync(apiHiddenDir, apiDir);
  apiMoved = false;
  console.log('[web] 已恢复 API 路由');
}

/**
 * 校验:每个由 C# 宿主提供的接口,在 src/app/api 下都必须有对应路由。
 *
 * 前端对拿不到的接口会静默降级,所以少建一个路由在开发期看不出来 ——
 * 比如 /api/displays 曾长期只有 C# 实现,浏览器版直接 404,副屏引导整个失效,
 * 而两边都不报错。构建时对照一次,能在打包前把这类漂移拦下来。
 */
const HOST_PROVIDED_ROUTES = ['displays', 'network', 'health', 'session'];

function verifyRouteParity() {
  if (!existsSync(apiDir)) {
    throw new Error(`找不到 ${apiDir},API 路由恢复失败`);
  }
  const missing = HOST_PROVIDED_ROUTES.filter((r) => !existsSync(join(apiDir, r)));
  if (missing.length > 0) {
    throw new Error(
      `C# 宿主实现了这些接口,但 src/app/api 下缺少对应路由: ${missing.join(', ')}。` +
        '\n  宿主实现见 shell/WebHost.cs 的 HandleApi;补上路由后前端才能在浏览器模式下正常工作。',
    );
  }
}

try {
  console.log('[web] 开始静态导出前端…');
  moveApiAside();

  // 直接跑 next 的入口脚本,而不是 `npm run build`。
  //
  // 两个原因:
  //   1. Windows 上 npm 是 npm.cmd,必须配 shell:true 才能起来,而 Node 会为此发
  //      DEP0190 警告(参数不经转义就拼进 cmd 命令行)。
  //   2. 绕开 npm 少一层进程,打包更快,也少一个和 PATH 有关的失败点。
  // 执行的命令与 package.json 的 build 脚本保持一致:typegen && build。
  const nextBin = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(nextBin)) {
    throw new Error(`找不到 ${nextBin},请先执行 npm install`);
  }

  const env = {
    ...process.env,
    VD_BUILD_TARGET: 'static',
    VD_SKIP_LINT: '1',
    NEXT_TELEMETRY_DISABLED: '1',
  };

  for (const args of [['typegen'], ['build']]) {
    const step = spawnSync(process.execPath, [nextBin, ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
      env,
    });
    if (step.status !== 0) throw new Error(`next ${args[0]} 失败,退出码 ${step.status}`);
  }
} finally {
  restoreApi();
}

verifyRouteParity();

if (!existsSync(join(outDir, 'index.html'))) {
  throw new Error('静态导出产物不完整:找不到 out/index.html');
}

const files = walk(outDir);
console.log(`[web] 导出产物 ${files.length} 个文件`);

rmSync(zipPath, { force: true });
await writeZip(files, zipPath);

const zipSize = statSync(zipPath).size;
console.log(`[web] 嵌入包已生成:${zipPath}  ${(zipSize / 1024 / 1024).toFixed(2)} MiB`);

// 完整性自检
const required = ['index.html', 'host/index.html', 'view/index.html'];
const names = new Set(files.map((f) => f.rel));
let missing = 0;
for (const name of required) {
  if (!names.has(name)) {
    console.error(`[web] 缺少关键页面: ${name}`);
    missing += 1;
  }
}
if (missing > 0) throw new Error(`导出产物缺少 ${missing} 个关键页面`);
console.log('[web] 关键页面校验通过:' + required.join(', '));

// 哨兵:确认打进包的是本次构建的代码,而不是上一轮的陈旧产物
const sentinel = 'getDisplayMedia 请求';
const jsFiles = files.filter((f) => f.rel.endsWith('.js'));
const hit = jsFiles.find((f) => readFileSync(f.full, 'utf8').includes(sentinel));
if (!hit) {
  throw new Error(`导出产物里找不到标记「${sentinel}」,可能不是本次构建的代码。`);
}
console.log(`[web] 新版标记已确认存在于:${hit.rel}`);
