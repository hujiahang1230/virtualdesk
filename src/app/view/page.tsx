'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { apiFetch } from '@/lib/api';
import {
  OFFER_WAIT_TIMEOUT_MS,
  PAIR_CODE_LENGTH,
  POLL_INTERVAL_MS,
  applyRemoteDescription,
  buildLocalDescription,
  checkViewerSupport,
  createPeerConnection,
  createStatsSampler,
  decodeSdpPayload,
  encodeSdpPayload,
  prepareReceiveOnlyVideo,
  sleep,
  type MediaStatsSnapshot,
} from '@/lib/rtc';

type ViewerStatus =
  | 'idle'
  | 'waiting'
  | 'answering'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error';

const STATUS_TEXT: Record<ViewerStatus, string> = {
  idle: '请输入电脑端显示的 6 位配对码',
  waiting: '正在等待电脑端的 Offer…',
  answering: '已收到 Offer,正在生成 Answer 并回传…',
  connecting: '正在建立 P2P 连接…',
  connected: '已连接',
  disconnected: '连接已断开',
  error: '出现问题',
};

interface SessionResponse {
  code: string;
  offer: string | null;
  answer: string | null;
  createdAt: string;
}

export default function ViewPage() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const samplerRef = useRef<ReturnType<typeof createStatsSampler> | null>(null);
  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  const activeRef = useRef(false);
  const statusRef = useRef<ViewerStatus>('idle');

  const [input, setInput] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<ViewerStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [countdown, setCountdown] = useState(Math.round(OFFER_WAIT_TIMEOUT_MS / 1000));
  const [stats, setStats] = useState<MediaStatsSnapshot | null>(null);
  const [iceState, setIceState] = useState('new');
  const [supportWarning, setSupportWarning] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    setSupportWarning(checkViewerSupport());
  }, []);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 支持 ?code=123456 自动填入
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const fromUrl = new URLSearchParams(window.location.search).get('code') ?? '';
    const digits = fromUrl.replace(/\D/g, '').slice(0, PAIR_CODE_LENGTH);
    if (digits.length > 0) setInput(digits);
  }, []);

  // 第一次渲染后把焦点给输入框(不用 autoFocus 属性,避免无障碍问题)
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 连接期间显示等待倒计时
  useEffect(() => {
    if (status !== 'waiting') return;
    setCountdown(Math.round(OFFER_WAIT_TIMEOUT_MS / 1000));
    const timer = window.setInterval(() => {
      setCountdown((value) => (value > 0 ? value - 1 : 0));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [status]);

  // 全屏状态同步
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  /**
   * 设备端诊断追踪。
   *
   * 平板连不上时最难判断的是"卡在哪一步":HTTP 打不开?拿到 offer 了但 ICE 不通?
   * 还是连上了但没画面?把这些阶段显式记下来,并显示在页面上,
   * 用户直接截图就能定位,不用靠猜。
   */
  const traceLinesRef = useRef<string[]>([]);
  const [traceOpen, setTraceOpen] = useState(false);
  const trace = useCallback((text: string) => {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${text}`;
    traceLinesRef.current.push(line);
    if (traceLinesRef.current.length > 120) traceLinesRef.current.shift();
    console.info('[第二块屏/平板] ' + text);
    try {
      sessionStorage.setItem('vd-view-trace', traceLinesRef.current.join('\n'));
    } catch {
      /* 忽略 */
    }
  }, []);

  const stopConnection = useCallback((nextStatus: ViewerStatus, message?: string) => {
    activeRef.current = false;
    if (pollRef.current) pollRef.current.cancelled = true;
    if (pcRef.current) {
      const state = pcRef.current.connectionState;
      const ice = pcRef.current.iceConnectionState;
      try {
        pcRef.current.close();
      } catch {
        /* ignore */
      }
      pcRef.current = null;
      trace(`清理连接(connectionState=${state}, ice=${ice})${message ? ' —— ' + message : ''}`);
    } else if (message) {
      trace('清理连接 —— ' + message);
    }
    samplerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setStats(null);
    setIceState('new');
    setStatus(nextStatus);
    setError(message ?? null);
  }, [trace]);

  useEffect(() => () => stopConnection('disconnected'), [stopConnection]);

  // Ctrl+Shift+D 开关诊断面板
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        setTraceOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 轮询等待电脑端的 Offer,拿到后生成 Answer 回传 */
  const waitForOffer = useCallback(
    async (pairCode: string, pc: RTCPeerConnection) => {
      const token = { cancelled: false };
      pollRef.current = token;
      const deadline = Date.now() + OFFER_WAIT_TIMEOUT_MS;

      while (!token.cancelled && activeRef.current && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        if (token.cancelled || !activeRef.current) return;

        let data: SessionResponse;
        try {
          const res = await apiFetch(`/api/session/${pairCode}`, { cache: 'no-store' });
          if (res.status === 404) {
            trace('查询配对码:404,会话不存在或已过期');
            stopConnection('error', '配对码不存在或会话已过期,请在电脑端重新开始共享。');
            return;
          }
          if (!res.ok) {
            trace(`查询配对码:HTTP ${res.status},继续等待`);
            continue;
          }
          data = (await res.json()) as SessionResponse;
        } catch (caught) {
          // 请求本身失败通常意味着网络层不通(防火墙 / 不同网段)
          trace('查询配对码失败(网络层):' + (caught instanceof Error ? caught.message : String(caught)));
          continue;
        }

        if (!data.offer) continue;
        trace('已拿到 offer,长度 ' + data.offer.length);
        if (data.answer) {
          // 该会话已经有人应答过,避免重复协商
          setNotice('这个配对码已经被其他设备连上了。如果画面不是你想要的,请让电脑端重新开始共享。');
        }

        try {
          setStatus('answering');
          const payload = decodeSdpPayload(data.offer);
          await applyRemoteDescription(pc, payload);
          trace('已应用远端 offer');
        } catch (caught) {
          stopConnection('error', `Offer 解析或应用失败:${caught instanceof Error ? caught.message : '未知错误'}`);
          return;
        }

        try {
          const built = await buildLocalDescription(pc, 'answer');
          trace(`已生成 answer,候选者 ${built.candidateCount} 个,ICE 完整=${built.complete}`);
          const posted = await apiFetch(`/api/session/${pairCode}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'answer',
              sdp: encodeSdpPayload(built.payload),
            }),
          });
          if (!posted.ok) {
            const body = (await posted.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `回传 Answer 失败(HTTP ${posted.status})`);
          }
          trace('answer 已回传,等待 P2P 建立');
          if (!built.complete) {
            setNotice('本地 ICE 收集超时(已用 4 秒),已提交当前 SDP,连接可能稍慢。');
          }
          setStatus('connecting');
        } catch (caught) {
          stopConnection('error', caught instanceof Error ? caught.message : '回传 Answer 失败。');
        }
        return;
      }

      if (activeRef.current && !token.cancelled) {
        trace('等待 offer 超时');
        stopConnection('error', '等待电脑端 Offer 超时(60 秒)。请确认电脑端已经开始共享,并且配对码输入正确。');
      }
    },
    [stopConnection, trace],
  );

  const connect = useCallback(
    async (rawCode: string) => {
      const pairCode = rawCode.replace(/\D/g, '').slice(0, PAIR_CODE_LENGTH);
      if (pairCode.length !== PAIR_CODE_LENGTH) {
        setError(`配对码必须是 ${PAIR_CODE_LENGTH} 位数字。`);
        return;
      }

      const problem = checkViewerSupport();
      if (problem) {
        setError(problem);
        setStatus('error');
        return;
      }

      setError(null);
      setNotice(null);
      setCode(pairCode);
      activeRef.current = true;
      setStatus('waiting');

      // 把配对码写进地址栏,刷新后仍能自动填入
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href);
        url.searchParams.set('code', pairCode);
        window.history.replaceState(null, '', url.toString());
      }

      const pc = createPeerConnection('viewer');
      pcRef.current = pc;

      // 只收视频,并把抖动缓冲压到 0 换取最低延迟
      prepareReceiveOnlyVideo(pc);

      pc.addEventListener('iceconnectionstatechange', () => {
        setIceState(pc.iceConnectionState);
        trace('ICE 状态 -> ' + pc.iceConnectionState);
      });
      pc.addEventListener('icecandidateerror', (event) => {
        const e = event as RTCPeerConnectionIceErrorEvent;
        trace(`ICE 候选者错误 ${e.errorCode} ${e.errorText || ''} @ ${e.url || '(无)'}`);
      });
      pc.addEventListener('connectionstatechange', () => {
        const state = pc.connectionState;
        trace('连接状态 -> ' + state);
        if (state === 'connected') {
          setStatus('connected');
          void videoRef.current?.play().catch(() => setAutoplayBlocked(true));
        } else if (state === 'failed') {
          stopConnection('error', 'P2P 连接失败。请确认平板与电脑在同一 Wi-Fi,并让电脑端重新开始共享。');
        } else if (state === 'disconnected' && statusRef.current === 'connected') {
          setStatus('disconnected');
        }
      });

      pc.addEventListener('track', (event) => {
        const [stream] = event.streams;
        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream ?? new MediaStream([event.track]);
        video.muted = true;
        trace('已收到视频轨道');
        void video.play().catch(() => setAutoplayBlocked(true));
      });

      trace('开始等待 offer,配对码 ' + pairCode);
      samplerRef.current = createStatsSampler(pc, 'inbound-rtp');
      void waitForOffer(pairCode, pc);
    },
    [stopConnection, trace, waitForOffer],
  );

  // 连接后每秒刷新接收端统计
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      const sampler = samplerRef.current;
      const current = statusRef.current;
      if (!pc || !sampler) return;
      if (current !== 'connecting' && current !== 'connected' && current !== 'disconnected') return;
      try {
        setStats(await sampler.sample());
      } catch {
        /* ignore */
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const target = videoRef.current?.parentElement ?? videoRef.current;
    if (!target) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void target.requestFullscreen?.().catch(() => undefined);
    }
  }, []);

  const reset = useCallback(() => {
    stopConnection('idle');
    setCode(null);
    setNotice(null);
    if (typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('code');
      window.history.replaceState(null, '', url.toString());
    }
  }, [stopConnection]);

  const isConnected = status === 'connected';
  const showVideoStage = code !== null && status !== 'idle' && status !== 'error';
  const canSubmit = input.replace(/\D/g, '').length === PAIR_CODE_LENGTH;

  const statusLine = useMemo(() => {
    if (status === 'waiting') return `${STATUS_TEXT.waiting}(${countdown} 秒后超时)`;
    return STATUS_TEXT[status];
  }, [status, countdown]);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-16 sm:px-6">
      {/* 诊断面板:Ctrl+Shift+D 开关,连不上时用来定位卡在哪一步 */}
      {traceOpen ? (
        <div className="fixed inset-x-3 top-3 z-50 max-h-[70vh] overflow-auto rounded-xl border border-cyan-400/40 bg-slate-950/95 p-4 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-cyan-200">平板端诊断(Ctrl+Shift+D 关闭)</p>
            <button type="button" className="vd-btn" onClick={() => setTraceOpen(false)}>
              关闭
            </button>
          </div>
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-300">
            {traceLinesRef.current.join('\n') || '(暂无记录,请先点一次「连接」)'}
          </pre>
        </div>
      ) : null}
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-lg">
            📱
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-100">平板端 · 接收电脑画面</p>
            <p className="text-xs text-slate-500">输入配对码即可,无需安装任何应用</p>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/" className="vd-btn">
            技术概览
          </Link>
          <Link href="/host" className="vd-btn">
            💻 电脑端
          </Link>
        </nav>
      </header>

      {supportWarning ? (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {supportWarning}
        </div>
      ) : null}

      {/* ---------- 输入配对码 ---------- */}
      {code === null ? (
        <section className="vd-card mx-auto max-w-xl p-6 sm:p-8">
          <h1 className="text-center text-xl font-bold text-slate-100">输入 6 位配对码</h1>
          <p className="mt-2 text-center text-sm text-slate-400">
            配对码显示在电脑端的页面上,由 6 位数字组成。
          </p>

          <form
            className="mt-6"
            onSubmit={(event) => {
              event.preventDefault();
              void connect(input);
            }}
          >
            <input
              ref={inputRef}
              className="vd-code-input"
              value={input}
              onChange={(event) => setInput(event.target.value.replace(/\D/g, '').slice(0, PAIR_CODE_LENGTH))}
              onPaste={(event) => {
                event.preventDefault();
                const text = event.clipboardData.getData('text');
                setInput(text.replace(/\D/g, '').slice(0, PAIR_CODE_LENGTH));
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={PAIR_CODE_LENGTH}
              placeholder="000000"
              aria-label="6 位配对码"
            />

            <button type="submit" className="vd-btn vd-btn-primary mt-5 w-full py-3 text-base" disabled={!canSubmit}>
              ▶ 连接电脑
            </button>
          </form>

          {error ? (
            <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>
          ) : null}

          <ul className="mt-6 space-y-1.5 text-xs leading-relaxed text-slate-500">
            <li>· 平板与电脑要连同一个 Wi-Fi(或同一个局域网)。</li>
            <li>· 电脑端页面必须已经点击“开始共享”,否则这里会一直等不到 Offer。</li>
            <li>· 也可以扫描 / 打开电脑端给出的链接,配对码会自动填入。</li>
          </ul>
        </section>
      ) : null}

      {/* ---------- 连接状态 ---------- */}
      {code !== null ? (
        <div className="vd-panel mb-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-3">
            <span
              className="vd-status-dot"
              data-state={
                status === 'connected' ? 'live' : status === 'error' || status === 'disconnected' ? 'error' : 'busy'
              }
            />
            <div>
              <p className="text-sm text-slate-200">{statusLine}</p>
              <p className="text-xs text-slate-500">
                配对码 <span className="font-mono text-slate-400">{code}</span> · ICE 状态{' '}
                <span className="font-mono text-slate-400">{iceState}</span>
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button type="button" className="vd-btn" onClick={toggleFullscreen}>
              {isFullscreen ? '⤢ 退出全屏' : '⤢ 全屏'}
            </button>
            <button type="button" className="vd-btn" onClick={reset}>
              ↻ 换个配对码
            </button>
          </div>
        </div>
      ) : null}

      {notice ? (
        <p className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
          {notice}
        </p>
      ) : null}

      {error && code !== null ? (
        <p className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</p>
      ) : null}

      {status === 'disconnected' && code ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <span>画面已经断开。可能是电脑端停止了共享,或者网络发生了切换。</span>
          <button
            type="button"
            className="vd-btn"
            onClick={() => {
              const retryCode = code;
              stopConnection('idle');
              void connect(retryCode);
            }}
          >
            重新连接
          </button>
        </div>
      ) : null}

      {/* ---------- 视频 ---------- */}
      {showVideoStage ? (
        <section className="vd-card overflow-hidden p-3 sm:p-4">
          <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-black">
            <video
              ref={videoRef}
              className="aspect-video w-full bg-black object-contain"
              autoPlay
              muted
              playsInline
              controls={false}
            />

            {!isConnected ? (
              <div className="absolute inset-0 grid place-items-center bg-slate-950/70 text-center">
                <div className="px-6">
                  <div className="mx-auto h-10 w-10 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-300" />
                  <p className="mt-4 text-sm text-slate-300">{statusLine}</p>
                  {status === 'waiting' ? (
                    <p className="mt-1 text-xs text-slate-500">
                      请确认电脑端已经点击“开始共享”,并且配对码是 {code}。
                    </p>
                  ) : null}
                </div>
              </div>
            ) : null}

            {autoplayBlocked && isConnected ? (
              <button
                type="button"
                className="vd-btn vd-btn-primary absolute bottom-4 left-1/2 -translate-x-1/2"
                onClick={() => {
                  setAutoplayBlocked(false);
                  void videoRef.current?.play().catch(() => setAutoplayBlocked(true));
                }}
              >
                ▶ 点击开始播放
              </button>
            ) : null}
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="画面分辨率" value={stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '—'} />
            <Stat
              label="帧率"
              value={stats?.framesPerSecond !== null && stats?.framesPerSecond !== undefined ? `${Math.round(stats.framesPerSecond)} fps` : '—'}
            />
            <Stat
              label="接收码率"
              value={stats?.bitrateMbps !== null && stats?.bitrateMbps !== undefined ? `${stats.bitrateMbps.toFixed(2)} Mbps` : '—'}
            />
            <Stat label="抖动" value={stats?.jitterMs !== null && stats?.jitterMs !== undefined ? `${stats.jitterMs} ms` : '—'} />
            <Stat label="丢包" value={stats?.packetsLost !== null && stats?.packetsLost !== undefined ? String(stats.packetsLost) : '—'} />
          </div>

          <p className="mt-3 text-xs leading-relaxed text-slate-500">
            为了把延迟压到最低,接收端把 jitterBufferTarget 设为 0(仅在 Chrome / Edge 生效),因此画面在弱网时可能出现轻微卡顿。
            若要点“全屏”,浏览器会隐藏地址栏,平板基本就是一块副屏了。
          </p>
        </section>
      ) : null}

      {isConnected ? (
        <p className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-200">
          已连接成功。视频流在电脑与平板之间点对点传输,不经过服务器;服务器只保存了这次会话的 SDP,2 小时后自动清理。
        </p>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="vd-panel px-3 py-2">
      <p className="text-[0.7rem] text-slate-500">{label}</p>
      <p className="mt-0.5 font-mono text-sm text-slate-200">{value}</p>
    </div>
  );
}
