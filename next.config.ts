import type { NextConfig } from 'next';

/**
 * 打包目标由环境变量决定:
 *
 *   VD_BUILD_TARGET=static  → 静态导出(output: 'export')
 *     给单文件 exe 用:页面导出成纯静态 HTML/JS,接口由 C# 宿主提供。
 *     注意:静态导出不允许存在 API 路由,所以打包脚本会先把 src/app/api
 *     临时改名成 src/app/_api(Next 会忽略下划线开头的目录),构建完再改回来。
 *
 *   其它(默认) → output: 'standalone'
 *     给 Web 部署用:带自己的 Node 服务与 /api 路由(npm run dev / npm start)。
 */
const staticExport = process.env.VD_BUILD_TARGET === 'static';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: staticExport ? 'export' : 'standalone',

  ...(staticExport
    ? {
        // 静态导出时每个页面导出成独立 HTML,链接需要显式尾斜杠
        trailingSlash: true,
        // 静态导出不支持 Next 的图片优化服务
        images: { unoptimized: true },
      }
    : {
        // 静态导出(output: 'export')不经过 Next 的 Node 服务,headers() 不生效,
        // 那边由 C# 宿主自己发(见 shell/WebHost.cs 的 WriteResponse)。
        async headers() {
          return [
            {
              source: '/:path*',
              headers: [
                { key: 'X-Content-Type-Options', value: 'nosniff' },
                { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
                { key: 'Referrer-Policy', value: 'no-referrer' },
                // 刻意**不发** Permissions-Policy 的 display-capture 指令:
                // 它正是 getDisplayMedia 的门禁,写错会直接让核心功能失效。
                // 浏览器默认值已经是 self,省略即可。
              ],
            },
          ];
        },
      }),

  eslint: {
    // 桌面打包时跳过 ESLint(npm run lint 单独跑),缩短打包时间
    ignoreDuringBuilds: process.env.VD_SKIP_LINT === '1',
  },
};

export default nextConfig;
