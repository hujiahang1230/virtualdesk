# VirtualDesk · 把平板变成电脑的第二块显示屏

把一个 Android 平板变成 Windows 的第二块显示器:**桌面真的扩展到平板上**,鼠标能移过去、窗口能拖过去,
而不是把主屏镜像一份。

**两端都不需要浏览器**。PC 端双击一个 exe,平板端装一个 20 KiB 的 App,
之后每次只需插上线、点一下「启动副屏」。

```
Windows 虚拟显示器 ──► PC 端捕获+编码 ──USB/TCP──► 平板 App 解码显示
   (VDD 驱动)          (virtualdesk.exe)              (MediaCodec 硬解)
```

| | 实现 |
| --- | --- |
| PC 端 | `virtualdesk.exe`(0.59 MiB 启动器)+ `virtualdesk-core.exe`(48.3 MiB 主程序),合计 **48.9 MiB**,无需安装 |
| 平板端 | 自研 App(VirtualDesk),**20.4 KiB**,APK 内嵌在 exe 里,首次运行自动装到平板 |
| 连接 | USB 数据线 + ADB 端口隧道,**不需要配 IP、不需要同一 Wi-Fi** |
| 画质 | 1920×1080 @ **60fps**,12 Mbps H.264 硬件编码 |
| 数据目录 | 与 exe 同级的 `virtualdesk-data\`(日志、安装记录、临时文件) |

> **两个 exe 都是必需的**:双击运行 `virtualdesk.exe`;
> 它负责准备可写临时目录、设置解压路径,然后拉起 `virtualdesk-core.exe`(真正的主体)。
> 它们是 `pack` 脚本一起产出的,分开拷贝会无法启动。

---

## 一、快速开始

### 第 1 步:准备虚拟显示器(只需一次)

Windows 必须存在第二块显示器,桌面才可能扩展出去。这需要一个**虚拟显示驱动** ——
浏览器和普通程序都没有能力凭空创建显示输出。

推荐开源驱动 [Virtual-Display-Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)(MIT):

```powershell
winget install --id=VirtualDrivers.Virtual-Display-Driver -e
```

或用它的 `VDD.Control` 图形界面安装。装完后:

1. 右键桌面 → **显示设置** → 应看到第二块显示器 → 模式选「**扩展这些显示器**」
2. 分辨率建议设成 1920×1080(或与平板比例接近的值)

> 驱动本身的取舍与风险见 [五、已知限制](#五已知限制)。
> 本程序会在面板上显示是否检测到虚拟屏,没检测到会直接提示。

### 第 2 步:打开平板的 USB 调试(只需一次)

```
设置 → 关于平板 → 连点「版本号」7 次 → 开发者选项
  ✓ 打开「USB 调试」
  ✓ 打开「USB 安装」     ← 强烈建议,否则以后升级 App 时平板会弹确认框
插上数据线 → 弹窗「允许 USB 调试吗?」→ 勾「一律允许」→ 允许
```

### 第 3 步:双击运行

双击 `virtualdesk.exe` → 控制面板弹出 → 点 **「▶ 启动副屏」**。

平板会自动打开 App 并显示扩展桌面,**平板上不需要任何操作**。

面板上会显示:

```
副屏已连接 · 正在传输
平板    iQOO Pad(Android 15)· 已连接
虚拟屏  1920×1080 @(1920,0)  Virtual Display Driver / Generic PnP Monitor
推流    监听中 · 编码 h264_mf · 端口 5000
```

> **以后每次使用**:插线 → 双击 exe → 点「启动副屏」。
> 平板 App 只在版本升级时才会重装(见 [六、常见问题](#六常见问题))。

---

## 二、它是怎么工作的

### 数据流

```
┌─ Windows ─────────────────────────────────────────────┐
│  虚拟显示器 (\\.\DISPLAY5, 1920×1080@60)              │
│        │                                              │
│        │ ① gdigrab 按桌面坐标截取该显示器区域          │
│        ▼                                              │
│  ffmpeg 子进程                                        │
│    ├─ ② h264_mf 硬件编码(回退 h264_nvenc / libx264) │
│    └─ ③ 编码器自带 AUD(h264_mf 会写,不要再插一遍)     │
│        │                                              │
│        │ ④ TCP:12 字节头(VDS2+宽+高)                    │
│        │    之后每帧 = 4 字节长度 + 一个访问单元        │
│        ▼                                              │
│  virtualdesk.exe (控制面板)                              │
│    └─ adb reverse tcp:5000  ← 把平板的 127.0.0.1 隧道过来
└───────────────────────────────────────────────────────┘
                        │ USB
