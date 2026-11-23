import { chromium } from "playwright";
import * as cheerio from "cheerio";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

let context;
let queue = Promise.resolve();
let chromeProcess;
// Keep one dedicated, local profile for the collector.  Public sites commonly
// set a short-lived verification cookie on the first visit; a profile per
// server process discarded that legitimate browser state on every restart.
const profileDir = fileURLToPath(
  new URL("./data/browser-standard/collector-profile", import.meta.url),
);

function isVerificationPage(html = "") {
  return /\$_ts|__jsluid_h|X-Via-JSL|安全验证|人机验证|访问过于频繁/i.test(html);
}

function verificationError(status) {
  const error = Error(
    `目标站点返回 HTTP ${status || 412} 浏览器验证页。DataClaw 已保留验证窗口和本地 Cookie；请在打开的 Chrome 窗口完成网站要求的公开访问验证后，再重新发起采集。`,
  );
  error.code = "SITE_VERIFICATION_REQUIRED";
  return error;
}
async function startBrowser() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  chromeProcess = spawn(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    [
      "--user-data-dir=" +
        profileDir,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + port,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
      "--disable-extensions",
      "--disable-component-extensions",
      "--disable-features=HttpsFirstMode,HttpsFirstBalancedModeAutoEnable,HttpsUpgrades",
      "--allow-running-insecure-content",
    ],
    { stdio: "ignore" },
  );
  chromeProcess.on("error", (e) =>
    console.error("Chrome 启动失败：" + e.message),
  );
  chromeProcess.on("exit", () => {
    context = undefined;
    chromeProcess = undefined;
  });
  for (let n = 0; n < 100; n++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) {
        const browser = await chromium.connectOverCDP(
          `http://127.0.0.1:${port}`,
        );
        browser.on("disconnected", () => {
          context = undefined;
        });
        return browser.contexts()[0];
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("采集 Chrome 未能启动，请关闭上次采集窗口后重试");
}
export async function closeBrowser() {
  const browser = context?.browser();
  context = undefined;
  await browser?.close().catch(() => {});
  chromeProcess?.kill();
  chromeProcess = undefined;
}
export function page(url, referer) {
  const work = queue.then(async () => {
    const u = new URL(url);
    if (!["http:", "https:"].includes(u.protocol))
      throw Error("请输入 HTTP 或 HTTPS 地址");
    let last = "";
    for (let attempt = 1; attempt <= 2; attempt++) {
      let tab;
      try {
        if (!context) context = await startBrowser();
        tab = await context.newPage();
        // Some of these public sites leave third-party/statistics resources
        // pending indefinitely.  "commit" gets us the document promptly; the
        // body check below is the actual readiness signal for extraction.
        const options = { waitUntil: "commit", timeout: 12000 };
        if (referer) {
          options.referer = referer;
        } else if (
          u.hostname === "ltj.customs.gov.cn" &&
          !u.pathname.endsWith("/xwfb34/index.html")
        )
          options.referer = `${u.protocol}//${u.hostname}/customs/xwfb34/index.html`;
        const response = await tab.goto(url, options);
        // The Customs site can first return a 412 page that runs JavaScript,
        // sets a cookie, and reloads the original URL.  Give a real browser a
        // short opportunity to complete that public verification instead of
        // treating the challenge document as an article/listing.
        await tab.waitForTimeout(1800);
        await tab
          .waitForFunction(
            () => document.body?.innerText.trim().length > 150,
            null,
            { timeout: 6500 },
          )
          .catch(() => {});
        const html = await tab.content(),
          $ = cheerio.load(html),
          body = $("body").text().trim();
        last = `HTTP ${response?.status()}，${$("title").text()}：${body.slice(0, 300)}`;
        if (isVerificationPage(html)) throw verificationError(response?.status());
        if (response && response.status() >= 400)
          throw Error(`目标站点返回 HTTP ${response.status()}`);
        if (body.length >= 150) {
          return { html, finalUrl: tab.url() };
        }
      } catch (error) {
        last = error.message || String(error);
        // Chrome may drop a renderer while a government site redirects between
        // HTTP hosts.  Let the next attempt create a fresh tab/context instead
        // of retrying a detached page.
        if (/Target page, context or browser has been closed|browser has been closed|frame was detached/i.test(last))
          await closeBrowser();
      } finally {
        await tab?.close().catch(() => {});
      }
      if (attempt < 2)
        await new Promise((resolve) =>
          setTimeout(resolve, /HTTP (400|412)/.test(last) ? 3500 : 1500),
        );
    }
    throw Error(`页面两次加载未得到可提取内容（${last}）`);
  });
  queue = work.catch(() => {});
  return work;
}

