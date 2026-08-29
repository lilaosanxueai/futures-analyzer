/* m4_monitor —— 监控：预警/盯盘/心得/新闻/皮肤/命令面板/自检 */

/* ---------- 价格预警 ---------- */
/* ---------- 价格预警 ---------- */

function persistAlarms() {
  store.set("fa_alarms", state.alarms);
}

let alarmSymShown = null; // 防止轮询期间覆盖用户正在输入的值

function updateAlarmRow(force = false) {
  const sym = state.selected;
  if (!sym) return;
  if (force || alarmSymShown !== sym) {
    const a = state.alarms[sym] || {};
    $("alarmUp").value = a.up ?? "";
    $("alarmDown").value = a.down ?? "";
    alarmSymShown = sym;
  }
}

function beep(freq = 880, dur = 0.2) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (beep._ctx = beep._ctx || new Ctx());
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.25, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    osc.start();
    osc.stop(ctx.currentTime + dur);
  } catch (e) { /* 无声环境忽略 */ }
}

/* 标签页标题闪烁：预警触发后即使切到别的标签页也能看到 */
let titleFlashTimer = null;

function flashTitle(text) {
  clearInterval(titleFlashTimer);
  const orig = "期货实时分析助手";
  let on = false;
  titleFlashTimer = setInterval(() => {
    document.title = on ? orig : `🔔 ${text}`;
    on = !on;
  }, 900);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
    document.title = "期货实时分析助手";
  }
});

function fireAlarm(sym, text, last) {
  toast(`🔔 ${sym} ${text}，当前价 ${fmt(last, 1)}`, true);
  flashTitle(`${sym} ${text}`);
  beep(1046);
  setTimeout(() => beep(1318), 200);
  setTimeout(() => beep(1046), 400);
}

function checkAlarms() {
  let changed = false;
  for (const [sym, a] of Object.entries(state.alarms)) {
    const q = state.quotes[sym];
    if (!q || q.last == null) continue;
    if (a.up != null && q.last >= a.up) {
      fireAlarm(sym, `已上破 ${fmt(a.up, 1)}`, q.last);
      a.up = null;
      changed = true;
    }
    if (a.down != null && q.last <= a.down) {
      fireAlarm(sym, `已下破 ${fmt(a.down, 1)}`, q.last);
      a.down = null;
      changed = true;
    }
  }
  for (const [sym, a] of Object.entries(state.alarms)) {
    if (a.up == null && a.down == null) delete state.alarms[sym];
  }
  if (changed) {
    persistAlarms();
    renderTable();
    updateAlarmRow(true);
  }
}

$("btnAlarmSave").addEventListener("click", () => {
  const sym = state.selected;
  if (!sym) return toast("请先选择合约", true);
  const up = parseFloat($("alarmUp").value);
  const down = parseFloat($("alarmDown").value);
  const a = { up: Number.isFinite(up) ? up : null, down: Number.isFinite(down) ? down : null };
  if (a.up == null && a.down == null) return toast("请至少填写一个有效的预警价格", true);
  state.alarms[sym] = a;
  persistAlarms();
  renderTable();
  toast(`已设置 ${sym} 预警：${a.up != null ? `上破 ${a.up} ` : ""}${a.down != null ? `下破 ${a.down}` : ""}`);
});

$("btnAlarmClear").addEventListener("click", () => {
  const sym = state.selected;
  if (!sym || !state.alarms[sym]) return;
  delete state.alarms[sym];
  persistAlarms();
  $("alarmUp").value = "";
  $("alarmDown").value = "";
  renderTable();
  toast(`已清除 ${sym} 的预警`);
});

/* ---------- AI 盯盘 ---------- */

const monitorState = { seen: new Set(), loaded: false };

function monitorBeep() {
  beep(523);
  setTimeout(() => beep(392), 220);
}

