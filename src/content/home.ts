/** 整体链路的 6 个步骤 */
export interface PipelineStage {
  step: number;
  title: string;
  summary: string;
  /** 关键取舍 / 参数 */
  points: string[];
  hardware: string;
}

export const PIPELINE: PipelineStage[] = [
  {
    step: 1,
    title: '显示源',
    summary: '系统合成出要送的这一帧画面:镜像走现有显示器,扩展屏则需要虚拟显示器驱动先“凭空造”一块屏。',
    points: [
      '镜像模式:直接采集主屏或指定窗口,零安装,但内容与电脑屏幕完全相同',
      '扩展模式:虚拟显示器驱动注册一块新屏,系统把它当成真显示器,窗口可拖过去',
      '虚拟屏的分辨率 / 刷新率 / HDR 元数据都由驱动上报,决定后面整条链路的画面上限',
    ],
    hardware: 'GPU 合成 + 显示驱动',
  },
  {
    step: 2,
    title: '屏幕采集',
    summary: '从 GPU 侧把画面取出来。桌面复制路径(零拷贝)比逐帧截图快一个数量级,是低延迟的前提。',
    points: [
      'Windows:DXGI Desktop Duplication 取纹理;可配合 Windows.Graphics.Capture 做窗口级采集',
      'macOS:ScreenCaptureKit 输出 IOSurface,直接喂给 VideoToolbox 硬件编码器',
      'Linux:PipeWire + xdg-desktop-portal 采集,Wayland 下的标准做法',
      '浏览器:getDisplayMedia() 只能拿到系统已授权的显示器 / 窗口 / 标签页',
    ],
    hardware: 'GPU 纹理 / IOSurface / DMA-BUF',
  },
  {
    step: 3,
    title: '视频编码',
    summary: '把帧压成码流。硬编码器(专用电路)是低延迟的关键,软编码只作为兜底。',
    points: [
      '编码器:H.264(兼容性最好)/ HEVC / AV1(同画质带宽最低,终端支持仍在铺开)',
      '低延迟配置:关 B 帧、单切片、零或极短前向参考、CBR 码率、GOP 加长以少发关键帧',
      '屏幕内容专用工具:H.264 的 screen-content 模式、AV1 的 palette / intra-BC 工具',
      '一个 1080p60 屏幕画面,硬编码 H.264 大概 3–8 Mbps,编码耗时 5–15 ms',
    ],
    hardware: 'NVENC / Quick Sync / AMF / VideoToolbox',
  },
  {
    step: 4,
    title: '网络传输',
    summary: '把码流送到平板。WebRTC 负责打洞、拥塞控制、抗丢包;USB 隧道则是延迟最低的旁路。',
    points: [
      'WebRTC:SRTP 加密、NACK 重传、PLI 请求关键帧、Google Congestion Control 动态调码率',
      'UDP + FEC:自研协议可以对屏幕内容做分层保护,牺牲带宽换稳定',
      'USB 隧道:adb reverse / usbmuxd 把 TCP 端口映射到平板,延迟降到约 30–40 ms,且不受 Wi-Fi 干扰',
      '关键指标:端到端延迟 = 采集 + 编码 + 网络 + 抖动缓冲 + 解码 + 显示,局域网内目标 70–120 ms',
    ],
    hardware: 'Wi-Fi 5/6 / 千兆网 / USB 3.x',
  },
  {
    step: 5,
    title: '解码显示',
    summary: '平板硬解码码流并刷到屏幕。抖动缓冲和显示刷新节奏决定了“手感”是否跟手。',
    points: [
      '解复用 → 硬件解码(MediaCodec / VideoToolbox)→ 直接上屏,避免多余的 CPU 拷贝',
      '抖动缓冲越小越跟手,但网络抖动时会卡顿;WebRTC 里用 receiver.jitterBufferTarget 调节',
      '平板屏幕的刷新率(60 / 90 / 120 Hz)决定体感流畅度上限',
      '色彩与缩放:同一个色域假设(通常 sRGB)能避免平板偏色',
    ],
    hardware: '平板硬件解码器',
  },
  {
    step: 6,
    title: '输入回传',
    summary: '把平板上的触控、手写笔、键盘事件送回电脑并注入系统。只有回传打通,才算真正“在用第二块屏”。',
    points: [
      '浏览器侧用 PointerEvent 采集,带压力与倾斜信息,归一化成 0–1 坐标再传输',
      '注入侧:Windows SendInput、Linux uinput(可被识别为触摸屏设备)、macOS CGEvent',
      'iOS 的指针事件与手写笔数据需要 Safari 支持,压感等级受限',
      '安全上要考虑:注入通道必须与已配对会话绑定,防止被当作远程控制后门',
    ],
    hardware: 'HID 注入 / 虚拟输入设备',
  },
];

