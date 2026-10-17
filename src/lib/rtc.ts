/**
 * WebRTC 公共工具:电脑端(/host)与平板端(/view)共用。
 *
 * 设计要点(对应首页「关键技术详解」):
 * 1. 非 trickle 模式:等 ICE 收集完成(或超时)后,把完整 SDP 一次提交给信令接口,
 *    这样信令只需要一次 POST / 一次 PUT,服务器逻辑极简,平板端也无需处理候选者。
 * 2. 只用公共 STUN 做 NAT 穿透,局域网内通常直连成功,视频不经过服务器。
 * 3. 接收端把 jitterBufferTarget 设为 0,牺牲少量抗抖动余量换取最低延迟。
 * 4. 编码侧 1080p / 60fps / 8Mbps 上限,并显式声明 H.264 高清档次,兼顾低延迟与兼容性。
 */

/** 配对码长度:6 位数字 */
export const PAIR_CODE_LENGTH = 6;

/** 会话有效期:2 小时(与后端清理策略一致) */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

/** 轮询信令接口的间隔 */
export const POLL_INTERVAL_MS = 1200;

/** 平板端等待 Offer 的最长时间 */
export const OFFER_WAIT_TIMEOUT_MS = 60_000;

/** 电脑端等待 Answer 的最长时间(略长于平板端,给用户留出输入配对码的时间) */
export const ANSWER_WAIT_TIMEOUT_MS = 90_000;

/** ICE 收集超时:超时后用已收集到的候选者继续,避免无限等待 */
export const ICE_GATHERING_TIMEOUT_MS = 4_000;

/** 视频码率上限 8Mbps */
export const MAX_VIDEO_BITRATE = 8_000_000;

/** 自动降低码率的阈值:每 10 秒统计一次,超过则按 0.8 系数下调 */
export const VIDEO_BITRATE_ADAPT_INTERVAL_MS = 10_000;

/**
 * 采集参数:按显示器原始分辨率、最高 60fps、不采集音频。
 *
 * 为什么不写死宽高上限:副屏场景下目标是一块**虚拟显示器**,它的分辨率由用户
 * 设定 —— 可能是 1920×1080 横屏,也可能是 1200×1920 竖屏,甚至 2560×1440。
 * 早期版本写了 `max: 1920 / 1080`,遇到竖屏或高分辨率虚拟屏会被降采样或裁切,
 * 副屏就"糊了"或"缺一块"。这里去掉硬上限,让浏览器按源的原生分辨率输出;
 * 码率仍由 MAX_VIDEO_BITRATE 控制,带宽不会被无限放大。
 */
export const DISPLAY_CAPTURE_CONSTRAINTS: DisplayMediaStreamOptions = {
  video: {
    frameRate: { ideal: 60, max: 60 },
  },
  audio: false,
};

/**
 * 屏幕内容的 contentHint。
 * 'detail' 让编码器优先保住文字与 UI 细节,而不是一味保帧率。
 */
export const SCREEN_CONTENT_HINT = 'detail' as const;

/** 采集到屏幕轨道后统一做的处理:标注 contentHint,让编码器知道这是屏幕内容 */
export function markTrackAsScreenContent(track: MediaStreamTrack): void {
  track.contentHint = SCREEN_CONTENT_HINT;
}

/** 只做 NAT 穿透,不做中继(服务器只跑信令,不转发媒体流) */
export const RTC_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:stun.miwifi.com:3478' },
  ],
  iceCandidatePoolSize: 4,
  bundlePolicy: 'max-bundle',
};

/** 信令接口里传输的 SDP 结构 */
export type SdpType = 'offer' | 'answer';

export interface SdpPayload {
  type: SdpType;
  sdp: string;
}

/**
 * 把 SDP 序列化成存进数据库的字符串。
 * 全链路统一用这一种编码:JSON.stringify({ type, sdp })。
 */
export function encodeSdpPayload(payload: SdpPayload): string {
  return JSON.stringify(payload);
}

/**
 * 解析数据库里的 SDP 字符串。
 * 兼容早期把整个 payload 又 JSON.stringify 了一遍的写法(双重编码),
 * 解析不出 { type, sdp } 时抛出中文错误,便于界面上直接展示。
 */
