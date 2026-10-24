'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { apiFetch, isHostedByApp } from '@/lib/api';
import qrcode from '@/lib/vendor/qrcode-generator';
interface NetworkResponse {
  candidates?: { address: string; label: string; listening?: boolean }[];
  primary?: string | null;
  /** 服务实际在监听的完整 URL,第一个最推荐。用它比自己拼地址可靠。 */
  listeningUrls?: string[];
}

/**
 * 平板接入页。
 *
 * 平板接入页:把接收地址画成二维码,平板扫一下就能打开,不用手输地址。
 * 免安装版的控制面板会在 `/api/network` 里给出实际监听地址,这个页面优先用它。
 *
 * 注意 Web 模式下 `/api/network` 不返回 listeningUrls(端口就是当前页面端口),
 * 这时会退回到"主地址 + location.port"自行拼接。
 *
 * 二维码用项目内置的 qrcode-generator(MIT)在浏览器里生成 ——
 * 不在 C# 侧手写编码器,避免"自己写 QR 实现"这类高风险工作。
 */
export default function QrPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [alternatives, setAlternatives] = useState<string[]>([]);
  const [port, setPort] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 宿主信息只能等挂载后再读:服务端渲染时没有 window,直接读会导致水合不一致
  const [hosted, setHosted] = useState(false);

  useEffect(() => {
    setHosted(isHostedByApp());
  }, []);

  // 找出平板可访问的地址。
  //
  // 关键:优先用服务端报告的"实际监听地址"(listeningUrls),而不是自己拿
  // primary + 当前端口拼。否则当网卡评分选错(例如选中了 VMware 虚拟网卡)时,
  // 二维码会指向平板根本连不上的地址,且现场没有任何提示。
  useEffect(() => {
    let cancelled = false;

    const fallback = () => {
      if (cancelled) return;
      setTarget(`${window.location.origin}/view`);
      setPort(Number(window.location.port) || null);
      setAlternatives([]);
    };

    apiFetch('/api/network')
      .then((res) => (res.ok ? (res.json() as Promise<NetworkResponse>) : null))
      .then((data) => {
        if (cancelled) return;

        // 首选:服务实际在监听的地址
        const listening = (data?.listeningUrls ?? []).filter((u) => u.startsWith('http://'));
        if (listening.length > 0) {
          setTarget(`${listening[0]}/view`);
          setAlternatives(listening.slice(1).map((u) => `${u}/view`));
          try {
            setPort(Number(new URL(listening[0]).port) || null);
          } catch {
            setPort(null);
          }
          return;
        }

        // 退路:只有 IP 时自己拼
        const address = data?.primary;
        if (!address) {
          fallback();
          return;
        }
        const currentPort = window.location.port;
        setPort(Number(currentPort) || null);
        setTarget(`http://${address}${currentPort ? `:${currentPort}` : ''}/view`);
        setAlternatives([]);
      })
      .catch(fallback);

    return () => {
      cancelled = true;
    };
  }, []);

  // 画二维码
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !target) return;

    try {
      const qr = qrcode(0, 'M');
      qr.addData(target);
      qr.make();

      const count = qr.getModuleCount();
      const scale = 8;
      const quiet = 4;
      const pixels = (count + quiet * 2) * scale;

      canvas.width = pixels;
      canvas.height = pixels;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        setError('浏览器不支持 canvas,无法绘制二维码。');
        return;
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, pixels, pixels);
      ctx.fillStyle = '#0a0e16';
      for (let row = 0; row < count; row += 1) {
        for (let col = 0; col < count; col += 1) {
          if (!qr.isDark(row, col)) continue;
          ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale);
        }
      }
      setError(null);
    } catch (caught) {
      setError('二维码生成失败:' + (caught instanceof Error ? caught.message : String(caught)));
    }
  }, [target]);

  const copy = useCallback(() => {
    if (!target) return;
    void navigator.clipboard?.writeText(target).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [target]);

  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-lg">
            📱
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-100">平板接入</p>
            <p className="text-xs text-slate-500">用平板相机扫下面的二维码即可打开接收页</p>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/host" className="vd-btn">
            电脑端
          </Link>
          <Link href="/" className="vd-btn">
            技术概览
          </Link>
        </nav>
      </header>

      <section className="vd-card flex flex-col items-center gap-4 p-6 sm:p-8">
        <div className="rounded-2xl bg-white p-4 shadow-lg">
          <canvas ref={canvasRef} className="block h-[300px] w-[300px]" aria-label="平板接入二维码" />
        </div>

        {error ? (
          <p className="max-w-md text-center text-sm text-rose-300">{error}</p>
        ) : (
          <p className="text-sm text-slate-400">平板扫这个码,直接打开接收页</p>
        )}

        <div className="w-full max-w-md">
          <p className="mb-1 text-xs text-slate-500">
            平板链接{port ? `(端口 ${port})` : ''}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-800 bg-slate-950/70 px-3 py-2 font-mono text-xs text-cyan-200">
              {target ?? '正在获取局域网地址…'}
            </code>
            <button type="button" className="vd-btn shrink-0" onClick={copy} disabled={!target}>
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>

        <p className="max-w-md text-center text-xs leading-relaxed text-slate-500">
          平板和这台电脑需要在同一个局域网(Wi-Fi)下。
          {hosted ? ' 如果扫不出来,可以把上面这行地址手动输入平板的浏览器。' : ''}
        </p>

        {alternatives.length > 0 ? (
          <details className="w-full max-w-md text-xs text-slate-500">
            <summary className="cursor-pointer select-none text-slate-400">
              平板连不上?试试这些备用地址({alternatives.length} 个)
            </summary>
            <div className="mt-2 space-y-1">
              {alternatives.map((url) => (
                <code
                  key={url}
                  className="block truncate rounded border border-slate-800 bg-slate-950/70 px-2 py-1 font-mono text-cyan-200/80"
                >
                  {url}
                </code>
              ))}
              <p className="pt-1 leading-relaxed text-slate-500">
                这些是本机其它网卡地址(例如 VMware、有线网)。平板只能访问与它同网段的那个。
              </p>
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
