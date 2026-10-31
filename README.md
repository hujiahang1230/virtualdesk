# VirtualDesk · 把平板变成电脑的第二块显示屏

把 Android 平板当 Windows 的扩展屏:**桌面真的延伸过去**,鼠标能移过去、窗口能拖过去,
而不是把主屏镜像一份。两端都不需要浏览器,也不用装第三方播放器。

| | |
| --- | --- |
| PC 端 | `virtualdesk.exe` + `virtualdesk-core.exe`,合计约 **49 MiB**,免安装、免运行时 |
| 平板端 | 自研 App,**20 KiB**,APK 内嵌在 exe 里,首次运行自动安装 |
| 连接 | USB 数据线 + ADB 端口隧道,**不用配 IP、不用同一 Wi-Fi** |
| 画质 | 1920×1080 @ **120fps**,20 Mbps H.264 硬件编码 |
| 数据目录 | exe 同级的 `virtualdesk-data\`(日志、安装记录、临时文件) |

> 两个 exe 必须放在一起:`virtualdesk.exe` 负责准备可写临时目录,再拉起真正的主体
> `virtualdesk-core.exe`。

---

## 快速开始

### 第 1 步:准备虚拟显示器(一次)

Windows 必须先有第二块显示器,桌面才可能扩展出去。这需要虚拟显示驱动 ——
普通程序没有能力凭空创建显示输出。

```powershell
winget install --id=VirtualDrivers.Virtual-Display-Driver -e
```

装完后在「显示设置」里把它设为**扩展这些显示器**,分辨率建议 1920×1080,
刷新率**选 120Hz 或更高**(平板是 120Hz,帧率才能对上)。

### 第 2 步:打开平板 USB 调试(一次)

```
设置 → 关于平板 → 连点「版本号」7 次 → 开发者选项
  ✓ USB 调试
  ✓ USB 安装          ← 建议打开,否则以后升级 App 时平板会弹确认框
插线 → 弹窗「允许 USB 调试」→ 勾「一律允许」→ 允许
```

### 第 3 步:双击运行

双击 `virtualdesk.exe` → 点 **「▶ 启动副屏」**。平板会自动打开 App 并显示扩展桌面,
**平板上不需要任何操作**。

面板会显示平板型号、虚拟屏分辨率、编码器和端口。以后每次:插线 → 双击 → 点一下。

---

## 使用

**图形界面**:双击运行即可。按钮为「启动副屏 / 停止 / 显示方式(铺满⇄完整)/ 重装 App / 数据」。

**命令行**:

```powershell
virtualdesk.exe --stream-app                  # 默认 端口 5000 / 120fps / 20M
virtualdesk.exe --stream-app 5000 60 12M      # 降到 60fps,省 CPU / 带宽
virtualdesk.exe --stream-app --fit            # 完整显示(留黑边),默认是铺满(裁边)
virtualdesk.exe --diagnose                    # 自检:显示器、adb、ffmpeg 状态
```

**显示方式**:虚拟屏 16:9、平板 1.42:1,比例差约 20%,只能三选二 ——
铺满会裁掉两侧(默认),`--fit` 完整可见但留黑边。想兼得需让虚拟屏分辨率等于平板分辨率。

---

## 工作原理

```
Windows 虚拟显示器
   │  ① DXGI 桌面复制(ddagrab);找不到输出时回退 GDI 截屏
   ▼
ffmpeg:② h264_mf 硬件编码 → ③ 按访问单元切帧
   │  ④ TCP:12 字节头(VDS2 + 宽 + 高),之后每帧 4 字节长度 + 数据
   ▼
virtualdesk.exe ── adb reverse tcp:5000 ── USB ──► 平板 App
                                                    ├ 按长度收帧 → MediaCodec 硬解
                                                    └ 渲染到 SurfaceView(120Hz 面板)