export function decodeSdpPayload(raw: string): SdpPayload {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('对端提交的 SDP 不是合法 JSON。');
  }

  // 兼容双重编码:字符串里又是一段 JSON
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error('对端提交的 SDP 不是合法 JSON。');
    }
  }

  if (!value || typeof value !== 'object') {
    throw new Error('对端提交的 SDP 结构不正确。');
  }

  const { type, sdp } = value as { type?: unknown; sdp?: unknown };
  if (type !== 'offer' && type !== 'answer') {
    throw new Error('对端提交的 SDP 缺少合法的 type。');
  }
  if (typeof sdp !== 'string' || !sdp.startsWith('v=')) {
    throw new Error('对端提交的 SDP 内容不合法。');
  }

  return { type, sdp };
}

/**
 * 把当前连接挂到 window 上,方便在浏览器控制台里排查问题,例如:
 *   __virtualdesk.pc.connectionState
 *   __virtualdesk.pc.iceConnectionState
 *   await __virtualdesk.pc.getStats()
 * 只暴露 PeerConnection 对象本身,不涉及任何画面数据。
 */
export interface VirtualDeskDebugHandle {
  pc: RTCPeerConnection;
  role: 'host' | 'viewer';
  at: number;
}

declare global {
  interface Window {
    __virtualdesk?: VirtualDeskDebugHandle;
  }
}

function exposeDebugHandle(pc: RTCPeerConnection, role: 'host' | 'viewer'): void {
  if (typeof window === 'undefined') return;
  window.__virtualdesk = { pc, role, at: Date.now() };
}

interface OfferOptionsWithCodecs extends RTCOfferOptions {
  codecPreferences?: CodecPreference[];
}

/**
 * 编解码能力描述。
 * 这里不用 RTCRtpCodecCapability:部分 TS DOM 版本还没有这个类型。
 */
interface CodecPreference {
  kind: 'video';
  mimeType: string;
  clockRate: number;
}

/** 优先 H.264(硬件编解码覆盖最广、延迟最低),其余编码作为兜底 */
const VIDEO_CODEC_PREFERENCES: CodecPreference[] = [
  { kind: 'video', mimeType: 'video/H264', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP8', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/VP9', clockRate: 90000 },
  { kind: 'video', mimeType: 'video/AV1', clockRate: 90000 },
];

/**
 * 创建 PeerConnection。
 */
export function createPeerConnection(role: 'host' | 'viewer' = 'host'): RTCPeerConnection {
  const pc = new RTCPeerConnection(RTC_CONFIGURATION);
  exposeDebugHandle(pc, role);

  pc.addEventListener('iceconnectionstatechange', () => {
    if (pc.iceConnectionState === 'failed') {
      try {
        pc.restartIce();
      } catch {
        // 老版本浏览器没有 restartIce,忽略
      }
    }
  });

  return pc;
}

/**
 * 等待 ICE 收集完成。带超时保护:超时后直接返回,用已收集的候选者继续。
 * 返回是否在超时前完成,便于界面提示。
 */
export function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs: number = ICE_GATHERING_TIMEOUT_MS,
): Promise<{ complete: boolean; candidateCount: number }> {
  const candidateCount = () => {
    const sdp = pc.localDescription?.sdp;
    if (!sdp) return 0;
    return (sdp.match(/^a=candidate:/gm) ?? []).length;
  };

  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve({ complete: true, candidateCount: candidateCount() });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (complete: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve({ complete, candidateCount: candidateCount() });
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish(true);
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);

    pc.addEventListener('icegatheringstatechange', onChange);
    // 极少数情况下状态在注册监听前就变了
    if (pc.iceGatheringState === 'complete') finish(true);
  });
}

/**
 * 生成待发送的 offer 或 answer(非 trickle,已含全部候选者)。
 */
