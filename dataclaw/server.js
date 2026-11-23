import http from "node:http";
import {
  html as exportHtml,
  output,
  removeOutput,
  publishLogisticsArticle,
  removeLogisticsArticle,
} from "./output.js";
import {
  page as browserPage,
  links as browserLinks,
  article as browserArticle,
  closeBrowser,
  openVerificationPage,
} from "./collector.js";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const dataFile = join(root, "data", "store.json");
const customsCategories = [
  {
    name: "媒体聚焦",
    url: "http://ltj.customs.gov.cn/customs/xwfb34/mtjj35/index.html",
  },
  {
    name: "重要会议",
    url: "http://ltj.customs.gov.cn/customs/xwfb34/3128008/index.html",
  },
  {
    name: "新闻发布会",
    url: "http://ltj.customs.gov.cn/customs/xwfb34/302330/index.html",
  },
  {
    name: "各关新闻",
    url: "http://ltj.customs.gov.cn/customs/xwfb34/302263/index.html",
  },
];
const sourceDefaults = customsCategories.map((category, index) => ({
  id: `customs-route-${index + 1}`,
  site: "海关总署",
  route: category.name,
  url: category.url,
  directPush: false,
  lastCollectedAt: null,
  status: "待采集",
  collectorVersion: 2,
}));
const collectionSettingsDefaults = {
  strategy: "round-robin",
  listIntervalSeconds: 20,
  articleMinSeconds: 12,
  articleMaxSeconds: 18,
  cycleRestSeconds: 60,
  retryFirstMinutes: 5,
  retrySecondMinutes: 20,
  maxRetries: 2,
  maxArticlesPerRoute: 10,
  // Disabled by default so upgrading or restarting the service never starts
  // a collection unexpectedly.
  scheduleEnabled: false,
  scheduleTime: "09:00",
  scheduleSourceIds: sourceDefaults.map((source) => source.id),
  scheduleLastRunKey: null,
};
const seed = {
  tasks: [],
  articles: [],
  sources: sourceDefaults,
  collectionLogs: [],
  collectionSettings: collectionSettingsDefaults,
};

