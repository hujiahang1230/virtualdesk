# 第二块屏 · 把平板 / 手机变成电脑的第二块显示屏

一个**技术科普 + 可运行原型**的全栈应用:用 Next.js(App Router)+ TypeScript + Tailwind CSS + PostgreSQL + Drizzle ORM 实现,
包含一条真正能跑起来的 **WebRTC 屏幕串流链路**——电脑端采集屏幕,平板端在浏览器里输入 6 位配对码就能看到画面。

- 首页 `/`:中文技术概览(整体链路 6 步、关键技术详解、方案对比、4 步实现路线、原型限制)
- 电脑端 `/host`:调用 `getDisplayMedia` 采集 1080p60,生成配对码,等待平板接入
- 平板端 `/view`:输入配对码,接收并全屏播放画面

> **验收结果(本机实测)**:同一台机器上两个 Chrome 页面之间,从平板端点"连接"到画面出现 **2.9 秒**;
> 编码分辨率 **1920×1080**、约 **51 fps**、端到端走 P2P。详见文末「验证记录」。

---

## 一、快速开始

### 1. 环境要求

| 项目 | 版本 |
| --- | --- |
| Node.js | ≥ 20.9 |
| PostgreSQL | ≥ 12(本地或远程都行) |
| 浏览器 | Chrome / Edge / Safari 15+(屏幕采集与 `jitterBufferTarget` 以 Chromium 系支持最好) |

### 2. 安装依赖

```bash
npm install
```

### 3. 配置数据库

复制 `.env.example` 为 `.env.local`(或直接设置环境变量),填入你的 PostgreSQL 连接串:

```bash
DATABASE_URL=postgres://用户名:密码@127.0.0.1:5432/virtualdesk
```

创建数据库并建表:

```bash
npm run db:push      # 建库(不存在时)+ 建表 + 自检,一步到位
npm run db:status    # 查看 signal_sessions 的字段、主键、索引并自检
```

`db:push` 执行的是 [`drizzle/0000_init.sql`](virtualdesk/drizzle/0000_init.sql)(等价于 `drizzle-kit push`
按 `src/db/schema.ts` 生成的结果),建完后会回读 `information_schema` 校验字段、主键与索引是否与 schema 一致。
需要改动表结构时用 `npm run db:generate` 生成新的迁移文件(依赖 drizzle-kit)。

> 本仓库还提供了一个**一次性本地 PostgreSQL**(仅用于开发验证,不属于交付功能):
> `npm run postgres:start` / `npm run postgres:stop`,数据放在 `.devdb/`(已被 .gitignore 忽略)。

### 4. 启动

```bash
npm run dev
```

- 电脑端:**必须**用 `http://localhost:3000/host` 打开。浏览器只在**安全上下文**(localhost 或 HTTPS)下允许屏幕采集。
- 平板端:用电脑的**局域网 IP** 访问,例如 `http://192.168.1.10:3000/view`。

```bash
npm run dev -- -H 0.0.0.0     # 需要平板访问时这样启动
```

电脑端页面上会直接给出可复制的局域网链接,平板打开后配对码会自动填入。

### 5. 构建与校验

```bash
npm run typegen     # next typegen:生成路由类型
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # next typegen && next build
```

### 6. 打包成 Windows 免安装版

**一个 exe 走天下:不需要 Node、不需要 PostgreSQL、不需要 .NET 运行时。**

```bash
npm run app:build       # 构建前端 + 打包,产出 shell/dist/(两个文件,整个目录拷走即可)
npm run app:run         # 直接运行
npm run app:serve       # 只起服务不开窗口(自动化测试/排查用)
npm run app:diagnose    # 自检:资源、数据目录、SQLite、局域网地址、浏览器
```

产物与体积:

| 文件 | 作用 | 体积 |
| --- | --- | --- |
| `第二块屏.exe` | 原生启动器:定好解压目录后拉起内部程序 | **0.6 MiB** |
| `VirtualDeskCore.exe` | 主程序:自包含 .NET + 内嵌前端 + SQLite | 48.2 MiB |
| **合计** | 拷到任何 Windows 上双击即用 | **48.8 MiB** |

数据(信令数据库、日志)写在 exe 同级的 `VirtualDesk-data` 目录里,属于绿色版。
首次运行会自动选中第一个**真正可写**的位置(会逐个试写文件确认,不只看目录是否存在)。

#### 启动后你会看到什么

双击 `第二块屏.exe` 后:

1. 弹出**控制面板窗口**(这就是应用主界面,不是浏览器):显示当前状态、配对码、
   电脑端与平板端地址、操作按钮,并每 1.5 秒刷新一次进度
2. 自动用你的默认浏览器打开**共享页**,你只需要点一下「开始共享」并选整个屏幕
3. 让平板扫描面板上的二维码入口(或手动打开平板端地址)即可接入