export async function buildLocalDescription(
  pc: RTCPeerConnection,
  type: SdpType,
  options: { iceTimeoutMs?: number } = {},
): Promise<{ payload: SdpPayload; complete: boolean; candidateCount: number }> {
  if (type === 'offer') {
    const offerOptions: OfferOptionsWithCodecs = {
      offerToReceiveAudio: false,
      offerToReceiveVideo: false,
      codecPreferences: VIDEO_CODEC_PREFERENCES,
    };
    const offer = await pc.createOffer(offerOptions);
    await pc.setLocalDescription(offer);
  } else {
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
  }

  // 远端需要的就是 setLocalDescription 之后的完整 SDP
  const { complete, candidateCount } = await waitForIceGatheringComplete(
    pc,
    options.iceTimeoutMs ?? ICE_GATHERING_TIMEOUT_MS,
  );

  const description = pc.localDescription;
  if (!description) {
    throw new Error('创建本地 SDP 描述失败,请确认浏览器支持 WebRTC。');
  }

  return {
    payload: { type, sdp: description.sdp },
    complete,
    candidateCount,
  };
}

/** 把收到的远端 SDP 应用到连接上 */
export async function applyRemoteDescription(
  pc: RTCPeerConnection,
  payload: SdpPayload,
): Promise<void> {
  await pc.setRemoteDescription({ type: payload.type, sdp: payload.sdp });
}

/**
 * 限制视频发送码率。
 * 两条路径都做:首次 offer 里声明 maxBitrate,后续还可以按需再下调。
 */
export async function applyVideoBitrateCap(
  pc: RTCPeerConnection,
  maxBitrate: number = MAX_VIDEO_BITRATE,
): Promise<void> {
  const senders = pc.getSenders().filter((sender) => sender.track?.kind === 'video');
  for (const sender of senders) {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) continue;
    params.encodings = params.encodings.map((encoding) => ({
      ...encoding,
      maxBitrate,
      // 屏幕内容:优先保证清晰度,不做空间层缩放
      scaleResolutionDownBy: 1,
    }));
    try {
      await sender.setParameters(params);
    } catch {
      // 部分浏览器在协商完成前不允许 setParameters,忽略即可
    }
  }
}

/** 只发送视频、不接收任何媒体(电脑端) */
export function addSendOnlyVideoTransceiver(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
): RTCRtpSender {
  const transceiver = pc.addTransceiver(track, {
    direction: 'sendonly',
    streams: [new MediaStream([track])],
    sendEncodings: [
      {
        maxBitrate: MAX_VIDEO_BITRATE,
        maxFramerate: 60,
        scaleResolutionDownBy: 1,
        priority: 'high',
      },
    ],
  });
  return transceiver.sender;
}

/**
 * 让接收端只收视频,并把抖动缓冲压到 0,把延迟降到最低(平板端)。
 * jitterBufferTarget 目前只有 Chrome / Edge 支持,其他浏览器会自动忽略。
 */
export function prepareReceiveOnlyVideo(pc: RTCPeerConnection): void {
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.getReceivers().forEach((receiver) => {
    const target = receiver as RTCRtpReceiver & { jitterBufferTarget?: number | null };
    if ('jitterBufferTarget' in target) {
      try {
        target.jitterBufferTarget = 0;
      } catch {
        // 不支持则退回默认抖动缓冲
      }
    }
  });
}