async function pollMonitor() {
  try {
    const d = await api("/api/monitor/events?limit=30");
    const statusEl = $("monitorStatus");
    if (statusEl) {
      statusEl.textContent = d.enabled
        ? `巡检 ${d.last_check || "…"} · 重点 ${d.focus.join("/")}`
        : "已关闭（可在 AI 设置中开启）";
    }
    const list = $("monitorList");
    if (!list) return;
    if (!d.events.length) {
      if (!monitorState.loaded) {
        list.innerHTML = `<div class="muted small monitor-hint">重点监控：${d.focus.join("、")} + 你的自选。急涨急跌时此处提示并推送声音/横幅/标题提醒，AI 自动给出解读。</div>`;
      }
      monitorState.loaded = true;
      return;
    }
    monitorState.loaded = true;
    // 新事件提醒（首次加载不提醒，避免打开页面被历史事件轰炸）
    if (monitorState.seen.size) {
      for (const e of d.events) {
        if (!monitorState.seen.has(e.id)) {
          if (e.dir === "trump") {
            toast(`🇺🇸 特朗普：${(e.text || "").slice(0, 44)}`, true);
            flashTitle("特朗普新表态");
          } else {
            const word = e.dir === "up" ? "急涨" : "跳水";
            const tag = e.intl ? "🌍 " : "🤖 ";
            toast(`${tag}${e.symbol} ${word} ${e.chg5 > 0 ? "+" : ""}${e.chg5}% → ${e.price}`, true);
            flashTitle(`${e.symbol} ${word}${e.chg5 > 0 ? "+" : ""}${e.chg5}%`);
          }
          monitorBeep();
        }
      }
    }
    d.events.forEach((e) => monitorState.seen.add(e.id));
    const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    list.innerHTML = d.events
      .map((e) => {
        const t = new Date(e.ts);
        const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
        // 特朗普表态事件
        if (e.dir === "trump") {
          return `<div class="mon-event trump-ev">
            <div class="mon-line"><span class="mon-time">${hhmm}</span><b>🇺🇸 特朗普</b>
            <span class="trump-txt">${esc(e.text)}</span>
            ${e.source ? `<span class="muted small">${e.source}</span>` : ""}</div>
          </div>`;
        }
        const cls = e.dir === "up" ? "up" : "down";
        const word = e.dir === "up" ? "急涨" : "跳水";
        const sign = e.chg5 > 0 ? "+" : "";
        const tag = e.intl ? "🌍 " : "";
        const symHtml = e.intl ? `<b>${e.name || e.symbol}</b>` : `<b>${e.symbol}</b>`;
        const range = e.intl && e.time_str ? `<span class="muted small">${e.time_str}</span>` : `<span class="muted small">5分 / 阈值${e.threshold}%</span>`;
        return `<div class="mon-event" data-sym="${e.symbol}">
          <div class="mon-line">
            <span class="mon-time">${hhmm}</span>${tag}${symHtml}
            <span class="${cls}">${word} ${sign}${e.chg5}%</span>
            <span>→ ${e.price}</span>
            ${range}
          </div>
          ${e.ai ? `<div class="mon-ai">💡 ${e.ai}</div>` : (e.intl ? "" : `<div class="mon-ai muted">AI 解读生成中…</div>`)}
        </div>`;
      })
      .join("");
  } catch (e) { /* 盯盘轮询失败静默，下轮重试 */ }
}

$("monitorList").addEventListener("click", (e) => {
  const item = e.target.closest(".mon-event");
  if (item && state.quotes[item.dataset.sym]) selectSymbol(item.dataset.sym);
  else if (item) {
    // 不在自选里（如重点品种），自动加入并选中
    addFromCandidate(item.dataset.sym);
  }
});

/* ---------- 交易心得（本地记录 + 飞书云文档同步） ---------- */

const notesState = { items: [] };

async function loadNotes() {
  try {
    const d = await api("/api/notes");
    notesState.items = d.items || [];
    renderNotes();
  } catch (e) {
    $("notesList").innerHTML = `<div class="muted small monitor-hint">心得加载失败：${e.message}</div>`;
  }
}