控制面板里的状态来自宿主自己的 `/api/status` 接口 —— 它直接读信令库,
所以"是否在共享、配对码是多少、平板是否已连上"都是真实状态,不是猜的。

| 面板显示 | 含义 |
| --- | --- |
| 准备就绪 · 等待开始共享 | 服务已起,浏览器里还没点共享 |
| 等待平板接入… | 已开始共享,配对码已生成 |
| 平板已接入,画面传输中 | 平板已完成协商,正在传输 |

#### 平板怎么接入:扫码

控制面板上有「打开平板二维码」,会用浏览器打开新增的 `/qr` 页面:

- 二维码由**项目内置的 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)**
  (Kazuhiko Arase,MIT)在浏览器里生成,源码在 `src/lib/vendor/`
- 内容是从 `/api/network` 取到的**局域网地址 + `/view`**,不是 `127.0.0.1` ——
  平板扫了才能连上
- 页面同时显示链接文本与「复制」按钮,扫不出来时可以手动输入

> 为什么不在 C# 侧画二维码:WinForms 要画二维码就得自己实现编码器。
> 我先按规范写了一个,但在功能图案计数上反复出错(始终差 7 格),
> 调试成本远高于收益。换用浏览器里成熟的 MIT 实现后,用一条命令就能验证
> (见下方验证记录),所以最终把二维码交给前端,C# 侧只负责给出正确的局域网地址。

#### 架构:三件事分别由最合适的组件承担

```
第二块屏.exe(原生启动器)
   └── VirtualDeskCore.exe(.NET WinForms,自包含单文件)
         ├── 控制面板    ← 状态、配对码、地址、操作按钮(应用主界面)
         ├── 内嵌前端    ← next export 的静态产物,压成 zip 编进程序集
         ├── 信令服务    ← TcpListener 自实现的 HTTP/1.1 + SQLite
         └── 系统浏览器  ← 采集屏幕、显示二维码
```

**为什么采集必须用系统浏览器**:屏幕采集 `getDisplayMedia` 在内嵌浏览器里根本不可用。
实测 WebView2 内核:

```
hasMediaDevices: false          ← navigator.mediaDevices 不存在
hasGetDisplayMedia: false
```

`WebView2` 是给嵌入式场景设计的,内核不提供 `navigator.mediaDevices`,所以在壳里点
“开始共享”**必然失败**(表现为画面闪一下就报“系统无法读取画面”)。授权、CDP 覆写、
命令行开关都试过,无效 —— 这是设计限制。而采集是这个应用的第一步,不能妥协,
所以采集这一步交回给真正的 Chrome / Edge;视频流依旧是本机与平板点对点传输。

代码结构(都在 `shell/`):

| 文件 | 职责 |
| --- | --- |
| `Program.cs` | 入口:数据目录 → 日志 → SQLite → HTTP 服务 → 窗口;`--diagnose` / `--serve` |
| `AppPaths.cs` | 数据目录定位(**逐个试写**)、局域网地址挑选、拉起浏览器 |
| `SignalStore.cs` | 信令存储:SQLite 单表,配对码 → offer/answer,2 小时过期 |
| `WebHost.cs` | HTTP 服务 + 信令接口 + 静态资源托管 + 注入接口地址 |
| `StaticAssets.cs` | 前端资源:从程序集里的 zip 直接读,不解压到磁盘 |
| `MainForm.cs` | 状态窗口:本机/平板地址、打开页面、复制链接、打开数据目录 |
| `launcher/launcher.cpp` | 原生启动器:指定 .NET 单文件解压目录(见下) |
| `scripts/build-web.mjs` | 前端静态导出 → `web.zip`(含新代码哨兵校验) |
| `scripts/pack.mjs` | 完整打包:前端 → dotnet publish → 编译启动器 → 校验 |

> **前置条件**:Windows x64 + 本机装有 Chrome 或 Edge(用于采集屏幕,几乎没有不装的 Windows)。
> **目标机器不需要任何运行时**。打包机需要 .NET SDK 10 与一个 g++(MinGW,可用 `VD_GXX` 指定)。

#### 打包过程中踩到的三个坑(都已在代码里解决)

**1. 桌面工程不能放在项目根的 `app/` 目录**

Next 会优先把根 `app/` 当成路由目录,导致 `src/app` 被完全忽略,构建退化成一个空的
pages router(只导出 `/404`)。所以宿主放在 `shell/`。

**2. .NET 单文件在启动前要解压,而默认位置 `%TEMP%\.net` 可能不可写**

含原生库或启用压缩的单文件,启动瞬间必须把内容解压到磁盘,默认目标是
`%TEMP%\.net\<应用名>`。在受控环境里 `%TEMP%` 可能连目录都建不出来:

```
Failure processing application bundle.
Failed to create directory [...\Temp\.net\...] Error code: 5
```

这段解压**发生在托管代码之前**,所以只能在更早的地方指定目录 —— 也就是原生启动器。
它先设好 `DOTNET_BUNDLE_EXTRACT_BASE_DIR`(递归创建目录,注意 `CreateDirectoryW`
不创建中间目录),再拉起内部程序。实测在 `%TEMP%` 不可写的条件下能自动回退到可写位置。

**3. `HttpListener` 在部分环境里不可用**

`HttpListener` 底层是 http.sys,`Start()` 会直接抛 `HttpListenerException「句柄无效」`
(单文件与非单文件发布都一样,与打包无关)。实测 `TcpListener` 完全可用,
所以 `WebHost.cs` 用裸 socket 实现了一个够用的 HTTP/1.1 服务端:
GET/POST/PUT + Content-Length + 静态文件,不需要分块传输。

> **前端怎么知道接口在哪个地址**:页面是静态导出的,不知道自己被挂在哪个端口上。
> 宿主返回 HTML 时会注入 `window.__VIRTUALDESK_API_BASE__`,前端的 `apiFetch`
> (`src/lib/api.ts`)优先用它。Web 版(npm run dev)没有这个变量,就走同源相对路径,
> 两套运行方式共用同一份页面代码。

#### 排查采集失败:`/host` 页面的步骤追踪

`/host` 会把每一步都记下来(getDisplayMedia 是否被调用、轨道状态、每处清理的来源)。
采集出问题时,在页面上按 **Ctrl+Shift+D** 打开诊断面板,把内容截图即可定位到具体哪一步。

#### 早期方案(已删除,如需查阅请用 git 历史)

- **Electron + electron-builder + 自解压启动器**:问题是 Electron 的 GUI 进程在部分环境里
  无法启动 —— 进程被创建后 0.0–0.3 秒内以异常码退出、不产生任何输出。换 Electron 28 与 44
  两代版本并用最小窗口程序对照,结果一致,确认是自带 Chromium 的兼容性问题。
- **.NET WinForms + WebView2**:窗口能起来(这是第一次成功显示界面),但 WebView2
  内核拿不到 `getDisplayMedia`,采集始终失败。这一步的结论直接导向了现在的架构。

因此先换成 .NET + WebView2(窗口能起来了,但采集不可用),最终定稿为
**.NET 托管服务 + 系统浏览器打开页面**,详见上一节。

---

## 二、页面与后端

### 页面

| 路径 | 说明 |
| --- | --- |
| `/` | 中文技术概览:6 步链路、6 个关键技术专题、三类方案对比、4 步实现路线、原型限制 |
| `/host` | 电脑端:开始共享 / 重新开始 / 停止,6 位配对码,局域网链接,实时编码分辨率、帧率、码率、RTT、ICE 状态 |
| `/view` | 平板端:6 位配对码输入(支持 `?code=xxxxxx` 自动填入)、等待 Offer 倒计时、全屏播放、断线提示与重连 |
| `/qr` | 平板接入:把接收地址画成二维码,平板扫码即用;同时给出链接与复制按钮 |

### 数据库

只有一张表,只存 SDP,不存画面:

```sql
CREATE TABLE signal_sessions (
  code       text PRIMARY KEY,          -- 6 位数字配对码
  offer      text,                      -- 电脑端写入
  answer     text,                      -- 平板端写入
  created_at timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX signal_sessions_created_at_idx ON signal_sessions (created_at);
```

同一张表有两套实现,分别服务两种运行方式:

| 运行方式 | 存储 | 定义位置 |
| --- | --- | --- |
| Web 版(`npm run dev`) | PostgreSQL | `src/db/schema.ts` |
| 免安装版(`第二块屏.exe`) | **SQLite**(单文件,零部署) | `shell/SignalStore.cs` |

信令就是"配对码 → 一段 SDP"的键值数据,单用户、一条连接、最多存活两小时。
Web 版保留 PostgreSQL 是因为它还要考虑多实例部署;免安装版不需要这个,
用 SQLite 可以完全不依赖外部服务。

### 接口