/** 媒体流统计快照,用于界面显示"实时编码分辨率/帧率" */
export interface MediaStatsSnapshot {
  width: number | null;
  height: number | null;
  framesPerSecond: number | null;
  /** 仅发送端有 */
  bitrateMbps: number | null;
  /** 编码器实际使用名,如 video/H264 */
  codec: string | null;
  roundTripTimeMs: number | null;
  packetsLost: number | null;
  jitterMs: number | null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickInboundSample(
  stats: RTCStatsReport,
  kind: 'outbound-rtp' | 'inbound-rtp',
): Record<string, unknown> | null {
  let best: Record<string, unknown> | null = null;
  stats.forEach((report) => {
    const record = report as unknown as Record<string, unknown>;
    if (record.type !== kind || record.kind !== 'video') return;
    if (record.isRemote === true) return;
    if (!best || Number(record.bytesSent ?? record.bytesReceived ?? 0) > Number(best.bytesSent ?? best.bytesReceived ?? 0)) {
      best = record;
    }
  });
  return best;
}

function pickCodec(stats: RTCStatsReport, codecId: unknown): string | null {
  if (typeof codecId !== 'string') return null;
  const codec = stats.get(codecId) as unknown as Record<string, unknown> | undefined;
  if (!codec) return null;
  const mimeType = typeof codec.mimeType === 'string' ? codec.mimeType : '';
  const clockRate = readNumber(codec.clockRate);
  return mimeType ? `${mimeType.replace('video/', '')}${clockRate ? ` @${Math.round(clockRate / 1000)}kHz` : ''}` : null;
}

/**
 * 统计采样器:负责两次采样之间做差值,算出实时码率。
 * `sample()` 会串行化,避免并发调用互相污染基线。
 */
export function createStatsSampler(pc: RTCPeerConnection, kind: 'outbound-rtp' | 'inbound-rtp') {
  let baseline: { bytes: number; timestamp: number } | null = null;
  let inflight: Promise<MediaStatsSnapshot> | null = null;

  const take = async (): Promise<MediaStatsSnapshot> => {
    const stats = await pc.getStats();
    const media = pickInboundSample(stats, kind);
    let roundTripTimeMs: number | null = null;
    let jitterMs: number | null = null;
    let packetsLost: number | null = null;

    stats.forEach((report) => {
      const record = report as unknown as Record<string, unknown>;
      if (record.type === 'candidate-pair' && record.state === 'succeeded' && record.nominated === true) {
        const rtt = readNumber(record.currentRoundTripTime);
        if (rtt !== null) roundTripTimeMs = Math.round(rtt * 1000);
      }
      if (record.type === 'inbound-rtp' && record.kind === 'video') {
        const jitter = readNumber(record.jitter);
        if (jitter !== null) jitterMs = Math.round(jitter * 1000);
        const lost = readNumber(record.packetsLost);
        if (lost !== null) packetsLost = lost;
      }
    });

    if (!media) {
      return {
        width: null,
        height: null,
        framesPerSecond: null,
        bitrateMbps: null,
        codec: null,
        roundTripTimeMs,
        packetsLost,
        jitterMs,
      };
    }

    const bytes = readNumber(kind === 'outbound-rtp' ? media.bytesSent : media.bytesReceived);
    const timestamp = readNumber(media.timestamp);
    let bitrateMbps: number | null = null;

    if (bytes !== null && timestamp !== null) {
      if (baseline && timestamp > baseline.timestamp && bytes >= baseline.bytes) {
        const seconds = (timestamp - baseline.timestamp) / 1000;
        if (seconds > 0.2) {
          bitrateMbps = ((bytes - baseline.bytes) * 8) / seconds / 1_000_000;
        }
      }
      baseline = { bytes, timestamp };
    }

    return {
      width: readNumber(media.frameWidth),
      height: readNumber(media.frameHeight),
      framesPerSecond: readNumber(media.framesPerSecond),
      bitrateMbps: bitrateMbps === null ? null : Math.round(bitrateMbps * 100) / 100,
      codec: pickCodec(stats, media.codecId),
      roundTripTimeMs,
      packetsLost,
      jitterMs,
    };
  };

  return {
    async sample(): Promise<MediaStatsSnapshot> {
      if (inflight) return inflight;
      inflight = take().finally(() => {
        inflight = null;
      });
      return inflight;
    },
    reset() {
      baseline = null;
    },
  };
}

/** 轮询到超时为止的通用等待器 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 检测浏览器是否具备串流所需能力,返回中文提示。
 */
export function checkHostSupport(): string | null {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return null;
  if (!window.isSecureContext) {
    return '浏览器要求安全上下文:请用 http://localhost 打开电脑端,或用 HTTPS 域名访问。';
  }
  if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    return '当前浏览器不支持屏幕采集(getDisplayMedia),请使用 Chrome / Edge / Safari 15+。';
  }
  if (typeof window.RTCPeerConnection !== 'function') {
    return '当前浏览器不支持 WebRTC。';
  }
  return null;
}

export function checkViewerSupport(): string | null {
  if (typeof window === 'undefined') return null;
  if (typeof window.RTCPeerConnection !== 'function') {
    return '当前浏览器不支持 WebRTC,请更新浏览器后重试。';
  }
  return null;
}