┌─ Android ─────────────▼───────────────────────────────┐
│  平板 App                                             │
│    ├─ 连 127.0.0.1:5000(经 adb 隧道,零网络配置)     │
│    ├─ 读 12 字节头 → 知道分辨率,配置解码器            │
│    ├─ 按长度前缀收帧 → MediaCodec 硬解(无需前瞻)      │
│    └─ 渲染到 SurfaceView(铺满裁切 / 完整留边)         │
└───────────────────────────────────────────────────────┘
```

### 每个选择都不是随便定的

| 决策 | 结论 | 依据 |
| --- | --- | --- |
| 捕获方式 | **gdigrab**,不是 DXGI | DXGI Desktop Duplication **看不到** IddCx 虚拟显示器(`ddagrab=output_idx=1` 报 `Failed to enumerate DXGI output 1`);GDI 按桌面区域截图可以拿到真实画面 |
| 编码器 | `h264_mf` 为主,`h264_nvenc` 优先 | 本机 NVIDIA 驱动 NVENC API 12.1 < ffmpeg 要求的 13.0,`h264_nvenc` 报错后回退 Media Foundation。程序会**逐个探测**而不是假设可用 |
| 帧率 | **60fps** | 虚拟屏是 60Hz;实测 1080p@60 只占 1.7 个 CPU 核 |
| 传输 | **TCP**,不是 UDP | 本机 UDP 收发不通(连测试图案都收不到);USB 是点对点可靠链路,TCP 不会丢包花屏 |
| 流格式 | **裸 H.264**,不是 MPEG-TS | App 端可直接喂 MediaCodec,省掉解封装与缓冲,延迟最低 |
| 分辨率怎么告诉 App | **12 字节自定义头** | 否则 App 得解析 SPS 才能知道分辨率,要实现指数哥伦布解码 —— 代码量翻倍 |
| 帧边界怎么切 | **长度前缀(VDS2)** | 裸流只能靠"看到下一帧的 AUD"判断上一帧结束,每帧白等 16.7ms;PC 端按 AUD 切好并写 4 字节长度,App 收满即解 |
| 输出帧什么时候收 | **独立线程持续收** | 只在"喂一帧"后顺手收一次,解码完的帧要等下一帧才上屏,平均多等半个帧间隔 |
| 收发缓冲区多大 | **64 KiB,不是 512 KiB** | 12 Mbps 下 512 KiB 相当于 340ms 排队空间,发送端会远远跑在平板消费前面,把延迟堆起来 |
| 平板怎么找到 PC | **`adb reverse`** | 平板连自己的 `127.0.0.1:5000` 就隧道到 PC。不需要 IP、二维码、同网段、防火墙放行 |
| 什么时候装 App | **比 versionCode** | 用文件哈希会导致"重建一次就重装一次",用户明明装过却总被弹安装框 |

---

## 三、实测数据

测试环境:Windows 11 25H2 / Ryzen 7 5800H / RTX 3060 Laptop / iQOO Pad(Android 15)。

### 采集与编码性能(实测)

| 配置 | 实际帧率 | CPU |
| --- | --- | --- |
| 1920×1080 @60 目标 | **60 fps** | **0.8 核**(硬件编码) |
| 1600×900 @60 目标 | 60 fps | 1.5 核 |
| 1280×720 @60 目标 | 60 fps | 1.0 核 |
| 1920×1080 @30 目标 | 30 fps | 0.8 核 |

> 早期曾在机器同时跑 Chrome + 推流时测出 41~45 fps,据此把默认值定成 30,
> 后来发现那是**负载导致**的偏差。空闲状态能跑满 60,已修正默认值。

#### 编码器必须显式开启硬件与低延迟档

`h264_mf` 的默认行为对"副屏"很不合适,有三处坑:

| 问题 | 现象 | 解决 |
| --- | --- | --- |
| 不指定 `-pix_fmt nv12` 时 `-hw_encoding true` 失败 | 报 `format negotiation failed (1/0)`,然后**静默退回软件编码** —— 白吃 1~2 个 CPU 核,延迟也更高 | 同时给 `-pix_fmt nv12` |
| 不指定 `-scenario` / `-rate_control` | 按默认场景(偏画质/吞吐)工作,内部积压若干帧 → **帧率显示 60,但拖窗口明显滞后** | `-scenario display_remoting -rate_control ld_vbr` |
| 误用 `-preset` / `-tune` | ffmpeg 只警告一句 `Codec AVOption preset has not been used`,然后**静默忽略** | `h264_mf` 用 MF 自己的参数;通用参数只给 nvenc/x264 |

程序里这些参数集中在 `AppStreamServer.EncoderArgs()`,**启动探测与实际推流用同一份**,
避免"探测通过、一启动就报错"。

### 平板端解码(真机日志)

```
VirtualDesk: 视频尺寸 1920x1080
VirtualDesk: 画面布局 3499x1968(容器 2800x1968, 模式 铺满/裁切)
VirtualDesk: 解码器已启动 1920x1080 (lowLatency=true)
VirtualDesk: 首帧已上屏
VirtualDesk: 解码帧率 61.3 fps(184 帧 / 3000 ms)
VirtualDesk: 解码帧率 59.2 fps(178 帧 / 3006 ms)
VirtualDesk: 解码帧率 60.8 fps(183 帧 / 3009 ms)
```

App 每 3 秒统计一次解码输出帧数并打日志(`adb logcat -s VirtualDesk` 可看)。

### 延迟实测(怎么测的)

延迟不能靠肉眼估。做法是**两端各记「累计帧数 + 墙钟」**,再用积压帧数反推:

```
PC 端   [统计] 已发送 1143 帧(+60/s) @ <PC 毫秒>
平板端  解码帧率 60.0 fps | 累计 1156 帧 @ <平板毫秒> | 内部延迟 20.6 ms
```

先把两端时钟对齐(`adb shell date +%s%3N` 往返取中点,误差约 ±40 ms),
再把平板时刻换算到 PC 时钟,同一时刻相减即为**在途帧数**,乘帧间隔就是管道延迟。

| 指标 | 优化前 | 优化后 |
| --- | --- | --- |
| 在途积压 | 4.0 帧 ≈ **67 ms** | 1.5 帧 ≈ **25 ms** |
| App 内部「到达→上屏」 | 27~31 ms | **20~21 ms** |

拆开看优化后的 25 ms:App 内部约 21 ms,传输只剩约 4 ms。
也就是说**链路排队已经基本清空**,剩下的大头在解码器内部与 PC 端采集编码。

三个把积压压下来的改动:

1. **收发缓冲 512 KiB → 64 KiB** —— 大缓冲给了发送端"提前跑"的空间,数据全堆在管道里
2. **协议 VDS1 → VDS2(长度前缀)** —— 消掉"等下一帧 AUD"的一帧前瞻
3. **独立线程持续收输出帧** —— 解码一完成就上屏,不再等下一次喂帧

> 顺带发现一个隐蔽 bug:`h264_mf` **自己就会写 AUD**,再挂 `h264_metadata=aud=insert`
> 会变成每帧两个 AUD(实测 3 秒 180 帧产出 360 个 AUD)。已按编码器类型区分,
> 只有不写 AUD 的编码器才需要那个 bsf。

---

## 四、构建

### 4.1 环境要求

| 组件 | 用途 | 说明 |
| --- | --- | --- |
| .NET SDK 10 | 编译 PC 端 | 已有 Windows SDK 不够,需要 .NET SDK |
| MinGW g++ | 编译原生启动器 | 或设 `VD_GXX` 指向 g++.exe |
| Node.js 20+ | 构建前端/APK 脚本 | |
| Android build-tools 34 + JDK 17+ | 构建平板 APK | 见 4.2,不需要 Gradle |
| ffmpeg 7.x | PC 端捕获+编码 | **运行期依赖**,见下方说明 |

### 4.2 构建平板 APK(不使用 Gradle)

本机 `services.gradle.org` 不可达,所以不走 Gradle,直接调用官方 build-tools:

```powershell
# 一次性:下载工具链到项目内 .android-build/(已验证可用的国内镜像)
node --use-system-ca tools/fetch-android-toolchain.mjs

