import Link from 'next/link';

import {
  HARDWARE_SOLUTIONS,
  LIMITATIONS,
  OPEN_SOURCE_SOLUTIONS,
  PIPELINE,
  ROADMAP,
  SELF_BUILT_SOLUTIONS,
  TECH_DETAILS,
  type SolutionRow,
} from '@/content/home';

const SOLUTION_COLUMNS: { key: keyof SolutionRow; label: string }[] = [
  { key: 'name', label: '方案' },
  { key: 'transport', label: '传输方式' },
  { key: 'latency', label: '延迟' },
  { key: 'extended', label: '扩展屏支持' },
  { key: 'touch', label: '触控回传' },
];

function SectionHeading({
  eyebrow,
  title,
  description,
  id,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  id?: string;
}) {
  return (
    <div id={id} className="scroll-mt-24">
      <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-400/80">{eyebrow}</p>
      <h2 className="mt-2 text-2xl font-bold text-slate-100 sm:text-3xl">{title}</h2>
      {description ? (
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-400 sm:text-base">{description}</p>
      ) : null}
    </div>
  );
}

function SolutionTable({ rows }: { rows: SolutionRow[] }) {
  return (
    <div className="vd-table-wrap vd-panel">
      <table className="vd-table">
        <thead>
          <tr>
            {SOLUTION_COLUMNS.map((column) => (
              <th key={column.key}>{column.label}</th>
            ))}
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td className="font-medium text-slate-200">{row.name}</td>
              <td className="text-slate-400">{row.transport}</td>
              <td className="text-slate-400">{row.latency}</td>
              <td className="text-slate-400">{row.extended}</td>
              <td className="text-slate-400">{row.touch}</td>
              <td className="min-w-[16rem] text-slate-400">{row.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HomePage() {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 pb-24 sm:px-6">
      {/* ---------- 顶部导航 ---------- */}
      <header className="flex flex-wrap items-center justify-between gap-3 py-6">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 text-lg">
            🖥️
          </span>
          <div>
            <p className="text-sm font-semibold text-slate-100">第二块屏</p>
            <p className="text-xs text-slate-500">把平板 / 手机变成电脑的第二块显示屏</p>
          </div>
        </div>
        <nav className="flex flex-wrap items-center gap-2 text-sm">
          <Link href="/host" className="vd-btn">
            💻 电脑端
          </Link>
          <Link href="/view" className="vd-btn">
            📱 平板端
          </Link>
        </nav>
      </header>

      {/* ---------- Hero ---------- */}
      <section className="vd-card relative overflow-hidden p-6 sm:p-10">
        <div className="absolute -right-24 -top-24 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl" />
        <div className="relative">
          <div className="flex flex-wrap gap-2">
            <span className="vd-chip">Next.js App Router</span>
            <span className="vd-chip">WebRTC P2P</span>
            <span className="vd-chip">PostgreSQL + Drizzle</span>
            <span className="vd-chip">TypeScript</span>
          </div>

          <h1 className="mt-5 text-3xl font-bold leading-tight text-slate-50 sm:text-5xl">
            把平板变成电脑的
            <span className="bg-gradient-to-r from-cyan-300 to-indigo-300 bg-clip-text text-transparent">
              第二块显示屏
            </span>
          </h1>

          <p className="mt-4 max-w-3xl text-sm leading-relaxed text-slate-300 sm:text-base">
            这件事听起来只是“投屏”,实际上是一条完整的低延迟链路:系统要合成画面、GPU 要交出纹理、编码器要把画面压成几兆的码流、网络要顶住抖动,平板要立刻解码上屏,最后触控和手写笔还要回传。
            本页把这条链路的每一环讲清楚,并提供一个可运行的 WebRTC 串流原型。
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/host" className="vd-btn vd-btn-primary px-5 py-3 text-base">
              💻 我是电脑端 · 开始共享
            </Link>
            <Link href="/view" className="vd-btn px-5 py-3 text-base">
              📱 我是平板端 · 输入配对码
            </Link>
          </div>

          <div className="mt-8 grid gap-3 sm:grid-cols-3">
            <div className="vd-panel p-4">
              <p className="text-2xl font-bold text-cyan-300">1080p / 60fps</p>
              <p className="mt-1 text-xs text-slate-400">采集与编码目标,码率上限 8 Mbps</p>
            </div>
            <div className="vd-panel p-4">
              <p className="text-2xl font-bold text-cyan-300">70–120 ms</p>
              <p className="mt-1 text-xs text-slate-400">局域网内端到端延迟的合理区间</p>
            </div>
            <div className="vd-panel p-4">
              <p className="text-2xl font-bold text-cyan-300">0 台服务器</p>
              <p className="mt-1 text-xs text-slate-400">视频走 P2P,信令服务器只看得到 SDP</p>
            </div>
          </div>
        </div>
      </section>

      {/* ---------- 一、整体链路 ---------- */}
      <section className="mt-16">
        <SectionHeading
          id="pipeline"
          eyebrow="第一部分"
          title="整体链路:6 个步骤"
          description="从“电脑上有一帧画面”到“平板上能用手指操作”,中间要经过 6 个环节。任何一个环节的选型都会直接决定最终延迟和画质。"
        />

        <div className="mt-8 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {PIPELINE.map((stage) => (
            <article key={stage.step} className="vd-card flex flex-col p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-9 w-9 place-items-center rounded-full border border-cyan-400/40 bg-cyan-400/10 text-sm font-bold text-cyan-300">
                    {stage.step}
                  </span>
                  <h3 className="text-lg font-semibold text-slate-100">{stage.title}</h3>
                </div>
                <span className="vd-chip">{stage.hardware}</span>
              </div>

              <p className="mt-4 text-sm leading-relaxed text-slate-300">{stage.summary}</p>

              <ul className="mt-4 space-y-2 text-sm text-slate-400">
                {stage.points.map((point) => (
                  <li key={point} className="flex gap-2">
                    <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-cyan-400/70" />
                    <span className="leading-relaxed">{point}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="vd-panel mt-4 p-4 text-sm text-slate-400">
          <span className="font-semibold text-slate-200">延迟预算参考(局域网 1080p60):</span>
          <span className="ml-1 font-mono text-cyan-300">
            采集 8ms + 编码 10ms + 网络 15ms + 抖动缓冲 5ms + 解码 8ms + 上屏 16ms ≈ 60–120ms
          </span>
        </div>
      </section>

      {/* ---------- 二、关键技术详解 ---------- */}
      <section className="mt-16">
        <SectionHeading
          id="tech"
          eyebrow="第二部分"
          title="关键技术详解"
          description="六个话题,覆盖从驱动到注入的每一层。每一条都写清了“为什么这么做”和“会踩什么坑”。"
        />

        <div className="mt-8 space-y-4">
          {TECH_DETAILS.map((tech) => (
            <details key={tech.id} className="vd-card group p-0" open={tech.id === 'virtual-display'}>
              <summary className="flex cursor-pointer list-none items-start gap-3 p-5 [&::-webkit-details-marker]:hidden">
                <span className="text-2xl" aria-hidden>
                  {tech.icon}
                </span>
                <span className="flex-1">
                  <span className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-slate-100">{tech.title}</span>
                    <span className="text-xs text-slate-500 transition group-open:rotate-180">▾</span>
                  </span>
                  <span className="mt-1 block text-sm text-slate-400">{tech.lead}</span>
                </span>
              </summary>

              <div className="border-t border-slate-800/70 px-5 pb-5 pt-4">
                <dl className="space-y-4">
                  {tech.items.map((item) => (
                    <div key={item.name}>
                      <dt className="text-sm font-semibold text-cyan-300">{item.name}</dt>
                      <dd className="mt-1 text-sm leading-relaxed text-slate-400">{item.detail}</dd>
                    </div>
                  ))}
                </dl>

                {tech.pitfalls && tech.pitfalls.length > 0 ? (
                  <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/5 p-3">
                    <p className="text-xs font-semibold text-amber-300">容易踩的坑</p>
                    <ul className="mt-2 space-y-1 text-xs text-amber-200/80">
                      {tech.pitfalls.map((pitfall) => (
                        <li key={pitfall}>· {pitfall}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </details>
          ))}
        </div>
      </section>

      {/* ---------- 三、方案对比 ---------- */}
      <section className="mt-16">
        <SectionHeading
          id="compare"
          eyebrow="第三部分"
          title="现成方案 / 开源方案 / 自研方案"
          description="先想清楚要的是“镜像”还是“扩展屏”,再决定买硬件、用开源,还是自己写。三者并不是互相替代的关系。"
        />

        <div className="mt-8 space-y-8">
          <div>
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <span className="vd-chip">买现成的</span> 硬件 / 商业方案
            </h3>
            <SolutionTable rows={HARDWARE_SOLUTIONS} />
          </div>

          <div>
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <span className="vd-chip">开源改造</span> 可直接用的开源项目
            </h3>
            <SolutionTable rows={OPEN_SOURCE_SOLUTIONS} />
          </div>

          <div>
            <h3 className="mb-3 flex items-center gap-2 text-lg font-semibold text-slate-100">
              <span className="vd-chip">自己动手</span> 自研路线的两种形态
            </h3>
            <SolutionTable rows={SELF_BUILT_SOLUTIONS} />
          </div>
        </div>
      </section>

      {/* ---------- 四、实现路线 ---------- */}
      <section className="mt-16">
        <SectionHeading
          id="roadmap"
          eyebrow="第四部分"
          title="4 步实现路线"
          description="每一步都有明确的完成标准。本仓库完成的是第 1 步;第 3 步之后才真正谈得上“扩展屏”。"
        />

        <div className="mt-8 grid gap-4 lg:grid-cols-2">
          {ROADMAP.map((phase, index) => (
            <article key={phase.phase} className="vd-card relative p-5">
              <span className="absolute right-5 top-5 text-4xl font-black text-slate-800/80">
                {index + 1}
              </span>
              <span className="vd-chip">{phase.phase}</span>
              <h3 className="mt-3 text-lg font-semibold text-slate-100">{phase.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{phase.goal}</p>

              <ul className="mt-4 space-y-2 text-sm text-slate-400">
                {phase.tasks.map((task) => (
                  <li key={task} className="flex gap-2">
                    <span className="text-cyan-400/80">▸</span>
                    <span className="leading-relaxed">{task}</span>
                  </li>
                ))}
              </ul>

              <p className="mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-3 text-xs text-emerald-200/90">
                <span className="font-semibold">完成标准:</span> {phase.exit}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* ---------- 五、原型限制 ---------- */}
      <section className="mt-16">
        <SectionHeading
          id="limits"
          eyebrow="第五部分"
          title="原型限制说明"
          description="这一节很重要:它解释了为什么浏览器方案只能做镜像,以及要变成真正的扩展屏还差什么。"
        />

        <div className="mt-8 grid gap-4 md:grid-cols-2">
          {LIMITATIONS.map((item) => (
            <div key={item.title} className="vd-card border-amber-500/20 p-5">
              <h3 className="flex items-start gap-2 text-base font-semibold text-amber-200">
                <span aria-hidden>⚠️</span>
                {item.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">{item.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---------- 六、开始使用 ---------- */}
      <section className="mt-16">
        <div className="vd-card p-6 sm:p-8">
          <SectionHeading
            eyebrow="动手试试"
            title="现在就跑一遍局域网串流"
            description="电脑端点“开始共享”,选择要共享的屏幕,拿到 6 位配对码;然后在平板的浏览器里打开平板端页面,输入配对码即可。整个过程视频不经过服务器。"
          />

          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <div className="vd-panel p-5">
              <p className="text-sm font-semibold text-slate-200">① 电脑端</p>
              <p className="mt-1 text-xs text-slate-400">
                用 Chrome / Edge 打开,点击“开始共享”,在系统弹窗里选择“整个屏幕”。
              </p>
              <Link href="/host" className="vd-btn vd-btn-primary mt-4 w-full">
                💻 打开电脑端 /host
              </Link>
            </div>
            <div className="vd-panel p-5">
              <p className="text-sm font-semibold text-slate-200">② 平板端</p>
              <p className="mt-1 text-xs text-slate-400">
                平板与电脑要在同一 Wi-Fi 下,输入 6 位配对码;也可以直接用电脑端给出的链接。
              </p>
              <Link href="/view" className="vd-btn mt-4 w-full">
                📱 打开平板端 /view
              </Link>
            </div>
          </div>

          <p className="mt-5 text-xs leading-relaxed text-slate-500">
            提示:电脑端必须用 <span className="font-mono">http://localhost</span> 打开,否则浏览器会因为“非安全上下文”拒绝屏幕采集;平板端则需要用电脑的局域网 IP 访问(例如
            <span className="font-mono"> http://192.168.1.10:3000/view</span>)。
          </p>
        </div>
      </section>

      <footer className="mt-16 border-t border-slate-800/70 pt-6 text-xs text-slate-500">
        <p>
          第二块屏 · 技术科普 + WebRTC 屏幕串流原型 · 信令数据仅保存 2 小时,视频流不经过服务器
        </p>
        <p className="mt-1">
          源码结构:<span className="font-mono">src/lib/rtc.ts</span> 公共 WebRTC 工具 ·
          <span className="font-mono"> src/db/schema.ts</span> 信令表 ·
          <span className="font-mono"> src/app/api/session</span> 信令接口
        </p>
      </footer>
    </div>
  );
}