两套实现遵循**完全相同的接口契约**(前端页面代码是同一份),所以 Web 版与免安装版可以互相替换,
而且 Web 版的 `scripts/verify-api.mjs` 对两者都能用。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/session` | 创建会话:先清理 2 小时前的旧会话,再生成**不重复**的 6 位码;body 可选 `{ offer }` |
| `GET` | `/api/session/[code]` | 返回 `{ code, offer, answer, createdAt }`;不存在返回 **404**,格式不合法返回 **400** |
| `PUT` | `/api/session/[code]` | body 为 `{ type: "offer" \| "answer", sdp }`;写入 offer 时**清空旧 answer** |
| `GET` | `/api/health` | 存活探测 + 存储连通性检查 |
| `GET` | `/api/network` | 返回本机可用的局域网私有地址,供电脑端生成分享链接 |

约定:`offer` / `answer` 字段存的是 `JSON.stringify({ type, sdp })`,单层编码,服务器原样存取。

---

## 三、WebRTC 实现要点

公共逻辑都在 [`src/lib/rtc.ts`](virtualdesk/src/lib/rtc.ts),两个页面共用:

1. **非 trickle ICE**:`buildLocalDescription()` 在 `setLocalDescription()` 之后等待
   `iceGatheringState === 'complete'`,**超时 4 秒**就带着已有候选者继续。
   好处是信令只需要一次 POST + 一次 PUT,服务器逻辑极简,平板端不必处理候选者。
2. **公共 STUN**:`stun.l.google.com:19302`、`stun1.l.google.com:19302`、
   `stun.cloudflare.com:3478`、`stun.miwifi.com:3478`。**只做地址发现,不做中继**——
   视频不经过服务器。
3. **发送端**:`addTransceiver(track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: 8_000_000 }] })`,
   并在协商前后各做一次 `setParameters()` 限速;`contentHint = 'detail'` 优先保文字清晰;
   编码优先级 H.264 → VP8 → VP9 → AV1。
4. **接收端**:`jitterBufferTarget = 0` 把抖动缓冲压到 0(仅 Chromium 系生效,其他浏览器忽略),
   用一点抗抖动余量换最低延迟。
5. **统计**:`createStatsSampler()` 用两次 `getStats()` 的差值算实时码率,同时读出
   编码分辨率、帧率、编码格式、RTT、丢包与抖动。
6. **调试**:页面里可以用 `__virtualdesk.pc` 拿到当前 `RTCPeerConnection`
   (例如 `__virtualdesk.pc.connectionState`、`await __virtualdesk.pc.getStats()`)。

### 采集参数

```ts
{ video: { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 },
          frameRate: { ideal: 60, max: 60 } },
  audio: false }