/** 关键技术详解 */
export interface TechDetail {
  id: string;
  icon: string;
  title: string;
  lead: string;
  items: { name: string; detail: string }[];
  pitfalls?: string[];
}

export const TECH_DETAILS: TechDetail[] = [
  {
    id: 'virtual-display',
    icon: '🖥️',
    title: '虚拟显示器',
    lead: '扩展屏与镜像的本质区别就在这里:系统必须先“相信”多了一块屏,才有画面可以采集。',
    items: [
      {
        name: 'Windows · IddCx',
        detail:
          'Indirect Display Driver(间接显示驱动)是微软官方框架:驱动以 UMDF 用户态驱动形式注册一个虚拟显示器,系统把它当普通显示器做合成,驱动再把帧交给用户态程序。可用 INF + 驱动签名部署,配合“扩展”模式即可把窗口拖到平板上。',
      },
      {
        name: 'macOS · CGVirtualDisplay',
        detail:
          '私有 API(CGVirtualDisplay / CGVirtualDisplayDescriptor)能创建虚拟显示器并设置分辨率、HiDPI 与刷新率。没有公开文档,需要适配系统版本,也不适合上架 App Store;商业方案通常走 DriverKit 自定义扩展。',
      },
      {
        name: 'Linux · evdi',
        detail:
          'evdi(Extensible Virtual Display Interface)是 DisplayLink 开源的内核模块,提供 /dev/dri 设备节点,用户态程序可注册虚拟显示器并直接读取帧缓冲。Wayland 下常与 PipeWire 采集配合。',
      },
      {
        name: '驱动带来的连锁约束',
        detail:
          '虚拟屏的分辨率决定采集上限;驱动注册的时机决定系统是否重排窗口;拔掉虚拟屏时必须先注销显示器,否则会残留“幽灵屏”,这也是这类产品最常见的用户投诉。',
      },
    ],
    pitfalls: ['Windows 需要签名驱动,安装要管理员权限', 'macOS 私有 API 随系统更新容易失效'],
  },
  {
    id: 'capture',
    icon: '🎥',
    title: '屏幕采集',
    lead: '采集路径决定了延迟基线:能拿到 GPU 纹理就不要走 CPU 截图。',
    items: [
      {
        name: 'DXGI Desktop Duplication',
        detail:
          '调用 IDXGIOutputDuplication::AcquireNextFrame 拿到桌面纹理,可只取发生变化的区域(脏矩形),是 Windows 上延迟最低的通用方案。局限:独占全屏的 D3D9 应用可能采集失败。',
      },
      {
        name: 'Windows.Graphics.Capture',
        detail:
          'Win10 1803+ 的现代 API,支持按窗口 / 显示器采集,自带光标与边框控制,内部同样走 GPU 侧纹理,适合打包进 UWP 或桌面桥应用。',
      },
      {
        name: 'ScreenCaptureKit',
        detail:
          'macOS 12.3+ 的官方采集框架,输出 CMSampleBuffer / IOSurface,可限定窗口、剔除自家窗口、控制帧率;配合 VideoToolbox 几乎零拷贝。',
      },
      {
        name: 'PipeWire / xdg-desktop-portal',
        detail:
          'Wayland 下应用不能直接读屏幕,必须通过 portal 让用户授权,拿到 PipeWire 流后再取帧;X11 下还有 XShm / XComposite 的老路径。',
      },
      {
        name: '浏览器 getDisplayMedia()',
        detail:
          'W3C Screen Capture 规范的实现,由浏览器弹出选择器,用户选定后拿到 MediaStreamTrack。约束:必须由用户手势触发、必须安全上下文(localhost 或 HTTPS)、不能凭空创建显示器、需要时单独申请系统音频。',
      },
    ],
    pitfalls: ['高帧率采集时要留意 GPU 占用,别把整机拖慢', '采集含硬件加速视频播放的窗口时,DXGI 可能拿不到画面'],
  },
  {
    id: 'encoding',
    icon: '⚡',
    title: '编码低延迟调优',
    lead: '同样是 H.264,配置不同延迟能差出 5 倍以上。',
    items: [
      {
        name: '延迟来自哪里',
        detail:
          '参考帧队列与 B 帧、码率控制缓冲(Lookahead / VBV)、切片划分与熵编码初始化、以及编码器为攒满一帧而做的缓冲。逐项关掉就能把延迟从 60 ms 压到 10 ms 级。',
      },
      {
        name: '参数清单',
        detail:
          '零 B 帧、single slice、low-latency 模式(如 NVENC 的 ULTRA_LOW_LATENCY)、CBR + 小 VBV、固定帧率;码率 1080p60 建议 6–10 Mbps。',
      },
      {
        name: '屏幕内容优化',
        detail:
          '文字与 UI 的冗余度极高:开启 screen content coding 工具、定期插关键帧、对静止画面做“无变化则不编码”,都能显著省带宽,但要注意别让静止后的首次变化变糊。',
      },
      {
        name: '自适应码率',
        detail:
          '用 WebRTC 的 getStats 读 bytesSent / roundTripTime / packetsLost,在丢包上升时按系数下调 maxBitrate;编码器排队(encodeQueueSize)变大时主动降帧率,优先保住延迟。',
      },
    ],
    pitfalls: ['一味拉高码率会先撞上 Wi-Fi 抖动', '降帧率比降分辨率对“可读性”的破坏更小'],
  },
  {
    id: 'transport',
    icon: '🛰️',
    title: '传输协议',
    lead: '局域网里 WebRTC 已经够用;跨网段、弱网或要求极低延迟时,才需要 UDP+FEC 或 USB 隧道。',
    items: [
      {
        name: 'WebRTC',
        detail:
          'SRTP 加密、ICE 打洞、NACK 重传、PLI 关键帧请求、拥塞控制与带宽估计一体;浏览器原生支持,信令服务器只需交换 SDP 与候选者。代价是协议栈较重,极低延迟场景下抖动缓冲会吃掉几毫秒。',
      },
      {
        name: 'UDP + FEC',
        detail:
          '自研协议可以把屏幕内容的特点用起来:按帧分层保护、只对关键帧强化冗余、丢包时直接丢整帧而不是苦等重传。代价是要自己实现拥塞控制与加密,跨公网对付 NAT 也更费劲。',
      },
      {
        name: 'USB 隧道',
        detail:
          'adb reverse(Android)/ usbmuxd(iOS)把平板上的本地端口映射到电脑,数据走 USB 不再受 Wi-Fi 干扰,延迟可稳定在 30–40 ms。缺点是需要数据线,且移动端要允许调试或安装配套应用。',
      },
      {
        name: 'TURN 与穿透',
        detail:
          '同一局域网内 STUN 直连成功率极高;跨运营商或对称 NAT 下需要 TURN 中继,这时服务器就真的在搬运视频流了,带宽成本与延迟都会上升。',
      },
    ],
    pitfalls: ['公共 STUN 只解决地址发现,不解决穿透失败', '注意别把信令服务器做成媒体服务器'],
  },
  {
    id: 'input',
    icon: '✍️',
    title: '触控与手写笔回传',
    lead: '回传链路决定了能不能“用”,而不只是“看”。',
    items: [
      {
        name: '事件采集',
        detail:
          'PointerEvent 带 pointerType(touch / pen / mouse)、pressure、tiltX / tiltY,以及 pointerdown 时 getCoalescedEvents() 提供的高频采样点。要按屏幕物理尺寸归一化坐标,否则不同 DPI 的平板会偏。',
      },
      {
        name: '坐标映射',
        detail:
          '把平板坐标映射到虚拟屏的像素坐标:需要考虑缩放比例、旋转方向,以及平板黑边(letterbox)。完整方案还会同步光标形状与位置,避免电脑与平板看到两个光标。',
      },
      {
        name: '注入方式',
        detail:
          'Windows 用 SendInput 或触控注入(可被识别为真实触摸);Linux 用 uinput 注册虚拟触摸屏设备;macOS 用 CGEvent / IOHIDPostEvent。注入真实触摸事件的好处是手势、滚动、双指缩放都能自然工作。',
      },
      {
        name: '手写笔与压感',
        detail:
          '压感值需要从浏览器一路带到注入层,中间任何一环取整或截断都会让笔触变“木”。多数实现会把 pressure 量化为 8–10 bit,并按设备能力映射曲线。',
      },
    ],
    pitfalls: ['注入通道等同远程控制,必须绑定已配对会话', 'macOS 需要辅助功能授权,首次使用要引导用户'],
  },
  {
    id: 'security',
    icon: '🔐',
    title: '安全与配对',
    lead: '屏幕内容里有密码、聊天记录和邮箱,配对与传输必须默认加密。',
    items: [
      {
        name: '配对码与短时 token',
        detail:
          '6 位配对码只用于一次性绑定,绑定成功后立即换成短期 token;配对码要有有效期与失败次数限制,防止暴力枚举(6 位数字只有 100 万种组合)。',
      },
      {
        name: '媒体加密',
        detail:
          'WebRTC 的 DTLS-SRTP 是强制加密,指纹随 SDP 交换,天然能防中间人。若自研传输,至少要上 AES-GCM 会话密钥并做密钥轮换。',
      },
      {
        name: '信令服务器的最小权限',
        detail:
          '服务器只存 SDP,不存画面。存 SDP 也要设 TTL(本原型 2 小时)并定期清理,避免堆积成大表;接口只允许写入自己会话的 SDP,不要提供任意读写。',
      },
      {
        name: '可见性提示',
        detail:
          '电脑端必须有常驻的共享指示(托盘图标 / 悬浮条),并在用户点“停止共享”或系统终止采集时立刻断开;document.visibilityState 变化时暂停采集也是省电与隐私的常见做法。',
      },
    ],
    pitfalls: ['默认密码 / 固定配对码是最常见的翻车点', '不要把未加密的裸 RTP 暴露在局域网'],
  },
];

