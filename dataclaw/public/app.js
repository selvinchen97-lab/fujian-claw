if (location.protocol === "file:") {
  document.body.innerHTML =
    '<main style="margin:10vh auto;max-width:620px;font:18px/1.8 system-ui"><h1>请通过本地服务打开 DataClaw</h1><p>直接打开 <code>public/index.html</code> 不会启动采集服务，也无法预览真实网页。</p><p>请访问 <a href="http://localhost:4310">http://localhost:4310</a>。</p></main>';
  throw new Error("DataClaw 必须通过本地服务运行");
}
const $ = (s) => document.querySelector(s);
let state = { tasks: [], articles: [] },
  editing = null,
  selected = null,
  activePreview = null,
  calendarMonth = new Date(),
  selectedSourceIds = new Set();
const toast = (text) => {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 3600);
};
const esc = (s = "") =>
  String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
async function api(path, options = {}) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(data.error || "操作失败");
  return data;
}
function render() {
  $("#article-count").textContent = state.articles.length;
  const list = $("#article-list");
  list.className = "article-list";
  list.innerHTML = state.articles.length
    ? state.articles
        .map(
          (a) =>
            `<article class="article-card"><div><h3>${esc(a.title)}</h3><p>${esc(a.sourceUrl)} · ${a.publishedAt || new Date(a.createdAt).toLocaleString("zh-CN")}</p>${a.logisticsPushError ? `<small class="push-error">物流栏目推送失败：${esc(a.logisticsPushError)}</small>` : a.logisticsPublishedAt ? `<small class="push-success">已推送至物流政策与资讯动态：${formatCollectedAt(a.logisticsPublishedAt)}</small>` : ""}</div><div class="article-actions"><button data-push-logistics="${a.id}">${a.logisticsPublishedAt ? "更新推送" : "一键推送"}</button><button class="secondary" data-edit="${a.id}">编辑 / 导出</button><button class="danger" data-delete="${a.id}">删除</button></div></article>`,
        )
        .join("")
    : '<div class="empty">还没有已保存的文章。</div>';
  document
    .querySelectorAll("[data-edit]")
    .forEach((b) => (b.onclick = () => openEditor(b.dataset.edit)));
  document
    .querySelectorAll("[data-delete]")
    .forEach((b) => (b.onclick = () => deleteArticle(b.dataset.delete)));
  document
    .querySelectorAll("[data-push-logistics]")
    .forEach(
      (b) =>
        (b.onclick = () => pushToLogistics(b.dataset.pushLogistics)),
    );
  renderCollectionLogs();
}
async function refresh() {
  state = await api("/api/state");
  render();
}
function dateKey(value) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function renderCollectionLogs() {
  const logs = state.collectionLogs || [];
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();
  $("#calendar-title").textContent = `${year} 年 ${month + 1} 月`;
  const byDay = new Map();
  logs.forEach((log) => {
    const key = dateKey(log.finishedAt || log.startedAt);
    byDay.set(key, [...(byDay.get(key) || []), log]);
  });
  const firstWeekday = new Date(year, month, 1).getDay();
  const days = new Date(year, month + 1, 0).getDate();
  const totalCells = Math.ceil((firstWeekday + days) / 7) * 7;
  $("#log-calendar").innerHTML = Array.from(
    { length: totalCells },
    (_, index) => {
      const day = index - firstWeekday + 1;
      if (day < 1 || day > days)
        return '<div class="calendar-day muted"></div>';
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const entries = byDay.get(key) || [];
      const failed = entries.some((entry) => entry.status.includes("失败") || entry.status === "需要验证");
      return `<div class="calendar-day ${entries.length ? "has-log" : ""} ${failed ? "has-failure" : ""}"><time>${day}</time>${entries.length ? `<span>${entries.length} 次采集</span>` : ""}</div>`;
    },
  ).join("");
  const list = $("#log-list");
  list.className = "log-list";
  list.innerHTML = logs.length
    ? logs
        .map(
          (log) =>
            `<article class="log-card"><div><strong>${esc(log.site)} · ${esc(log.route)}</strong><p>${formatCollectedAt(log.finishedAt || log.startedAt)} · 新增 ${log.added} 篇 · 跳过 ${log.skipped} 篇 · 失败 ${log.failed} 篇</p>${log.message ? `<small class="log-message">${esc(log.message)}</small>` : ""}</div><span class="route-status ${log.status.includes("失败") || log.status === "需要验证" ? "failed" : log.status === "采集中" ? "pending" : ""}">${esc(log.status)}</span></article>`,
        )
        .join("")
    : '<div class="empty">暂无采集记录。</div>';
}
function openEditor(id) {
  editing = state.articles.find((a) => a.id === id);
  $("#edit-title").value = editing.title;
  $("#edit-content").value = editing.content;
  $("#export").href = `/api/articles/${id}/export`;
  $("#editor").showModal();
}
async function deleteArticle(id) {
  const article = state.articles.find((a) => a.id === id);
  if (
    !article ||
    !confirm(
      `确认删除「${article.title}」？\n此操作会同时删除对应的 HTML 和 JSON 导出文件。`,
    )
  )
    return;
  try {
    await api("/api/articles/" + id, { method: "DELETE" });
    await refresh();
    toast("文章已删除。");
  } catch (e) {
    toast(e.message);
  }
}
async function pushToLogistics(id) {
  const article = state.articles.find((item) => item.id === id);
  if (!article) return;
  try {
    await api(`/api/articles/${id}/push-logistics`, { method: "POST" });
    await refresh();
    toast("已推送到物流政策与资讯动态栏目。");
  } catch (e) {
    toast(e.message);
  }
}
function chooseArticle(article) {
  selected = article;
  $("#selected-title").textContent = article.title;
  $("#selected-url").textContent = article.url;
  $("#selected-article").classList.remove("hidden");
  $("#article-preview").focus();
}
function showView(view) {
  const button = document.querySelector(`nav button[data-view="${view}"]`) || document.querySelector('nav button[data-view="collect"]');
  document.querySelectorAll("nav button").forEach((x) => x.classList.remove("active"));
  button.classList.add("active");
  document.querySelectorAll(".view").forEach((x) => x.classList.remove("show"));
  $("#" + button.dataset.view).classList.add("show");
  $("#page-title").textContent = button.textContent.trim().slice(2);
}
document.querySelectorAll("nav button").forEach((button) => (button.onclick = () => { location.hash = button.dataset.view; }));
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));
showView(location.hash.slice(1) || "collect");
async function loadCustomsSource() {
  try {
    const source = await api("/api/sources/customs");
    state.sources = source.configurations;
    state.collectionRunning = source.running;
    renderCollectionRoutes(source.configurations);
    $("#customs-categories").innerHTML = source.categories
      .map((x) => `<button data-category-url="${x.url}">${x.name}</button>`)
      .join("");
    document.querySelectorAll("[data-category-url]").forEach(
      (b) =>
        (b.onclick = () => {
          $("#url").value = b.dataset.categoryUrl;
          selected = null;
          $("#selected-article").classList.add("hidden");
          toast(`已选择「${b.textContent}」，请预览链接。`);
        }),
    );
  } catch (e) {
    toast(e.message);
  }
}
function formatCollectedAt(value) {
  if (!value) return "尚未采集";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function renderCollectionRoutes(routes) {
  $("#route-count").textContent = routes.length;
  selectedSourceIds = new Set(
    [...selectedSourceIds].filter((id) => routes.some((route) => route.id === id)),
  );
  const container = $("#collection-routes");
  container.innerHTML = routes
    .map(
      (route) =>
        `<article class="route-row"><label class="route-select" aria-label="选择 ${esc(route.route)}"><input type="checkbox" data-select-source="${route.id}" ${selectedSourceIds.has(route.id) ? "checked" : ""} ${route.status === "采集中" || route.status === "排队中" ? "disabled" : ""}></label><div class="route-source"><span class="source-mark">海</span><div><strong>${esc(route.site)}</strong><small>公开资讯来源</small></div></div><div class="route-name"><strong>${esc(route.route)}</strong><small>${esc(route.url)}</small>${route.statusDetail ? `<small class="route-detail" title="${esc(route.statusDetail)}">${esc(route.statusDetail)}</small>` : ""}</div><div class="push-switch" role="group" aria-label="${esc(route.route)} 推送设置"><button class="${route.directPush ? "active" : ""}" data-direct-push="true" data-source-id="${route.id}">直接推送</button><button class="${route.directPush ? "" : "active"}" data-direct-push="false" data-source-id="${route.id}">不推送</button></div><time>${formatCollectedAt(route.lastCollectedAt)}</time><span class="route-status ${route.status === "待采集" || route.status === "排队中" || route.status === "采集中" ? "pending" : route.status.includes("失败") || route.status === "需要验证" ? "failed" : ""}">${esc(route.status)}</span>${route.status === "采集中" || route.status === "排队中" ? '<button class="danger collect-button" data-stop-collection>停止</button>' : route.status === "需要验证" ? `<button class="secondary collect-button" data-verify-source="${route.id}">打开验证页面</button>` : `<button class="collect-button" data-collect-source="${route.id}">采集</button>`}</article>`,
    )
    .join("");
  document
    .querySelectorAll("[data-stop-collection]")
    .forEach((button) => (button.onclick = stopCollection));
  document
    .querySelectorAll("[data-select-source]")
    .forEach(
      (checkbox) =>
        (checkbox.onchange = () => {
          if (checkbox.checked) selectedSourceIds.add(checkbox.dataset.selectSource);
          else selectedSourceIds.delete(checkbox.dataset.selectSource);
          updateBatchControls(routes);
        }),
    );
  updateBatchControls(routes);
  document
    .querySelectorAll("[data-direct-push]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          updateDirectPush(
            button.dataset.sourceId,
            button.dataset.directPush === "true",
          )),
    );
  document
    .querySelectorAll("[data-collect-source]")
    .forEach(
        (button) =>
        (button.onclick = () => collectRoute(button.dataset.collectSource)),
    );
  document
    .querySelectorAll("[data-verify-source]")
    .forEach(
      (button) =>
        (button.onclick = () => openVerification(button.dataset.verifySource)),
    );
}
function updateBatchControls(routes = state.sources || []) {
  const selectable = routes.filter(
    (route) => route.status !== "采集中" && route.status !== "排队中",
  );
  const count = selectedSourceIds.size;
  $("#batch-selection").textContent = `已选择 ${count} 条`;
  $("#collect-selected").disabled = count === 0;
  $("#stop-collection").classList.toggle("is-hidden", !state.collectionRunning);
  $("#collect-selected").textContent = count ? `一键采集 (${count})` : "一键采集";
  $("#select-all-routes").textContent =
    selectable.length && selectable.every((route) => selectedSourceIds.has(route.id))
      ? "取消全选"
      : "全选路由";
}
async function updateDirectPush(id, directPush) {
  try {
    await api(`/api/sources/customs/${id}`, {
      method: "PATCH",
      body: { directPush },
    });
    await loadCustomsSource();
    toast(directPush ? "已设置为直接推送。" : "已设置为不直接推送。");
  } catch (e) {
    toast(e.message);
  }
}
async function collectRoute(id) {
  try {
    await api(`/api/sources/customs/${id}/collect`, { method: "POST" });
    await loadCustomsSource();
    toast("正在比对并采集新增文章…");
    await waitForCollection([id]);
  } catch (e) {
    toast(e.message);
  }
}
async function openVerification(id) {
  try {
    const result = await api(`/api/sources/customs/${id}/verify`, { method: "POST" });
    toast(result.message);
  } catch (e) {
    toast(e.message);
  }
}
async function collectSelectedRoutes() {
  const ids = [...selectedSourceIds];
  if (!ids.length) return;
  try {
    const result = await api("/api/sources/customs/collect-batch", {
      method: "POST",
      body: { ids },
    });
    await loadCustomsSource();
    toast(result.message);
    await waitForCollection(ids);
  } catch (e) {
    toast(e.message);
  }
}
async function waitForCollection(ids) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const source = await api("/api/sources/customs");
    renderCollectionRoutes(source.configurations);
    const routes = source.configurations.filter((item) => ids.includes(item.id));
    if (!routes.some((route) => ["采集中", "排队中"].includes(route.status))) {
      await refresh();
      const result = routes.reduce(
        (total, route) => ({
          added: total.added + (route.lastResult?.added || 0),
          skipped: total.skipped + (route.lastResult?.skipped || 0),
          failed: total.failed + (route.lastResult?.failed?.length || 0),
        }),
        { added: 0, skipped: 0, failed: 0 },
      );
      toast(
        `批量采集完成：新增 ${result.added} 篇，跳过 ${result.skipped} 篇${result.failed ? `，失败 ${result.failed} 篇` : ""}。`,
      );
      return;
    }
  }
  toast("采集仍在后台进行，可稍后查看状态。");
}
$("#select-all-routes").onclick = () => {
  const routes = state.sources || [];
  const selectable = routes.filter(
    (route) => route.status !== "采集中" && route.status !== "排队中",
  );
  const allSelected = selectable.length && selectable.every((route) => selectedSourceIds.has(route.id));
  selectable.forEach((route) => {
    if (allSelected) selectedSourceIds.delete(route.id);
    else selectedSourceIds.add(route.id);
  });
  renderCollectionRoutes(routes);
};
$("#collect-selected").onclick = collectSelectedRoutes;
async function stopCollection() {
  try {
    const result = await api("/api/sources/customs/stop", { method: "POST" });
    toast(result.message);
    await loadCustomsSource();
    await refresh();
  } catch (e) { toast(e.message); }
}
$("#stop-collection").onclick = stopCollection;
$("#preview").onclick = async () => {
  const url = $("#url").value.trim();
  if (!url) return;
  $("#preview").textContent = "正在预览…";
  $("#preview-info").textContent = "正在加载真实栏目网页…";
  $("#links").className = "empty";
  $("#links").textContent = "正在加载…";
  selected = null;
  $("#selected-article").classList.add("hidden");
  try {
    const r = await api("/api/preview", { method: "POST", body: { url } });
    $("#preview-info").textContent =
      `已从真实网页识别 ${r.links.length} 篇文章`;
    $("#links").className = "link-cards";
    $("#links").innerHTML = r.links.length
      ? r.links
          .map(
            (a, i) =>
              `<article class="link-card"><span>${String(i + 1).padStart(2, "0")}</span><div><h4>${esc(a.title)}</h4><p>${esc(a.url)}</p></div><button class="secondary" data-select="${i}">选择</button></article>`,
          )
          .join("")
      : "未发现可识别的文章链接。";
    document
      .querySelectorAll("[data-select]")
      .forEach(
        (b) =>
          (b.onclick = () => chooseArticle(r.links[Number(b.dataset.select)])),
      );
  } catch (e) {
    $("#preview-info").textContent = "预览失败";
    $("#links").className = "empty";
    $("#links").textContent = e.message;
    toast(e.message);
  } finally {
    $("#preview").textContent = "预览链接";
  }
};
$("#article-preview").onclick = async () => {
  if (!selected) return;
  $("#article-preview").textContent = "正在加载正文…";
  try {
    const r = await api("/api/articles/preview", {
      method: "POST",
      body: { url: selected.url, referer: selected.referer },
    });
    activePreview = r;
    const a = r.article;
    $("#preview-title").textContent = a.title;
    $("#preview-meta").textContent = a.publishedAt
      ? `发布时间：${a.publishedAt}`
      : "发布时间：未识别";
    $("#preview-source").textContent = a.sourceUrl;
    $("#open-source").href = a.sourceUrl;
    $("#page-snapshot").src = `/api/article-previews/${r.previewId}/page`;
    $("#preview-content").textContent = a.content;
    $("#article-dialog").showModal();
  } catch (e) {
    toast(e.message);
  } finally {
    $("#article-preview").textContent = "第三步：预览正文网页";
  }
};
$("#confirm-fetch").onclick = async (e) => {
  e.preventDefault();
  if (!activePreview) return;
  $("#confirm-fetch").textContent = "正在保存…";
  try {
    const a = await api("/api/articles/fetch", {
      method: "POST",
      body: { previewId: activePreview.previewId },
    });
    await refresh();
    $("#article-dialog").close();
    openEditor(a.id);
    activePreview = null;
    toast("正文已抓取并保存。");
  } catch (e) {
    toast(e.message);
  } finally {
    $("#confirm-fetch").textContent = "确认抓取正文";
  }
};
$("#save-article").onclick = async (e) => {
  e.preventDefault();
  try {
    await api("/api/articles/" + editing.id, {
      method: "PUT",
      body: {
        title: $("#edit-title").value,
        content: $("#edit-content").value,
      },
    });
    await refresh();
    $("#editor").close();
    toast("文章已保存。");
  } catch (e) {
    toast(e.message);
  }
};
$("#calendar-prev").onclick = () => {
  calendarMonth = new Date(
    calendarMonth.getFullYear(),
    calendarMonth.getMonth() - 1,
    1,
  );
  renderCollectionLogs();
};
$("#calendar-next").onclick = () => {
  calendarMonth = new Date(
    calendarMonth.getFullYear(),
    calendarMonth.getMonth() + 1,
    1,
  );
  renderCollectionLogs();
};
async function loadCollectionSettings() {
  try {
    const settings = await api("/api/collection-settings");
    const form = $("#collection-settings");
    Object.entries(settings).forEach(([key, value]) => {
      if (form.elements[key]) form.elements[key].value = value;
    });
  } catch (e) { toast(e.message); }
}
$("#collection-settings").onsubmit = async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  Object.keys(body).filter((key) => key !== "strategy").forEach((key) => { body[key] = Number(body[key]); });
  try {
    await api("/api/collection-settings", { method: "PUT", body });
    $("#settings-status").textContent = "设置已保存，将在下一次采集时生效。";
    toast("采集设置已保存。");
  } catch (e) { $("#settings-status").textContent = e.message; toast(e.message); }
};
loadCustomsSource();
loadCollectionSettings();
refresh().catch((e) => toast(e.message));