// Opens the same persistent collector profile in a visible Chrome window.
// This deliberately leaves any site-required verification to the person using
// the workbench; it does not attempt to solve or bypass it.
export async function openVerificationPage(url) {
  const work = queue.then(async () => {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol))
      throw Error("请输入 HTTP 或 HTTPS 地址");
    if (!context) context = await startBrowser();
    const tab = await context.newPage();
    await tab.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    return { finalUrl: tab.url() };
  });
  queue = work.catch(() => {});
  return work;
}
export function links(html, base) {
  const $ = cheerio.load(html),
    found = new Map();
  $("a[href]").each((_, el) => {
    const title = $(el)
      .text()
      .trim()
      .replace(/^[•·\s]+/, "");
    const customsListing = base.includes("customs.gov.cn");
    const listingTitle =
      $(el).attr("istitle") === "true" ||
      /\d{4}-\d{2}-\d{2}/.test($(el).closest("li").text());
    if (customsListing && !listingTitle) return;
    try {
      const url = new URL($(el).attr("href"), base).href;
      if (
        /^https?:/.test(url) &&
        title.length > 5 &&
        (listingTitle ||
          /article_|\/content\.html/.test(url) ||
          (!customsListing && !/index\.html/.test(url)))
      )
        found.set(url, { url, title, referer: base });
    } catch {}
  });
  return [...found.values()];
}
export function article(html, sourceUrl) {
  const $ = cheerio.load(html);
  $("script,style,nav,footer,header").remove();
  const title = $("h1").first().text().trim() || $("title").text().trim();
  const selectors = [
    ".news_detail_con",
    "#zoom",
    ".TRS_Editor",
    ".view.TRS_UEDITOR",
    "[class*=article-content]",
    "[class*=article_content]",
    ".content",
    "article",
    "main",
  ];
  let content = "";
  let fallbackUsed = false;
  for (const selector of selectors) {
    const node = $(selector).first();
    if (node.text().trim().length < 100) continue;
    node.find("br").replaceWith("\n");
    node.find("p").each((_, p) => $(p).append("\n\n"));
    content = node
      .text()
      .replace(/[\t ]+/g, " ")
      .replace(/\n\s*\n/g, "\n\n")
      .trim();
    break;
  }
  if (content.length < 100) {
    let candidate = null,
      size = 0;
    $("div").each((_, el) => {
      const node = $(el),
        classes = (node.attr("class") || "").toLowerCase();
      if (/header|footer|nav|share|sidebar/.test(classes)) return;
      const text = node.text().trim().replace(/\s+/g, " ");
      if (text.length > size && text.length < 50000) {
        candidate = node;
        size = text.length;
      }
    });
    if (candidate) {
      candidate.find("br").replaceWith("\n");
      candidate.find("p").each((_, p) => $(p).append("\n\n"));
      content = candidate
        .text()
        .replace(/[\t ]+/g, " ")
        .replace(/\n\s*\n/g, "\n\n")
        .trim();
      fallbackUsed = true;
    }
  }
  if (fallbackUsed && title) {
    const start = content.indexOf(title);
    if (start > 0) content = content.slice(start);
    const end = content.search(/\n\s*(?:浏览次数|版权所有|地址：)/);
    if (end > 0) content = content.slice(0, end).trim();
  }
  if (!title || content.length < 100)
    throw Error("未识别出可靠正文，未保存；需要为此文章模板补充解析规则");
  const publishedAt =
    $("body")
      .text()
      .match(/发布时间[：:]\s*(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/)?.[1] ||
    null;
  return {
    id: crypto.randomUUID(),
    title,
    sourceUrl,
    content,
    publishedAt,
    createdAt: new Date().toISOString(),
    status: "草稿",
  };
}
