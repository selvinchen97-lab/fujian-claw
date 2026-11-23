# DataClaw 技术实现文档

## 1. 技术栈

| 层级 | 实现 |
| --- | --- |
| 本地服务 | Node.js 原生 `http` 模块 |
| 前端 | 原生 HTML、CSS、JavaScript 单页界面 |
| 浏览器采集 | Playwright 连接本机标准 Google Chrome 的 CDP 调试端口 |
| HTML 解析 | Cheerio |
| 数据存储 | 本地 JSON 文件 |
| 导出 | HTML、JSON |

服务入口为 `server.js`，监听 `127.0.0.1:4310`。

## 2. 目录

```text
dataclaw/
├── server.js                     # API、采集调度、数据读写
├── collector.js                  # Chrome 会话、页面加载、链接和正文解析
├── output.js                     # HTML / JSON 导出
├── public/                       # 前端页面、交互和样式
├── data/store.json               # 内容、路由状态、日志、采集设置
├── exports/                      # 已入库文章导出文件
├── PRD.md
└── TECHNICAL_IMPLEMENTATION.md
```

## 3. 架构

```text
浏览器界面
    │ HTTP API
    ▼
server.js ── 调度 / 去重 / 日志 / 停止控制 ── data/store.json
    │
    ▼
collector.js ── Playwright CDP ── 本机 Google Chrome ── 公开网站
    │
    ▼
Cheerio 解析正文 ── output.js ── exports/*.html + exports/*.json
```

## 4. 采集实现

### 浏览器会话

- 使用用户电脑上的标准 Google Chrome，而非无头浏览器。
- 使用专用且持久的本地 Chrome 配置目录，保留公开站点正常发放的会话 Cookie；采集器不读取用户日常 Chrome 的个人资料。
- 每个页面使用独立标签页，成功或失败后关闭标签页。
- 保留 HTTP/HTTPS 原始协议，不强制升级 HTTPS。
- 对海关栏目正文传递来源栏目页 Referer，提高公开页面访问稳定性。

### 轮转调度

批量任务默认采用 `round-robin`：

1. 依次读取所选路由的列表页，间隔 `listIntervalSeconds`。
2. 为每条路由建立最多 `maxArticlesPerRoute` 条候选队列。
3. 每轮按路由顺序各处理一篇文章。
4. 每篇正文后随机等待 `articleMinSeconds` 到 `articleMaxSeconds`。
5. 若仍有候选，轮次结束后等待 `cycleRestSeconds`。

`sequential` 是兼容模式，按一个栏目完成后再进入下一个栏目。

### 重试与停止

- `fetchWithRetry` 将 HTTP 400 视为临时站点限制，可按配置冷却重试。
- HTTP 412 的 JavaScript 验证页会被识别为“需要验证”，不会误作正文或无提示地长时间重试。
- 工作台可打开采集专用 Chrome 验证页；验证由用户在网站允许的公开流程中完成，随后重新发起采集。
- `activeRun` 保存当前任务路由、停止标记和等待取消回调。
- 停止 API 取消等待、关闭 Chrome，并将相关路由与未完成日志写为“已停止”。
- 当前运行状态只存在内存；历史结果保存在 JSON，不阻止新任务启动。
- 路由进入“采集中”与创建工作日志会在网络请求前立即保存，避免长请求期间状态停留在“排队中”。

## 5. 数据模型

`data/store.json` 主要字段：

```json
{
  "articles": [],
  "sources": [],
  "collectionLogs": [],
  "collectionSettings": {
    "strategy": "round-robin",
    "listIntervalSeconds": 20,
    "articleMinSeconds": 12,
    "articleMaxSeconds": 18,
    "cycleRestSeconds": 60,
    "retryFirstMinutes": 5,
    "retrySecondMinutes": 20,
    "maxRetries": 2,
    "maxArticlesPerRoute": 10
  }
}
```

文章以 `sourceUrl` 和页面最终 URL 去重。正文保存前规范为以空行分隔的段落，并补充 `sourceName`、`sourceRoute` 和 `status: "已入库"`。

## 6. 主要 API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/state` | 内容、路由、日志、设置与运行状态 |
| GET / PUT | `/api/collection-settings` | 读取或保存采集设置 |
| GET | `/api/sources/customs` | 获取内置路由及当前运行状态 |
| PATCH | `/api/sources/customs/:id` | 更新直接推送开关 |
| POST | `/api/sources/customs/:id/collect` | 启动单项采集 |
| POST | `/api/sources/customs/collect-batch` | 启动多路由采集 |
| POST | `/api/sources/customs/stop` | 停止当前任务 |
| GET | `/api/collection-logs` | 获取工作日志 |
| DELETE | `/api/articles/:id` | 删除文章及导出文件 |

## 7. 运行与维护

- 启动：`npm start`。
- 代码修改后需重启本地服务。
- 静态响应使用 `Cache-Control: no-store`，减少旧页面与新接口不匹配。
- 采集任务运行中不允许保存采集设置，防止参数前后不一致。
- 站点临时风控、页面模板变更或网络异常会记录为失败；系统不尝试规避访问控制。
