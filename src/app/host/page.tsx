'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import CopyButton from '@/components/CopyButton';
import { apiFetch } from '@/lib/api';
import { useDesktop } from '@/lib/use-desktop';
import {
  ANSWER_WAIT_TIMEOUT_MS,
  DISPLAY_CAPTURE_CONSTRAINTS,
  MAX_VIDEO_BITRATE,
  PAIR_CODE_LENGTH,
  POLL_INTERVAL_MS,
  addSendOnlyVideoTransceiver,
  applyRemoteDescription,
  applyVideoBitrateCap,
  buildLocalDescription,
  checkHostSupport,
  createPeerConnection,
  createStatsSampler,
  decodeSdpPayload,
  encodeSdpPayload,
  markTrackAsScreenContent,
  sleep,
  type MediaStatsSnapshot,
} from '@/lib/rtc';

type HostStatus = 'idle' | 'capturing' | 'waiting' | 'answering' | 'connected' | 'stopped' | 'error';

interface CreateSessionResponse {
  code?: string;
  error?: string;
}

interface SessionResponse {
  code: string;
  offer: string | null;
  answer: string | null;
  createdAt: string;
}

interface NetworkResponse {
  candidates: { address: string; label: string }[];
  primary: string | null;
}

interface DisplayEntry {
  index: number;
  device: string;
  description: string;
  x: number;
  y: number;
  width: number;
  height: number;
  primary: boolean;
  likelyVirtual: boolean;
}

interface DisplayListResponse {
  displays: DisplayEntry[];
  count: number;
  canExtend: boolean;
  recommendedIndex: number | null;
  recommendedSize: string | null;
}

const STATUS_TEXT: Record<HostStatus, string> = {
  idle: '未开始共享',
  capturing: '正在等待你选择要共享的屏幕…',
  waiting: '已创建会话,等待平板接入',
  answering: '收到平板应答,正在建立 P2P 连接…',
  connected: '已连接,画面正在传输',
  stopped: '已停止共享',
  error: '出现问题',
};

const STATUS_DOT: Record<HostStatus, 'live' | 'busy' | 'error' | 'idle'> = {
  idle: 'idle',
  capturing: 'busy',
  waiting: 'busy',
  answering: 'busy',
  connected: 'live',
  stopped: 'idle',
  error: 'error',
};

/** 对"这一次共享的目标对不对"的判定结果 */
type ShareTargetCheck = { kind: 'ok' | 'hint' | 'warn'; text: string } | null;

/**
 * 判断用户共享的是不是"那块该共享的屏"。
 *
 * 背景:副屏场景要求共享**虚拟显示器**。如果共享的是主屏,平板看到的就是镜像,
 * 但画面完全正常,用户几乎不可能自己发现。浏览器不告诉我们"共享了哪一块",
 * 只给分辨率和 displaySurface,所以这里只能用分辨率做启发式判断。
 *
 * 已知局限:若虚拟屏与主屏分辨率完全相同,仅凭分辨率无法区分 —— 这种情况返回
 * 一条"软提示"而不是断言,避免误报。
 */
function checkShareTarget(
  picked: { width: number; height: number; surface: string | null },
  list: DisplayListResponse | null,
): ShareTargetCheck {
  if (!list || list.displays.length === 0) return null;

  const sizeText = `${picked.width}×${picked.height}`;

  if (picked.surface === 'window' || picked.surface === 'browser') {
    return {
      kind: 'warn',
      text: `你共享的是一个${picked.surface === 'browser' ? '浏览器标签页' : '窗口'},不是整块屏幕。` +
        '副屏需要共享「整块屏幕」,否则桌面不会扩展过去。请停止后重新共享。',
    };
  }

  if (list.displays.length === 1) {
    return {
      kind: 'warn',
      text: '系统里只检测到 1 块屏幕,所以平板看到的是**镜像**,不是扩展屏。' +
        '要真正扩展桌面,需要先装一个虚拟显示驱动(步骤见 README)。',
    };
  }

  const primary = list.displays.find((d) => d.primary);
  const others = list.displays.filter((d) => !d.primary);

  const matchesPrimary = Boolean(primary && primary.width === picked.width && primary.height === picked.height);
  const matchedOther = others.find((d) => d.width === picked.width && d.height === picked.height);

  if (matchedOther && !matchesPrimary) {
    return {
      kind: 'ok',
      text: `已共享扩展屏(${sizeText}),平板看到的应该是扩展桌面而不是镜像。`,
    };
  }

  if (matchesPrimary && !matchedOther) {
    return {
      kind: 'warn',
      text: `你共享的是主屏(${sizeText}),平板看到的会是镜像。` +
        `请停止后重新共享,并在选择器里挑那块 ${list.recommendedSize ?? '扩展'} 的屏幕。`,
    };
  }

  if (matchesPrimary && matchedOther) {
    return {
      kind: 'hint',
      text: `主屏和扩展屏都是 ${sizeText},无法自动判断你选了哪一块。` +
        '如果平板显示的是主屏(镜像)而不是扩展桌面,请重新共享并点另一块。',
    };
  }

  return {
    kind: 'hint',
    text: `你共享的画面是 ${sizeText},和检测到的显示器分辨率都不完全一致(可能是窗口或缩放导致)。` +
      '如果平板看到的是镜像而不是扩展桌面,请重新共享并选择整块屏幕。',
  };
}