# 构建 APK
node tools/build-apk.mjs
```

流程与踩坑:

| 步骤 | 工具 | 注意 |
| --- | --- | --- |
| 清单与资源表 | `aapt2 link` | 产出带二进制清单的 APK |
| 编译 Java | `javac --release 17` | 本机 javac 是 25,**必须降到 17**,否则 d8 不认 class 文件版本 |
| 转 dex | `d8` | 输出目录必须事先存在,否则报 `Invalid output` |
| 塞进 APK | 自写 ZIP 读写 | **`resources.arsc` 必须保持不压缩**,见下方坑 1 |
| 对齐 | `zipalign -p 4` | APK 要求 4 字节对齐 |
| 签名 | `apksigner` | 本地调试证书,v2 + v3 方案 |

工具链放在 `.android-build/`(已 gitignore),JDK 复用机器上 JetBrains IDE 自带的 JBR,
**不写系统目录、不需要管理员权限**。

**改平板端功能时**:把 `tools/build-apk.mjs` 里的 `APK_VERSION_CODE` 加一,
这样 PC 端才会把它装到平板上(见 [六、常见问题](#六常见问题))。

### 4.3 打包 exe

```powershell
npm run app:build          # 构建前端 + APK + dotnet publish + 编译启动器
npm run app:run            # 直接运行
```

产物:

```
shell/dist/
  virtualdesk.exe          0.59 MiB  原生启动器(MinGW C++,双击这个)
  virtualdesk-core.exe    48.29 MiB  主程序(.NET 10 自包含单文件)
  virtualdesk-data/                  首次运行后生成的数据目录
