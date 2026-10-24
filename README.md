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
该接口会报出当前配对码,因此**只接受本机(127.0.0.1)请求**,局域网访问会拿到 403;
控制面板本身走的就是 loopback,不受影响。

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
| `GET` | `/api/displays` | 返回显示器列表与"该共享哪一块"的建议(见下方说明) |
| `GET` | `/api/status` | **仅免安装版、仅本机(127.0.0.1)**:控制面板专用,汇报会话阶段与活跃配对码 |

约定:`offer` / `answer` 字段存的是 `JSON.stringify({ type, sdp })`,单层编码,服务器原样存取。

**关于 `/api/displays`**:枚举显示器必须走操作系统 API,浏览器不提供等价能力,
所以 Web 模式恒返回 `displays: []` + `reason: "browser-unsupported"`,页面据此提示
"副屏引导需使用 Windows 便携版"—— 而不是误报成"只检测到 1 块屏"。
真正实现它的是 [`shell/WebHost.cs`](virtualdesk/shell/WebHost.cs) 的 `HandleApi`
(用 `EnumDisplayMonitors` / `EnumDisplayDevices`)。

> 两套实现的路由必须一一对应。打包脚本会对照 C# 侧提供的接口清单校验
> `src/app/api` 下是否有对应路由 —— 少建一个在开发期看不出来(前端会静默降级),
> 但会让某个功能在浏览器模式下整个失效。清单见 `shell/scripts/build-web.mjs`
> 的 `HOST_PROVIDED_ROUTES`。

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
// src/lib/rtc.ts 的 DISPLAY_CAPTURE_CONSTRAINTS
{ video: { frameRate: { ideal: 60, max: 60 } }, audio: false }
```

**刻意不写 `width` / `height` 上限**:早期版本写死了 `max: 1920 / 1080`,
遇到竖屏(1200×1920)或高分辨率的虚拟屏会被降采样,副屏场景直接失效。
现在按显示器原生分辨率输出,由浏览器按源的实际尺寸决定,再用 §六 的方式
核对用户有没有选错屏。采集失败时前端会依次降级:原生 @60fps → 720p30 → 浏览器默认值。

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
│   ├── verify-pages.mjs           页面渲染与关键内容验证
│   └── verify-share-target.mjs    共享目标判定的单元测试(10 项)
├── shell/                         免安装版宿主(.NET WinForms,当前方案)
│   ├── Program.cs                 入口:数据目录 → 日志 → SQLite → HTTP 服务 → 窗口
│   ├── AppPaths.cs                数据目录定位(逐个试写)、局域网地址、拉起浏览器
│   ├── SignalStore.cs             信令存储:SQLite 单表,2 小时过期
│   ├── WebHost.cs                 TcpListener 自实现的 HTTP 服务 + 信令接口 + 静态资源
│   ├── StaticAssets.cs            前端资源:直接从程序集里的 zip 读,不解压到磁盘
│   ├── DisplayInfo.cs             显示器枚举 / 虚拟显示器识别 / DPI 感知
│   ├── FirewallHelper.cs          放行入站防火墙规则
│   ├── MainForm.cs                状态窗口:本机/平板地址与操作按钮
│   ├── Log.cs                     运行日志(线程安全追加)
│   ├── launcher/launcher.cpp      原生启动器:指定 .NET 单文件解压目录
│   ├── assets/icon.ico            应用与窗口图标
│   └── scripts/
│       ├── build-web.mjs          前端静态导出 → web.zip(新代码哨兵 + 路由一致性校验)
│       └── pack.mjs               完整打包:前端 → dotnet publish → 启动器 → 校验
├── src/
│   ├── app/
│   │   ├── api/
│   │   │   ├── session/route.ts           POST /api/session
│   │   │   ├── session/[code]/route.ts    GET / PUT /api/session/[code]
│   │   │   ├── health/route.ts            GET /api/health
│   │   │   ├── network/route.ts           GET /api/network
│   │   │   └── displays/route.ts          GET /api/displays(Web 模式恒为空列表)
│   │   ├── host/page.tsx                   电脑端
│   │   ├── view/page.tsx                   平板端
│   │   ├── qr/page.tsx                     扫码页
│   │   ├── page.tsx                        首页(技术概览)
│   │   ├── layout.tsx / globals.css / icon.svg
│   ├── components/CopyButton.tsx
│   ├── content/home.ts             首页全部中文文案与表格数据
│   ├── db/{index.ts, schema.ts}    连接与表定义
│   └── lib/
│       ├── rtc.ts                  WebRTC 公共逻辑(两端共用)
│       ├── session.ts              信令存取(服务端)
│       ├── share-target.ts         共享目标判定(纯函数,可脱离浏览器测试)
│       ├── rate-limit.ts           配对码防枚举的进程内限流
│       ├── api.ts                  接口地址解析 + 宿主注入变量的类型声明
│       └── vendor/qrcode-generator.js
└── drizzle.config.ts
```

