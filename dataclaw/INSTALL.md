# DataClaw 安装说明

DataClaw 是一个本机 Node.js 应用；不需要 Python、数据库服务或全局安装的采集工具。

## 运行环境

- Node.js：20（含）至 27（不含）版本，推荐使用项目当前验证过的 `26.4.0`。
- npm：10 或以上，当前验证版本为 `11.17.0`。
- 已安装的 Google Chrome（标准稳定版）。采集时会调用本机 Chrome 浏览公开网页；macOS 默认位置为 `/Applications/Google Chrome.app`。

## 安装与校验

如果使用 nvm，可先在项目根目录执行：

```bash
nvm use
```

随后安装并校验：

```bash
npm ci
npm run check
```

未使用 nvm 时，确认 `node --version` 位于上述范围后，直接执行后两条命令即可。

`npm ci` 会严格使用仓库中的 `package-lock.json`，让不同电脑安装完全一致的 Node 依赖。若正在开发并且有意修改依赖清单，才使用 `npm install` 更新锁文件。

## 启动

```bash
npm start
```

浏览器打开 [http://localhost:4310](http://localhost:4310)。不要直接双击或以 `file://` 形式打开 `public/index.html`：那样只有静态页面，无法调用本地采集服务。

服务只绑定本机地址 `127.0.0.1`。停止服务可在启动它的终端按 `Ctrl+C`。

## 依赖清单

| 依赖 | 用途 |
| --- | --- |
| `cheerio` | 解析列表页与文章页的 HTML，辅助识别链接与正文。 |
| `playwright` | 连接并控制本机 Chrome，加载公开网页。 |

Node 依赖版本由 `package-lock.json` 锁定；浏览器运行时使用本机安装的 Google Chrome，不会额外下载浏览器。