```

---

## 四、目录结构

```
virtualdesk/
├── drizzle/0000_init.sql          建表语句(等价于 npm run db:push)
├── scripts/
│   ├── dev-postgres.mjs           一次性本地 PostgreSQL 启停(仅开发验证用)
│   ├── db-setup.mjs               建库 / 执行 SQL / 表结构自检(push、status、sql、ensure)
│   ├── fix-esbuild.mjs            受限环境下补齐 esbuild 可执行文件(postinstall)
│   ├── verify-api.mjs             信令接口端到端验证(27 项)
│   └── verify-pages.mjs           页面渲染与关键内容验证
├── shell/                         免安装版宿主(.NET WinForms,当前方案)
│   ├── Program.cs                 入口:数据目录 → 日志 → SQLite → HTTP 服务 → 窗口
│   ├── AppPaths.cs                数据目录定位(逐个试写)、局域网地址、拉起浏览器
│   ├── SignalStore.cs             信令存储:SQLite 单表,2 小时过期
│   ├── WebHost.cs                 TcpListener 自实现的 HTTP 服务 + 信令接口 + 静态资源
│   ├── StaticAssets.cs            前端资源:直接从程序集里的 zip 读,不解压到磁盘
│   ├── MainForm.cs                状态窗口:本机/平板地址与操作按钮
│   ├── launcher/launcher.cpp      原生启动器:指定 .NET 单文件解压目录
│   ├── assets/icon.ico            应用与窗口图标
│   └── scripts/
│       ├── build-web.mjs          前端静态导出 → web.zip(含新代码哨兵校验)
│       └── pack.mjs               完整打包:前端 → dotnet publish → 启动器 → 校验
├── src/
│   ├── app/
│   │   ├── api/session/route.ts            POST /api/session
│   │   ├── api/session/[code]/route.ts     GET / PUT /api/session/[code]
│   │   ├── api/health/route.ts             GET /api/health
│   │   ├── api/network/route.ts            GET /api/network
│   │   ├── host/page.tsx                   电脑端
│   │   ├── view/page.tsx                   平板端
│   │   ├── page.tsx                        首页(技术概览)
│   │   ├── layout.tsx / globals.css / icon.svg
│   ├── components/CopyButton.tsx
│   ├── content/home.ts             首页全部中文文案与表格数据
│   ├── db/{index.ts, schema.ts}    连接与表定义
│   └── lib/{rtc.ts, session.ts, use-desktop.ts, desktop-types.ts}
└── drizzle.config.ts
```

---

## 五、原型限制(重要)

1. **浏览器只能镜像,做不了扩展屏 —— 这是当前阶段最大的限制。**
   `getDisplayMedia()` 采集的是系统里**已存在**的显示器 / 窗口,浏览器无法创建新的显示输出。
   要"多一块屏"必须安装虚拟显示驱动(Windows **IddCx**、macOS **CGVirtualDisplay**、Linux **evdi**),
   这不是纯 Web 能绕过的限制。首页「原型限制说明」一节详细解释了这一点。

   **但两者的组合是可行的**:先装一个虚拟显示驱动,让 Windows 多认一块屏并扩展桌面,
   再用本应用采集**那块虚拟屏**。这正是 spacedesk / Parsec / Duet 等成熟产品的做法 ——
   它们无一例外都带一个虚拟显示驱动。

   ```
   虚拟显示驱动(IddCx,系统级)
        └── Windows 多出一块显示器 → 桌面扩展到它上面
              └── 本应用采集这块虚拟屏 → WebRTC 推到平板
   ```

   采集侧已经为此做好准备:采集不再写死 1920×1080 上限,而是**按显示器原生分辨率**输出,
   所以 2560×1440 或竖屏 1200×1920 都能原样透传,不会被降采样。
2. **没有系统级输入注入。** 平板端只负责显示。要把触控 / 手写笔回传并注入系统,
   需要电脑端跑原生客户端(Windows `SendInput`、Linux `uinput`、macOS `CGEvent`)。
   副屏场景下这一步几乎是必需的(否则只能看、不能点),属于后续工作。
3. **采集必须由用户手动授权**(浏览器要求用户手势触发选择器),无法完全无人值守。
   多显示器环境下,需要在系统选择器里**选中那块虚拟屏**。
4. **跨公网需要 TURN。** 本原型只用公共 STUN,适用于同一局域网或 NAT 友好的网络;
   对称 NAT / 企业防火墙下需要部署 TURN,此时视频会经服务器中转。
5. **信令数据 2 小时过期**,创建会话时顺带清理,不会堆积。

---

## 六、把平板当副屏(当前进度)

**当前版本:镜像可用,扩展待验证。** 这一节说明"副屏"到底缺什么、怎么补、补到哪一步了。

### 6.1 镜像与扩展的区别

| | 镜像(Mirror) | 扩展(Extend) |
| --- | --- | --- |
| 系统里有几块屏 | 1 块 | 2 块以上 |
| 平板看到什么 | 主屏的复制品 | 一块**独立的桌面区域** |
| 鼠标能否移过去 | 不能 | 能 |
| 窗口能否拖过去 | 不能 | 能 |
| 当前版本 | ✅ 已支持 | ⏳ 需要虚拟显示驱动 |

关键点:**这不是应用代码的问题**。Windows 只有在"显示器拓扑"里存在第二个显示目标时,
才允许把桌面扩展出去。浏览器和普通进程都没有 API 能凭空创建显示输出 ——
所以 spacedesk / Parsec / Duet / SuperDisplay 全都附带一个虚拟显示驱动,没有例外。

### 6.2 补齐扩展能力:装一个虚拟显示驱动

推荐开源的 [Virtual-Display-Driver](https://github.com/VirtualDrivers/Virtual-Display-Driver)(MIT):

1. 下载 release 包,解压
2. 以**管理员**身份运行包里的安装脚本(它会导入一张自签名证书并安装驱动)
3. 装好后在「显示设置」里应该能看到多出来的一块显示器,把显示模式设为「**扩展**」
4. 建议把这块虚拟屏的分辨率设成平板的分辨率(例如 1920×1200 或竖屏 1200×1920)

> 自签名驱动安装可能遇到证书相关的提示,这是这类驱动的常见摩擦点。
> 若安装后设备管理器里显示黄色感叹号,通常是证书没有导入「受信任的根证书颁发机构」。

### 6.3 然后这样用

1. 启动 `第二块屏.exe`
2. 控制面板应显示 **「✅ 检测到 2 块屏幕 · 共享时请选 1920×1200 那块(扩展屏)」**
   - 如果仍显示「只有 1 块屏幕」,说明驱动没装好或显示模式还是"复制"
3. 在浏览器里点「开始共享」,在系统选择器里**选那块虚拟屏**(不是主屏)
4. 共享页会核对你的选择:
   - ✅「已共享扩展屏」→ 平板看到的就是扩展桌面
   - ⚠「你共享的是主屏,平板看到的会是镜像」→ 停止后重选
5. 平板扫码接入

### 6.4 本程序为副屏做的三件事

| 能力 | 实现 |
| --- | --- |
| 枚举真实显示器 | `shell/DisplayInfo.cs` 用 `EnumDisplayMonitors` + `EnumDisplayDevices`,并以 Per-Monitor-V2 DPI 感知运行,保证拿到的是**物理像素** |
| 告诉用户选哪块 | `/api/displays` 返回列表并给出推荐项;控制面板与共享页都会显示 |
| 采集后核对 | 用 `track.getSettings()` 的分辨率与 `displaySurface` 判断是否选错屏;若主屏与虚拟屏分辨率相同则给出"无法自动判断"的软提示,不误报 |

DPI 这一项容易踩坑:进程若"DPI 不感知",125% 缩放下 1920×1080 会被读成 1536×864,
和浏览器报告的物理像素对不上,核对就会误报。`DisplayInfo.EnsureDpiAwareness()` 在启动最早期
声明 Per-Monitor-V2 解决了这一点。

采集侧也已配合:不再写死 `max: 1920×1080`,而是**按显示器原生分辨率**输出,
因此 2560×1440 或竖屏 1200×1920 都会原样透传。

### 6.5 还没做的

- **输入回传**(平板点按 → 电脑鼠标)。浏览器不能注入系统输入,需要一个原生程序调用
  `SendInput` 并把坐标映射到虚拟屏。没有这一步,副屏只能看、不能点。
- **竖竖屏与旋转**:平板竖着用时,虚拟屏也要设成竖屏,两者需配合;暂无自动同步。
- **分辨率记忆**:目前每次共享都要在系统选择器里手动挑屏。浏览器不提供"记住上次选择"
  的 API,`getDisplayMedia` 每次都弹选择器。
- **零外部依赖**:若要脱离第三方驱动、做成"装一个 exe 就有副屏",需要自研 IddCx 驱动
  (用户模式驱动 + 自签名或 EV 证书签名),工作量远大于当前形态。

---

## 七、验证记录

本机实测环境:Windows、Chrome 151、PostgreSQL 18(本机 127.0.0.1:55432)。

| 验证项 | 命令 | 结果 |
| --- | --- | --- |
| 路由类型生成 | `npm run typegen` | ✅ 通过 |
| 类型检查 | `npm run typecheck` | ✅ 通过 |
| 代码规范 | `npm run lint` | ✅ 通过 |
| 生产构建 | `npm run build` | ✅ 通过(8 条路由全部生成) |
| 数据库初始化 | `npm run db:push` / `npm run db:status` | ✅ 建库建表后自检通过(字段、主键、索引一致) |
| 信令接口 | `npm run verify:api` | ✅ 27/27 通过(含 404/400 分支、offer 清空 answer、空 body 建会话) |
| 页面渲染 | `npm run verify:pages` | ✅ 4/4 通过 |
| 真实浏览器串流 | 两个 Chrome 页面自动化 | ✅ 13/13 通过 |
| 免安装版打包 | `npm run app:build` | ✅ 关键文件 + 新版前端哨兵校验全通过,产出一个 48.8 MiB 目录 |
| 免安装版自检 | `第二块屏.exe --diagnose` | ✅ 静态资源 29 个文件、SQLite 读写、局域网地址、本机浏览器全部就绪 |
| 免安装版接口 | 12 项信令接口实测 | ✅ 12/12 通过(含 400/404 分支、offer 清空 answer) |
| 免安装版端到端 | 真实 Chrome 双页面 | ✅ 9/9 通过(注入生效 → 配对码 → 平板解码 1920×1080 → 画面持续刷新) |
| 受限环境兼容 | `%TEMP%` 与 `%LOCALAPPDATA%` 均不可写 | ✅ 启动器自动回退到可写解压目录与数据目录,全链路正常 |
| 平板二维码 | 真实浏览器渲染 `/qr` + jsQR 解码 | ✅ 7/7 通过(296×296 canvas → 解出局域网地址,非 127.0.0.1) |
| 完整验收 | 状态接口 + 二维码 + 共享 + 接收 | ✅ 10/10 通过(含"状态接口反映正在共享/已连接") |
| 副屏能力(显示器枚举 + 选屏引导) | 真实浏览器 + `/api/displays` | ✅ 10/10 通过(见下方输出) |
| 选屏判定逻辑(含多屏分支) | `npm run verify:share-target` | ✅ 10/10 通过(覆盖选对/选错/同分辨率/窗口等分支) |
| 原生分辨率采集 | 真实浏览器采集与接收 | ✅ 4/4 通过(采集跟随源分辨率,不再强制 1080p) |

**为什么要单独测选屏判定**:开发机只有一块物理屏,浏览器里永远走不到
「检测到 2 块屏、用户选错」那条分支 —— 而它恰恰是用户装了虚拟显示驱动之后
唯一会走的路径。所以把判定逻辑抽到 `src/lib/share-target.ts`,用构造数据覆盖全部分支:

```
✓ 只有 1 块屏时提示是镜像
✓ 共享了扩展屏 → 判定为正确
✓ 共享了主屏 → 警告是镜像
✓ 主屏与扩展屏同分辨率 → 只给软提示
✓ 共享窗口 → 警告不是整块屏
✓ 共享标签页 → 警告不是整块屏
✓ 分辨率与所有显示器都不符 → 软提示
✓ 没有显示器数据 → 不产生结论
✓ 显示器列表为空 → 不产生结论
✓ 横屏扩展屏(1920×1200)也能正确识别
结果:10/10 通过
```

副屏能力的验证输出(本机只有 1 块物理屏,所以走的是"只能镜像"分支):

```
✓ 显示器接口可用  -> count=1
✓ 分辨率为物理像素(DPI 已修正)  -> 1920×1080
✓ canExtend 与屏数一致  -> count=1 canExtend=false
✓ 状态接口带 displayCount / canExtend
✓ 页面提示只能镜像  -> 只检测到 1 块屏幕 · 当前只能镜像
✓ 采集后给出共享目标核对结论  -> 系统里只检测到 1 块屏幕,所以平板看到的是镜像
✓ 仍然正常拿到配对码  -> 533725
✓ 平板端解码出画面  -> 1280×720
✓ 全程无 JS 报错
结果:10/10 通过
```

自检报告里的显示器部分:

```
[OK  ] 显示器: 1920×1080 主屏  (Generic PnP Monitor)
[注意] 只有 1 块屏幕 —— 当前只能镜像,不能扩展
       要当副屏用,需要先安装虚拟显示驱动(见 README「把平板当副屏」)