/** 方案对比 */
export interface SolutionRow {
  name: string;
  transport: string;
  latency: string;
  extended: string;
  touch: string;
  note: string;
}

export const HARDWARE_SOLUTIONS: SolutionRow[] = [
  {
    name: 'DisplayLink 扩展坞 / 无线适配器',
    transport: 'USB 或 60GHz 无线',
    latency: '低(10–30 ms)',
    extended: '原生支持',
    touch: '视型号而定',
    note: '即插即用,但需要专用硬件与厂商驱动,平板端支持有限。',
  },
  {
    name: 'iPad 随航(Sidecar)/ 通用控制',
    transport: 'Wi-Fi 或 USB',
    latency: '低',
    extended: '原生支持',
    touch: '完整(含 Apple Pencil)',
    note: '体验标杆,但被锁在 Apple 生态内,且需要同一 Apple ID。',
  },
  {
    name: 'Miracast / AirPlay 投屏',
    transport: 'Wi-Fi Direct / 局域网',
    latency: '中(50–150 ms)',
    extended: '多为镜像',
    touch: '一般不支持',
    note: '协议简单,延迟与画质都不适合办公精细操作。',
  },
];

export const OPEN_SOURCE_SOLUTIONS: SolutionRow[] = [
  {
    name: 'Sunshine + Moonlight',
    transport: '局域网 / 公网',
    latency: '很低(NVENC / AMF 硬编)',
    extended: '需配合虚拟显示驱动',
    touch: '客户端支持手势与触控映射',
    note: '游戏串流最优解,延迟极低;办公场景的配对与多屏管理偏弱,移动端以原生客户端为主而非浏览器。',
  },
  {
    name: 'Deskreen',
    transport: '局域网(WebRTC / P2P)',
    latency: '中',
    extended: '不支持(仅镜像)',
    touch: '不支持',
    note: '基于 Electron + WebRTC,把电脑屏幕镜像到任意浏览器;架构与本原型最接近,可作为参考实现。',
  },
  {
    name: 'RustDesk 等远程桌面',
    transport: 'P2P + 中继',
    latency: '中',
    extended: '支持(自带虚拟显示器)',
    touch: '支持',
    note: '远程控制的完整方案,包含输入注入;界面与交互是为“远程操作”而非“第二块屏”设计的。',
  },
  {
    name: 'Virtual Display Driver + 自研采集',
    transport: '无(只有驱动)',
    latency: '—',
    extended: '原生支持',
    touch: '—',
    note: '只解决“多一块屏”,传输与显示要自己接;适合作为自研方案的驱动层。',
  },
];

