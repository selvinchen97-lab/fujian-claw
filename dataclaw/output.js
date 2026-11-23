import { mkdir, writeFile, rm, readFile } from "node:fs/promises";
export const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
function logisticsDate(value) {
  if (!value) return new Date().toISOString().slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? String(value).slice(0, 10)
    : parsed.toISOString().slice(0, 10);
}
function sourceLabel(a) {
  const source = a.sourceName
    ? `${a.sourceName}${a.sourceRoute ? ` · ${a.sourceRoute}` : ""}`
    : "公开网页";
  return source;
}
export function logisticsHtml(a) {
  const date = logisticsDate(a.publishedAt || a.createdAt);
  const source = sourceLabel(a);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(a.title)} - 中国（福建）国际贸易单一窗口</title><style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#333;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif}.topbar{height:26px;background:#151b87;color:#fff}.top-inner{width:1200px;height:100%;margin:auto;display:flex;justify-content:flex-end;align-items:center;gap:15px;font-size:12px}.header{height:78px;background:linear-gradient(#4895d1,#246bb5);box-shadow:inset 0 -1px rgba(255,255,255,.28)}.header-inner{width:1200px;height:100%;margin:auto;display:flex;align-items:center}.brand{color:#fff;line-height:1;letter-spacing:1px}.brand-main{font-size:27px;font-weight:300;text-shadow:0 1px 1px #276195}.brand-sub{font-family:STKaiti,KaiTi,serif;font-size:17px;letter-spacing:6px;margin:8px 0 0 3px;opacity:.92}.nav{margin-left:auto;display:flex;gap:28px;color:#fff;font-size:16px}.nav span{white-space:nowrap}.page{width:1200px;min-height:760px;margin:auto;padding:7px 22px 50px;border-left:1px solid #ddd;border-right:1px solid #ddd}.crumb{height:44px;display:flex;align-items:center;color:#5b88b9;font-size:13px}.article{padding:30px 80px 44px;border-top:1px solid #e7e7e7}.article h1{margin:0;text-align:center;font-size:26px;font-weight:500;line-height:1.55;color:#333}.meta{margin:18px 0 34px;text-align:center;color:#8c8c8c;font-size:14px}.body{font-family:SimSun,"Songti SC",serif;font-size:17px;line-height:2.05;color:#333}.body p{margin:0 0 1.1em;text-indent:2em;white-space:pre-wrap}.source{margin-top:34px;padding-top:18px;border-top:1px solid #ededed;color:#777;font:14px/1.9 "Microsoft YaHei","PingFang SC",sans-serif}.source a{color:#3f7dbc;word-break:break-all}.disclaimer{margin-top:16px;color:#999;font:13px/1.85 "Microsoft YaHei","PingFang SC",sans-serif}.footer{padding:23px 0 28px;background:#123f80;color:#d0e0f1;text-align:center;font-size:12px;line-height:2.4}@media(max-width:800px){.top-inner,.header-inner,.page{width:100%}.nav{display:none}.page{border:0;padding:6px 15px 40px}.article{padding:25px 6px}.article h1{font-size:22px}.body{font-size:16px}}</style></head><body><div class="topbar"><div class="top-inner">客服服务　微信公众号</div></div><header class="header"><div class="header-inner"><div class="brand"><div class="brand-main">中国（福建）国际贸易单一窗口</div><div class="brand-sub">福建省电子口岸公共平台</div></div><nav class="nav"><span>首页</span><span>单一窗口</span><span>口岸动态</span><span>口岸服务</span><span>阳光收费</span><span>操作时限</span><span>会员中心</span><span>客户服务</span></nav></div></header><main class="page"><div class="crumb">首页　&gt;&gt;　口岸服务　&gt;&gt;　国际物流专区　&gt;&gt;　物流政策与资讯动态</div><article class="article"><h1>${escape(a.title)}</h1><div class="meta">发布日期：${escape(date)}　|　【打印】</div><div class="body">${a.content
    .split(/\n\s*\n/)
    .map((p) => `<p>${escape(p)}</p>`)
    .join(
      "",
    )}</div><div class="source"><div>来源：${escape(source)}</div><div>原文网址：<a href="${escape(a.sourceUrl)}" target="_blank" rel="noreferrer">${escape(a.sourceUrl)}</a></div></div><div class="disclaimer">免责声明：本页面内容仅作公开信息传播与参考，文章观点和事实以原始来源为准；如涉及版权问题，请联系处理。</div></article></main><footer class="footer">闽ICP备14009608号-5　　闽ICP备14009608号-20<br>地址：福州市鼓楼区铜盘路118号　管理运营：福建省电子口岸服务中心</footer></body></html>`;
}
export function html(a) {
  return logisticsHtml(a);
}
export async function output(a) {
  const folder = new URL("./exports/", import.meta.url);
  await mkdir(folder, { recursive: true });
  await writeFile(new URL(a.id + ".html", folder), html(a));
  await writeFile(new URL(a.id + ".json", folder), JSON.stringify(a, null, 2));
}
export async function removeOutput(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("无效文章标识");
  const folder = new URL("./exports/", import.meta.url);
  await Promise.all(
    ["html", "json"].map((ext) =>
      rm(new URL(`${id}.${ext}`, folder), { force: true }),
    ),
  );
}
const logisticsNewsFolder = new URL("../dist/data/", import.meta.url);
const logisticsNewsFile = new URL("logistics-news.js", logisticsNewsFolder);
const logisticsArticleFolder = new URL("../dist/policy/", import.meta.url);
async function readLogisticsNews() {
  try {
    const script = await readFile(logisticsNewsFile, "utf8");
    const assignment = script.indexOf("window.LOGISTICS_NEWS");
    if (assignment < 0) return [];
    const json = script
      .slice(script.indexOf("=", assignment) + 1)
      .trim()
      .replace(/;\s*$/, "");
    const news = JSON.parse(json);
    return Array.isArray(news) ? news : [];
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
async function writeLogisticsNews(news) {
  await mkdir(logisticsNewsFolder, { recursive: true });
  await writeFile(
    logisticsNewsFile,
    `window.LOGISTICS_NEWS = ${JSON.stringify(news, null, 2)};\n`,
  );
}
export async function publishLogisticsArticle(article) {
  if (!article?.id || !article.title || !article.content)
    throw Error("文章信息不完整，无法推送到物流资讯栏目");
  await mkdir(logisticsArticleFolder, { recursive: true });
  const detailPath = `policy/${article.id}.html`;
  const publishedAt = new Date().toISOString();
  const item = {
    id: article.id,
    title: article.title,
    date: logisticsDate(article.publishedAt || article.createdAt),
    excerpt: article.content.replace(/\s+/g, " ").trim().slice(0, 150),
    detailPath,
    sourceUrl: article.sourceUrl,
    publishedAt,
  };
  const existing = await readLogisticsNews();
  const news = [item, ...existing.filter((entry) => entry.id !== article.id)];
  await writeFile(new URL(`${article.id}.html`, logisticsArticleFolder), logisticsHtml(article));
  await writeLogisticsNews(news);
  return { detailPath, publishedAt };
}
export async function removeLogisticsArticle(id) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw Error("无效文章标识");
  const existing = await readLogisticsNews();
  if (existing.some((entry) => entry.id === id))
    await writeLogisticsNews(existing.filter((entry) => entry.id !== id));
  await rm(new URL(`${id}.html`, logisticsArticleFolder), { force: true });
}