```

为什么要两个 exe:.NET 单文件发布在**启用压缩**时,启动瞬间必须把内容解压到 `%TEMP%`;
受控环境里 `%TEMP%` 可能连目录都建不出来(`Failed to create directory [...\Temp\.net\...] Error code: 5`)。
这段解压发生在托管代码之前,只能在更早的地方指定目录 —— 也就是一个原生启动器
(先设 `DOTNET_BUNDLE_EXTRACT_BASE_DIR` 和 `TEMP`,再拉起内部 exe)。

**关于 ffmpeg**:目前从 `PATH`、`VD_FFMPEG` 环境变量或程序目录查找 `ffmpeg.exe`。
它不是单文件的一部分 —— 要彻底摆脱需要自研捕获 + 进程内 Media Foundation 编码,
属于后续工作(见 [五、已知限制](#五已知限制))。

### 4.4 目录结构

```
android/app/src/main/          平板端 App(Java,无第三方依赖)
  AndroidManifest.xml
  java/com/virtualdesk/viewer/MainActivity.java

shell/                         PC 端(.NET WinForms)
  Program.cs                   入口、--stream / --stream-app / --serve / --diagnose
  MainForm.cs                  控制面板(Android 专用)
  AppStreamServer.cs           裸 H.264 推流服务
  AdbController.cs             ADB 编排(设备/隧道/安装/启动)
  DisplayInfo.cs               显示器枚举(含虚拟屏识别)
  Streamer.cs                  VLC 用的 MPEG-TS 模式
  WebHost.cs / SignalStore.cs  Web 版信令服务(SQLite)
  launcher/launcher.cpp         原生启动器
  scripts/build-web.mjs        前端静态导出 + 打包 web.zip
  scripts/pack.mjs             完整打包