function renderNotes() {
  const list = $("notesList");
  const items = notesState.items;
  if (!items.length) {
    list.innerHTML = `<div class="muted small monitor-hint">暂无心得。盘中闪念、复盘结论、错误教训——记下来才会复利。</div>`;
    return;
  }
  list.innerHTML = items.map((n) => {
    const t = new Date(n.ts);
    const hm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    const title = n.title || (n.content || "").slice(0, 24);
    const date = n.date || `${t.getMonth() + 1}/${t.getDate()}`;
    return `<div class="note-item" data-id="${n.id}">
      <div class="note-head">
        <b class="note-title"></b>
        <span class="note-time">${date} ${hm}</span>
        ${n.symbol ? `<span class="note-sym">${n.symbol}</span>` : ""}
        ${n.tags ? `<span class="note-tag">#${n.tags}</span>` : ""}
        ${n.synced ? `<span class="note-synced">☁已同步</span>` : ""}
        <span class="note-ops">
          ${n.synced ? "" : `<button data-sync="${n.id}" title="同步这条到飞书">☁</button>`}
          <button data-del="${n.id}" title="删除">✕</button>
        </span>
      </div>
      <div class="note-body"></div>
    </div>`;
  }).join("");
  // 文本用 textNode 填充避免 XSS
  list.querySelectorAll(".note-item").forEach((el) => {
    const n = items.find((x) => x.id === el.dataset.id);
    el.querySelector(".note-title").textContent = n ? (n.title || (n.content || "").slice(0, 24)) : "";
    el.querySelector(".note-body").textContent = n ? n.content : "";
  });
}

async function addNote() {
  const contentEl = $("noteContent");
  const text = contentEl.value.trim();
  if (!text) return toast("请填写心得正文", true);
  const title = $("noteTitle").value.trim();
  const date = $("noteDate").value || new Date().toISOString().slice(0, 10);
  const symbol = $("noteSymbol").value.trim().toUpperCase();
  const tags = $("noteTags").value.trim().replace(/^#/, "");
  try {
    await api("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, content: text, symbol, tags, date }),
    });
    $("noteTitle").value = "";
    contentEl.value = "";
    $("noteTags").value = "";
    // 标题、品种、日期保留（连续记录同类心得更顺手），正文清空
    loadNotes();
    toast("心得已保存");
  } catch (e) {
    toast(`保存失败：${e.message}`, true);
  }
}

async function syncNotes(noteId = "") {
  try {
    const d = await api(`/api/notes/feishu-sync${noteId ? `?note_id=${noteId}` : ""}`, { method: "POST" });
    if (d.synced) {
      toast(`☁ 已同步 ${d.synced} 条心得到飞书`);
      loadNotes();
    } else {
      toast(d.msg || "没有待同步的心得");
    }
  } catch (e) {
    toast(`飞书同步失败：${e.message}`, true);
  }
}

$("btnNoteAdd").addEventListener("click", addNote);
$("noteContent").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) addNote();
});
$("btnNoteSync").addEventListener("click", () => syncNotes());
// 品种输入框：默认带出当前选中合约，可下拉选主力合约或自由输入
function prefillNoteSymbol() {
  const el = $("noteSymbol");
  if (el && !el.value && state.selected) el.value = state.selected;
}
$("notesList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    api(`/api/notes/${del.dataset.del}`, { method: "DELETE" }).then(loadNotes).catch(() => {});
    return;
  }
  const sync = e.target.closest("[data-sync]");
  if (sync) syncNotes(sync.dataset.sync);
});

/* ---------- 主题要闻（资讯视图：全部 / 原油黄金 / 美伊冲突） ---------- */

const newsState = {
  seen: new Set(), geopolSeen: new Set(), loaded: false,
  topics: {}, all: [], aiTags: {}, aiStatus: "off",
  filter: store.get("fa_news_filter", "all"),
};

function highlightKeywords(text, topic) {
  let html = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const topics = Array.isArray(topic) ? topic : [topic];
  const kws = topics.flatMap((t) => newsState.topics[t] || []);
  for (const kw of [...new Set(kws)]) {
    if (!kw) continue;
    try {
      html = html.replace(new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    } catch (e) { /* 忽略非法正则 */ }
  }
  return html;
}

function renderNewsView() {
  const list = $("newsList");
  if (!list) return;
  const hlTopics = newsState.filter === "all" ? ["oilgold", "usiran"] : [newsState.filter];
  let items = newsState.all.filter((it) =>
    newsState.filter === "all" ? true : (it.topics || []).includes(newsState.filter)
  );
  // AI 语义筛选：ready 后只显示 AI 判定相关的条目
  if (newsState.aiStatus === "ready" && newsState.filter === "all") {
    items = items.filter((_, idx) => newsState.aiTags[idx] !== undefined);
  }
  // 主题命中的（原油黄金/美伊等期货相关）优先展示
  items = [...items].sort((a, b) => ((b.topics || []).length) - ((a.topics || []).length));
  if (!items.length) {
    list.innerHTML = `<div class="muted small monitor-hint">${newsState.aiStatus === "filtering" ? "AI 正在智能筛选中，请稍候…" : "该主题暂无条目（数据源每 2 分钟更新）"}</div>`;
    return;
  }
  list.innerHTML = items
    .map((it, idx) => {
      const hm = it.time ? it.time.slice(11, 16) : "";
      const day = it.time ? it.time.slice(5, 10) : "";
      const aiTag = newsState.aiTags[idx] ? `<span class="ai-tag">${newsState.aiTags[idx]}</span>` : "";
      const body = it.link
        ? `<a href="${it.link}" target="_blank" rel="noopener" title="${(it.summary || "").replace(/"/g, "&quot;")}">${highlightKeywords(it.title, hlTopics)}</a>`
        : `<span title="${(it.summary || "").replace(/"/g, "&quot;")}">${highlightKeywords(it.title, hlTopics)}</span>`;
      const tags = (it.topics || []).map((t) => t === "usiran" ? "⚔️" : t === "oilgold" ? "🛢" : "").join(" ");
      return `<div class="news-item${(it.topics || []).length ? " matched" : ""}">
        <span class="news-time">${day} ${hm}</span>${aiTag}${body}<span class="news-src">${tags} ${it.source}</span>
      </div>`;
    })
    .join("");
}