export const SELF_BUILT_SOLUTIONS: SolutionRow[] = [
  {
    name: '纯浏览器 WebRTC(本原型)',
    transport: 'WebRTC / 公共 STUN',
    latency: '局域网内 70–120 ms',
    extended: '不支持(浏览器只能镜像)',
    touch: '可自研(需原生注入端)',
    note: '零安装、平板即用;受浏览器沙箱限制,拿不到虚拟显示器,也没有系统级输入注入。',
  },
  {
    name: '原生客户端 + 虚拟显示器驱动',
    transport: 'WebRTC / 自研 UDP + FEC',
    latency: '可压到 20–40 ms',
    extended: '支持',
    touch: '完整(含手写笔压感)',
    note: '需要为每个平台写驱动与客户端,开发量大,但能覆盖全部能力,是产品的最终形态。',
  },
];

/** 4 步实现路线 */
export interface RoadmapPhase {
  phase: string;
  title: string;
  goal: string;
  tasks: string[];
  exit: string;
}

export const ROADMAP: RoadmapPhase[] = [
  {
    phase: '第 1 步',
    title: '打通镜像链路(本原型)',
    goal: '用浏览器把电脑画面送到平板,验证 Wi-Fi 环境下的真实延迟与画质。',
    tasks: [
      'getDisplayMedia 采集 1080p60,contentHint 设为 detail',
      'WebRTC 点对点传输,信令只交换一次 SDP(非 trickle)',
      '平板端 jitterBufferTarget 设为 0,全屏播放',
    ],
    exit: '同一局域网内,输入配对码后 5 秒内看到画面;通过 getStats 看到 RTT 与码率。',
  },
  {
    phase: '第 2 步',
    title: '把体验做扎实',
    goal: '让链路在真实家庭 / 办公 Wi-Fi 下稳定,而不是只在理想环境能跑。',
    tasks: [
      '自适应码率与帧率:根据 RTT、丢包、encodeQueueSize 动态调节',
      '配对体验:二维码、局域网自动发现、断线自动重连',
      '性能:关闭码率探测、限制采集帧率、后台时暂停采集',
    ],
    exit: '连续使用 1 小时不卡顿,丢包 3% 以内仍保持可读画面。',
  },
  {
    phase: '第 3 步',
    title: '从镜像升级为真正的扩展屏',
    goal: '装上虚拟显示器驱动,让平板成为第二块屏而不是复制品。',
    tasks: [
      '按平台实现虚拟显示驱动:Windows IddCx / macOS CGVirtualDisplay / Linux evdi',
      '驱动上报 1920×1200@60 等目标分辨率,并处理热插拔与幽灵屏',
      '采集目标切换到虚拟显示器,窗口可以拖过去',
    ],
    exit: '平板显示的内容可以独立于电脑主屏,鼠标能跨屏移动。',
  },
  {
    phase: '第 4 步',
    title: '输入回传与产品化',
    goal: '让平板可以真正操作电脑,并补齐安全与打包。',
    tasks: [
      '触控 / 手写笔事件回传与系统级注入(Windows SendInput、Linux uinput、macOS CGEvent)',
      '硬编解码优先(H.264 / HEVC),开启低延迟档与屏幕内容优化',
      '安全:短期 token、配对失败次数限制、托盘共享指示、一键断开',
    ],
    exit: '在平板上点按、拖拽、手写都能在电脑上生效,延迟体感低于 40 ms。',
  },
];

