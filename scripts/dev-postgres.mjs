/**
 * 本地一次性 PostgreSQL 启停脚本(仅用于开发/验证,不属于交付功能)。
 *
 * 用法:
 *   node scripts/dev-postgres.mjs start     # 初始化并启动,打印 DATABASE_URL
 *   node scripts/dev-postgres.mjs stop      # 停止
 *   node scripts/dev-postgres.mjs status    # 查看状态
 *   node scripts/dev-postgres.mjs url       # 只打印连接串
 *
 * 数据库文件放在 .devdb/(已在 .gitignore 里忽略),只监听 127.0.0.1。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, openSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const PGDATA = process.env.VD_PGDATA || join(projectRoot, '.devdb', 'data');
const PGPORT = Number(process.env.VD_PGPORT || 55432);
const PGUSER = 'postgres';
const PGDATABASE = 'virtualdesk';
const LOGFILE = join(dirname(PGDATA), 'postgres.log');

/**
 * 找 PostgreSQL 的 bin 目录。支持三种常见布局:
 *   1) VD_PG_ROOT 直接就是 bin 目录(桌面版 resources/pgsql/bin)
 *   2) VD_PG_ROOT 是解压后的包目录(含 native/bin,即 @embedded-postgres 的结构)
 *   3) VD_PG_ROOT 是系统安装目录(含 bin)
 */
function resolvePgBin(root) {
  const candidates = [root, join(root, 'native', 'bin'), join(root, 'bin')];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'postgres.exe'))) return candidate;
  }
  return join(root, 'bin');
}

const DEFAULT_PG_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'desktop',
  'resources',
  'pgsql',
);
const PG_ROOT = process.env.VD_PG_ROOT || DEFAULT_PG_ROOT;
const PG_BIN = resolvePgBin(PG_ROOT);

const INITDB = join(PG_BIN, 'initdb.exe');
const PG_CTL = join(PG_BIN, 'pg_ctl.exe');
const POSTGRES = join(PG_BIN, 'postgres.exe');
const PIDFILE = join(dirname(PGDATA), 'postgres.pid');

/**
 * 在受限沙箱里 pg_ctl 无法创建 restricted token(Windows error 87),
 * 所以直接以子进程方式拉起 postgres.exe。设置 VD_PG_MODE=pg_ctl 可改回 pg_ctl。
 */
const USE_PG_CTL = process.env.VD_PG_MODE === 'pg_ctl';