function updateAiBadge() {
  const badge = $("aiFilterBadge");
  if (!badge) return;
  const count = Object.keys(newsState.aiTags).length;
  if (newsState.aiStatus === "ready") {
    badge.textContent = `🤖 AI 已筛选 ${count} 条相关`;
    badge.className = "ai-filter-badge ready";
  } else if (newsState.aiStatus === "filtering") {
    badge.textContent = "🤖 AI 筛选中…";
    badge.className = "ai-filter-badge filtering";
  } else {
    badge.textContent = "🤖 AI 筛选不可用（未配 Key）";
    badge.className = "ai-filter-badge";
  }
}

async function pollNews() {
  try {
    const d = await api("/api/news");
    newsState.topics = d.topics || {};
    newsState.all = d.items || [];
    newsState.aiStatus = (d.ai && d.ai.status) || "off";
    newsState.aiTags = (d.ai && d.ai.tags) || {};
    updateAiBadge();
    if (!newsState.all.length) return;

    // 新命中条目提醒（首次加载静默；两类主题分别去重）
    if (newsState.loaded) {
      for (const it of newsState.all.slice(0, 12)) {
        if (it.matched && !newsState.seen.has(it.title)) {
          toast(`📰 ${it.title.slice(0, 46)}${it.title.length > 46 ? "…" : ""}`);
        }
        if ((it.topics || []).includes("usiran") && !newsState.geopolSeen.has(it.title)) {
          toast(`⚔️ 美伊 ${it.title.slice(0, 44)}${it.title.length > 44 ? "…" : ""}`);
        }
      }
    }
    newsState.all.forEach((it) => {
      newsState.seen.add(it.title);
      if ((it.topics || []).includes("usiran")) newsState.geopolSeen.add(it.title);
    });
    newsState.loaded = true;
    renderNewsView();
  } catch (e) { /* 新闻轮询失败静默 */ }
}

document.querySelectorAll(".filter-chip").forEach((chip) => {
  if (chip.dataset.filter === newsState.filter) chip.classList.add("active");
  chip.addEventListener("click", () => {
    document.querySelectorAll(".filter-chip").forEach((c) => c.classList.toggle("active", c === chip));
    newsState.filter = chip.dataset.filter;
    store.set("fa_news_filter", newsState.filter);
    renderNewsView();
  });
});

/* ---------- 皮肤系统 ---------- */

const SKINS = [
  { id: "dark",        name: "暗夜（默认）", desc: "经典深色",        colors: ["#0d1117", "#161b22", "#3b82f6"] },
  { id: "light",       name: "晴空白",       desc: "清逸浅色",        colors: ["#f2f5f9", "#ffffff", "#2563eb"] },
  { id: "glass-dark",  name: "玻璃 · 夜",    desc: "毛玻璃暗色",      colors: ["#0a0d18", "#2a3550", "#8b5cf6"] },
  { id: "glass-light", name: "玻璃 · 昼",    desc: "毛玻璃浅色",      colors: ["#eef2fb", "#ffffff", "#38bdf8"] },
  { id: "aurora",      name: "极光动态",     desc: "流动极光 + 玻璃", colors: ["#05070f", "#3b82f6", "#a855f7"] },
  { id: "green",       name: "墨绿护眼",     desc: "低饱和绿调",      colors: ["#0f1a14", "#1b2c23", "#10b981"] },
];