---

## 五、原型限制(重要)

1. **浏览器不能自己创建显示输出 —— 这是当前阶段最大的限制。**
   `getDisplayMedia()` 采集的是系统里**已存在**的显示器 / 窗口,浏览器无法创建新的显示输出。
   要"多一块屏"必须安装虚拟显示驱动(Windows **IddCx**、macOS **CGVirtualDisplay**、Linux **evdi**),
   这不是纯 Web 能绕过的限制。首页「原型限制说明」一节详细解释了这一点。

   **但两者的组合是可行的**:先装一个虚拟显示驱动,让 Windows 多认一块屏并扩展桌面,
   再用本应用采集**那块虚拟屏**。这正是 spacedesk / Parsec / Duet 等成熟产品的做法 ——
   它们无一例外都带一个虚拟显示驱动。§六 记录了这条路目前的完成度。

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

## 五之二、安全现状(请务必读完)

这是一个**局域网内的自用工具**,但信令接口在设计上就是无鉴权的 —— 它必须能被平板直接访问。
下面如实说明现状、已经做了什么、以及**还差什么**。

### 已经落实的

| 措施 | 位置 | 说明 |
| --- | --- | --- |
| 不发 `Access-Control-Allow-Origin: *` | `shell/WebHost.cs` | 页面与接口**同源**,这个头零收益。发了的话,用户在同一个 Wi-Fi 下访问的任意网站都能用脚本驱动这台机器的信令接口 |
| `/api/status` 仅限本机 | `shell/WebHost.cs` | 该接口会报出**当前活跃的配对码**。控制面板走 `127.0.0.1`,不受影响;局域网访问返回 403 |
| 配对码防枚举限流 | `src/lib/rate-limit.ts`、`shell/WebHost.cs` | 创建会话 10 次/分钟/IP,信令读写 60 次/分钟/IP |
| 不外泄数据库错误细节 | 三个 API 路由 | 驱动的原始 `error.message` 含 host/port/dbname/user,而 `/api/health` 无鉴权。改为服务端记录 + 客户端只拿 `requestId` |
| `/api/health` 不返回绝对路径 | 两端 | 免安装版原本返回含 Windows 用户名的 SQLite 完整路径,现只返回文件名 |
| 连接串不再硬编码在源码里 | `src/db/index.ts`、`drizzle.config.ts` | 未配置 `DATABASE_URL` 时明确报错,而不是悄悄连上一个写死的默认库 |
| 安全响应头 | `next.config.ts`、`shell/WebHost.cs` | `X-Content-Type-Options` / `X-Frame-Options` / `Referrer-Policy` |
| 公用网络告警 | `shell/FirewallHelper.cs`、`Program.cs` | 放行规则是 `profile=private,public`;在咖啡馆/机场这类公用网络下主动提示一次 |

> 响应头刻意**不发** `Permissions-Policy` 的 `display-capture` 指令 ——
> 它正是 `getDisplayMedia` 的门禁,配错会直接让核心功能失效。浏览器默认值已是 `self`。

### 仍然存在的风险(有意接受的取舍)

1. **配对码仍是唯一凭据,而且没有所有权绑定。**
   任何知道码的设备都能读走 host 的 offer SDP、并 `PUT` 覆盖 answer。
   码空间只有 100 万,限流把穷举速度压到了可接受,但**挡不住分布式枚举**。

2. **限流是进程内的 best-effort**:重启即清零;多实例部署时各算各的;
   按 IP 计数,NAT 后面多人共用一个出口会被一起限。
   要根治需要在 `signal_sessions` 上记录失败次数并锁死会话 —— 需要改两套存储的 schema,尚未做。

