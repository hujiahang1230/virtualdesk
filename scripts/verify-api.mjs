/**
 * 信令接口端到端验证脚本(开发用)。
 *
 * 需要先启动应用(默认 http://127.0.0.1:3000)以及 PostgreSQL。
 * 用法:
 *   node scripts/verify-api.mjs
 *   VD_BASE_URL=http://127.0.0.1:3100 node scripts/verify-api.mjs
 */
const BASE = process.env.VD_BASE_URL || 'http://127.0.0.1:3000';

let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${extra ? '  -> ' + extra : ''}`);
  }
}

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  const text = await res.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** 造一个形状合法的 SDP,避免依赖真实浏览器 */
function fakeSdpBody(type) {
  return [
    'v=0',
    'o=- 1234567890 2 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'a=ice-options:trickle',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:abcd',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=fingerprint:sha-256 11:22:33',
    'a=setup:' + (type === 'offer' ? 'actpass' : 'active'),
    'a=mid:0',
    `a=${type === 'offer' ? 'sendonly' : 'recvonly'}`,
    'a=rtpmap:96 H264/90000',
    'a=candidate:1 1 udp 2122252543 192.168.1.10 54321 typ host generation 0',
    'a=end-of-candidates',
    '',
  ].join('\r\n');
}

/**
 * 客户端实际提交的 sdp 字段内容:JSON.stringify({ type, sdp })。
 * 数据库里存的、PUT 写入的、GET 读出来的都是这一种形式。
 */
function fakeSdp(type) {
  return JSON.stringify({ type, sdp: fakeSdpBody(type) });
}

console.log('验证目标: ' + BASE + '\n');

// 1. 健康检查
console.log('[1] GET /api/health');
{
  const { status, json } = await req('GET', '/api/health');
  check('HTTP 200', status === 200, 'status=' + status);
  check('数据库可达', json?.database?.reachable === true, JSON.stringify(json?.database));
  if (json?.database?.target) {
    check('连接串已脱敏', !String(json.database.target).includes('postgres:postgres@'), json.database.target);
  }
}

// 2. 创建会话
// 电脑端创建会话时,POST 的 offer 字段就是 encodeSdpPayload 的结果(单层 JSON 字符串)
const encodedOffer = fakeSdp('offer');
let code = null;
console.log('\n[2] POST /api/session');
{
  const { status, json } = await req('POST', '/api/session', { offer: encodedOffer });
  check('HTTP 201', status === 201, 'status=' + status);
  check('返回 6 位数字配对码', typeof json?.code === 'string' && /^\d{6}$/.test(json.code), JSON.stringify(json));
  code = json?.code ?? null;
  check('返回了清理条数', typeof json?.removed === 'number', JSON.stringify(json));
}

// 3. 读取会话
console.log('\n[3] GET /api/session/[code]');
{
  const { status, json } = await req('GET', `/api/session/${code}`);
  check('HTTP 200', status === 200, 'status=' + status);
  check('offer 原样返回', json?.offer === encodedOffer);
  check('answer 初始为空', json?.answer === null, String(json?.answer));
  check('返回 createdAt', typeof json?.createdAt === 'string' && !Number.isNaN(Date.parse(json.createdAt)));
}

// 4. 错误分支
console.log('\n[4] 参数校验与 404');
{
  const a = await req('GET', '/api/session/999999');
  check('不存在的配对码返回 404', a.status === 404, 'status=' + a.status);

  const b = await req('GET', '/api/session/abcd');
  check('非 6 位数字配对码返回 400', b.status === 400, 'status=' + b.status);

  const c = await req('PUT', `/api/session/${code}`, { type: 'bogus', sdp: fakeSdp('answer') });
  check('非法 type 返回 400', c.status === 400, 'status=' + c.status);

  const d = await req('PUT', `/api/session/${code}`, { type: 'answer' });
  check('缺少 sdp 返回 400', d.status === 400, 'status=' + d.status);

  const e = await req('PUT', `/api/session/${code}`, { type: 'answer', sdp: 'not-an-sdp' });
  check('非法 sdp 返回 400', e.status === 400, 'status=' + e.status);

  const f = await req('PUT', `/api/session/${code}`, 'not-json');
  check('非 JSON 请求体返回 400', f.status === 400, 'status=' + f.status);

  const g = await req('PUT', '/api/session/111111', { type: 'answer', sdp: fakeSdp('answer') });
  check('写入不存在的会话返回 404', g.status === 404, 'status=' + g.status);
}

// 5. 写入 answer(与平板端真实写入格式一致)
console.log('\n[5] PUT /api/session/[code] 写入 answer');
{
  const encodedAnswer = fakeSdp('answer');
  const { status } = await req('PUT', `/api/session/${code}`, {
    type: 'answer',
    sdp: encodedAnswer,
  });
  check('HTTP 200', status === 200, 'status=' + status);

  const { json } = await req('GET', `/api/session/${code}`);
  check('answer 已保存', json?.answer === encodedAnswer);

  // 存进去的必须是"能解析出 { type, sdp }"的单层 JSON
  let decoded = null;
  try {
    decoded = JSON.parse(json.answer);
  } catch {
    decoded = null;
  }
  check(
    'answer 是可直接解析的 { type, sdp }',
    decoded?.type === 'answer' && decoded?.sdp === fakeSdpBody('answer'),
    JSON.stringify(decoded)?.slice(0, 80),
  );
  check('offer 未被覆盖', typeof json?.offer === 'string' && JSON.parse(json.offer).type === 'offer');
}

// 6. 重新写入 offer 应清空 answer
console.log('\n[6] 重新写入 offer 清空旧 answer');
{
  const newOffer = encodedOffer.replace('1234567890', '9876543210');
  const { status } = await req('PUT', `/api/session/${code}`, { type: 'offer', sdp: newOffer });
  check('写入新 offer 返回 200', status === 200, 'status=' + status);

  const { json } = await req('GET', `/api/session/${code}`);
  check('answer 被清空', json?.answer === null, String(json?.answer).slice(0, 60));
  check('offer 已更新', json?.offer === newOffer, String(json?.offer).slice(0, 60));
}

// 7. 空 body 创建会话
console.log('\n[7] POST /api/session 允许空请求体');
{
  const { status, json } = await req('POST', '/api/session');
  check('HTTP 201', status === 201, 'status=' + status);
  check('返回配对码', typeof json?.code === 'string' && /^\d{6}$/.test(json.code));
  const snapshot = await req('GET', `/api/session/${json.code}`);
  check('新会话 offer 为 null', snapshot.json?.offer === null);
}

console.log(`\n结果: ${passed} 项通过, ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