function applySkin(id) {
  if (!SKINS.some((s) => s.id === id)) id = "dark";
  document.body.dataset.skin = id;
  store.set("fa_skin", id);
  renderSkinList();
  redrawCharts();
}

function renderSkinList() {
  const cur = document.body.dataset.skin || "dark";
  const el = $("skinList");
  if (!el) return;
  el.innerHTML = SKINS.map((s) => `
    <button class="skin-card${s.id === cur ? " active" : ""}" data-skin="${s.id}">
      <span class="skin-preview">${s.colors.map((c) => `<i style="background:${c}"></i>`).join("")}</span>
      <span class="skin-name">${s.name}</span>
      <span class="skin-desc">${s.desc}</span>
    </button>`).join("");
}

$("btnSkin").addEventListener("click", (e) => {
  e.stopPropagation();
  $("skinPop").classList.toggle("hidden");
  renderSkinList();
});
$("skinPop").addEventListener("click", (e) => {
  e.stopPropagation();
  const card = e.target.closest("[data-skin]");
  if (card) applySkin(card.dataset.skin);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#skinPop") && !e.target.closest("#btnSkin")) {
    $("skinPop").classList.add("hidden");
  }
});

/* ---------- 命令面板 Ctrl+K ---------- */

const CMDK_COMMANDS = [
  { key: "工作台", desc: "视图", run: () => switchView("work") },
  { key: "详情", desc: "视图", run: () => switchView("detail") },
  { key: "对比", desc: "视图", run: () => switchView("compare") },
  { key: "资讯/要闻", desc: "视图", run: () => switchView("news") },
  { key: "心得", desc: "视图", run: () => switchView("notes") },
  { key: "交易日志", desc: "视图", run: () => switchView("trades") },
  { key: "热力图", desc: "视图", run: () => switchView("heat") },
  { key: "晨报", desc: "生成/查看 AI 简报", run: () => $("btnReport").click() },
  { key: "皮肤", desc: "切换界面皮肤", run: () => $("btnSkin").click() },
  { key: "设置", desc: "AI/飞书/盯盘配置", run: () => $("btnSettings").click() },
];

const cmdkState = { hits: [], index: -1 };

function cmdkRender() {
  const q = $("cmdkInput").value.trim().toLowerCase();
  let hits = [];
  if (!q) {
    hits = CMDK_COMMANDS.slice(0, 6).map((c) => ({ type: "cmd", ...c }));
  } else {
    const cmds = CMDK_COMMANDS.filter((c) => c.key.toLowerCase().includes(q))
      .map((c) => ({ type: "cmd", ...c }));
    const syms = state.candidates
      .filter((c) => c.symbol.toLowerCase().includes(q) || (c.name || "").includes(q) || (c.py || "").startsWith(q))
      .slice(0, 8)
      .map((c) => ({ type: "sym", key: c.symbol, desc: c.name, sym: c.symbol }));
    hits = [...syms, ...cmds].slice(0, 12);
  }
  cmdkState.hits = hits;
  if (cmdkState.index >= hits.length) cmdkState.index = hits.length - 1;
  $("cmdkList").innerHTML = hits.length
    ? hits.map((h, i) => `<div class="cmdk-item${i === cmdkState.index ? " hl" : ""}" data-i="${i}">
        <span>${h.type === "sym" ? `<b>${h.key}</b> ${h.desc}` : h.key}</span>
        <span class="desc">${h.type === "sym" ? "合约 →" : h.desc}</span>
      </div>`).join("")
    : `<div class="cmdk-item muted">无匹配</div>`;
}

function cmdkRun(i) {
  const h = cmdkState.hits[i];
  if (!h) return;
  cmdkClose();
  if (h.type === "sym") {
    addFromCandidate(h.sym);
    switchView("detail");
  } else {
    h.run();
  }
}

function cmdkOpen() {
  $("cmdk").classList.remove("hidden");
  $("cmdkInput").value = "";
  cmdkState.index = 0;
  cmdkRender();
  setTimeout(() => $("cmdkInput").focus(), 30);
}
function cmdkClose() { $("cmdk").classList.add("hidden"); }

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("cmdk").classList.contains("hidden") ? cmdkOpen() : cmdkClose();
  }
  if ($("cmdk").classList.contains("hidden")) return;
  if (e.key === "Escape") cmdkClose();
  if (e.key === "ArrowDown") { e.preventDefault(); cmdkState.index = Math.min(cmdkState.index + 1, cmdkState.hits.length - 1); cmdkRender(); }
  if (e.key === "ArrowUp") { e.preventDefault(); cmdkState.index = Math.max(cmdkState.index - 1, 0); cmdkRender(); }
  if (e.key === "Enter") cmdkRun(cmdkState.index);
});
$("cmdkInput").addEventListener("input", () => { cmdkState.index = 0; cmdkRender(); });
$("cmdkList").addEventListener("click", (e) => {
  const item = e.target.closest("[data-i]");
  if (item) cmdkRun(Number(item.dataset.i));
});
$("cmdk").addEventListener("click", (e) => { if (e.target === $("cmdk")) cmdkClose(); });