3. **信令与媒体都是明文 HTTP。** 这是 `getDisplayMedia` 的硬约束 ——
   它只在**安全上下文**(HTTPS 或 localhost)里可用,而局域网服务无法自签证书。
   好在媒体流本身是 DTLS-SRTP(WebRTC 强制),视频内容不经过明文信道;
   但 SDP 会在网络上明文传递,其中包含 ICE 候选(内网 IP)。

4. **SDP 原文在存储里保留 2 小时**(Postgres / SQLite 均为明文)。这是设计如此,
   目的是不保存任何画面数据。

### 建议的使用方式

在**可信网络**(家里 / 办公室)下使用,用完关闭程序。
公用网络下程序会弹窗提示,风险自负。

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

> **这一整节只在 Windows 便携版成立。** 枚举显示器必须走操作系统 API,
> 浏览器不提供等价能力,所以 Web 模式的 `/api/displays` 恒返回空列表,
> 页面会明确提示"副屏引导需使用 Windows 便携版",而不是让你以为系统里只有一块屏。
> 详见 [§二 · 接口](#接口) 与 `src/app/api/displays/route.ts`。

DPI 这一项容易踩坑:进程若"DPI 不感知",125% 缩放下 1920×1080 会被读成 1536×864,
和浏览器报告的物理像素对不上,核对就会误报。`DisplayInfo.EnsureDpiAwareness()` 在启动最早期
声明 Per-Monitor-V2 解决了这一点。

采集侧也已配合:不再写死 `max: 1920×1080`,而是**按显示器原生分辨率**输出,
因此 2560×1440 或竖屏 1200×1920 都会原样透传。

### 6.5 原生推流:不用浏览器(实验)

浏览器方案能用,但要求每次手动点「共享」、在系统弹窗里挑屏,平板那边也得开浏览器。
`--stream` 模式去掉了浏览器:**进程内驱动 ffmpeg 直接抓虚拟屏并推流**。

```powershell
# 自动挑本机地址(优先 USB 直连链路),30fps / 6Mbps
第二块屏.exe --stream

# 指定地址与参数
第二块屏.exe --stream 192.168.28.233 5000 30 6M
```

平板端用 **VLC**(不是浏览器):「网络」→「流」→ 输入 `tcp://<电脑IP>:5000`,
并把网络缓存调到 100~200ms。

#### 技术选型与实测依据

这一节的每个选择都来自实测,不是照抄:

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 能不能用 DXGI Desktop Duplication 抓虚拟屏 | **不能** | `ddagrab=output_idx=1` 报 `Failed to enumerate DXGI output 1`。虚拟屏由 IddCx 间接显示驱动提供,不在同一块适配器上,也不是可复制的 DXGI output |
| GDI 能不能抓虚拟屏 | **能** | `gdigrab` 按桌面区域截图,实测抓到真实桌面内容(与主屏截图的 PSNR 仅 4.7 dB,证明是不同区域) |
| 1080p60 能不能跑满 | **不能** | GDI 路径实测 1080p 最高 41~45 fps,占用 2.6~2.7 个 CPU 核 |
| 1080p30 能不能跑满 | **能** | 实测 29 fps 准时达标,只占 **1.0 个核** |
| 硬件编码 | `h264_nvenc` 不可用 → 回退 `h264_mf` | 本机驱动 NVENC API 12.1 < ffmpeg 要求的 13.0。`h264_mf`(Media Foundation)可用 |
| UDP 还是 TCP | **TCP** | 本机 UDP 收发不通(连 `testsrc` 都收不到),TCP 一次通过。USB 直连是点对点可靠链路,TCP 不会丢包花屏 |

`--stream` 因此按 **30fps** 设计。对副屏看文档/写代码足够;要 60fps 必须改用
**Windows.Graphics.Capture**(全程 GPU,不做 CPU 拷贝),那是后续工作。

#### 已实现的健壮性

- **编码器自动探测**:先各试一帧,`h264_nvenc` → `h264_mf` → `libx264` 取第一个能用的。
  否则只会在推流启动瞬间报 `Driver does not support the required nvenc API version`。
- **断线自动重连**:ffmpeg 在客户端断开后以 `-10053` 退出,守护循环会自动重起,
  平板随时可以重新连接,不用回电脑重启程序。
- **标准输入判定**:`Console.ReadLine()` 在输入被重定向时立即返回 `null`,会导致程序秒退。
  现在只在交互式终端里等回车。

#### 已验证的输出

```
收到 1933 KiB   avg_frame_rate=30/1   duration=15.000000
codec_name=h264  width=1920  height=1080
捕获区域 1920×1080 @(1920,0)   编码器 h264_mf   监听 tcp://0.0.0.0:5000
```

打包后的 `第二块屏.exe --stream` 同样验证通过(启动器会转发参数)。

### 6.6 一键副屏:ADB + 自研 Android App

上一条的 VLC 方案只是过渡:LVC 自带缓冲,延迟通常 100~500ms,而且平板端还得手动开播放器。
这一条把两端都换成自己的东西 —— **平板端不再需要浏览器,也不需要任何第三方播放器**。

```powershell
第二块屏.exe --stream-app
```

执行后 PC 端会依次完成(平板上**不需要任何操作**):

| 步骤 | 用到的能力 | 作用 |
| --- | --- | --- |
| 找设备 | `adb devices` | 确认平板已连接且已授权 |
| 建隧道 | `adb reverse tcp:5000 tcp:5000` | 平板上的 `127.0.0.1:5000` 直达 PC,**不需要配任何 IP** |
| 装 App | `adb install -r` | 自动安装/升级平板端 App(APK 内嵌在 exe 里) |
| 推流 | ffmpeg + `h264_metadata=aud=insert` | 裸 H.264(不是 MPEG-TS),App 直接喂解码器 |
| 拉起 | `adb shell am start` | 自动打开 App 并全屏 |
| 常亮 | `adb shell svc power stayon true` | 副屏不会自己熄屏 |

#### 为什么可以不用 VLC

Android **没有**内置的流播放能力。所以"不用浏览器、也不用第三方 App"的唯一办法,
就是自己写一个客户端。这个客户端只做三件事:

1. 连 `127.0.0.1:5000`(`adb reverse` 隧道)
2. 读 12 字节头拿到分辨率
3. 把裸 H.264 按 AUD 切帧,喂给 `MediaCodec` 硬解,渲染到 `SurfaceView`

没有解封装、没有缓冲池,从收到帧到上屏只有解码耗时。

#### 协议(比 MPEG-TS 简单)

```
"VDS1"            4 字节魔数
width  (int32 LE) 4 字节
height (int32 LE) 4 字节
之后:连续 Annex-B H.264,已用 h264_metadata=aud=insert 插入 AUD
```

**为什么要自己写头**:走标准路径 App 就得解析 SPS 才能知道分辨率(要实现指数哥伦布解码);
而分辨率 PC 端本来就知道,12 字节头能省掉 App 一半的代码。

**为什么要插入 AUD**:裸 H.264 没有帧边界,App 需要自己判断"一帧到哪结束"。
插入 AUD(NAL type 9)后,每个 AUD 就是一次分界,App 只需按这个切分,不会花屏。

#### 构建平板 App(不使用 Gradle)

本机 `services.gradle.org` 不可达,所以不走 Gradle,而是直接调用官方 build-tools:

```
node --use-system-ca tools/fetch-android-toolchain.mjs   # 下载工具链到 .android-build/
node tools/build-apk.mjs                                  # aapt2 → javac → d8 → 重打包 → zipalign → apksigner
```

| 步骤 | 工具 | 说明 |
| --- | --- | --- |
| 清单与资源表 | `aapt2 link` | 产出带二进制清单的 APK |
| 编译 Java | `javac --release 17` | 本机 javac 是 25,必须降到 17 否则 d8 不认 class 版本 |
| 转 dex | `d8` | 输出 classes.dex |
| 塞进 APK | 自写 ZIP 读写 | 避免依赖,直接改 zip 结构 |
| 对齐 | `zipalign -p 4` | APK 要求 4 字节对齐 |
| 签名 | `apksigner` | 本地调试证书,verify 通过(v2 + v3 方案) |

工具链放在项目内 `.android-build/`(已 gitignore),JDK 复用机器上 JetBrains IDE 自带的 JBR,
不写系统目录、不需要管理员。

#### 已验证 / 未验证

**已在真机上跑通**(iQOO Pad / iPA2375,Android 15,1968×2800):

```
PC 端日志
  设备 400D5E041Y00000 已就绪
  端口隧道已建立:tcp:5000 → 平板 127.0.0.1:5000
  App 推流编码器:h264_mf
  平板已连接:127.0.0.1:52527
  已发送流头:VDS1 1920×1080

平板端日志
  VirtualDesk: 连接 127.0.0.1:5000
  VirtualDesk: 视频尺寸 1920x1080
  VirtualDesk: 画面布局 2800x1575(容器 2800x1968)
  VirtualDesk: 解码器已启动 1920x1080 (lowLatency=true)
```

平板全屏显示扩展桌面,无浏览器、无第三方播放器、无可见 UI。画面按 16:9 等比缩放
(2800×1575 居中,上下留黑边),不变形。

其他已验证项:

```
工具链   aapt2 2.19 / adb 34.0.5 / d8 8.2.2 / javac 25
APK      16.4 KiB,minSdk 26 / targetSdk 34
         apksigner verify 通过(v2 + v3)
内嵌     exe 运行时释放 APK 并 adb install
无设备   给出 USB 调试指引,退出码 1
```

#### 三个踩过的坑(值得记住)

1. **`resources.arsc` 必须不压缩**
   自己重打包 APK 时如果把所有条目都 deflate,Android 11+ 会直接拒绝安装:
   ```
   Failure [-124: ... requires the resources.arsc of installed APKs to be
              stored uncompressed and aligned on a 4-byte boundary]
   ```
   正确做法是**原样保留** aapt2 产出的压缩方式,只追加 `classes.dex`。

2. **拼访问单元必须补回起始码**
   NAL 解析器剥离了 `00 00 01`,而 `MediaCodec` 的输入要求标准 Annex-B。
   漏了这一步的表现很有欺骗性:解码器 `start()` 成功、日志一切正常,
   但平板永远停在「正在等待首帧」。

3. **`SurfaceView` 默认拉伸**
   16:9 的视频铺到 16:10 的平板上会被拉伸变形。必须按比例算显示区尺寸并居中,
   宁可留黑边也不要变形。

#### 显示模式:铺满还是完整

虚拟屏通常是 16:9,平板常见 16:10 / 3:2。**没有一种缩放方式能同时做到
"铺满 + 不变形 + 不丢内容"**,只能按偏好取舍:

| 模式 | 命令 | 效果 |
| --- | --- | --- |
| **铺满**(默认) | `第二块屏.exe --stream-app` | 等比放大到填满屏幕,溢出部分裁掉。实测 3499×1968 铺进 2800×1968,**两侧各裁约 12%** |
| **完整** | `第二块屏.exe --stream-app --fit` | 等比缩放到完整可见,上下留黑边。实测 2800×1575 居中 |

铺满模式下画面不变形,但窗口贴边时会被裁掉一部分。想三者兼得,唯一的办法是
**让虚拟屏分辨率等于平板分辨率**(2800×1968),这样视频与屏幕 1:1,不缩放、
不裁切、也最清晰。

> 那样做需要改 `vdd_settings.xml` 里的 `<resolutions>` 并重启驱动设备,
> 需要管理员权限。另外注意:实测这台机器上 `C:\VirtualDisplayDriver\` 已被
> 驱动安装程序清理,配置不在原位,重启驱动后可能重建出默认配置。
> 因此当前默认方案是"铺满 + 裁切",不依赖任何管理员操作。

#### 前置条件(只有一条)

平板上打开一次 **USB 调试**:`设置 → 关于平板 → 连点「版本号」7 次 → 开发者选项 → USB 调试`,
插线后在弹窗里点「允许」(建议勾「一律允许」)。之后 PC 记住授权,不用重复。

> vivo/iQOO 可能还有「USB 调试(安全设置)」开关;将来做触控回传时需要它。


### 6.7 还没做的

- **输入回传**(平板点按 → 电脑鼠标)。浏览器不能注入系统输入,需要一个原生程序调用
  `SendInput` 并把坐标映射到虚拟屏。没有这一步,副屏只能看、不能点。
  好消息是 ADB 通道已经打通,坐标回传只需在现有 TCP 连接上反向发小包。
- **60fps**:需要 Windows.Graphics.Capture 的 D3D11 互操作,当前 GDI 路径封顶 45fps。
- **App 真机验证**:APK 已构建并签名,但构建环境碰不到实体平板,解码与显示需要装机反馈。
- **竖屏与旋转**:平板竖着用时,虚拟屏也要设成竖屏,两者需配合;暂无自动同步。
- **零外部依赖**:`--stream` / `--stream-app` 都依赖 ffmpeg.exe。要彻底摆脱,
  需自研 IddCx 驱动 + 进程内 Media Foundation 编码。

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