async function load() {
  const saved = existsSync(dataFile)
    ? JSON.parse(await readFile(dataFile, "utf8"))
    : structuredClone(seed);
  const existingSources = new Map(
    (saved.sources || []).map((source) => [source.id, source]),
  );
  return {
    ...saved,
    tasks: saved.tasks || [],
    articles: saved.articles || [],
    collectionLogs: saved.collectionLogs || [],
    collectionSettings: {
      ...collectionSettingsDefaults,
      ...(saved.collectionSettings || {}),
    },
    sources: sourceDefaults.map((source) => {
      const task = (saved.tasks || []).find((item) => item.url === source.url);
      const persisted = existingSources.get(source.id);
      // Results created before the resilient-browser collector were not
      // comparable: the browser profile could be torn down mid-batch.  Do not
      // present those obsolete failures as the status of the current route.
      const needsCollectorMigration = !persisted?.collectorVersion;
      return {
        ...source,
        lastCollectedAt: task?.lastRun || source.lastCollectedAt,
        status: task?.lastRun ? task.status || source.status : source.status,
        ...persisted,
        ...(needsCollectorMigration
          ? { lastCollectedAt: null, lastResult: null, status: "待采集" }
          : {}),
      };
    }),
  };
}
async function save(data) {
  await mkdir(join(root, "data"), { recursive: true });
  const temp = dataFile + "." + crypto.randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, dataFile);
}
function reply(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    // The workbench is a local, mutable application.  Serving an earlier
    // HTML/JS bundle after a restart leaves users on a mismatched UI/API.
    "cache-control": "no-store, max-age=0",
  });
  res.end(
    Buffer.isBuffer(data) || typeof data === "string"
      ? data
      : JSON.stringify(data),
  );
}
function previewDocument(html, sourceUrl) {
  const base = `<base href="${String(sourceUrl).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}" target="_blank">`;
  const safeHtml = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<meta\b[^>]*http-equiv=["']?refresh[^>]*>/gi, "");
  if (/<head\b[^>]*>/i.test(safeHtml))
    return safeHtml.replace(/<head\b[^>]*>/i, (match) => `${match}${base}`);
  return `<!doctype html><html><head><meta charset="utf-8">${base}</head><body>${safeHtml}</body></html>`;
}
function clean(value = "") {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function absolute(url, href) {
  try {
    return new URL(href, url).href;
  } catch {
    return null;
  }
}
function extractLinks(html, base) {
  const links = [
    ...html.matchAll(
      /<a\b[^>]*href=["']([^"'#?][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ]
    .map((m) => ({ url: absolute(base, m[1]), title: clean(m[2]) }))
    .filter((x) => x.url && x.title && x.title.length > 5);
  return [...new Map(links.map((x) => [x.url, x])).values()].slice(0, 80);
}
function extractArticle(html, url) {
  const title =
    clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]) ||
    "未识别标题";
  const bodyMatch =
    html.match(/<(article|main)[^>]*>([\s\S]*?)<\/(article|main)>/i) ||
    html.match(
      /<div[^>]+(?:class|id)=["'][^"']*(?:content|article|detail|news)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i,
    );
  const text = clean(bodyMatch ? bodyMatch[2] || bodyMatch[1] : html);
  return {
    id: crypto.randomUUID(),
    title,
    sourceUrl: url,
    content: text.slice(0, 30000),
    createdAt: new Date().toISOString(),
    status: "草稿",
  };
}
const pageCache = new Map();
const articlePreviews = new Map();
async function fetchPage(url, fresh = false, referer) {
  const cached = pageCache.get(url);
  if (!fresh && cached && Date.now() - cached.savedAt < 30 * 60 * 1000)
    return cached.value;
  let value;
  try {
    value = await browserPage(url, referer);
  } catch (firstError) {
    // Keep a normal browser session (including any public-site cookies) after
    // a temporary 4xx/WAF response.  Only a genuinely detached browser needs
    // to be rebuilt; otherwise the next paced article request is needlessly
    // treated as a brand-new client.
    if (/Target page, context or browser has been closed|browser has been closed|frame was detached/i.test(firstError.message || ""))
      await closeBrowser();
    throw firstError;
  }
  pageCache.set(url, { savedAt: Date.now(), value });
  return value;
  /* legacy
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('仅支持 HTTP/HTTPS 公开网址');
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; DataClaw/0.1; +local-content-workbench)', 'accept-language': 'zh-CN,zh;q=0.9' } });
  const html = await response.text();
  if (!response.ok) {
    if ([401, 403, 412, 429].includes(response.status)) throw new Error(`目标站点返回 HTTP ${response.status}，拒绝了自动化访问或需要额外验证；DataClaw 不会绕过该访问控制。`);
    throw new Error(`目标服务器返回 HTTP ${response.status}`);
  }
  if (/$_ts|安全验证|验证码|访问过于频繁|人机验证/i.test(html) && html.length < 12000) throw new Error('目标站点返回反自动化验证页，尚未得到可提取的公开正文。可尝试浏览器渲染、开放接口或取得网站授权。');
  return { finalUrl: response.url, html }; */
}
function formatArticleForStorage(article, source) {
  const paragraphs = article.content
    .replace(/\r/g, "")
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter((paragraph) => paragraph.length > 0);
  if (!paragraphs.length) throw Error("正文为空，未入库");
  return {
    ...article,
    content: paragraphs.join("\n\n"),
    sourceName: source.site,
    sourceRoute: source.route,
    status: "已入库",
  };
}
async function pushWhenEnabled(article, source) {
  if (!source.directPush) return article;
  try {
    const published = await publishLogisticsArticle(article);
    return {
      ...article,
      logisticsPublishedAt: published.publishedAt,
      logisticsDetailPath: published.detailPath,
      logisticsPushError: null,
    };
  } catch (error) {
    // Collection must not discard a successfully captured public article just
    // because the local presentation site cannot be written at that moment.
    console.error("推送物流资讯栏目失败：", error);
    return { ...article, logisticsPushError: error.message };
  }
}
let running = false;
let activeRun = null;
async function collectSource(id, manageRunning = true, run) {
  let result = { added: 0, skipped: 0, failed: [] };
  let logId;
  try {
    ensureRunning(run);
    let data = await load();
    const source = data.sources.find((item) => item.id === id);
    if (!source) throw Error("采集路由不存在");
    source.status = "采集中";
    source.lastResult = null;
    source.statusDetail = null;
    logId = crypto.randomUUID();
    data.collectionLogs.unshift({
      id: logId,
      sourceId: source.id,
      site: source.site,
      route: source.route,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "采集中",
      added: 0,
      skipped: 0,
      failed: 0,
    });
    await save(data);

    const list = await fetchPage(source.url, true);
    const candidates = browserLinks(list.html, list.finalUrl);
    if (!candidates.length) throw Error("未识别到可采集的文章链接");
    const existingUrls = new Set(
      data.articles.map((article) => article.sourceUrl),
    );
    for (const item of candidates) {
      ensureRunning(run);
      if (existingUrls.has(item.url)) {
        result.skipped += 1;
        continue;
      }
      try {
        const detail = await fetchPage(item.url, true, source.url);
        if (existingUrls.has(detail.finalUrl)) {
          result.skipped += 1;
          continue;
        }
        let article = formatArticleForStorage(
          browserArticle(detail.html, detail.finalUrl),
          source,
        );
        article = await pushWhenEnabled(article, source);
        await output(article);
        data.articles.unshift(article);
        existingUrls.add(item.url);
        existingUrls.add(article.sourceUrl);
        result.added += 1;
        await save(data);
      } catch (error) {
        result.failed.push(`${item.title}：${error.message}`);
      }
      // Public-government sites commonly apply short burst limits.  Pace a
      // batch exactly as a reader stepping through article links would.
      await delay(1800, run);
    }
    data = await load();
    const latestSource = data.sources.find((item) => item.id === id);
    latestSource.lastCollectedAt = new Date().toISOString();
    latestSource.lastResult = result;
    latestSource.status = result.failed.length
      ? result.added || result.skipped
        ? "部分失败"
        : "采集失败"
      : result.added
        ? "完成"
        : "无新增";
    const log = data.collectionLogs.find((item) => item.id === logId);
    if (log)
      Object.assign(log, {
        finishedAt: new Date().toISOString(),
        status: latestSource.status,
        added: result.added,
        skipped: result.skipped,
        failed: result.failed.length,
      });
    await save(data);
  } catch (error) {
    if (error.code === "COLLECTION_STOPPED") throw error;
    const data = await load();
    const source = data.sources.find((item) => item.id === id);
    if (source) {
      source.status = "采集失败";
      source.lastCollectedAt = new Date().toISOString();
      source.lastResult = {
        ...result,
        failed: [...result.failed, error.message],
      };
      const log = data.collectionLogs.find((item) => item.id === logId);
      if (log)
        Object.assign(log, {
          finishedAt: new Date().toISOString(),
          status: "采集失败",
          added: result.added,
          skipped: result.skipped,
          failed: result.failed.length + 1,
        });
      await save(data);
    }
  } finally {
    if (manageRunning) running = false;
  }
}
async function collectSources(ids, run) {
  try {
    let data = await load();
    const settings = data.collectionSettings;
    const requested = new Set(ids);
    data.sources.forEach((source) => {
      if (!requested.has(source.id)) return;
      source.status = "排队中";
      source.lastResult = null;
      source.statusDetail = null;
    });
    await save(data);
    if (settings.strategy === "sequential") {
      for (const id of ids) {
        await collectSource(id, false, run);
        if (id !== ids.at(-1)) await delay(settings.cycleRestSeconds * 1000, run);
      }
      return;
    }

    const jobs = [];
    for (let index = 0; index < ids.length; index += 1) {
      const source = data.sources.find((item) => item.id === ids[index]);
      const result = { added: 0, skipped: 0, failed: [] };
      const logId = crypto.randomUUID();
      source.status = "采集中";
      data.collectionLogs.unshift({
        id: logId, sourceId: source.id, site: source.site, route: source.route,
        startedAt: new Date().toISOString(), finishedAt: null, status: "采集中",
        added: 0, skipped: 0, failed: 0,
      });
      // Persist the start immediately.  Without this save a 412 verification
      // wait left the UI looking as though every route was merely queued.
      await save(data);
      try {
        const list = await fetchWithRetry(source.url, true, undefined, settings, run);
        const candidates = browserLinks(list.html, list.finalUrl).slice(0, settings.maxArticlesPerRoute);
        if (!candidates.length) throw Error("未识别到可采集的文章链接");
        jobs.push({ source, result, logId, candidates, index: 0 });
      } catch (error) {
        result.failed.push(error.message);
        source.statusDetail = error.message;
        const log = data.collectionLogs.find((item) => item.id === logId);
        if (log) log.message = error.message;
        jobs.push({ source, result, logId, candidates: [], index: 0 });
      }
      await save(data);
      if (index < ids.length - 1) await delay(settings.listIntervalSeconds * 1000, run);
    }

    const existingUrls = new Set(data.articles.map((article) => article.sourceUrl));
    while (jobs.some((job) => job.index < job.candidates.length)) {
      for (const job of jobs) {
        ensureRunning(run);
        const item = job.candidates[job.index++];
        if (!item) continue;
        if (existingUrls.has(item.url)) { job.result.skipped += 1; continue; }
        try {
          const detail = await fetchWithRetry(item.url, true, job.source.url, settings, run);
          if (existingUrls.has(detail.finalUrl)) job.result.skipped += 1;
          else {
            let article = formatArticleForStorage(browserArticle(detail.html, detail.finalUrl), job.source);
            article = await pushWhenEnabled(article, job.source);
            await output(article);
            data.articles.unshift(article);
            existingUrls.add(item.url); existingUrls.add(article.sourceUrl);
            job.result.added += 1;
            await save(data);
          }
        } catch (error) { job.result.failed.push(`${item.title}：${error.message}`); }
        await delay(randomBetween(settings.articleMinSeconds, settings.articleMaxSeconds) * 1000, run);
      }
      if (jobs.length > 1 && jobs.some((job) => job.index < job.candidates.length))
        await delay(settings.cycleRestSeconds * 1000, run);
    }
    for (const job of jobs) finishCollection(data, job.source.id, job.result, job.logId);
    await save(data);
  } catch (error) {
    if (error.code === "COLLECTION_STOPPED") await markRunStopped(ids);
    else throw error;
  } finally {
    running = false;
    if (activeRun === run) activeRun = null;
  }
}
function ensureRunning(run) {
  if (run?.stopped) {
    const error = Error("采集任务已停止");
    error.code = "COLLECTION_STOPPED";
    throw error;
  }
}
function delay(ms, run) {
  ensureRunning(run);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    run?.stoppers.add(() => { clearTimeout(timer); reject(Object.assign(Error("采集任务已停止"), { code: "COLLECTION_STOPPED" })); });
  });
}
function randomBetween(min, max) { return Math.floor(min + Math.random() * (max - min + 1)); }
async function fetchWithRetry(url, fresh, referer, settings, run) {
  let attempt = 0;
  while (true) {
    ensureRunning(run);
    try { return await fetchPage(url, fresh, referer); }
    catch (error) {
      if (error.code === "SITE_VERIFICATION_REQUIRED") throw error;
      if (!/HTTP 400|HTTP 412/.test(error.message || "") || attempt >= settings.maxRetries) throw error;
      await closeBrowser();
      const minutes = attempt === 0 ? settings.retryFirstMinutes : settings.retrySecondMinutes;
      attempt += 1;
      await delay(minutes * 60 * 1000, run);
    }
  }
}
async function markRunStopped(ids) {
  const data = await load();
  const requested = new Set(ids);
  data.sources.forEach((source) => {
    if (requested.has(source.id) && ["采集中", "排队中"].includes(source.status)) source.status = "已停止";
  });
  data.collectionLogs.forEach((log) => {
    if (requested.has(log.sourceId) && log.status === "采集中") Object.assign(log, { status: "已停止", finishedAt: new Date().toISOString() });
  });
  await save(data);
}
function finishCollection(data, sourceId, result, logId) {
  const source = data.sources.find((item) => item.id === sourceId);
  source.lastCollectedAt = new Date().toISOString(); source.lastResult = result;
  source.statusDetail = result.failed[0] || null;
  source.status = result.failed.some((message) => /浏览器验证页|SITE_VERIFICATION_REQUIRED/.test(message))
    ? "需要验证"
    : result.failed.length ? (result.added || result.skipped ? "部分失败" : "采集失败") : (result.added ? "完成" : "无新增");
  const log = data.collectionLogs.find((item) => item.id === logId);
  if (log) Object.assign(log, { finishedAt: new Date().toISOString(), status: source.status, added: result.added, skipped: result.skipped, failed: result.failed.length, message: result.failed[0] || null });
}
function startCollectionRun(ids) {
  if (running) throw Error("已有采集正在进行，请等待完成或停止后再试");
  const run = { ids, stopped: false, stoppers: new Set() };
  activeRun = run;
  running = true;
  collectSources(ids, run).catch((error) => console.error("采集任务异常：", error));
  return run;
}
function localScheduleKey(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
function validScheduleTime(value) {
  return /^([01]\\d|2[0-3]):[0-5]\\d$/.test(value || "");
}
async function runScheduledCollectionIfDue() {
  if (running) return;
  const data = await load();
  const settings = data.collectionSettings;
  if (!settings.scheduleEnabled || !validScheduleTime(settings.scheduleTime)) return;
  const now = new Date();
  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const runKey = `${localScheduleKey(now)} ${settings.scheduleTime}`;
  // A short restart at the scheduled minute should not make that day's run
  // disappear; the persisted key nevertheless prevents a duplicate run.
  if (nowTime < settings.scheduleTime || settings.scheduleLastRunKey === runKey) return;
  const ids = [...new Set(settings.scheduleSourceIds || [])].filter((id) =>
    data.sources.some((source) => source.id === id),
  );
  if (!ids.length) return;
  settings.scheduleLastRunKey = runKey;
  await save(data);
  startCollectionRun(ids);
  console.log(`定时采集已启动：${runKey}，${ids.length} 条路由`);
}
async function runTask(id) {
  if (running) throw Error("已有任务运行，请稍后重试");
  running = true;
  let data = await load(),
    task = data.tasks.find((t) => t.id === id);
  if (!task) {
    running = false;
    throw Error("任务不存在");
  }
  task.status = "运行中";
  task.lastRun = new Date().toISOString();
  task.log = [];
  await save(data);
  try {
    const list = await fetchPage(task.url);
    const candidates = browserLinks(list.html, list.finalUrl).slice(
      0,
      task.limit || 5,
    );
    if (!candidates.length) throw Error("此栏目未识别到文章链接");
    for (const item of candidates) {
      data = await load();
      task = data.tasks.find((t) => t.id === id);
      if (data.articles.some((a) => a.sourceUrl === item.url)) {
        task.log.push("跳过重复：" + item.title);
        await save(data);
        continue;
      }
      try {
        const p = await fetchPage(item.url),
          a = browserArticle(p.html, p.finalUrl);
        data = await load();
        task = data.tasks.find((t) => t.id === id);
        a.category = task.name;
        await output(a);
        if (!data.articles.some((x) => x.sourceUrl === a.sourceUrl))
          data.articles.unshift(a);
        task.log.push("已保存：" + a.title);
      } catch (e) {
        task.log.push("失败：" + item.title + " — " + e.message);
      }
      await save(data);
    }
    task.status = task.log.some((x) => x.startsWith("失败"))
      ? "部分失败"
      : "完成";
  } catch (e) {
    task.status = "失败";
    task.log.push(e.message);
  } finally {
    const latest = await load();
    latest.tasks[latest.tasks.findIndex((t) => t.id === id)] = task;
    task.nextRun =
      task.frequency === "manual"
        ? null
        : new Date(
            Date.now() + (task.frequency === "hourly" ? 3600000 : 86400000),
          ).toISOString();
    await save(latest);
    running = false;
  }
}
async function handleApi(req, res, body) {
  const url = new URL(req.url, "http://local");
  const data = await load();
  if (req.method === "GET" && url.pathname === "/api/state")
    return reply(res, 200, { ...data, collectionRunning: running });
  if (req.method === "GET" && url.pathname === "/api/collection-logs")
    return reply(res, 200, { logs: data.collectionLogs });
  if (req.method === "GET" && url.pathname === "/api/collection-settings")
    return reply(res, 200, data.collectionSettings);
  if (req.method === "PUT" && url.pathname === "/api/collection-settings") {
    if (running) throw Error("采集进行中，完成后再修改执行设置");
    const numeric = ["listIntervalSeconds", "articleMinSeconds", "articleMaxSeconds", "cycleRestSeconds", "retryFirstMinutes", "retrySecondMinutes", "maxRetries", "maxArticlesPerRoute"];
    if (!["round-robin", "sequential"].includes(body.strategy)) throw Error("采集策略无效");
    const settings = { ...data.collectionSettings, ...body };
    for (const key of numeric) {
      if (!Number.isInteger(settings[key]) || settings[key] < 0 || settings[key] > 3600) throw Error(`设置 ${key} 无效`);
    }
    if (settings.articleMinSeconds > settings.articleMaxSeconds) throw Error("正文最小间隔不能大于最大间隔");
    if (typeof settings.scheduleEnabled !== "boolean") throw Error("定时采集开关无效");
    if (!validScheduleTime(settings.scheduleTime))
      throw Error("定时采集时间应为 HH:MM，例如 09:30");
    if (!Array.isArray(settings.scheduleSourceIds))
      throw Error("请提供定时采集路由配置");
    settings.scheduleSourceIds = [...new Set(settings.scheduleSourceIds)];
    if (settings.scheduleSourceIds.some((id) => !data.sources.some((source) => source.id === id)))
      throw Error("定时采集包含不存在的路由");
    if (settings.scheduleEnabled && !settings.scheduleSourceIds.length)
      throw Error("请至少选择一条需要定时采集的路由");
    data.collectionSettings = settings;
    await save(data);
    return reply(res, 200, settings);
  }
  if (req.method === "PUT" && /^\/api\/tasks\/[^/]+$/.test(url.pathname)) {
    throw Error("采集配置已移除，采集源现由代码内置管理");
  }
  if (req.method === "GET" && url.pathname === "/api/sources/customs")
    return reply(res, 200, {
      name: "海关总署",
      categories: customsCategories,
      configurations: data.sources,
      running,
    });
  if (
    req.method === "PATCH" &&
    /^\/api\/sources\/customs\/[^/]+$/.test(url.pathname)
  ) {
    if (typeof body.directPush !== "boolean") throw Error("请指定是否直接推送");
    const id = url.pathname.split("/").pop();
    const source = data.sources.find((item) => item.id === id);
    if (!source) throw Error("采集路由不存在");
    source.directPush = body.directPush;
    await save(data);
    return reply(res, 200, source);
  }
  if (
    req.method === "POST" &&
    url.pathname === "/api/sources/customs/collect-batch"
  ) {
    const ids = [...new Set(body.ids || [])];
    if (!ids.length) throw Error("请至少选择一条采集路由");
    if (ids.some((id) => !data.sources.some((source) => source.id === id)))
      throw Error("包含不存在的采集路由");
    startCollectionRun(ids);
    return reply(res, 202, {
      message: `已将 ${ids.length} 条路由加入采集队列`,
      ids,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/sources/customs/stop") {
    if (!running || !activeRun) return reply(res, 200, { message: "当前没有运行中的采集任务" });
    activeRun.stopped = true;
    activeRun.stoppers.forEach((stop) => stop());
    await closeBrowser();
    await markRunStopped(activeRun.ids);
    return reply(res, 200, { message: "已停止当前采集任务" });
  }
  if (
    req.method === "POST" &&
    /^\/api\/sources\/customs\/[^/]+\/verify$/.test(url.pathname)
  ) {
    if (running) throw Error("请先停止当前采集任务，再打开验证页面");
    const id = url.pathname.split("/")[4];
    const source = data.sources.find((item) => item.id === id);
    if (!source) throw Error("采集路由不存在");
    const page = await openVerificationPage(source.url);
    return reply(res, 200, {
      message: "已在采集专用 Chrome 窗口打开验证页面；完成网站要求的公开访问验证后，请重新采集。",
      finalUrl: page.finalUrl,
    });
  }
  if (
    req.method === "POST" &&
    /^\/api\/sources\/customs\/[^/]+\/collect$/.test(url.pathname)
  ) {
    const id = url.pathname.split("/")[4];
    if (!data.sources.some((item) => item.id === id))
      throw Error("采集路由不存在");
    startCollectionRun([id]);
    return reply(res, 202, { message: "已开始采集增量内容" });
  }
  if (req.method === "POST" && url.pathname === "/api/browser-import") {
    if (!body.url || !body.html)
      throw new Error("需要提供已打开页面的网址和页面内容");
    const links = extractLinks(body.html, body.url);
    if (links.length >= 3)
      return reply(res, 200, {
        type: "list",
        links,
        message: `已从浏览器页面识别 ${links.length} 条链接`,
      });
    const candidate = extractArticle(body.html, body.url);
    const heading = clean(
      (body.html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1],
    );
    const article = {
      ...candidate,
      title: heading || candidate.title,
      category: body.category || "浏览器导入",
      importMethod: "browser-assisted",
    };
    data.articles.unshift(article);
    await save(data);
    return reply(res, 201, { type: "article", article });
  }
  if (req.method === "POST" && url.pathname.endsWith("/run")) {
    throw Error(
      "当前为人工确认模式。请在采集中心预览链接和正文后，再确认抓取。",
    );
  }
  if (req.method === "POST" && url.pathname.endsWith("/toggle")) {
    throw Error("采集配置已移除，采集源现由代码内置管理");
  }
  if (req.method === "POST" && url.pathname === "/api/preview") {
    const page = await fetchPage(body.url);
    return reply(res, 200, {
      finalUrl: page.finalUrl,
      links: browserLinks(page.html, page.finalUrl),
    });
  }
  if (req.method === "POST" && url.pathname === "/api/articles/preview") {
    const page = await fetchPage(body.url, false, body.referer),
      article = browserArticle(page.html, page.finalUrl),
      previewId = crypto.randomUUID();
    articlePreviews.set(previewId, {
      article,
      html: page.html,
      sourceUrl: page.finalUrl,
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    for (const [id, preview] of articlePreviews)
      if (preview.expiresAt < Date.now()) articlePreviews.delete(id);
    return reply(res, 200, { previewId, article });
  }
  if (
    req.method === "GET" &&
    /^\/api\/article-previews\/[^/]+\/page$/.test(url.pathname)
  ) {
    const preview = articlePreviews.get(url.pathname.split("/")[3]);
    if (!preview || preview.expiresAt < Date.now())
      return reply(
        res,
        410,
        "预览已失效，请返回工作台重新预览。",
        "text/plain; charset=utf-8",
      );
    res.setHeader(
      "content-security-policy",
      "sandbox; default-src http: https: data:; style-src http: https: 'unsafe-inline'; img-src http: https: data:; font-src http: https: data:",
    );
    return reply(
      res,
      200,
      previewDocument(preview.html, preview.sourceUrl),
      "text/html; charset=utf-8",
    );
  }
  if (req.method === "POST" && url.pathname === "/api/articles/fetch") {
    const preview = articlePreviews.get(body.previewId);
    if (!preview || preview.expiresAt < Date.now())
      throw Error("预览已失效，请重新预览正文后确认抓取");
    const latest = await load(),
      existing = latest.articles.find(
        (a) => a.sourceUrl === preview.article.sourceUrl,
      );
    if (existing) return reply(res, 200, existing);
    latest.articles.unshift(preview.article);
    await save(latest);
    await output(preview.article);
    articlePreviews.delete(body.previewId);
    return reply(res, 201, preview.article);
  }
  if (req.method === "POST" && url.pathname === "/api/tasks") {
    throw Error("采集配置已移除，采集源现由代码内置管理");
  }
  if (
    req.method === "POST" &&
    /^\/api\/articles\/[^/]+\/push-logistics$/.test(url.pathname)
  ) {
    const id = url.pathname.split("/")[3];
    const index = data.articles.findIndex((article) => article.id === id);
    if (index < 0) return reply(res, 404, { error: "文章不存在" });
    const published = await publishLogisticsArticle(data.articles[index]);
    data.articles[index] = {
      ...data.articles[index],
      logisticsPublishedAt: published.publishedAt,
      logisticsDetailPath: published.detailPath,
      logisticsPushError: null,
    };
    await save(data);
    return reply(res, 200, data.articles[index]);
  }
  if (
    req.method === "DELETE" &&
    /^\/api\/articles\/[^/]+$/.test(url.pathname)
  ) {
    const id = url.pathname.split("/").pop(),
      index = data.articles.findIndex((a) => a.id === id);
    if (index < 0) return reply(res, 404, { error: "文章不存在" });
    const [article] = data.articles.splice(index, 1);
    await save(data);
    await Promise.all([removeOutput(article.id), removeLogisticsArticle(article.id)]);
    return reply(res, 200, { id: article.id });
  }
  if (req.method === "PUT" && url.pathname.startsWith("/api/articles/")) {
    const i = data.articles.findIndex(
      (a) => a.id === url.pathname.split("/").pop(),
    );
    if (i < 0) return reply(res, 404, { error: "文章不存在" });
    data.articles[i] = {
      ...data.articles[i],
      ...body,
      id: data.articles[i].id,
      updatedAt: new Date().toISOString(),
    };
    await save(data);
    return reply(res, 200, data.articles[i]);
  }
  if (
    req.method === "GET" &&
    url.pathname.startsWith("/api/articles/") &&
    url.pathname.endsWith("/export")
  ) {
    const id = url.pathname.split("/")[3],
      a = data.articles.find((x) => x.id === id);
    if (!a) return reply(res, 404, "Not found", "text/plain");
    await output(a);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="article-${id}.html"`,
    });
    return res.end(exportHtml(a));
  }
  return reply(res, 404, { error: "接口不存在" });
}
const server = http.createServer(async (req, res) => {
  try {
    if (
      req.headers.origin &&
      req.headers.origin !== "http://localhost:4310" &&
      req.headers.origin !== "http://127.0.0.1:4310"
    )
      return reply(res, 403, { error: "仅允许本地工作台访问" });
    if (req.url.startsWith("/api/")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return await handleApi(req, res, raw ? JSON.parse(raw) : {});
    }
    const pathname = new URL(req.url, "http://local").pathname;
    const safe = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
    const path = join(publicDir, safe);
    if (!path.startsWith(publicDir) || !existsSync(path))
      return reply(res, 404, "Not found", "text/plain");
    const type =
      extname(path) === ".css"
        ? "text/css"
        : extname(path) === ".js"
          ? "text/javascript"
          : "text/html";
    reply(res, 200, await readFile(path), `${type}; charset=utf-8`);
  } catch (error) {
    reply(res, 400, { error: error.message || "请求失败" });
  }
});
server.listen(4310, "127.0.0.1", () =>
  console.log("DataClaw 已启动：http://localhost:4310"),
);
// This is intentionally lightweight: scheduling belongs to the always-on
// DataClaw process and does not require a browser tab to stay open.
const scheduleTimer = setInterval(() => {
  runScheduledCollectionIfDue().catch((error) =>
    console.error("定时采集检查失败：", error),
  );
}, 15_000);
async function shutdown() {
  clearInterval(scheduleTimer);
  await closeBrowser();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