/* ---------- 标签页标题实时价格 ---------- */

function setDocTitle() {
  const q = state.selected && state.quotes[state.selected];
  if (q && q.last != null && !titleFlashTimer) {
    const pct = q.change_pct;
    document.title = `${state.selected} ${q.last} ${pct != null ? (pct >= 0 ? "↑" : "↓") + Math.abs(pct).toFixed(2) + "%" : ""} | 期货助手`;
  }
}

/* ---------- 系统自检 ---------- */

const healthState = { poll: null };

function healthBadgeRender(d) {
  const badge = $("healthBadge");
  if (!badge) return;
  const results = d.results || [];
  if (d.running) {
    badge.textContent = "🩺检中";
    badge.className = "health-badge warn";
    return;
  }
  if (!results.length) {
    badge.textContent = "🩺…";
    badge.className = "health-badge";
    return;
  }
  const fails = results.filter((r) => !r.ok).length;
  badge.textContent = fails ? `🩺${fails}项异常` : "🩺正常";
  badge.className = "health-badge " + (fails ? "fail" : "ok");
}

async function pollHealth() {
  try {
    const d = await api("/api/health");
    healthBadgeRender(d);
    if ($("healthPop") && !$("healthPop").classList.contains("hidden")) renderHealthList(d);
  } catch (e) { /* 静默 */ }
}

function renderHealthList(d) {
  const list = $("healthList");
  if (!list) return;
  $("healthTime").textContent = d.ts ? new Date(d.ts).toLocaleString("zh-CN") : "";
  const results = d.results || [];
  list.innerHTML = results.length
    ? results.map((r) => `<div class="health-row">
        <span class="${r.ok ? "ok" : "fail"}">${r.ok ? "✓" : "✕"} ${r.name}</span>
        <span style="text-align:right"><span class="muted small">${r.detail}</span> <span class="ms">${r.ms}ms</span></span>
      </div>`).join("")
    : `<div class="muted small">${d.running ? "自检运行中…" : "尚未运行自检"}</div>`;
}

$("healthBadge").addEventListener("click", async () => {
  $("healthPop").classList.toggle("hidden");
  if (!$("healthPop").classList.contains("hidden")) {
    renderHealthList({ results: [], running: false });
    await pollHealth();
  }
});
$("btnHealthRun").addEventListener("click", async () => {
  const btn = $("btnHealthRun");
  btn.disabled = true;
  btn.textContent = "自检运行中…（约 10 秒）";
  try {
    await api("/api/health/run", { method: "POST" });
    // 轮询直到完成
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const d = await api("/api/health");
      if (!d.running && d.results.length) { healthBadgeRender(d); renderHealthList(d); break; }
    }
  } catch (e) {
    toast(`自检失败：${e.message}`, true);
  }
  btn.disabled = false;
  btn.textContent = "🔄 立即重新自检";
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#healthPop") && !e.target.closest("#healthBadge")) {
    $("healthPop")?.classList.add("hidden");
  }
});

/* ---------- 旧数据自动清理（标注保留 60 天） ---------- */

function pruneOldAnnotations() {
  try {
    const store = store.get("fa_annot", {});
    const cutoff = Date.now() - 60 * 86400000;
    let removed = 0;
    for (const sym of Object.keys(store)) {
      for (const date of Object.keys(store[sym])) {
        const keep = (store[sym][date] || []).filter((a) => (a.ts || 0) >= cutoff);
        removed += (store[sym][date] || []).length - keep.length;
        if (keep.length) store[sym][date] = keep; else delete store[sym][date];
      }
      if (!Object.keys(store[sym]).length) delete store[sym];
    }
    if (removed) {
      store.set("fa_annot", store);
      toast(`已自动清理 ${removed} 条 60 天前的旧标注`);
    }
  } catch (e) { /* 忽略 */ }
}
