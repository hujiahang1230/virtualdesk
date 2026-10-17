import { NextResponse } from 'next/server';
import { networkInterfaces } from 'node:os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface Candidate {
  address: string;
  label: string;
  score: number;
}

function isPrivateV4(address: string): number {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return 0;
  const [a, b] = parts;
  if (a === 192 && b === 168) return 100; // 家用 / 办公 Wi-Fi 最常见
  if (a === 10) return 90; // 企业内网
  if (a === 172 && b >= 16 && b <= 31) return 80; // Docker / 虚拟网卡偏多,靠后
  return 0;
}

/**
 * GET /api/network —— 给电脑端页面用:告诉它有哪些局域网地址可以分享给平板。
 * 只返回本机的私有地址,不返回公网地址或 MAC。
 */
export async function GET() {
  const candidates: Candidate[] = [];

  for (const [name, infos] of Object.entries(networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.internal) continue;
      if (info.family !== 'IPv4') continue;
      const score = isPrivateV4(info.address);
      if (score === 0) continue;
      candidates.push({ address: info.address, label: name, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));

  return NextResponse.json({
    candidates: candidates.map(({ address, label }) => ({ address, label })),
    primary: candidates[0]?.address ?? null,
  });
}
