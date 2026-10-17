/**
 * 数据库初始化辅助脚本。
 *
 * 用法:
 *   node scripts/db-setup.mjs push               # 一键:建库(如不存在)+ 建表 + 自检,等价于 npm run db:push
 *   node scripts/db-setup.mjs ensure             # 只确保目标数据库存在
 *   node scripts/db-setup.mjs sql <file.sql>     # 执行一个 .sql 文件(按分号切分,逐条执行)
 *   node scripts/db-setup.mjs status             # 打印当前库里的表结构自检结果
 *
 * 连接串来自 DATABASE_URL,默认使用本地开发库(见 scripts/dev-postgres.mjs)。
 *
 * 说明:`npm run db:generate` 仍然用 drizzle-kit 从 src/db/schema.ts 生成迁移。
 * 这里不调用 drizzle-kit,是因为它在部分受限环境里会因为无法启动子进程而中断;
 * 而建表本身只需要执行 drizzle/0000_init.sql,两条路径产生的结构是一致的。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const DEFAULT_URL = 'postgres://postgres@127.0.0.1:55432/virtualdesk';
const DATABASE_URL = process.env.DATABASE_URL || DEFAULT_URL;
const INIT_SQL = join('drizzle', '0000_init.sql');

/** 建表语句都是 IF NOT EXISTS,重复执行会产生 NOTICE;这些提示不需要打扰使用者 */
const CLIENT_OPTIONS = {
  max: 1,
  onnotice: (notice) => {
    if (notice.severity === 'NOTICE' || notice.severity === 'INFO' || notice.severity === 'DEBUG') return;
    console.warn(`[db-setup] PostgreSQL ${notice.severity}: ${notice.message}`);
  },
};

/** 期望的表结构,用于建表后自检 */
const EXPECTED_COLUMNS = [
  { name: 'code', dataType: 'text', nullable: false },
  { name: 'offer', dataType: 'text', nullable: true },
  { name: 'answer', dataType: 'text', nullable: true },
  { name: 'created_at', dataType: 'timestamp with time zone', nullable: false },
];
const EXPECTED_INDEX = 'signal_sessions_created_at_idx';

function adminUrlFor(target) {
  const url = new URL(target);
  const dbName = decodeURIComponent(url.pathname.replace(/^\//, ''));
  url.pathname = '/postgres';
  return { url: url.toString(), dbName };
}

async function ensure() {
  const { url, dbName } = adminUrlFor(DATABASE_URL);
  if (!dbName) throw new Error('DATABASE_URL 里没有数据库名');

  const sql = postgres(url, CLIENT_OPTIONS);
  try {
    const existing = await sql`select 1 from pg_database where datname = ${dbName}`;
    if (existing.length > 0) {
      console.log(`[db-setup] 数据库已存在: ${dbName}`);
      return;
    }
    // 数据库名来自连接串,这里用标识符拼接,并做白名单校验
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
      throw new Error(`数据库名不合法: ${dbName}`);
    }
    await sql.unsafe(`create database "${dbName}"`);
    console.log(`[db-setup] 已创建数据库: ${dbName}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** 按分号切分 SQL 文件,忽略注释行与 drizzle 的分隔标记 */
function splitStatements(sqlText) {
  return sqlText
    .split(/;\s*(?:\r?\n|$)/)
    .map((chunk) =>
      chunk
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('--> statement-breakpoint'))
        .join('\n')
        .trim(),
    )
    .filter((chunk) => chunk.length > 0 && !/^(--.*)$/.test(chunk));
}

async function applySqlFile(file) {
  const fullPath = resolve(projectRoot, file);
  if (!existsSync(fullPath)) {
    throw new Error(`找不到 SQL 文件: ${fullPath}`);
  }
  const statements = splitStatements(readFileSync(fullPath, 'utf8'));
  const sql = postgres(DATABASE_URL, CLIENT_OPTIONS);
  try {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
    console.log(`[db-setup] 已执行 ${statements.length} 条语句: ${file}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** 读回表结构,和期望值对比 */
async function inspectSchema() {
  const sql = postgres(DATABASE_URL, CLIENT_OPTIONS);
  try {
    const columns = await sql`
      select column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = 'public' and table_name = 'signal_sessions'
      order by ordinal_position
    `;
    const indexes = await sql`
      select indexname from pg_indexes
      where schemaname = 'public' and tablename = 'signal_sessions'
    `;
    const primaryKeys = await sql`
      select kcu.column_name
      from information_schema.table_constraints tc
      join information_schema.key_column_usage kcu
        on tc.constraint_name = kcu.constraint_name and tc.table_schema = kcu.table_schema
      where tc.table_name = 'signal_sessions' and tc.constraint_type = 'PRIMARY KEY'
    `;

    const actual = columns.map((row) => ({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === 'YES',
    }));

    const problems = [];
    if (actual.length === 0) {
      problems.push('表 signal_sessions 不存在');
    } else {
      for (const expected of EXPECTED_COLUMNS) {
        const found = actual.find((column) => column.name === expected.name);
        if (!found) {
          problems.push(`缺少字段 ${expected.name}`);
        } else if (found.dataType !== expected.dataType || found.nullable !== expected.nullable) {
          problems.push(
            `字段 ${expected.name} 类型不符(期望 ${expected.dataType} nullable=${expected.nullable},实际 ${found.dataType} nullable=${found.nullable})`,
          );
        }
      }
      for (const column of actual) {
        if (!EXPECTED_COLUMNS.some((expected) => expected.name === column.name)) {
          problems.push(`多出字段 ${column.name}`);
        }
      }
      if (primaryKeys.length !== 1 || primaryKeys[0].column_name !== 'code') {
        problems.push(`主键不是 code(实际 ${JSON.stringify(primaryKeys.map((row) => row.column_name))})`);
      }
      if (!indexes.some((row) => row.indexname === EXPECTED_INDEX)) {
        problems.push(`缺少索引 ${EXPECTED_INDEX}`);
      }
    }

    return { columns: actual, indexes: indexes.map((row) => row.indexname), problems };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function status() {
  const result = await inspectSchema();
  console.log('[db-setup] 表 signal_sessions 字段:');
  for (const column of result.columns) {
    console.log(`  - ${column.name} ${column.dataType}${column.nullable ? '' : ' NOT NULL'}`);
  }
  console.log('[db-setup] 索引: ' + (result.indexes.join(', ') || '(无)'));

  if (result.problems.length > 0) {
    console.log('[db-setup] 自检未通过:');
    for (const problem of result.problems) console.log('  ✗ ' + problem);
    process.exitCode = 1;
  } else {
    console.log('[db-setup] 自检通过:表结构与 src/db/schema.ts 一致');
  }
}

/** 一键建库 + 建表 + 自检 */
async function push() {
  await ensure();
  await applySqlFile(INIT_SQL);

  const result = await inspectSchema();
  if (result.problems.length > 0) {
    throw new Error('建表后自检未通过:\n  ' + result.problems.join('\n  '));
  }
  console.log('[db-setup] 自检通过:signal_sessions 的字段、主键与索引都符合预期');
}

const command = process.argv[2] || 'push';

try {
  if (command === 'push') await push();
  else if (command === 'ensure') await ensure();
  else if (command === 'sql') await applySqlFile(process.argv[3]);
  else if (command === 'status') await status();
  else {
    console.error('未知命令: ' + command);
    console.error('可用命令:push / ensure / sql <file.sql> / status');
    process.exit(1);
  }
} catch (error) {
  console.error('[db-setup] 失败: ' + (error instanceof Error ? error.message : String(error)));
  process.exit(1);
}