```


二维码验证的关键输出(用 jsQR 解码 canvas 像素,而非只看页面有没有画东西):

```
✓ 页面没有报错
✓ 能读到 canvas 像素  -> 296×296
✓ 二维码可被标准解码器识别  -> http://192.168.150.1:38471/view
✓ 二维码内容是接收页链接
✓ 页面显示的链接与二维码一致
✓ 链接不是 127.0.0.1(平板要能访问)
结果:7/7 通过
```

完整验收则覆盖了控制面板依赖的状态接口:

```
✓ 状态接口可用  -> idle
✓ 状态接口给出局域网地址  -> http://192.168.150.1:38471
✓ 二维码页可解码  -> http://192.168.150.1:38471/view
✓ 桌面端拿到配对码  -> 466112
✓ 状态接口反映正在共享  -> "466112"
✓ 平板端解码出画面  -> 1920×1080 readyState=4
✓ 状态接口反映已连接  -> "connected"
✓ 全程无 JS 报错或资源失败
结果:10/10 通过
```

免安装版在**受限环境**下的实测日志(`%TEMP%` 指向不可写位置):

```
启动器开始,exe 目录 = ...\shell\dist
解压目录候选:
  [不可写] ...\shell\dist\第二块屏-数据\dotnet —— 创建目录失败,错误码 5
  [可写] ...\shell\dist\VirtualDesk-data\dotnet