export const DEV_DATABASE_URL = `postgres://${PGUSER}@127.0.0.1:${PGPORT}/${PGDATABASE}`;

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} 退出码 ${code}`));
    });
  });
}

function waitForPort(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolvePromise();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline) rejectPromise(new Error(`等待端口 ${port} 超时`));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

function assertBinaries() {
  const required = [INITDB, POSTGRES, ...(USE_PG_CTL ? [PG_CTL] : [])];
  const missing = required.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(
      `找不到 PostgreSQL 可执行文件:\n  ${missing.join('\n  ')}\n\n` +
        '这个脚本只为本地开发提供一次性数据库,需要一份免安装的 PostgreSQL 二进制。两种做法:\n' +
        '  1) 用系统已安装的 PostgreSQL:设置环境变量 VD_PG_ROOT 指向其安装目录(里面有 bin/initdb.exe、bin/postgres.exe);\n' +
        '  2) 自己装一个 PostgreSQL 服务,然后把 DATABASE_URL 指向它,这个脚本就不需要了。\n' +
        '如果你只是想把项目跑起来,请直接看 README 的「配置数据库」一节。',
    );
  }
}

function writeConfig() {
  const conf = join(PGDATA, 'postgresql.conf');
  appendFileSync(
    conf,
    [
      '',
      '# ---- virtualdesk 本地开发配置 ----',
      "listen_addresses = '127.0.0.1'",
      `port = ${PGPORT}`,
      'max_connections = 30',
      'fsync = off',
      'synchronous_commit = off',
      'full_page_writes = off',
      '',
    ].join('\n'),
    'utf8',
  );
}

function initIfNeeded() {
  if (existsSync(join(PGDATA, 'PG_VERSION'))) return false;
  mkdirSync(PGDATA, { recursive: true });
  return true;
}

function isRunning() {
  if (existsSync(PIDFILE)) {
    const pid = Number(readFileSync(PIDFILE, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        // 进程已退出,清理陈旧 pid 文件
        try {
          unlinkSync(PIDFILE);
        } catch {
          /* ignore */
        }
      }
    }
  }
  return null;
}

async function start() {
  assertBinaries();

  const already = isRunning();
  if (already) {
    console.log(`[dev-postgres] 已在运行(PID ${already}): ` + DEV_DATABASE_URL);
    return;
  }

  if (initIfNeeded()) {
    console.log('[dev-postgres] 初始化数据目录: ' + PGDATA);
    await run(INITDB, [
      '-D',
      PGDATA,
      '-U',
      PGUSER,
      '-A',
      'trust',
      '-E',
      'UTF8',
      '--locale=C',
      '--no-sync',
    ]);
    writeConfig();
  }

  console.log('[dev-postgres] 启动 PostgreSQL,端口 ' + PGPORT);
  if (USE_PG_CTL) {
    await run(PG_CTL, ['start', '-D', PGDATA, '-l', LOGFILE, '-w', '-t', '60', '-o', `-p ${PGPORT}`]);
  } else {
    // 直接拉起 postgres.exe:stdout/stderr 重定向到日志文件
    const out = openSync(LOGFILE, 'a');
    const child = spawn(POSTGRES, ['-D', PGDATA, '-p', String(PGPORT)], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    if (!child.pid) throw new Error('启动 postgres.exe 失败:没有拿到进程 ID');
    writeFileSync(PIDFILE, String(child.pid), 'utf8');
    console.log(`[dev-postgres] postgres.exe PID=${child.pid}`);
  }

  await waitForPort(PGPORT);

  const version = readFileSync(join(PGDATA, 'PG_VERSION'), 'utf8').trim();
  console.log(`[dev-postgres] 已启动(PostgreSQL ${version})`);
  console.log('DATABASE_URL=' + DEV_DATABASE_URL);
}

async function stop() {
  assertBinaries();
  if (!existsSync(join(PGDATA, 'PG_VERSION'))) {
    console.log('[dev-postgres] 数据目录不存在,无需停止。');
    return;
  }

  const pid = isRunning();
  if (USE_PG_CTL || !pid) {
    await run(PG_CTL, ['stop', '-D', PGDATA, '-m', 'fast', '-w', '-t', '30']);
  } else {
    process.kill(pid);
    const deadline = Date.now() + 20_000;
    while (isRunning() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300));
    }
    if (isRunning()) process.kill(pid, 'SIGKILL');
  }
  try {
    unlinkSync(PIDFILE);
  } catch {
    /* ignore */
  }
  console.log('[dev-postgres] 已停止');
}

async function status() {
  assertBinaries();
  const pid = isRunning();
  if (USE_PG_CTL) {
    await run(PG_CTL, ['status', '-D', PGDATA]);
    return;
  }
  if (pid) {
    console.log(`[dev-postgres] 运行中,PID=${pid}`);
    console.log('DATABASE_URL=' + DEV_DATABASE_URL);
  } else {
    console.log('[dev-postgres] 未运行');
    process.exitCode = 3;
  }
}

const command = process.argv[2] || 'start';

try {
  if (command === 'start') await start();
  else if (command === 'stop') await stop();
  else if (command === 'status') await status();
  else if (command === 'url') console.log(DEV_DATABASE_URL);
  else {
    console.error('未知命令: ' + command);
    process.exit(1);
  }
} catch (error) {
  console.error('[dev-postgres] 失败: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