/** 原型限制 */
export interface Limitation {
  title: string;
  detail: string;
}

export const LIMITATIONS: Limitation[] = [
  {
    title: '浏览器只能镜像,做不了扩展屏',
    detail:
      'getDisplayMedia() 采集的是系统里已经存在的显示器或窗口,浏览器无法创建新的显示输出。要“多一块屏”,必须安装虚拟显示驱动(Windows IddCx、macOS CGVirtualDisplay、Linux evdi),这不是纯 Web 能绕过的限制。',
  },
  {
    title: '没有系统级输入注入',
    detail:
      '本原型的平板端只负责显示。浏览器没有向操作系统注入触控 / 键盘事件的能力,输入回传需要电脑端跑一个原生客户端(或驱动)来接收并注入,见第 4 步路线。',
  },
  {
    title: '采集必须由用户手动授权',
    detail:
      '浏览器要求由用户手势触发选择器,并会显示明显的“正在共享”提示。这对安全是好事,但意味着无法完全无人值守地自动开始共享。',
  },
  {
    title: '跨公网需要 TURN 中继',
    detail:
      '本原型只用公共 STUN 做地址发现,适用于同一局域网或 NAT 友好的网络。对称 NAT、企业防火墙下需要部署 TURN,此时视频会经过服务器中转,带宽与延迟都会上升。',
  },
  {
    title: '硬件与环境差异',
    detail:
      '编码器能力、平板解码器支持(尤其 AV1 / HEVC)、Wi-Fi 信道拥塞都会影响体验。原型固定 1080p60 上限、8 Mbps 码率上限,条件不足时会自动降级。',
  },
  {
    title: '信令服务器不保存画面',
    detail:
      '服务器只存一次 offer 和一次 answer,2 小时后自动清理。视频流走 P2P,服务器看不到画面——这也是这套架构最值得保留的性质。',
  },
];
