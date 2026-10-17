import type { Metadata, Viewport } from 'next';

import './globals.css';

export const metadata: Metadata = {
  title: '第二块屏 · 把平板变成电脑扩展显示屏',
  description:
    '从虚拟显示器、屏幕采集、低延迟编码到 WebRTC 点对点传输的技术科普,附带一个可以直接在局域网跑起来的同屏串流原型。',
  applicationName: '第二块屏',
  keywords: [
    '第二块屏',
    '扩展显示屏',
    'WebRTC',
    '屏幕串流',
    '虚拟显示器',
    'IddCx',
    'ScreenCaptureKit',
    'PipeWire',
  ],
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#070b14',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="font-sans antialiased">{children}</body>
    </html>
  );
}