tools/
  fetch-android-toolchain.mjs  下载 Android 构建工具链
  build-apk.mjs                手工构建 APK

src/                           Web 版前端(Next.js,见附录)
```

---

## 五、已知限制

1. **还不能"点"** —— 平板目前只能看。要把触屏/手写笔回传到电脑并注入系统,
   需要 PC 端调用 `SendInput` 并把坐标映射到虚拟屏。ADB 通道已打通,
   坐标可复用现有 TCP 连接反向发小包,属于后续工作。
2. **上限 60fps(唯一卡点是采集)** —— 逐环节实测过,只有采集过不去:

   | 环节 | 120fps 可行性 | 实测依据 |
   | --- | --- | --- |
   | 平板面板 | ✅ | `dumpsys display` 报告 30/48/60/90/120/144Hz;App 调 `Surface.setFrameRate` 后 `activeMode` 实测切到 **120Hz** |
   | 平板解码 | ✅ 富余 | 喂 720p120 数据时实测解码 **~300fps** |
   | 虚拟显示器 | ✅ | 驱动暴露 90/120/144/165/244Hz 模式 |
   | H.264 编码 | ✅ | 加 `-r <fps>` 规整时间基后,1080p@120 可正常编码 |
   | **GDI 采集** | ❌ **上限约 70fps** | 目标 90/120 实际都只产出 **66~71 帧/秒** |

   除采集外都已就绪。另外要注意:**面板 120Hz 下 72fps 反而比 60fps 更顿**
   (120÷60=2 整除,120÷72 不整除,节奏不匀),所以 60fps 是当前最合适的选择。

   要上 120fps,必须换捕获方式:**Windows.Graphics.Capture**(全程 GPU)。
   但它给的是 D3D 纹理,而 ffmpeg 子进程只能吃内存帧,直接走会引入一次
   GPU→CPU 回读(1080p120 约 1 GB/s),收益不确定。真正解需要把编码也搬进进程内
   (Media Foundation + D3D 纹理直通),属于架构级改造。
3. **"铺满"会裁掉两侧** —— 虚拟屏 16:9、平板 1.42:1,比例差约 20%。
   铺满(默认)不变形但裁边;`--fit` 完整显示但留黑边。想三者兼得只能让虚拟屏分辨率
   等于平板分辨率(需管理员改驱动配置)。
4. **依赖第三方虚拟显示驱动** —— 自研 IddCx 驱动可以做成"装一个 exe 就有副屏",
   但需要 WDK + 驱动签名,且自签名方案在 Secure Boot 下有风险。
5. **依赖 ffmpeg.exe** —— 见 4.3。
6. **驱动风险自担** —— 虚拟显示驱动属于系统级组件。装之前建议记住怎么进安全模式;
   大版本更新显卡驱动前先卸载 VDD。
7. **仅 Windows** —— macOS 需要 CGVirtualDisplay,Linux 需要 evdi,均未支持。

---

## 六、常见问题

### 点「启动副屏」后平板又弹安装框?

**原因**:平板上的 App 版本低于 exe 内嵌的版本,程序判定需要升级。

现在按 **versionCode** 比较(不是文件哈希),所以只会在版本真的升级时装一次:

```
平板 App 版本落后(已装 1,需要 2),重新安装
平板 App 已是最新(versionCode 2 >= 2),跳过安装
```

**如果每次都弹**,通常是没开开发者选项里的「**USB 安装**」——
关着时每次 `adb install` 都会让平板弹一次确认框。打开它即可。

### 面板上「平板」显示未连接 / 未授权?

| 面板提示 | 处理 |
| --- | --- |
| 没有检测到通过 ADB 连接的平板 | 检查数据线(充电线可能没有数据线芯)、USB 调试是否打开 |
| 已连接但**未授权** | 解锁平板,在「允许 USB 调试吗」弹窗点允许;没弹窗就「撤销 USB 调试授权」后重新插线 |
| offline | 重新插拔数据线,或 `adb kill-server` 后重试 |

### 面板上「虚拟屏 未检测到」?

虚拟显示驱动没启用:

```
设备管理器 → 显示适配器 → Virtual Display Driver → 启用设备
```

然后 **Win+P → 扩展**。Windows 有时会把虚拟屏创建出来却**不挂到桌面**
(适配器和 monitor 都在,但状态是 detached),这时需要显式扩展一次。

### 平板黑屏,停在「已连接,正在等待首帧」?

解码器启动了但没有出画。历史上这两个原因都踩过:

1. **拼访问单元时丢了起始码** —— `MediaCodec` 要求标准 Annex-B,
   每个 NAL 前必须带 `00 00 00 01`。表现就是解码器 start 成功、日志全绿、一帧不出。
2. **`resources.arsc` 被压缩** —— APK 装得上但跑不起来;

现在都已修复。若仍出现,看 `adb logcat -s VirtualDesk` 的输出。

### 画面被拉伸变形 / 上下有黑边?

- 变形 = 早期版本直接让 SurfaceView 拉伸填满。现在按比例计算显示区。
- 有黑边 = 用了 `--fit`(完整显示)。默认是铺满裁切。

面板上的「显示:铺满 / 完整」按钮可随时切换。

### 帧率显示 60,但操作有明显延迟感?

**这是两个不同的问题**:帧率说的是"每秒收到多少帧",延迟说的是"画面比实际操作晚多久"。
帧率满、延迟高,通常是链路里**缓冲太深**。

已修的坑(见 [三、实测数据](#三实测数据) 的"编码器必须显式开启硬件与低延迟档"):

- `h264_mf` 没开硬件时静默跑软件编码
- 没指定 `-scenario display_remoting` / `-rate_control ld_vbr` 时 MF 会攒帧

仍然存在的固有延迟来源:

| 环节 | 量级 | 能否优化 |
| --- | --- | --- |
| gdigrab 同步截图 | 5~10 ms | 需换 Windows.Graphics.Capture |
| 硬件编码 | 5~15 ms | 已是最优档 |
| TCP + USB | 1~3 ms | 已设 TCP_NODELAY |
| MediaCodec 解码 | 10~20 ms | 已设 KEY_LOW_LATENCY |
| 平板合成 + 面板刷新 | ≤16 ms | 受屏幕刷新率限制 |

如果仍然觉得迟钝,可以试:

```powershell
# 降低画质换速度(quality 40 更快)
# 或降低捕获分辨率
virtualdesk.exe --stream-app 5000 60 8M
```

### 帧率不到 60?

1. 确认虚拟屏刷新率是 60Hz 以上(显示设置 → 高级显示设置)
2. 确认机器负载不高 —— 实测 CPU 忙时 GDI 捕获会掉到 40 多帧
3. 看平板端日志 `解码帧率 x fps`;若 PC 端够快而平板端低,是解码瓶颈

### 能不能上 90 / 120fps?

**能跑到 120,但真正卡住的是采集,而且这里"更高的帧率"未必更好。**

先纠正一个曾经的错误结论:`h264_mf` 并非不支持高帧率。
之前 72/90/120 一律报 `MF_E_UNSUPPORTED_D3D_TYPE`,真正原因是
**gdigrab 的时间基是 1/1000000(tbr=1000k)**,Media Foundation 无法据此构造合法的
媒体类型。输出参数里加一行 `-r <fps>` 规整帧率后,120fps 也能正常打开编码器。

加上这一行后,在**虚拟屏全屏播放动画**(每帧都在变化)的条件下实测:

| 目标帧率 | 实际发出 | 结论 |
| --- | --- | --- |
| 60fps | **60/s** | 达标 |
| 90fps | 66~72/s | 到不了,被采集卡住 |
| 120fps | 67~71/s | 到不了,被采集卡住 |

逐环节现状:

| 环节 | 120fps 可行性 | 依据 |
| --- | --- | --- |
| 平板面板 | ✅ | 实测 `activeMode` 可切到 120Hz |
| 平板解码 | ✅ 富余 | 喂 720p120 实测 ~300fps |
| H.264 编码 | ✅ | 加 `-r` 后 1080p@120 正常 |
| **GDI 采集** | ❌ **上限约 70fps** | 目标 90/120 都只实际产出 66~71/s |

#### 为什么 60fps 反而比 72fps 更顺

平板面板是 **120Hz**。只有目标帧率能整除刷新率,节奏才均匀:

```
120Hz + 60fps  →  每帧正好占 2 个刷新周期,完全均匀
120Hz + 72fps  →  有的帧占 1 个周期、有的占 2 个 → 节奏不匀,看起来更"顿"
```

所以即使采集能给出 ~70fps 也没用 —— 除非能做到 120(需要 Windows.Graphics.Capture),
否则 **60fps 是这块屏幕上最稳的选择**。

要真正上 120fps,必须把捕获换成 **Windows.Graphics.Capture**(全程 GPU)。
难点在于它给的是 D3D 纹理,而 ffmpeg 子进程只能吃内存帧,直接走要加一次
GPU→CPU 回读(1080p120 约 1 GB/s),很可能要把编码也搬进进程内。

> 顺带已有的无成本优化:即使内容是 60fps,App 也会把面板**提到 120Hz**,
> 让「帧就绪 → 上屏」的等待从最多 16.6ms 降到最多 8.3ms。

---

## 七、验证记录

| 项目 | 结果 |
| --- | --- |
| 真机全链路 | ✅ 平板全屏显示扩展桌面,无浏览器、无第三方播放器 |
| 平板端解码帧率 | ✅ 59.2 / 60.8 / 61.3 fps(连续三档,每档 3 秒) |
| PC 端 CPU | ✅ 1080p@60 约 1.7 核 |
| APK 构建 | ✅ 20.4 KiB,minSdk 26 / targetSdk 34,apksigner v2+v3 通过 |
| 安装跳过 | ✅ 已装 v2 时日志输出「已是最新,跳过安装」 |
| 前端 | ✅ `tsc --noEmit` / `eslint` 全绿 |
| 打包 | ✅ 48.9 MiB,双击即用 |

---

## 附:Web 版(浏览器 + WebRTC)

仓库里同时保留了一条**基于浏览器**的实现,用于技术演示与跨网络场景:

- 前端:Next.js 15(App Router)+ React 19 + Tailwind CSS 4
- 页面:`/` 技术科普、`/host` 电脑端采集、`/view` 平板端接收、`/qr` 扫码接入
- 信令:PostgreSQL + Drizzle ORM(Web 版)/ SQLite(便携版 `--serve`)
- 媒体:WebRTC 非 trickle ICE、8 Mbps 码率上限、公共 STUN

```powershell
npm install
# .env 里配置 DATABASE_URL,见 .env.example
npm run db:push
npm run dev            # http://localhost:3000
```

**它与本文档描述的产品路径已经无关**:浏览器路径必须由用户手动点「开始共享」、
在系统弹窗里选屏,而且平板端也要开浏览器 —— 这正是后来改成原生推流的原因。
Web 版保留下来作为参考实现与科普站点,`--serve` 模式仍可用它做信令测试。

更早的 Electron / WebView2 方案已经删除,如需查阅请用 git 历史。

---

## 许可与第三方

- 内置二维码库 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)(MIT),
  见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- 虚拟显示驱动 [Virtual-Display-Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)(MIT)
- ffmpeg 按需从系统查找,不随仓库分发

仓库:<https://github.com/hujiahang1230/virtualdesk>