```

几个关键决定的原因:

| 决定 | 原因 |
| --- | --- |
| 捕获用 DXGI 而非 GDI | GDI 是同步 BitBlt,1080p 实测只有 ~70fps 且更吃 CPU;DXGI 在 GPU 侧取帧 |
| 传裸 H.264 而非 MPEG-TS | App 可以直接喂解码器,省掉解封装与缓冲,延迟最低 |
| 自己写 12 字节头 | 否则 App 要解析 SPS 拿分辨率(得实现指数哥伦布解码),代码量翻倍 |
| 每帧带长度前缀 | 裸流只能靠"看到下一帧的 AUD"判断边界,每帧白等 16.7ms |
| 用 `adb reverse` 传流 | 平板连自己的 `127.0.0.1:5000`,不需要 IP、二维码、防火墙放行 |
| 按 versionCode 判断安装 | 用文件哈希会导致"重新构建一次就重装一次",用户明明装过还被弹框 |

---

## 性能实测

1920×1080,虚拟屏 165Hz、平板 120Hz:

| 推流目标 | PC 发送 | 平板解码 | App 内部延迟 | ffmpeg CPU |
| --- | --- | --- | --- | --- |
| 60fps | 58~60/s | 52~60 fps | 22.9~23.6 ms | 1.36 核 |
| **120fps(默认)** | **119~121/s** | **120.0~120.3 fps** | **19~21 ms** | **0.9~1.5 核** |

延迟的测法:两端各记「累计帧数 + 墙钟」,对齐时钟后同一时刻相减得到在途帧数,
乘以帧间隔即为管道延迟。实测在途积压约 **1.5 帧(25ms)**,其中传输只占约 4ms。

编码器上有三个必须显式设置的点(默认行为都不适合副屏):

- `-pix_fmt nv12`:否则 `h264_mf` 强制硬件会失败并**静默退回软件编码**,白吃 1~2 个核
- `-scenario display_remoting -rate_control ld_vbr`:MF 的低延迟档,否则内部会攒帧
- `-r <fps>`:规整时间基,否则非标准帧率(72/120 等)直接打不开编码器

---

## 常见问题

### 双击提示「Windows 已保护你的电脑 / 发布者: 未知」

SmartScreen 对**未签名程序**的例行拦截,不是病毒告警。打包时已做本机自签名
(`shell/scripts/sign-exe.ps1`):生成证书 → 用 `CertAddEncodedCertificateToStore`
写入当前用户「受信任根 / 受信任发布者」(绕过系统确认弹窗)→ 签 SHA256 并加时间戳。

自签名只对**信任了该证书的机器**有效。拷到别的电脑仍会提示,此时:

- 直接点「仍要运行」,或
- 关闭「Windows 安全中心 → 应用和浏览器控制 → 基于信誉的保护 → 检查应用和文件」,或
- 把证书导入目标机器(管理员):`Import-Certificate -FilePath VirtualDesk.cer -CertStoreLocation Cert:\LocalMachine\Root`

想让所有人都免提示,只能买公开 CA 的代码签名证书(EV 类型才有即时信誉)。

### 平板又弹安装框

平板上的 App 版本低于 exe 内嵌版本,程序判定要升级。按 **versionCode** 比较,
只有版本真变了才装一次。如果**每次都弹**,通常是没开开发者选项里的「USB 安装」。

### 面板显示平板未连接 / 未授权

| 提示 | 处理 |
| --- | --- |
| 没检测到通过 ADB 连接的平板 | 换数据线(有些充电线没有数据线芯)、确认 USB 调试已开 |
| 已连接但未授权 | 解锁平板,在「允许 USB 调试」弹窗点允许;没弹窗就「撤销 USB 调试授权」后重插 |
| offline | 重插,或 `adb kill-server` 后重试 |

### 面板显示「虚拟屏 未检测到」

```
设备管理器 → 显示适配器 → Virtual Display Driver → 启用设备
```

然后 Win+P → 扩展。Windows 有时会创建虚拟屏却不挂到桌面(适配器在、状态是 detached),
这时需要显式扩展一次。

### 平板黑屏,停在「已连接,正在等待首帧」

看 `adb logcat -s VirtualDesk`。历史上有两个原因:拼访问单元时丢了起始码
(MediaCodec 要求标准 Annex-B),以及 `resources.arsc` 被压缩导致 APK 装得上但跑不起来。
现在都已修复。

### 画面变形 / 有黑边

变形是早期版本直接拉伸;现在按比例计算。有黑边说明用了 `--fit`,面板上可随时切换。

### 想省 CPU、或平板不是 120Hz

```powershell
virtualdesk.exe --stream-app 5000 60 12M
```

### 能不能上 165Hz 甚至更高

**不必,也基本无意义**。平板面板上限 120Hz,只有帧率能整除刷新率时节奏才均匀:

```
120Hz + 120fps → 每帧占 1 个周期,最均匀
120Hz + 60fps  → 每帧占 2 个周期,同样均匀
120Hz + 72fps  → 有的 1 个、有的 2 个 → 节奏不匀,反而更顿
```

采集侧实测可跑到约 150fps(ddagrab),编码器 1080p@120 也只占约 1.5 核,
所以真正的上限是**平板屏幕**。

> 另外:Windows.Graphics.Capture 在 Windows 11 25H2 build 26200.7623 上会一律返回
> `E_ACCESSDENIED`(显示器与窗口都被拒,与本程序无关),因此改用 DXGI 桌面复制实现。

---

## 已知限制

1. **还不能点** —— 平板目前只能看。触控/手写笔回传需要 PC 端 `SendInput` + 坐标映射,
   ADB 通道已通,属于后续工作。
2. **依赖第三方虚拟显示驱动** —— 自研 IddCx 驱动可以做到"装一个 exe 就有副屏",
   但需要 WDK 与驱动签名。
3. **依赖 ffmpeg.exe** —— 从 `PATH`、`VD_FFMPEG` 或程序目录查找,未打进单文件。
4. **仅 Windows** —— macOS 需 CGVirtualDisplay,Linux 需 evdi,均未支持。
5. **驱动风险自担** —— 虚拟显示驱动是系统级组件,装前建议记住怎么进安全模式。

---

## 构建

需要:.NET SDK 10、MinGW g++、Node.js 20+、Android build-tools 34、JDK 17+、ffmpeg。

```powershell
node --use-system-ca tools/fetch-android-toolchain.mjs   # 一次性:下载 Android 工具链到 .android-build/
node tools/build-apk.mjs                                 # 构建平板 APK
npm run app:build                                        # 打包 exe(含自动签名)
npm run app:run                                          # 运行
```

**APK 不使用 Gradle**(本机访问不到 services.gradle.org),直接调官方 build-tools:
`aapt2 link` → `javac --release 17` → `d8` → 自写 ZIP 重打包 → `zipalign -p 4` → `apksigner`。
其中 `resources.arsc` 必须保持**不压缩**,否则安装时报 `Failure [-124]`。

改动平板端功能时,把 `tools/build-apk.mjs` 里的 `APK_VERSION_CODE` 加一,
PC 端才会把它装到平板上。

产物:

```
shell/dist/
  virtualdesk.exe          0.6 MiB   原生启动器(MinGW C++,双击这个)
  virtualdesk-core.exe    48.6 MiB   主程序(.NET 自包含单文件)
  virtualdesk-data/                  首次运行后生成
```

主要源码:

```
android/app/src/main/java/com/virtualdesk/viewer/MainActivity.java   平板端(纯 Java)
shell/Program.cs          入口:--stream-app / --stream / --serve / --diagnose
shell/MainForm.cs         控制面板
shell/AppStreamServer.cs  推流服务(采集/编码/协议)
shell/DxgiOutputs.cs      显示器 → DXGI 输出序号映射
shell/AdbController.cs    ADB 编排(设备/隧道/安装/启动)
shell/scripts/pack.mjs    打包 + 签名
```

---

## 第三方

- 虚拟显示驱动 [Virtual-Display-Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)(MIT)
- 二维码库 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)(MIT),见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- ffmpeg 按需从系统查找,不随仓库分发

> 仓库里还保留着一条基于浏览器的 WebRTC 实现(Next.js + PostgreSQL),属于早期方案,
> 与现在的产品路径无关 —— 它必须人工选屏、平板还要开浏览器,这正是后来改成原生推流的原因。

仓库:<https://github.com/hujiahang1230/virtualdesk>
