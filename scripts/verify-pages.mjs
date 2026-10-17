/**
 * 页面渲染验证:检查三个页面能正常返回,并且关键中文内容确实在 HTML 里。
 * 用法:VD_BASE_URL=http://127.0.0.1:3300 node scripts/verify-pages.mjs
 */
const BASE = process.env.VD_BASE_URL || 'http://127.0.0.1:3000';

const expectations = [
  {
    path: '/',
    name: '首页(技术概览)',
    must: [
      '把平板变成电脑的',
      '整体链路:6 个步骤',
      '虚拟显示器',
      'IddCx',
      'CGVirtualDisplay',
      'evdi',
      'DXGI Desktop Duplication',
      'ScreenCaptureKit',
      'PipeWire',
      '编码低延迟调优',
      'UDP + FEC',
      'USB 隧道',
      '触控与手写笔回传',
      '安全与配对',
      '现成方案',
      '开源方案',
      '自研方案',
      '4 步实现路线',
      '原型限制说明',
      '/host',
      '/view',
    ],
  },
  {
    path: '/host',
    name: '电脑端',
    // “重新开始 / 停止”是按状态条件渲染的,首屏只有“开始共享”
    must: ['配对码', '开始共享', '本地预览', '整个屏幕'],
  },
  {
    path: '/view',
    name: '平板端',
    // “全屏”按钮在输入配对码之后才出现
    must: ['输入 6 位配对码', '连接电脑', '同一个 Wi-Fi'],
  },
  {
    path: '/api/network',
    name: '局域网地址接口',
    must: ['candidates', 'primary'],
  },
];

let failed = 0;

for (const page of expectations) {
  const res = await fetch(BASE + page.path);
  const body = await res.text();
  const missing = page.must.filter((needle) => !body.includes(needle));

  const statusOk = res.status === 200;
  if (!statusOk || missing.length > 0) failed += 1;

  console.log(`${statusOk && missing.length === 0 ? '✓' : '✗'} ${page.name} ${page.path}  HTTP ${res.status}  ${body.length} 字节`);
  if (missing.length > 0) console.log('    缺少内容: ' + missing.join(' / '));
}

console.log(failed === 0 ? '\n全部页面渲染正常' : `\n有 ${failed} 个页面异常`);
process.exit(failed === 0 ? 0 : 1);