选定解压目录 = ...\shell\dist\VirtualDesk-data\dotnet
内部进程已创建,PID 5144
内部进程已退出,退出码 0
```

内部程序自检结果:

```
  [OK  ] 前端静态资源: 29 个文件
  [OK  ] 信令数据库(SQLite): 写入并读回配对码 549003
  [OK  ] 局域网地址: 192.168.1.7  (WLAN)
  [OK  ] 本机浏览器(用于采集屏幕): chrome.exe, msedge.exe
```

浏览器端到端结果:

```
  注入信息: {"apiBase":"http://127.0.0.1:38471","hostFlag":"desktop","hasGetDisplayMedia":true}
✓ 接口地址已注入      ✓ 宿主标记为 desktop      ✓ 采集接口可用
✓ 桌面端拿到配对码  -> 285096
✓ 平板端解码出画面  -> 1920×1080 readyState=4
✓ 画面持续刷新(不是静止帧)   ✓ 没有失败的静态资源请求   ✓ 页面没有 JS 异常
结果:9/9 通过
```

端到端串流实测数据(两个 Chrome 页面,同一台机器):

```
电脑端采集:1920×1080 @ 60fps,displaySurface = monitor,contentHint = detail
平板端连接耗时:2.9s(从点击“连接”到画面出现)
平板端解码:1920×1080,约 46–51 fps,readyState = 4,pc.connectionState = connected
画面持续刷新:前后两帧哈希不同 → 确实在播视频,不是静止占位
```

> 说明:浏览器自动化脚本属于一次性验证工具,不随交付提供;
> 仓库里保留的验证脚本是 `scripts/verify-api.mjs` 与 `scripts/verify-pages.mjs`。

---

## 八、常见问题

**平板连不上 / 一直停在"正在等待电脑端的 Offer"?**

按这个顺序排查,三步就能定位卡在哪一层。

**第 1 步:平板的浏览器能不能打开这个地址?**

在平板浏览器里打开(控制面板「平板端地址」就是它,端口号也在那里):

```
http://<电脑的局域网IP>:<端口>/api/health
```

- **显示一段 JSON** → 网络层通了,问题在画面协商,跳到第 3 步
- **打不开 / 转圈 / 拒绝连接** → 网络层不通,继续第 2 步

**第 2 步:网络层为什么不通?**

| 可能原因 | 怎么确认 | 怎么解决 |
| --- | --- | --- |
| Windows 防火墙拦了入站 | 程序首次监听时会弹「允许访问网络」,当时点了取消 | 点控制面板的「**放行防火墙**」按钮(会弹一次 UAC) |
| 选错了网卡地址 | 电脑装 VMware/VirtualBox 时它们的虚拟网卡也是 192.168.x | 本版已自动优先真实网卡并监听全部地址;面板显示的就是推荐地址 |
| 平板与电脑不在同一网段 | 平板 Wi-Fi 设置里看 IP,前三段要与电脑一致 | 连同一个 Wi-Fi(同一路由器) |
| 路由器开了「AP 隔离 / 客户端隔离」 | 手机上互相 ping 不通 | 在路由器设置里关闭该选项 |

> 这台开发机的真实情况就是"多网卡"典型:同时存在 `192.168.150.1`(VMware VMnet1)、
> `192.168.253.1`(VMware VMnet8)和 `192.168.1.7`(WLAN)。早期版本按字符串排序挑地址,
> 结果选中了 VMware 虚拟网卡,并且**只绑定了那一个地址**,平板自然永远连不上。
> 现在改为:真实网卡优先 + **全部地址都监听**。

**第 3 步:能打开页面但没画面?**

在平板上按 **Ctrl+Shift+D** 打开诊断面板(需要外接键盘),它会记录每一步:

```
开始等待 offer,配对码 069617
已拿到 offer,长度 4123
已应用远端 offer
已生成 answer,候选者 8 个,ICE 完整=true
answer 已回传,等待 P2P 建立
ICE 状态 -> checking
ICE 状态 -> connected
连接状态 -> connected
已收到视频轨道
```

| 停在哪 | 含义 |
| --- | --- |
| `开始等待 offer` 之后没有新行 | 电脑端还没点「开始共享」,或配对码输错了 |
| `查询配对码失败(网络层)` | 平板到电脑的 HTTP 不通,回第 2 步 |
| `ICE 状态 -> failed` | 双方都拿到了 SDP 却打不通 —— 典型是 AP 隔离或跨网段 |
| 到了 `已收到视频轨道` 但没画面 | 浏览器拦了自动播放,点一下画面即可 |

> Chrome 默认把 ICE 候选者里的本机地址做 mDNS 混淆(`xxxx.local`)。多数局域网都能解析,
> 但若路由器关闭了组播,解析会失败,表现为 `ICE 状态 -> failed`。
> 打开路由器的「组播 / IGMP」,或改用有线连接通常能解决。

**双击后弹出「Microsoft Edge 未响应,因为现有实例正在以提升的权限运行,是否用普通权限重启现有实例?」**

这不是程序出错,而是 Windows 的 UAC 权限冲突。原因是**程序被以管理员身份启动了**:

1. 本程序以管理员运行时,它拉起的浏览器会继承管理员令牌
2. 但你平时开着的浏览器是**普通权限**,Windows 不允许同一浏览器混用两种权限
3. 于是弹出这个询问框(它只是一个选择框,不是崩溃)

**处理办法**:

- 当场点「**是(Y)**」即可继续
- 想彻底避免:关闭程序,然后**直接双击** `第二块屏.exe`,**不要**选「以管理员身份运行」
- 程序本身不需要管理员权限;如果是从管理员终端启动的,换成普通终端即可

程序已经做了三件事来减少这个困扰:

- 提权运行时,启动时用弹窗明确说明原因与处理办法
- 打开浏览器时**优先交给 `explorer.exe` 代开** —— 资源管理器代开的程序会落到用户会话,
  不继承管理员令牌,因此不会和已有浏览器实例冲突
- 自检报告里会明确写出当前权限状态(`[OK] 运行权限: 普通权限(推荐)` 或一行注意事项)

**电脑端点击"开始共享"没有反应 / 报安全上下文错误?**
必须用 `http://localhost:3000/host` 或 HTTPS 打开。用 `http://192.168.x.x:3000/host` 打开时浏览器会拒绝采集。

**接口返回 503?**
没有配置 `DATABASE_URL`,或 PostgreSQL 连不上。先访问 `/api/health` 看 `database` 字段的说明。

**平板能看到画面但很卡?**
先看电脑端的"发送码率 / 往返时延"。弱网下可以降低采集分辨率,或让两端走 5GHz Wi-Fi;
跨网段时考虑部署 TURN。