export default function HostPage() {
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const samplerRef = useRef<ReturnType<typeof createStatsSampler> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const pollRef = useRef<{ cancelled: boolean } | null>(null);
  const activeRef = useRef(false);
  const statusRef = useRef<HostStatus>('idle');

  const [status, setStatus] = useState<HostStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [streamInfo, setStreamInfo] = useState<string | null>(null);
  const [trackSettings, setTrackSettings] = useState<string | null>(null);
  const [stats, setStats] = useState<MediaStatsSnapshot | null>(null);
  const [iceState, setIceState] = useState<string>('new');
  const [candidateCount, setCandidateCount] = useState<number | null>(null);
  const [supportWarning, setSupportWarning] = useState<string | null>(null);
  const [lanIp, setLanIp] = useState<string | null>(null);

  /** 系统里的显示器列表。副屏场景要靠它判断"该共享哪一块"。 */
  const [displayList, setDisplayList] = useState<DisplayListResponse | null>(null);
  /** 采集后对"是否选错屏"的判定结果 */
  const [shareCheck, setShareCheck] = useState<ShareTargetCheck>(null);

  // 桌面版(.exe)外壳的状态;浏览器里为 null,页面照旧走 Web 逻辑
  const desktop = useDesktop();

  /**
   * 是否运行在桌面壳(WebView2)里。
   *
   * 关键:WebView2 内嵌内核不提供 navigator.mediaDevices,
   * 也就是说在桌面壳内部**无法调用 getDisplayMedia 采集屏幕**。
   * 所以桌面壳里不能直接显示"开始共享",而要引导用户用系统浏览器打开本页。
   */
  const [inDesktopShell, setInDesktopShell] = useState(false);

  useEffect(() => {
    // 桌面壳里 navigator.mediaDevices 直接不存在,这是最可靠的判据
    const noCaptureApi = typeof navigator.mediaDevices?.getDisplayMedia !== 'function';
    setInDesktopShell(noCaptureApi || Boolean(window.virtualdeskDesktop));
  }, []);

  useEffect(() => {
    setSupportWarning(checkHostSupport());
  }, []);

  // 镜像一份状态到 ref,供长生命周期的定时器读取,避免定时器被反复重建
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/network')
      .then((res) => (res.ok ? (res.json() as Promise<NetworkResponse>) : null))
      .then((data) => {
        if (!cancelled && data?.primary) setLanIp(data.primary);
      })
      .catch(() => {
        /* 拿不到局域网地址也不影响主流程 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 系统里有哪些显示器。拿不到就当未知处理,不阻塞共享流程。
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/displays')
      .then((res) => (res.ok ? (res.json() as Promise<DisplayListResponse>) : null))
      .then((data) => {
        if (!cancelled && data) setDisplayList(data);
      })
      .catch(() => {
        /* 老版本宿主没有这个接口,忽略 */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 诊断追踪:把每一步与每次清理都记下来,失败时能一眼看出卡在哪。
   *
   * 同时写三处,可靠性优先:
   *   1. localStorage —— 页面刷新后仍能读到
   *   2. window 上的全局变量 —— 控制台可直接查看
   *   3. 页面里一个隐藏的 <pre> —— 就算存储不可用也能用"查看源代码"看到
   * 只在本机记录,不上传任何地方。
   */
  const traceLines = useRef<string[]>([]);
  const trace = useCallback((text: string) => {
    const line = `${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${text}`;
    traceLines.current.push(line);
    if (traceLines.current.length > 150) traceLines.current.shift();
    const all = traceLines.current.join('\n');

    console.info('[第二块屏] ' + text);

    try {
      localStorage.setItem('vd-trace', all);
    } catch {
      /* 忽略 */
    }
    try {
      (window as unknown as Record<string, unknown>).__vdTrace = all;
    } catch {
      /* 忽略 */
    }
    try {
      let node = document.getElementById('vd-trace-out');
      if (!node) {
        node = document.createElement('pre');
        node.id = 'vd-trace-out';
        node.style.display = 'none';
        document.body.appendChild(node);
      }
      node.textContent = all;
    } catch {
      /* 忽略 */
    }
  }, []);

  /** 清理所有资源,回到 idle/stopped 状态 */
  const teardown = useCallback(
    (nextStatus: HostStatus, message?: string, reason?: string) => {
      // 记录"谁触发了清理"以及当时的轨道状态,这是定位"闪一下就没"的关键
      const trackState = streamRef.current?.getVideoTracks()[0]?.readyState ?? '(无轨道)';
      const connectionState = pcRef.current?.connectionState ?? '(无连接)';
      trace(
        `清理:${nextStatus}${reason ? `,来源=${reason}` : ''}` +
          `${message ? ' / ' + message : ''}(轨道=${trackState},连接=${connectionState})`,
      );

      activeRef.current = false;
      if (pollRef.current) pollRef.current.cancelled = true;
      if (abortRef.current) abortRef.current.abort();
      abortRef.current = null;

      if (pcRef.current) {
        try {
          pcRef.current.getSenders().forEach((sender) => sender.track?.stop());
          pcRef.current.close();
        } catch {
          /* ignore */
        }
        pcRef.current = null;
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      samplerRef.current = null;

      if (previewRef.current) previewRef.current.srcObject = null;

      setStats(null);
      setCandidateCount(null);
      setIceState('new');
      setShareCheck(null);
      setStatus(nextStatus);
      setError(message ?? null);
    },
    [trace],
  );

  // 组件卸载时释放资源。
  // 用 ref 拿最新的 teardown:既保证卸载时一定是最后一次的实现,又避免把 teardown
  // 放进依赖数组 —— 那样每次依赖变化都会先触发一次"清理",把刚建立的采集状态重置掉。
  const teardownRef = useRef(teardown);
  useEffect(() => {
    teardownRef.current = teardown;
  }, [teardown]);
  useEffect(
    () => () => {
      teardownRef.current('stopped', undefined, '组件卸载');
    },
    [],
  );
  /** 轮询等待平板的 Answer */
  const waitForAnswer = useCallback(
    async (pc: RTCPeerConnection, pairCode: string) => {
      const token = { cancelled: false };
      pollRef.current = token;
      const deadline = Date.now() + ANSWER_WAIT_TIMEOUT_MS;
      let applied = false;

      while (!token.cancelled && activeRef.current && Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        if (token.cancelled || !activeRef.current || applied) break;

        try {
          const res = await apiFetch(`/api/session/${pairCode}`, { cache: 'no-store' });
          if (res.status === 404) {
            teardown('error', '会话已过期,请重新开始共享。', '轮询遇到 404');
            return;
          }
          if (!res.ok) continue;

          const data = (await res.json()) as SessionResponse;
          if (!data.answer) continue;

          setStatus('answering');
          const payload = decodeSdpPayload(data.answer);
          await applyRemoteDescription(pc, payload);
          applied = true;
          await applyVideoBitrateCap(pc, MAX_VIDEO_BITRATE);
        } catch (caught) {
          // 解析或协商失败:保持轮询,等待有效应答覆盖
          console.warn('[host] 应用 answer 失败,继续等待:', caught);
        }
      }

      if (!applied && activeRef.current && !token.cancelled) {
        teardown('error', '等待平板接入超时,请点击“重新开始”再试一次。', '等待 answer 超时');
      }
    },
    [teardown],
  );

  const startSharing = useCallback(async () => {
    // 第一件事就记下来:哪怕后面卡在系统选择器上,也能看出"流程已开始"
    trace('===== 开始共享流程 =====');

    setError(null);
    setCode(null);
    setStats(null);

    const step = trace;

    const problem = checkHostSupport();
    if (problem) {
      step('前置检查未通过:' + problem);
      setSupportWarning(problem);
      setStatus('error');
      setError(problem);
      return;
    }

    step('前置检查通过,准备调用 getDisplayMedia');
    setStatus('capturing');
    activeRef.current = true;

    try {
      // 先用理想参数;被系统/硬件拒绝时自动降级,而不是直接失败。
      // 首选参数不限制宽高 —— 副屏场景下虚拟显示器可能是竖屏或 1440p,
      // 写死上限会被降采样。真正的分辨率上限由显示器本身决定。
      const attempts: Array<{ label: string; constraints: DisplayMediaStreamOptions }> = [
        { label: '显示器原生分辨率 · 60fps', constraints: DISPLAY_CAPTURE_CONSTRAINTS },
        {
          label: '720p30(降级)',
          constraints: {
            video: {
              frameRate: { ideal: 30, max: 30 },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          },
        },
        { label: '浏览器默认(再次降级)', constraints: { video: true, audio: false } },
      ];

      let stream: MediaStream | null = null;
      let lastError: unknown = null;

      for (const attempt of attempts) {
        step(`已发出 getDisplayMedia 请求(参数:${attempt.label}),等待你在系统弹窗里选择共享目标…`);
        try {
          stream = await navigator.mediaDevices.getDisplayMedia(attempt.constraints);
          if (attempt.label !== '显示器原生分辨率 · 60fps') {
            step(`已降级为「${attempt.label}」并采集成功`);
          }
          break;
        } catch (captureError) {
          lastError = captureError;
          const described = describeCaptureError(captureError);
          step(`getDisplayMedia 失败(${attempt.label}):${described}`);

          // 用户主动取消就不该继续换参数重试,否则会反复弹窗
          if (captureError instanceof DOMException && captureError.name === 'NotAllowedError') {
            throw captureError;
          }
        }
      }

      if (!stream) throw lastError ?? new Error('屏幕采集失败。');

      streamRef.current = stream;
      step(`getDisplayMedia 成功,轨道数 ${stream.getTracks().length}`);

      const [track] = stream.getVideoTracks();
      if (!track) throw new Error('没有拿到视频轨道,请重新选择共享目标。');

      step(`拿到视频轨道:${track.label || '(无标签)'},readyState=${track.readyState}`);

      // 屏幕内容优先保清晰度,而不是保流畅度
      markTrackAsScreenContent(track);
      setTrackSettings(describeTrack(track));
      setStreamInfo(track.label || '屏幕共享');
      step('轨道参数:' + describeTrack(track));

      // 副屏场景最容易犯的错:选择器里点成了主屏,于是平板看到的是镜像。
      // 画面本身完全正常,用户不会察觉,所以这里主动核对一次。
      const chosen = track.getSettings();
      const picked = {
        width: chosen.width ?? 0,
        height: chosen.height ?? 0,
        surface: chosen.displaySurface ?? null,
      };
      step(`共享目标:${picked.width}×${picked.height},surface=${picked.surface ?? '未知'}`);
      const targetCheck = checkShareTarget(picked, displayList);
      setShareCheck(targetCheck);
      if (targetCheck) step(`共享目标判定(${targetCheck.kind}):${targetCheck.text}`);

      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        previewRef.current.muted = true;
        void previewRef.current.play().catch(() => undefined);
        step('已挂到本地预览');
      }

      const pc = createPeerConnection('host');
      pcRef.current = pc;

      pc.addEventListener('iceconnectionstatechange', () => setIceState(pc.iceConnectionState));
      pc.addEventListener('connectionstatechange', () => {
        step('连接状态变为 ' + pc.connectionState);
        if (pc.connectionState === 'failed') {
          teardown('error', 'P2P 连接建立失败。请确认两端在同一局域网,或稍后重试。', 'connectionState=failed');
        }
      });

      addSendOnlyVideoTransceiver(pc, track);
      await applyVideoBitrateCap(pc, MAX_VIDEO_BITRATE);
      step('已创建 PeerConnection 并加入发送轨道');

      // 共享被系统或用户终止时自动复位
      track.addEventListener('ended', () => {
        step('视频轨道 ended 事件触发(共享被系统或用户终止)');
        if (activeRef.current) teardown('stopped', '屏幕共享已被停止。', '视频轨道 ended');
      });

      const built = await buildLocalDescription(pc, 'offer');
      setCandidateCount(built.candidateCount);
      step(`已生成 offer,候选者 ${built.candidateCount} 个,ICE 收集完整=${built.complete}`);
      if (!built.complete) {
        setError('ICE 候选者收集超时(已用 4 秒),仍继续提交 SDP,连接可能稍慢。');
      }

      const created = await apiFetch('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ offer: encodeSdpPayload(built.payload) }),
      });

      const createdBody = (await created.json()) as CreateSessionResponse;
      if (!created.ok || !createdBody.code) {
        throw new Error(createdBody.error ?? `创建会话失败(HTTP ${created.status})`);
      }

      setCode(createdBody.code);
      setStatus('waiting');

      // 每秒采样一次发送端统计
      const sampler = createStatsSampler(pc, 'outbound-rtp');
      samplerRef.current = sampler;

      void waitForAnswer(pc, createdBody.code);
    } catch (caught) {
      const message = describeCaptureError(caught);
      step('流程失败:' + message);
      if (caught instanceof Error && caught.stack) step('堆栈:' + caught.stack.split('\n')[1]?.trim());
      teardown('error', message, 'startSharing 抛异常');
    }
  }, [teardown, waitForAnswer, trace, displayList]);

  // 连接建立后持续刷新统计信息(定时器只创建一次,通过 ref 读取最新状态)
  useEffect(() => {
    const timer = window.setInterval(async () => {
      const pc = pcRef.current;
      const sampler = samplerRef.current;
      const current = statusRef.current;
      if (!pc || !sampler) return;
      if (current !== 'waiting' && current !== 'answering' && current !== 'connected') return;

      try {
        setStats(await sampler.sample());
      } catch {
        /* getStats 偶发失败,忽略 */
      }

      if (pc.connectionState === 'connected' && current !== 'connected') {
        setStatus('connected');
      } else if (
        (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') &&
        current === 'connected'
      ) {
        setStatus('stopped');
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const { shareUrl, lanUrl, lanLabel } = useMemo(() => {
    if (!code || typeof window === 'undefined') {
      return { shareUrl: null, lanUrl: null, lanLabel: null };
    }

    // 桌面版:主进程已经算出"平板该用哪个地址",直接用它拼配对码
    if (desktop?.lanUrl) {
      const base = desktop.lanUrl.split('?')[0];
      return {
        shareUrl: `${window.location.origin}/view?code=${code}`,
        lanUrl: `${base}?code=${code}`,
        lanLabel: desktop.lanCandidates[0]?.address ?? null,
      };
    }

    const port = window.location.port || '3000';
    return {
      shareUrl: `${window.location.origin}/view?code=${code}`,
      lanUrl: lanIp ? `http://${lanIp}:${port}/view?code=${code}` : null,
      lanLabel: lanIp,
    };
  }, [code, lanIp, desktop]);

  const isBusy = status === 'capturing' || status === 'waiting' || status === 'answering';
  const isLive = status === 'connected';

  /** 诊断面板:显示最近的操作步骤,失败时可以直接截图给我 */
  const [traceOpen, setTraceOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Ctrl+Shift+D 切换诊断面板
      if (event.ctrlKey && event.shiftKey && (event.key === 'D' || event.key === 'd')) {
        event.preventDefault();
        setTraceOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** 在系统浏览器里打开共享页(桌面壳内无法采集屏幕,只能这么办) */
  const openInSystemBrowser = useCallback(() => {
    const url = `${window.location.origin}/host`;
    // 桌面壳提供了走系统默认浏览器打开的通道
    if (window.virtualdeskDesktop?.openExternal) {
      void window.virtualdeskDesktop.openExternal(url);
      return;
    }
    window.open(url, '_blank', 'noopener');
  }, []);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-20 sm:px-6">
      {/* 诊断面板:按 Ctrl+Shift+D 开关 */}
      {traceOpen ? (
        <div className="fixed inset-x-3 top-3 z-50 max-h-[70vh] overflow-auto rounded-xl border border-cyan-400/40 bg-slate-950/95 p-4 shadow-2xl">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-cyan-200">诊断步骤(Ctrl+Shift+D 关闭)</p>
            <button type="button" className="vd-btn" onClick={() => setTraceOpen(false)}>
              关闭
            </button>
          </div>
          <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap text-slate-300">
            {traceLines.current.join('\n') || '(暂无记录,请先点一次“开始共享”)'}
          </pre>
        </div>
      ) : null}
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-lg">
            💻
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-100">电脑端 · 共享这一台电脑的屏幕</p>
            <p className="text-xs text-slate-500">
              {desktop
                ? `桌面版 · 内置数据库已就绪${desktop.version ? ` · v${desktop.version}` : ''}`
                : '采集 1080p60 · 码率上限 8 Mbps · 视频点对点直传'}
            </p>
          </div>
        </div>
        <nav className="flex items-center gap-2 text-sm">
          <Link href="/" className="vd-btn">
            技术概览
          </Link>
          <Link href="/view" className="vd-btn">
            📱 平板端
          </Link>
        </nav>
      </header>

      {supportWarning ? (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200">
          {supportWarning}
        </div>
      ) : null}

      {/* ---------- 桌面壳内的引导:内嵌内核无法采集屏幕,必须换到系统浏览器 ---------- */}
      {inDesktopShell ? (
        <section className="vd-card mb-5 p-5 sm:p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-amber-200">
            <span aria-hidden>⚠️</span>
            需要在本机浏览器里开始共享
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-slate-300">
            当前窗口是桌面壳的内嵌浏览器(WebView2)。为了保证安全,它的内核
            <span className="text-amber-200">没有提供屏幕采集接口</span>
            (<span className="font-mono text-xs">navigator.mediaDevices</span> 不存在),
            所以在这里点“开始共享”一定会失败。
          </p>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            共享本身仍然是<strong className="text-slate-300">本机对平板</strong>的点对点传输,和浏览器无关 ——
            只是“采集哪块屏幕”这个动作必须由真正的浏览器来做。
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="vd-btn vd-btn-primary" onClick={openInSystemBrowser}>
              🌐 用系统浏览器打开共享页
            </button>
            <button
              type="button"
              className="vd-btn"
              onClick={() => window.virtualdeskDesktop?.openExternal(`${window.location.origin}/view`)}
            >
              📱 用系统浏览器打开接收页
            </button>
          </div>

          <p className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-3 font-mono text-xs break-all text-slate-400">
            {typeof window !== 'undefined' ? `${window.location.origin}/host` : '/host'}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            在这个地址上打开共享页即可;配对码会自动显示,平板用局域网链接接入。
          </p>
        </section>
      ) : null}

      <div className={`grid gap-5 lg:grid-cols-[1.35fr_1fr] ${inDesktopShell ? 'hidden' : ''}`}>
        {/* ---------- 左侧:本地预览 ---------- */}
        <section className="vd-card p-4 sm:p-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold text-slate-200">本地预览</h2>
            <span className="flex items-center gap-2 text-xs text-slate-400">
              <span className="vd-status-dot" data-state={STATUS_DOT[status]} />
              {STATUS_TEXT[status]}
            </span>
          </div>

          <div className="relative overflow-hidden rounded-xl border border-slate-800 bg-black/60">
            <video
              ref={previewRef}
              className="aspect-video w-full bg-black object-contain"
              autoPlay
              muted
              playsInline
            />
            {status === 'idle' ? (
              <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
                <div>
                  <p className="text-3xl">🖥️</p>
                  <p className="mt-3 text-sm text-slate-400">点击右侧“开始共享”,选择要共享的屏幕</p>
                </div>
              </div>
            ) : null}
          </div>

          {/* 副屏引导:告诉他该选哪一块屏 */}
          {displayList ? (
            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs">
              {displayList.canExtend ? (
                <>
                  <p className="flex items-center gap-2 font-semibold text-emerald-300">
                    <span>✅</span>
                    检测到 {displayList.count} 块屏幕 · 可以扩展
                  </p>
                  <p className="mt-2 leading-relaxed text-slate-400">
                    点「开始共享」后,在选择器里请选
                    {displayList.recommendedSize ? (
                      <span className="mx-1 font-mono text-cyan-300">{displayList.recommendedSize}</span>
                    ) : (
                      ' 非主屏那一块 '
                    )}
                    —— 那才是扩展屏。选成主屏的话,平板看到的会是镜像。
                  </p>
                  <ul className="mt-2.5 space-y-1">
                    {displayList.displays.map((d) => (
                      <li key={d.device} className="flex items-center gap-2 text-slate-500">
                        <span className="font-mono">
                          {d.width}×{d.height}
                        </span>
                        <span>{d.primary ? '主屏(笔记本自带)' : d.likelyVirtual ? '虚拟副屏' : '扩展屏'}</span>
                        {d.index === displayList.recommendedIndex ? (
                          <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-cyan-300">选这块</span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p className="flex items-center gap-2 font-semibold text-amber-300">
                    <span>⚠</span>
                    只检测到 1 块屏幕 · 当前只能镜像
                  </p>
                  <p className="mt-2 leading-relaxed text-slate-400">
                    平板会显示这块屏的复制品,不能把桌面扩展过去 —— 因为系统里还没有第二块屏。
                    要真扩展到平板,需要先装一个虚拟显示驱动。
                  </p>
                  <Link href="/" className="mt-2 inline-block text-cyan-300 underline-offset-2 hover:underline">
                    了解为什么需要虚拟显示驱动 →
                  </Link>
                </>
              )}
            </div>
          ) : null}

          {/* 采集后的目标核对结果 */}
          {shareCheck ? (
            <div
              className={`mt-3 rounded-xl border p-4 text-xs leading-relaxed ${
                shareCheck.kind === 'ok'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200'
                  : shareCheck.kind === 'hint'
                    ? 'border-slate-700 bg-slate-900/60 text-slate-300'
                    : 'border-amber-500/40 bg-amber-500/10 text-amber-200'
              }`}
            >
              {shareCheck.text}
            </div>
          ) : null}

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="编码分辨率" value={stats?.width && stats?.height ? `${stats.width}×${stats.height}` : '—'} />
            <Stat
              label="实时帧率"
              value={stats?.framesPerSecond !== null && stats?.framesPerSecond !== undefined ? `${Math.round(stats.framesPerSecond)} fps` : '—'}
            />
            <Stat
              label="发送码率"
              value={stats?.bitrateMbps !== null && stats?.bitrateMbps !== undefined ? `${stats.bitrateMbps.toFixed(2)} Mbps` : '—'}
            />
            <Stat
              label="往返时延"
              value={stats?.roundTripTimeMs !== null && stats?.roundTripTimeMs !== undefined ? `${stats.roundTripTimeMs} ms` : '—'}
            />
          </div>

          <dl className="mt-4 space-y-1.5 text-xs text-slate-500">
            <div className="flex justify-between gap-4">
              <dt>采集源</dt>
              <dd className="truncate text-slate-400">{streamInfo ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>轨道参数</dt>
              <dd className="truncate font-mono text-slate-400">{trackSettings ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>编码器 / 编码格式</dt>
              <dd className="truncate font-mono text-slate-400">{stats?.codec ?? '—'}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>ICE 状态 / 候选者</dt>
              <dd className="font-mono text-slate-400">
                {iceState}
                {candidateCount === null ? '' : ` · ${candidateCount} 个候选`}
              </dd>
            </div>
          </dl>
        </section>

        {/* ---------- 右侧:配对与操作 ---------- */}
        <section className="space-y-4">
          <div className="vd-card p-5">
            <h2 className="text-sm font-semibold text-slate-200">配对码</h2>
            <p className="mt-1 text-xs text-slate-500">
              在平板上打开平板端页面,输入这 {PAIR_CODE_LENGTH} 位数字;或直接用下面的链接。
            </p>

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-5 text-center">
              <p
                data-testid="pair-code"
                aria-live="polite"
                className="font-mono text-4xl tracking-[0.35em] text-cyan-300 sm:text-5xl"
              >
                {code ?? '— — — — — —'}
              </p>
            </div>

            {code ? (
              <div className="mt-4 space-y-3">
                {lanUrl ? (
                  <div className="vd-panel p-3">
                    <p className="text-xs text-slate-500">
                      平板访问链接(推荐{lanLabel ? ` · 网卡 ${lanLabel}` : ''})
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-emerald-300">{lanUrl}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <CopyButton value={lanUrl} label="复制局域网链接" />
                      <button
                        type="button"
                        className="vd-btn"
                        onClick={() => {
                          if (desktop) void window.virtualdeskDesktop?.openExternal(lanUrl);
                          else window.open(lanUrl, '_blank', 'noopener');
                        }}
                      >
                        {desktop ? '用系统浏览器打开' : '在新标签页打开'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {shareUrl ? (
                  <div className="vd-panel p-3">
                    <p className="text-xs text-slate-500">
                      {desktop ? '本机地址(桌面版内部使用,平板访问不到)' : '当前地址'}
                    </p>
                    <p className="mt-1 break-all font-mono text-xs text-slate-400">{shareUrl}</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <CopyButton value={shareUrl} label="复制本机链接" />
                      <Link href={`/view?code=${code}`} className="vd-btn" target={desktop ? '_blank' : undefined}>
                        在本机打开平板端
                      </Link>
                    </div>
                  </div>
                ) : null}

                {!lanUrl ? (
                  <p className="text-xs leading-relaxed text-amber-300/80">
                    没有探测到局域网地址,平板暂时连不上。请确认电脑已连上 Wi-Fi 或网线;若是浏览器版,还需要用电脑的局域网
                    IP 重新打开本页(例如
                    <span className="font-mono"> http://192.168.1.10:3000/host</span>)。桌面版会自动处理这一步。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="vd-card p-5">
            <h2 className="text-sm font-semibold text-slate-200">操作</h2>
            <div className="mt-3 flex flex-wrap gap-3">
              <button
                type="button"
                className="vd-btn vd-btn-primary flex-1"
                onClick={() => {
                  teardown('idle', undefined, '重新开始按钮');
                  void startSharing();
                }}
                disabled={isBusy}
              >
                {status === 'idle' ? '▶ 开始共享' : '↻ 重新开始'}
              </button>
              <button
                type="button"
                className="vd-btn vd-btn-danger flex-1"
                onClick={() => teardown('stopped', undefined, '停止按钮')}
                disabled={status === 'idle' || status === 'stopped'}
              >
                ■ 停止
              </button>
            </div>

            <p className="mt-3 text-xs text-slate-500">
              浏览器会弹窗让你选择共享“整个屏幕”还是某个窗口。选“整个屏幕”时,平板看到的就是完整桌面。
            </p>

            {error ? (
              <p className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs leading-relaxed text-red-200">
                {error}
              </p>
            ) : null}

            {isLive ? (
              <p className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs leading-relaxed text-emerald-200">
                连接已建立:视频走 P2P 直传,服务器只中转了一次 SDP。可以点击左侧预览下方的数据观察码率与帧率变化。
              </p>
            ) : null}
          </div>

          <div className="vd-card p-5 text-xs leading-relaxed text-slate-400">
            <h2 className="text-sm font-semibold text-slate-200">本次连接的技术细节</h2>
            <ul className="mt-3 space-y-1.5">
              <li>· 采集约束:按显示器原生分辨率、最高 60fps、不采集音频(副屏场景不做降采样)</li>
              <li>· contentHint = detail,优先保证文字清晰</li>
              <li>· 码率上限 8 Mbps,通过 sendEncodings 与 setParameters 双重限制</li>
              <li>· 非 trickle ICE:等待候选者收集完成(超时 4 秒)后一次性提交完整 SDP</li>
              <li>· ICE 服务器:公共 STUN(只做地址发现,不做中继)</li>
            </ul>
          </div>
        </section>
      </div>
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

function describeTrack(track: MediaStreamTrack): string {
  const settings = track.getSettings();
  const parts = [
    settings.width && settings.height ? `${settings.width}×${settings.height}` : null,
    settings.frameRate ? `${Math.round(settings.frameRate)}fps` : null,
    track.contentHint ? `hint=${track.contentHint}` : null,
  ].filter(Boolean);
  return parts.join(' · ') || '—';
}

function describeCaptureError(caught: unknown): string {
  if (caught instanceof DOMException) {
    // 把真实的错误名与浏览器给的原因一起带上,便于定位
    const detail = `${caught.name}: ${caught.message}`;

    switch (caught.name) {
      case 'NotAllowedError':
        return `你取消了屏幕选择,或浏览器拒绝了共享权限。(${detail})`;
      case 'NotFoundError':
        return `没有选中任何可共享的屏幕或窗口。(${detail})`;
      case 'NotReadableError':
        return (
          '系统无法读取画面。常见原因:桌面壳没有拿到屏幕采集授权、被安全软件或远程桌面占用,或采集源选择器没有返回结果。' +
          `(${detail})`
        );
      case 'AbortError':
        return `共享被中断,请重试。(${detail})`;
      case 'OverconstrainedError':
        return `当前环境不满足采集参数要求(例如不支持 1080p60)。(${detail})`;
      case 'TypeError':
        return `调用方式不被支持:可能不是安全上下文,或该环境不支持 getDisplayMedia。(${detail})`;
      default:
        return `采集失败:${detail}`;
    }
  }
  if (caught instanceof Error) return `${caught.name}: ${caught.message}`;
  return `未知错误:${String(caught)}`;
}
