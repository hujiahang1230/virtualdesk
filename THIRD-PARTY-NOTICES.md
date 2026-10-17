# 第三方组件声明

本项目内联了下列第三方代码。为便于审计与离线构建,相关源码直接放在仓库里,
而不是构建时从网络安装。

---

## qrcode-generator

- 文件:`src/lib/vendor/qrcode-generator.js`
- 用途:在浏览器里生成平板接入用的二维码
- 项目主页:<http://www.d-project.com/>
- 说明:仓库内为上游源码,仅在文件末尾追加了一个 ES 模块 `export default` 导出
  (上游是 UMD,在 Next 的 ESM 解析下取不到默认导出)。

```
QR Code Generator for JavaScript

Copyright (c) 2009 Kazuhiko Arase

URL: http://www.d-project.com/

Licensed under the MIT license:
  http://www.opensource.org/licenses/mit-license.php

The word 'QR Code' is registered trademark of
DENSO WAVE INCORPORATED
  http://www.denso-wave.com/qrcode/faqpatent-e.html
```

MIT License 全文:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

---

## 运行期依赖

其余第三方组件通过包管理器安装,许可证见各自 npm 包:

| 组件 | 用途 |
| --- | --- |
| [Next.js](https://nextjs.org/) | Web 框架(App Router) |
| [React](https://react.dev/) | UI |
| [Tailwind CSS](https://tailwindcss.com/) | 样式 |
| [Drizzle ORM](https://orm.drizzle.team/) | Web 版数据库访问 |
| [postgres](https://github.com/porsager/postgres) | Web 版 PostgreSQL 驱动 |
| [Microsoft.Data.Sqlite](https://learn.microsoft.com/dotnet/standard/data/sqlite/) | 免安装版的信令存储 |
| [Microsoft.Web.WebView2](https://learn.microsoft.com/microsoft-edge/webview2/) | 仅用于早期的试做版本(现已移除) |

内置 PostgreSQL / Node 运行时不随仓库分发,仅在本地打包时使用。
