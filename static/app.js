/* 期货实时分析助手 - 前端逻辑 */

const $ = (id) => document.getElementById(id);

const state = {
  watchlist: JSON.parse(localStorage.getItem("fa_watchlist") || "null") || ["RB0", "CU0", "M0", "SC0", "IF0"],
  selected: localStorage.getItem("fa_selected") || null,
  quotes: {},        // symbol -> quote
  names: {},         // symbol -> name/exchange（来自主力列表）
  chat: JSON.parse(localStorage.getItem("fa_chat_history") || "[]") || [],  // 持久化（最近 60 条）
  aiReady: false,
  aiModel: "",       // 当前模型名（判断是否支持图片输入）
  polling: null,
  sort: { key: null, dir: -1 },                          // 表格排序
  alarms: JSON.parse(localStorage.getItem("fa_alarms") || "{}"), // {sym: {up, down}}
  prevLast: {},     // symbol -> 上次最新价（用于闪烁）
  ticks: { sym: null, points: [] },   // 实时走势：本次会话对选中合约的 5 秒采样
  refreshCount: 0,  // 轮询计数（分时图自动刷新节流）
  klinePeriod: "day",                 // K线周期
  klineView: null,                    // K线窗口 {bars, offset}（滚轮缩放/拖拽平移）
  klineShowMA: true,                  // MA 叠加开关
  klineShowBoll: false,               // BOLL 叠加开关
  annotMode: null,                    // 分时图标注模式（bull/bear/risk/level/note）
  candidates: [],    // 合约候选（含拼音）
  dropHits: [],      // 搜索下拉当前匹配项
  dropIndex: -1,     // 搜索下拉键盘高亮索引
};

/* ---------- 工具 ---------- */

/* HTML 转义：AI 文本常含 < > &（如"收盘 < MA10"），直插 innerHTML 会截断结构 */
function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* 国际品种（与后端 INTL_SYMBOLS 对应，可走纪律检查/资金情绪/K线日线/实时解读） */
const INTL_SYMBOLS = ["WTI", "BRENT", "GOLD", "DXY"];
const _INTL_NAMES = { WTI: "WTI 原油", BRENT: "布伦特原油", GOLD: "COMEX 黄金", DXY: "美元指数" };

/* 主题（皮肤）：色卡预览 + 切换 + 持久化 */
const THEMES = [
  { id: "dark",   name: "深夜蓝", bg: "#0d1117", panel: "#1c2330", accent: "#3b82f6" },
  { id: "amoled", name: "纯黑",   bg: "#000000", panel: "#141414", accent: "#4d8dff" },
  { id: "light",  name: "浅色",   bg: "#eef1f6", panel: "#ffffff", accent: "#2563eb" },
  { id: "green",  name: "墨绿",   bg: "#0e1712", panel: "#18291f", accent: "#3fa372" },
  { id: "glass",  name: "玻璃·夜", bg: "#162034", panel: "#1e2942", accent: "#7aa2f7" },
  { id: "aurora", name: "极光",   bg: "#121a2e", panel: "#1a243c", accent: "#5eead4" },
];

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || "dark";
}

function setTheme(id) {
  if (id === "dark") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", id);
  }
  localStorage.setItem("fa_theme", id);
  renderThemePop();
}

function renderThemePop() {
  const pop = $("themePop");
  const cur = currentTheme();
  pop.innerHTML = THEMES.map((t) => `
    <div class="theme-card ${t.id === cur ? "active" : ""}" data-theme-id="${t.id}" title="${t.name}">
      <div class="swatch" style="background: linear-gradient(135deg, ${t.bg} 55%, ${t.panel} 55%, ${t.panel} 75%, ${t.accent} 75%)"></div>
      ${t.name}
    </div>`).join("");
  pop.querySelectorAll(".theme-card").forEach((card) => {
    card.addEventListener("click", () => setTheme(card.dataset.themeId));
  });
}

$("btnTheme").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("themePop");
  if (pop.classList.contains("hidden")) {
    renderThemePop();
    pop.classList.remove("hidden");
  } else {
    pop.classList.add("hidden");
  }
});
document.addEventListener("click", (e) => {
  const pop = $("themePop");
  if (!pop.classList.contains("hidden") && !e.target.closest(".theme-pop") && e.target.id !== "btnTheme") {
    pop.classList.add("hidden");
  }
});


function fmt(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
  return Number(v).toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function chgClass(v) {
  if (v > 0) return "up";
  if (v < 0) return "down";
  return "flat";
}

function toast(text, isErr = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = "toast" + (isErr ? " err" : "");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), 2600);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.detail || data.error || `请求失败 (${res.status})`);
  return data;
}

/* ---------- 轻量 Markdown 渲染（先整体转义防 XSS，再解析常见语法） ---------- */

function mdInline(s) {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
}

function mdSplitRow(line) {
  return line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
}

function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(String(src || "")).split(/\r?\n/);
  const out = [];
  let para = [], code = null, list = null, table = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${mdInline(para.join("<br>"))}</p>`); para = []; }
  };
  const flushList = () => {
    if (list) { out.push(`</${list}>`); list = null; }
  };
  const flushTable = () => {
    if (table.length) {
      const rows = table.filter((r) => !/^\s*:?-{2,}/.test(mdSplitRow(r).join("")));
      const body = rows.map((r, i) =>
        `<tr>${mdSplitRow(r).map((c) => `<${i === 0 ? "th" : "td"}>${mdInline(c)}</${i === 0 ? "th" : "td"}>`).join("")}</tr>`
      ).join("");
      out.push(`<table>${body}</table>`);
      table = [];
    }
  };
  const flushAll = () => { flushPara(); flushList(); flushTable(); };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (/^\s*```/.test(line)) {
      if (code === null) { flushAll(); code = []; }
      else { out.push(`<pre><code>${code.join("\n")}</code></pre>`); code = null; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }

    if (/^\s*$/.test(line)) { flushAll(); continue; }

    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { flushAll(); out.push(`<h${h[1].length + 1}>${mdInline(h[2])}</h${h[1].length + 1}>`); continue; }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); out.push("<hr>"); continue; }

    if (/^\s*\|/.test(line)) { flushPara(); flushList(); table.push(line); continue; }
    flushTable();

    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.*)/);
    if (ul || ol) {
      flushPara();
      const want = ul ? "ul" : "ol";
      if (list !== want) { flushList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    flushList();

    const bq = line.match(/^\s*>\s?(.*)/);
    if (bq) { flushPara(); out.push(`<blockquote>${mdInline(bq[1])}</blockquote>`); continue; }

    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${code.join("\n")}</code></pre>`);
  flushAll();
  return out.join("");
}

function saveWatchlist() {
  localStorage.setItem("fa_watchlist", JSON.stringify(state.watchlist));
}

/* ---------- 行情轮询 ---------- */

async function doRefresh() {
  if (!state.watchlist.length) {
    $("quoteBody").innerHTML = `<tr><td colspan="4" class="muted center pad">暂无自选合约，请在上方添加</td></tr>`;
    return;
  }
  try {
    const data = await api(`/api/watchlist?symbols=${state.watchlist.join(",")}`);
    data.quotes.forEach((q) => (state.quotes[q.symbol] = q));
    checkAlarms();
    renderTable();
    renderMarketStatus(data.market_open);
    setDocTitle();
    $("lastUpdate").textContent = data.ts ? new Date(data.ts).toLocaleTimeString("zh-CN") : "";
    recordTick();
    if (state.selected && state.quotes[state.selected] && currentView() === "detail") renderQuoteArea();
    // 行情到达后补画一次分时图（选中时行情未到，昨结线缺失）
    if (state.selected && state.quotes[state.selected]?.prev_settle != null && !state.intradayDrawn) {
      state.intradayDrawn = true;
      if (currentView() === "detail") loadIntraday(state.selected);
    }
    // 交易时段内每 30 秒（6 轮轮询）静默刷新一次分时图与 K 线；每 20 秒拉一次盯盘事件
    state.refreshCount += 1;
    if (data.market_open && state.refreshCount % 6 === 0 && state.selected && currentView() === "detail") {
      loadIntraday(state.selected);
      loadKline(state.selected);
    }
    if (state.refreshCount % 4 === 0) pollMonitor();
    if (state.refreshCount % 8 === 0) pollNews();
    // 纪律页浮动盈亏随行情刷新（编辑中/无持仓行时零成本跳过）
    if (currentView() === "discipline" && dcLogState.items.some((e) => e.status === "open")
        && !document.querySelector("#dcLogBody input")) {
      renderDcLogBody();
    }
  } catch (e) {
    renderMarketStatus(null, e.message);
  }
}

function renderMarketStatus(open, err) {
  const el = $("marketStatus");
  if (err) {
    el.textContent = "行情获取失败，重试中…";
    el.className = "market-status closed";
    return;
  }
  if (open === null || open === undefined) {
    el.textContent = "--";
    el.className = "market-status closed";
  } else if (open) {
    el.textContent = "● 交易时段";
    el.className = "market-status open";
  } else {
    el.textContent = "○ 非交易时段（数据为最近快照）";
    el.className = "market-status closed";
  }
}

/* ---------- 自选列表 ---------- */

function quoteRowHtml(sym) {
  return `<td class="sym">${sym}<span class="sym-sub"></span></td>
    <td class="num"></td><td class="num"></td>
    <td><button class="btn-del" data-del="${sym}" title="移除">✕</button></td>`;
}

function sortedWatchlist() {
  const { key, dir } = state.sort;
  if (!key) return state.watchlist;
  return [...state.watchlist].sort((a, b) => {
    if (key === "symbol") return a.localeCompare(b) * dir;
    const va = state.quotes[a]?.[key] ?? -Infinity;
    const vb = state.quotes[b]?.[key] ?? -Infinity;
    return (va - vb) * dir;
  });
}

function updateSortArrows() {
  document.querySelectorAll("th .arrow").forEach((el) => {
    const k = el.dataset.arrow;
    el.textContent = state.sort.key === k ? (state.sort.dir === 1 ? "▲" : "▼") : "";
  });
}

document.querySelector("thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.key;
  if (state.sort.key === key) {
    state.sort.dir *= -1;
  } else {
    state.sort = { key, dir: -1 };
  }
  updateSortArrows();
  renderTable();
});

function renderTable() {
  const tbody = $("quoteBody");
  if (!state.watchlist.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted center pad">暂无自选合约</td></tr>`;
    return;
  }

  /* 增量同步行结构：新增的追加、删除的移除（含初始静态占位行），已存在的行不重建，
     避免 5 秒轮询刷新时整个表格 DOM 被替换（闪烁、点击/悬停丢失） */
  const existing = new Map(
    Array.from(tbody.querySelectorAll("tr[data-sym]")).map((tr) => [tr.dataset.sym, tr])
  );
  tbody.querySelectorAll("tr:not([data-sym])").forEach((tr) => tr.remove());
  for (const sym of sortedWatchlist()) {
    if (!existing.has(sym)) {
      const tr = document.createElement("tr");
      tr.dataset.sym = sym;
      tr.innerHTML = quoteRowHtml(sym);
      tbody.appendChild(tr);
    }
    existing.delete(sym);
  }
  existing.forEach((tr) => tr.remove());

  // 按排序结果重排行顺序，并更新各行数据
  const order = sortedWatchlist();
  for (const sym of order) {
    const tr = tbody.querySelector(`tr[data-sym="${sym}"]`);
    if (!tr) continue;
    if (tbody.children[order.indexOf(sym)] !== tr) tbody.insertBefore(tr, tbody.children[order.indexOf(sym)]);
    tr.className = sym === state.selected ? "selected" : "";
    const q = state.quotes[sym];
    const tds = tr.children;
    const sub = tds[0].querySelector(".sym-sub");
    const cls = q ? chgClass(q.change_pct) : "flat";
    const hasAlarm = state.alarms[sym] && (state.alarms[sym].up != null || state.alarms[sym].down != null);
    sub.textContent = (state.names[sym] || (q ? q.name : "")) + (hasAlarm ? " 🔔" : "");
    tr.title = q ? `${sym} 成交量 ${fmt(q.volume)} · 持仓量 ${fmt(q.position)}` : sym;
    const cells = [
      [1, q ? `${fmt(q.last, q.digits ?? 1)}` : "加载中…", cls],
      [2, q ? `${q.change_pct > 0 ? "+" : ""}${fmt(q.change, q.digits ?? 1)} / ${q.change_pct > 0 ? "+" : ""}${fmt(q.change_pct, 2)}%` : "--", cls],
    ];
    for (const [idx, text, colorCls] of cells) {
      tds[idx].textContent = text;
      tds[idx].className = `num ${colorCls}`.trim();
    }
    // 价格变化闪烁
    if (q && q.last != null && state.prevLast[sym] != null && q.last !== state.prevLast[sym]) {
      const flash = q.last > state.prevLast[sym] ? "flash-up" : "flash-down";
      tds[1].classList.remove("flash-up", "flash-down");
      void tds[1].offsetWidth; // 重启动画
      tds[1].classList.add(flash);
    }
    if (q && q.last != null) state.prevLast[sym] = q.last;
  }
}

$("quoteBody").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    const sym = del.dataset.del;
    state.watchlist = state.watchlist.filter((s) => s !== sym);
    if (state.selected === sym) {
      selectSymbol(state.watchlist[0] || null);
    }
    saveWatchlist();
    renderTable();
    return;
  }
  const tr = e.target.closest("tr[data-sym]");
  if (tr) selectSymbol(tr.dataset.sym);
});

// 双击列表行：直达合约详情页
$("quoteBody").addEventListener("dblclick", (e) => {
  const tr = e.target.closest("tr[data-sym]");
  if (tr) {
    selectSymbol(tr.dataset.sym);
    switchView("detail");
  }
});

async function addSymbol() {
  const input = $("symbolInput");
  const raw = input.value.trim().toUpperCase();
  if (!raw) return;
  const sym = raw.endsWith("0") || /(\d{3,4})$/.test(raw) ? raw : raw + "0";
  if (!state.watchlist.includes(sym)) {
    state.watchlist.push(sym);
    saveWatchlist();
    renderTable();
  }
  input.value = "";
  selectSymbol(sym);
  await doRefresh();
}

$("btnAdd").addEventListener("click", addSymbol);
$("symbolInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addSymbol();
});

/* ---------- 合约详情 ---------- */

function selectSymbol(sym) {
  state.selected = sym || null;
  localStorage.setItem("fa_selected", state.selected || "");
  state.intradayDrawn = false;
  renderTable();
  renderQuoteArea();
  if (currentView() === "detail") {
    // 详情视图可见才绘制图表（隐藏容器 clientWidth=0，无法绘图）
    renderAnalysisArea();
    renderSignalArea();
  }
  updateAlarmRow();
  syncDetailSymSelect();
}

function renderQuoteArea() {
  const sym = state.selected;
  const box = $("detailBody");
  $("detailTime").textContent = "";
  if (!sym) {
    box.innerHTML = `<div class="muted center pad">在左侧列表中选择一个合约查看详情</div>`;
    return;
  }
  const q = state.quotes[sym];
  if (!q) {
    box.innerHTML = `<div class="muted center pad">加载 ${sym} …</div>`;
    return;
  }
  const cls = chgClass(q.change_pct);
  const sign = q.change_pct > 0 ? "+" : "";
  const name = state.names[sym] || "";
  const dg2 = q.digits ?? 1;
  // 日内区间位置条：现价位于（今开~最高 或 最低~最高）区间的百分比
  let rangeBar = "";
  if (q.high != null && q.low != null && q.high > q.low && q.last != null) {
    const posPct = Math.max(0, Math.min(100, ((q.last - q.low) / (q.high - q.low)) * 100));
    rangeBar = `
      <div class="range-bar-wrap">
        <span class="muted small">低 ${fmt(q.low, dg2)}</span>
        <div class="range-bar"><div class="range-fill" style="width:${posPct.toFixed(0)}%"></div><div class="range-dot" style="left:${posPct.toFixed(0)}%"></div></div>
        <span class="muted small">高 ${fmt(q.high, dg2)}</span>
        <span class="small ${cls}" style="margin-left:6px">日内 ${posPct.toFixed(0)}% 位</span>
      </div>`;
  }
  box.innerHTML = `
    <div class="detail-top">
      <span class="detail-name">${sym}<span class="exch">${q.exchange || ""}${name ? " · " + name : ""}</span></span>
      <span id="detailLast" class="detail-last ${cls}">${fmt(q.last, dg2)}</span>
      <span class="detail-chg ${cls}">${sign}${fmt(q.change, dg2)}（${sign}${fmt(q.change_pct, 2)}%）</span>
    </div>
    ${rangeBar}
    <div class="detail-grid">
      ${dg("今开", fmt(q.open, dg2))}
      ${dg("昨结", fmt(q.prev_settle, dg2))}
      ${dg("成交量", fmt(q.volume))}
      ${dg("持仓量", fmt(q.position))}
    </div>
    <div class="book-duel">
      <div class="book-side bid">
        <span class="book-label">买一 ${q.bid_vol != null ? fmt(q.bid_vol) : "--"} 手</span>
        <span class="book-price">${q.bid != null ? fmt(q.bid, dg2) : "--"}</span>
      </div>
      <div class="book-mid muted">盘口</div>
      <div class="book-side ask">
        <span class="book-price">${q.ask != null ? fmt(q.ask, dg2) : "--"}</span>
        <span class="book-label">卖一 ${q.ask_vol != null ? fmt(q.ask_vol) : "--"} 手</span>
      </div>
    </div>
    <div class="tick-wrap">
      <div class="spark-title">实时走势（本次会话）</div>
      <div id="tickChart"></div>
    </div>`;
  $("detailTime").textContent = q.time ? `行情时间：${q.time}` : "";
  renderTickChart();
  // 价格变化闪烁（大字）
  const lastEl = $("detailLast");
  if (state.prevLast.detailSym === sym && state.prevLast.detailVal != null && q.last !== state.prevLast.detailVal) {
    const flash = q.last > state.prevLast.detailVal ? "flash-up" : "flash-down";
    lastEl.classList.add(flash);
    setTimeout(() => lastEl.classList.remove(flash), 1300);
  }
  state.prevLast.detailSym = sym;
  state.prevLast.detailVal = q.last;
}

async function renderAnalysisArea() {
  const sym = state.selected;
  const box = $("chartArea");
  if (!sym) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="intraday-wrap">
      <div class="intraday-legend">
        <span><i class="legend-dot" style="background:#f5c542"></i>价格</span>
        <span><i class="legend-dot" style="background:#7aa2f7"></i>均价</span>
        <span id="intradayDate" class="muted"></span>
        <span class="annot-bar" title="标注模式：选中后在分时图上点击放置（双击标注删除）">
          <button class="annot-btn" data-annot="bull" title="标注多头判定">📈多</button>
          <button class="annot-btn" data-annot="bear" title="标注空头判定">📉空</button>
          <button class="annot-btn" data-annot="risk" title="标注风险点">⚠️</button>
          <button class="annot-btn" data-annot="level" title="画关键价位线（支撑/压力/止损）">📏</button>
          <button class="annot-btn" data-annot="note" title="文字批注（走势推理）">📝</button>
          <button class="annot-btn" data-annot-clear="1" title="清除当日全部标注">🧹</button>
          <button class="annot-btn" id="btnAnnotAi" title="把标注交给 AI 逐条评估并给独立推演">🤖评估</button>
          <button class="annot-btn" id="btnAnnotNote" title="标注转结构化心得（可同步飞书）">💾存心得</button>
        </span>
      </div>
      <div id="intradayChart"><span class="muted small">分时加载中…</span></div>
    </div>
    <div class="kline-wrap">
      <div class="kline-head">
        <span class="kline-title">K 线 · <span class="muted">MA5 <i class="legend-dot" style="background:#ffffff"></i> MA10 <i class="legend-dot" style="background:#f5c542"></i> MA20 <i class="legend-dot" style="background:#c084fc"></i></span></span>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <div class="period-tabs" id="periodTabs">
            ${Object.keys(PERIOD_LABEL).map((p) => `<button data-p="${p}" class="${state.klinePeriod === p ? "active" : ""}">${PERIOD_LABEL[p]}</button>`).join("")}
          </div>
          <button class="kline-toggle${state.klineShowMA ? " on" : ""}" id="tglMA" title="均线开关">MA</button>
          <button class="kline-toggle${state.klineShowBoll ? " on" : ""}" id="tglBoll" title="布林带开关">BOLL</button>
          <span class="muted small" title="滚轮缩放 · 拖拽平移 · 双击复位">🖱️缩放/平移</span>
        </div>
      </div>
      <div class="kline-chart-box">
        <div id="klineChart"><span class="muted small">K线加载中…</span></div>
        <div id="klineTip" class="kline-tip hidden"></div>
      </div>
    </div>`;
  loadIntraday(sym);
  loadKline(sym);
  $("periodTabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-p]");
    if (!b || b.dataset.p === state.klinePeriod) return;
    state.klinePeriod = b.dataset.p;
    loadKline(sym);
  });
  $("tglMA").addEventListener("click", () => {
    state.klineShowMA = !state.klineShowMA;
    $("tglMA").classList.toggle("on", state.klineShowMA);
    const el = $("klineChart");
    if (el && el._kfull) renderKlineChart(el, el._kfull);
  });
  $("tglBoll").addEventListener("click", () => {
    state.klineShowBoll = !state.klineShowBoll;
    $("tglBoll").classList.toggle("on", state.klineShowBoll);
    const el = $("klineChart");
    if (el && el._kfull) renderKlineChart(el, el._kfull);
  });
}

async function renderSignalArea() {
  const sym = state.selected;
  const box = $("sigArea");
  if (!sym) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="sig-box"><div class="sig-title">技术信号与指标（日线）</div><span class="muted small">加载中…</span></div>`;
  try {
    const d = await api(`/api/indicators/${sym}`);
    const v = d.values || {};
    const chips = (d.signals || []).length
      ? d.signals.map((s) => `<span class="sig ${s.dir}" title="${s.detail}">${s.name}<span class="d">${s.detail}</span></span>`).join("")
      : `<span class="muted small">当前无明显技术信号</span>`;
    const fv = (x) => (x == null ? "--" : x);
    const group = (title, items) => `
      <div class="ind-group">
        <div class="ind-group-title">${title}</div>
        <div class="detail-grid">${items.map(([k, val]) => dg(k, fv(val))).join("")}</div>
      </div>`;
    box.innerHTML = `
      <div id="fundPanel"></div>
      <div class="sig-box">
        <div class="sig-title">技术信号（${d.date} 日线）</div>
        <div class="sig-chips">${chips}</div>
        <div style="margin-top:10px">
          ${group("趋势 · 均线", [["MA5", v.ma5], ["MA10", v.ma10], ["MA20", v.ma20], ["MA60", v.ma60]])}
          ${group("动能 · MACD / RSI", [["DIF", v.dif], ["DEA", v.dea], ["MACD柱", v.macd_hist], ["RSI6", v.rsi6], ["RSI12", v.rsi12]])}
          ${group("超买超卖 · KDJ", [["K", v.k], ["D", v.d], ["J", v.j]])}
          ${group("波动 · 布林带", [["上轨", v.boll_up], ["中轨", v.boll_mid], ["下轨", v.boll_low]])}
        </div>
      </div>`;
    loadFundPanel(sym);  // 骨架稳定后再异步加载资金情绪
  } catch (e) {
    box.innerHTML = `<div class="sig-box"><div class="sig-title">技术信号与指标</div><span class="muted small">加载失败：${e.message}</span></div>`;
  }
}

/* 资金情绪面板：价量仓三要素 → 评分条 + 因子列表 */
async function loadFundPanel(sym) {
  const el = $("fundPanel");
  if (!el) return;
  el.innerHTML = `<div class="sig-box"><div class="sig-title">主力资金情绪</div><span class="muted small">分析中…</span></div>`;
  try {
    const fs = await api(`/api/fund/${sym}`);
    const pctPos = ((fs.score + 100) / 2).toFixed(0);  // -100~100 → 0~100%
    const factors = (fs.factors || []).map((f) => `<li>${esc(f)}</li>`).join("");
    el.innerHTML = `<div class="sig-box fund-panel">
      <div class="sig-title">主力资金情绪（价量仓三要素）</div>
      <div class="fund-score-row">
        <span class="fund-bias">${esc(fs.bias)}</span>
        <span class="fund-score-num ${fs.score > 0 ? "up" : fs.score < 0 ? "down" : ""}">${fs.score > 0 ? "+" : ""}${fs.score}</span>
      </div>
      <div class="fund-gauge"><div class="fund-gauge-dot" style="left:${pctPos}%"></div></div>
      <div class="fund-gauge-labels muted small"><span>空头主导 -100</span><span>0</span><span>+100 多头主导</span></div>
      <ul class="fund-factors">${factors}</ul>
      <div class="muted small">💡 ${esc(fs.summary)}</div>
    </div>`;
  } catch (e) {
    el.innerHTML = `<div class="sig-box"><div class="sig-title">主力资金情绪</div><span class="muted small">资金情绪分析不可用：${e.message}</span></div>`;
  }
}

/* ---------- 实时走势（本次会话的 5 秒采样轨迹） ---------- */

function recordTick() {
  const sym = state.selected;
  const q = sym && state.quotes[sym];
  if (!q || q.last == null) return;
  if (state.ticks.sym !== sym) state.ticks = { sym, points: [] };
  state.ticks.points.push({ t: Date.now(), p: q.last });
  if (state.ticks.points.length > 240) state.ticks.points.shift(); // 保留约 20 分钟
}

function renderTickChart() {
  const box = $("tickChart");
  if (!box) return;
  const wrap = box.parentElement;
  const { sym, points } = state.ticks;
  if (!sym || points.length < 2) { wrap.style.display = "none"; return; }
  wrap.style.display = "";
  const w = box.clientWidth || 560, h = 68, pad = 8;
  const prices = points.map((pt) => pt.p);
  let min = Math.min(...prices), max = Math.max(...prices);
  if (max - min < 1e-9) { min -= 1; max += 1; }
  const span = max - min;
  const x = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const y = (p) => pad + (1 - (p - min) / span) * (h - pad * 2 - 14);
  const pts = points.map((pt, i) => `${x(i).toFixed(1)},${y(pt.p).toFixed(1)}`).join(" ");
  const rising = prices[prices.length - 1] >= prices[0];
  const color = rising ? "var(--up)" : "var(--down)";
  const lastP = prices[prices.length - 1];
  const durMin = Math.max(1, Math.round((points[points.length - 1].t - points[0].t) / 60000));
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.5"/>
    <circle cx="${x(points.length - 1)}" cy="${y(lastP)}" r="2.5" fill="${color}"/>
    <text x="${w - pad}" y="${y(lastP) - 6}" fill="${color}" font-size="10" text-anchor="end">${lastP}</text>
    <text x="${pad}" y="${h - 3}" fill="#8a93a6" font-size="9">近 ${durMin} 分钟（5 秒采样）</text>
    <text x="${w - pad}" y="${h - 3}" fill="#8a93a6" font-size="9" text-anchor="end">高 ${max} / 低 ${min}</text>
  </svg>`;
}

function dg(k, v) {
  return `<div class="dg-item"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

/* ---------- K 线蜡烛图（红涨绿跌 + MA + 成交量副图 + 信号标记 + 十字光标） ---------- */

const PERIOD_LABEL = { "1m": "1分", "5m": "5分", "15m": "15分", "30m": "30分", "60m": "60分", "day": "日K" };

async function loadKline(sym) {
  const el = $("klineChart");
  if (!el) return;
  try {
    const d = await api(`/api/kline/${sym}?period=${state.klinePeriod}&limit=500`);
    if (!d.items.length) { el.textContent = "暂无K线数据"; return; }
    el._kfull = d;
    state.klineView = { bars: 90, offset: 0 };
    renderKlineChart(el, d);
    const tabs = document.querySelectorAll("#periodTabs button");
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.p === state.klinePeriod));
  } catch (e) {
    el.textContent = `K线加载失败：${e.message}`;
  }
}

/* K 线蜡烛图：窗口化渲染（bars/offset 支持缩放平移）+ MA/BOLL 开关 */
function renderKlineChart(el, data) {
  const all = data.items;
  const vw = state.klineView || (state.klineView = { bars: 90, offset: 0 });
  vw.bars = Math.max(20, Math.min(vw.bars, all.length));
  vw.offset = Math.max(0, Math.min(vw.offset, all.length - 20));
  const end = all.length - vw.offset;
  const items = all.slice(Math.max(0, end - vw.bars), end);
  const w = el.clientWidth || 540;
  const padL = 6, padR = 58, padT = 8, mainH = 225, gap = 6, volH = 56, padB = 18;
  const plotW = w - padL - padR;
  const n = items.length;
  const cw = plotW / n;
  const volTop = padT + mainH + gap;
  const volBase = volTop + volH - 4;

  const highs = [], lows = [];
  items.forEach((it) => { highs.push(it.high ?? it.close ?? 0); lows.push(it.low ?? it.close ?? 0); });
  const overlayKeys = [];
  if (state.klineShowMA) overlayKeys.push("ma5", "ma10", "ma20");
  if (state.klineShowBoll) overlayKeys.push("boll_up", "boll_mid", "boll_low");
  for (const k of overlayKeys) {
    items.forEach((it) => { if (it[k] != null) { highs.push(it[k]); lows.push(it[k]); } });
  }
  let pmin = Math.min(...lows), pmax = Math.max(...highs);
  const pr = (pmax - pmin) * 0.05 || 1;
  pmin -= pr; pmax += pr;
  const yMain = (p) => padT + (1 - (p - pmin) / (pmax - pmin)) * (mainH - padT);
  const volMax = Math.max(...items.map((i) => i.volume || 0)) || 1;
  const yVol = (v) => volTop + (1 - v / volMax) * (volH - 6);
  const cx = (i) => padL + (i + 0.5) * cw;
  const fp = (v) => (v >= 1000 ? v.toFixed(0) : v.toFixed(1));

  const els = [];
  // 价格网格与右轴刻度
  for (let g = 0; g <= 3; g++) {
    const p = pmin + ((pmax - pmin) * g) / 3;
    const yy = yMain(p);
    els.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="#232b3b" stroke-dasharray="2 4"/>`);
    els.push(`<text x="${w - padR + 4}" y="${(yy + 3).toFixed(1)}" fill="#8a93a6" font-size="9">${fp(p)}</text>`);
  }
  // 蜡烛与成交量
  items.forEach((it, i) => {
    if (it.close == null || it.open == null) return;
    const up = it.close >= it.open;
    const color = up ? "#f34e4e" : "#22c55e";
    const x = cx(i);
    const bw = Math.max(1, cw * 0.7);
    els.push(`<line x1="${x.toFixed(1)}" y1="${yMain(it.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${yMain(it.low).toFixed(1)}" stroke="${color}" stroke-width="1"/>`);
    const y1 = yMain(Math.max(it.open, it.close));
    const y2 = yMain(Math.min(it.open, it.close));
    els.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, y2 - y1).toFixed(1)}" fill="${color}"/>`);
    if (it.volume) {
      const vy = yVol(it.volume);
      els.push(`<rect x="${(x - bw / 2).toFixed(1)}" y="${vy.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, volBase - vy).toFixed(1)}" fill="${color}" opacity="0.5"/>`);
    }
  });
  // 叠加线（MA / BOLL）
  const maColors = { ma5: "#ffffff", ma10: "#f5c542", ma20: "#c084fc", boll_up: "#38bdf8", boll_mid: "#94a3b8", boll_low: "#38bdf8" };
  for (const k of overlayKeys) {
    const pts = items.map((it, i) => (it[k] == null ? null : `${cx(i).toFixed(1)},${yMain(it[k]).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) els.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${maColors[k]}" stroke-width="1" opacity="${k.startsWith("boll") ? 0.75 : 0.9}"${k === "boll_mid" ? ' stroke-dasharray="4 3"' : ""}/>`);
  }
  // 最新价虚线与右侧价签
  const last = items[n - 1];
  if (last.close != null) {
    const up = last.close >= (last.open ?? last.close);
    const c = up ? "#f34e4e" : "#22c55e";
    const yy = yMain(last.close);
    els.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${c}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.8"/>`);
    els.push(`<rect x="${w - padR + 1}" y="${(yy - 7).toFixed(1)}" width="${padR - 3}" height="14" rx="2" fill="${c}"/>`);
    els.push(`<text x="${w - padR + 5}" y="${(yy + 4).toFixed(1)}" fill="#fff" font-size="9">${fp(last.close)}</text>`);
  }
  // 信号标记（▲看多 ▼看空 ◆警示）
  (data.signals || []).forEach((s, si) => {
    const idx = items.findIndex((it) => it.datetime === s.date);
    if (idx < 0) return;
    const x = cx(idx);
    const col = s.dir === "bull" ? "#f34e4e" : s.dir === "bear" ? "#22c55e" : "#f5a623";
    const yTop = yMain(items[idx].high ?? items[idx].close) - 10 - (si % 2) * 10;
    let shape;
    if (s.dir === "bull") shape = `<polygon points="${x.toFixed(1)},${(yTop - 5).toFixed(1)} ${(x - 4).toFixed(1)},${(yTop + 3).toFixed(1)} ${(x + 4).toFixed(1)},${(yTop + 3).toFixed(1)}" fill="${col}"/>`;
    else if (s.dir === "bear") shape = `<polygon points="${x.toFixed(1)},${(yTop + 3).toFixed(1)} ${(x - 4).toFixed(1)},${(yTop - 5).toFixed(1)} ${(x + 4).toFixed(1)},${(yTop - 5).toFixed(1)}" fill="${col}"/>`;
    else shape = `<rect x="${(x - 3.5).toFixed(1)}" y="${(yTop - 4).toFixed(1)}" width="7" height="7" fill="${col}" transform="rotate(45 ${x.toFixed(1)} ${(yTop - 0.5).toFixed(1)})"/>`;
    els.push(`<g>${shape}<title>${s.name}：${s.detail}</title></g>`);
  });
  // X 轴时间刻度
  const tickIdx = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
  tickIdx.forEach((i) => {
    const label = data.period === "day" ? items[i].datetime.slice(5) : items[i].datetime.slice(5, 16);
    els.push(`<text x="${cx(i).toFixed(1)}" y="${volBase + 12}" fill="#8a93a6" font-size="9" text-anchor="middle">${label}</text>`);
  });
  // 十字光标竖线（预留，hover 时移动）
  els.push(`<line id="kCross" x1="0" y1="${padT}" x2="0" y2="${volBase}" stroke="#8a93a6" stroke-dasharray="3 3" visibility="hidden"/>`);

  const H = volBase + padB;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${H}" width="${w}" height="${H}">${els.join("")}</svg>`;
  el._kdata = { items, cx, padL, plotW, period: data.period };
  bindKlineHover(el);
  bindKlineZoomPan(el, data);
}

/* 滚轮缩放（20~500 根）+ 拖拽平移 + 双击复位（rAF 节流重绘） */
function bindKlineZoomPan(el, data) {
  const vw = state.klineView;
  const all = data.items;
  let raf = null;
  const redraw = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = null; renderKlineChart(el, data); });
  };
  el.onwheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
    vw.bars = Math.round(Math.max(20, Math.min(vw.bars * factor, all.length)));
    vw.offset = Math.min(vw.offset, all.length - 20);
    redraw();
  };
  let dragging = false, lastX = 0;
  el.onpointerdown = (e) => {
    dragging = true; lastX = e.clientX;
    el.setPointerCapture(e.pointerId);
  };
  el.onpointermove = (e) => {
    if (!dragging) return;
    const barW = (el.clientWidth || 540) / vw.bars;
    const dBars = Math.round((e.clientX - lastX) / barW);
    if (dBars !== 0) {
      lastX += dBars * barW;
      vw.offset = Math.max(0, Math.min(vw.offset + dBars, all.length - 20));
      redraw();
    }
  };
  el.onpointerup = el.onpointercancel = () => { dragging = false; };
  el.ondblclick = () => {
    vw.bars = 90; vw.offset = 0;
    redraw();
    toast("已复位");
  };
}

function bindKlineHover(el) {
  const tip = $("klineTip");
  const cross = el.querySelector("#kCross");
  if (!tip || !cross) return;
  el.onmousemove = (ev) => {
    const { items, cx, padL, plotW, period } = el._kdata;
    const rect = el.getBoundingClientRect();
    const px = ev.clientX - rect.left;
    let idx = Math.round((px - padL) / (plotW / items.length) - 0.5);
    idx = Math.max(0, Math.min(items.length - 1, idx));
    const it = items[idx];
    if (!it) return;
    cross.setAttribute("x1", cx(idx).toFixed(1));
    cross.setAttribute("x2", cx(idx).toFixed(1));
    cross.setAttribute("visibility", "visible");
    const prev = items[idx - 1];
    const chg = prev && prev.close ? ((it.close - prev.close) / prev.close) * 100 : null;
    const cls = chg == null ? "" : chg >= 0 ? "up" : "down";
    tip.innerHTML = `<b>${period === "day" ? it.datetime : it.datetime.slice(5, 16)}</b>　开 ${it.open} 高 ${it.high} 低 ${it.low} 收 <span class="${cls}">${it.close}${chg != null ? `（${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%）` : ""}</span><br>量 ${fmt(it.volume)}　仓 ${fmt(it.position)}${it.ma5 != null ? `<br>MA5 ${it.ma5} · MA10 ${it.ma10} · MA20 ${it.ma20}` : ""}`;
    tip.classList.remove("hidden");
    const box = el.parentElement.getBoundingClientRect();
    tip.style.left = Math.max(4, Math.min(px + 16, box.width - 240)) + "px";
    tip.style.top = Math.max(4, ev.clientY - box.top - 20) + "px";
  };
  el.onmouseleave = () => {
    tip.classList.add("hidden");
    cross.setAttribute("visibility", "hidden");
  };
}

/* 日内分时图：价格线 + 均价线 + 昨结基准虚线 + 最新点 + 时间刻度 */
function renderIntradayChart(el, items, prevSettle, date) {
  const w = el.clientWidth || 560, h = 140, padT = 8, padB = 16, padX = 8;
  const prices = items.map((it) => it.price).filter((p) => p != null);
  if (prices.length < 2) { el.textContent = "暂无分时数据"; return; }
  let min = Math.min(...prices), max = Math.max(...prices);
  if (prevSettle) { min = Math.min(min, prevSettle); max = Math.max(max, prevSettle); }
  const rawSpan = max - min || 1;
  min -= rawSpan * 0.06;
  max += rawSpan * 0.06;
  const n = items.length;
  const x = (i) => padX + (i / Math.max(1, n - 1)) * (w - padX * 2);
  const y = (p) => padT + (1 - (p - min) / (max - min)) * (h - padT - padB);
  const line = (key, color, dash) =>
    `<polyline points="${items
      .map((it, i) => (it[key] == null ? null : `${x(i).toFixed(1)},${y(it[key]).toFixed(1)}`))
      .filter(Boolean).join(" ")}" fill="none" stroke="${color}" stroke-width="1.3"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
  const last = items[n - 1];
  const dotColor = prevSettle ? (last.price >= prevSettle ? "var(--up)" : "var(--down)") : "#f5c542";
  const settleLine = prevSettle
    ? `<line x1="${padX}" y1="${y(prevSettle)}" x2="${w - padX}" y2="${y(prevSettle)}" stroke="#8a93a6" stroke-width="1" stroke-dasharray="4 4"/>
       <text x="${padX + 2}" y="${y(prevSettle) - 3}" fill="#8a93a6" font-size="9">昨结 ${prevSettle}</text>`
    : "";
  const tickIdx = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
  const tickEls = tickIdx
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${h - 4}" fill="#8a93a6" font-size="9" text-anchor="middle">${items[i].time}</text>`)
    .join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    ${settleLine}
    ${line("avg", "#7aa2f7")}
    ${line("price", "#f5c542")}
    <circle cx="${x(n - 1)}" cy="${y(last.price)}" r="2.5" fill="${dotColor}"/>
    <text x="${(x(n - 1) - 5).toFixed(1)}" y="${y(last.price) - 6}" fill="${dotColor}" font-size="10" text-anchor="end">${last.price}</text>
    ${tickEls}
  </svg>`;
  // 标注坐标系（数据坐标存储，图重绘后位置不丢）+ 标注层 + 点击放置（上游 cb02f31 整合）
  el._iscale = {
    date,
    padL: padX,
    padR: w - padX,
    xOfTime: (t) => {
      const i = items.findIndex((it) => it.time === t);
      return i < 0 ? padX : x(i);
    },
    yOfPrice: y,
    timeOfX: (sx) => {
      if (sx < padX - 4 || sx > w - padX + 4) return null;
      const i = Math.max(0, Math.min(n - 1, Math.round(((sx - padX) / (w - padX * 2)) * Math.max(1, n - 1))));
      return items[i].time;
    },
    priceOfY: (sy) => {
      if (sy < padT - 4 || sy > h - padB + 4) return null;
      return min + (1 - (sy - padT) / (h - padT - padB)) * (max - min);
    },
  };
  drawAnnotations(el);
  bindIntradayAnnot(el);
}

async function loadIntraday(sym) {
  try {
    const data = await api(`/api/intraday/${sym}`);
    const el = $("intradayChart");
    const dateEl = $("intradayDate");
    if (dateEl) dateEl.textContent = `（${data.date}）`;
    if (!el) return;
    if (!data.items.length) { el.textContent = "暂无分时数据"; return; }
    // 自测钩子：?annot_test=1 时生成示例标注（也用于回归验证标注渲染）
    if (new URLSearchParams(location.search).get("annot_test") === "1" && !getAnnots(sym, data.date).length) {
      const p = data.items[Math.floor(data.items.length * 0.3)];
      addAnnot(sym, data.date, { id: "test1", type: "bull", time: p.time, price: p.price, ts: Date.now() });
      addAnnot(sym, data.date, { id: "test2", type: "level", time: p.time, price: +(p.price * 1.004).toFixed(1), text: "压力", ts: Date.now() + 1 });
      addAnnot(sym, data.date, { id: "test3", type: "note", time: p.time, price: +(p.price * 0.996).toFixed(1), text: "示例批注", ts: Date.now() + 2 });
    }
    renderIntradayChart(el, data.items, state.quotes[sym]?.prev_settle, data.date);
  } catch (e) {
    const el = $("intradayChart");
    if (el) el.textContent = "分时数据加载失败";
  }
}

/* ---------- 日内走势图形标注（上游 cb02f31 整合） ---------- */

const ANNOT_INFO = {
  bull: { label: "📈多", color: "#f34e4e" },
  bear: { label: "📉空", color: "#22c55e" },
  risk: { label: "⚠风险", color: "#f5a623" },
  level: { label: "📏价位", color: "#7aa2f7" },
  note: { label: "📝批注", color: "#ffffff" },
};

function annotStore() { return JSON.parse(localStorage.getItem("fa_annot") || "{}"); }
function saveAnnotStore(s) { localStorage.setItem("fa_annot", JSON.stringify(s)); }
function getAnnots(sym, date) { return (annotStore()[sym] || {})[date] || []; }
function addAnnot(sym, date, a) {
  const s = annotStore();
  (s[sym] = s[sym] || {});
  (s[sym][date] = s[sym][date] || []);
  s[sym][date].push(a);
  saveAnnotStore(s);
}
function delAnnot(sym, date, id) {
  const s = annotStore();
  if (s[sym] && s[sym][date]) {
    s[sym][date] = s[sym][date].filter((a) => a.id !== id);
    saveAnnotStore(s);
  }
}
function clearAnnots(sym, date) {
  const s = annotStore();
  if (s[sym]) { delete s[sym][date]; saveAnnotStore(s); }
}

function annotFmtList(anns) {
  return anns.map((a) => {
    const info = ANNOT_INFO[a.type] || {};
    return `${a.time} ${info.label || a.type} @${a.price}${a.text ? `「${a.text}」` : ""}`;
  });
}

function drawAnnotations(el) {
  const scale = el._iscale;
  const svg = el.querySelector("svg");
  if (!svg || !scale || !scale.date || !state.selected) return;
  const old = svg.querySelector("#annotLayer");
  if (old) old.remove();
  const annots = getAnnots(state.selected, scale.date);
  if (!annots.length) return;
  const NS = "http://www.w3.org/2000/svg";
  const layer = document.createElementNS(NS, "g");
  layer.id = "annotLayer";

  for (const a of annots) {
    const info = ANNOT_INFO[a.type] || ANNOT_INFO.note;
    const g = document.createElementNS(NS, "g");
    g.dataset.annotId = a.id;
    g.style.cursor = "pointer";
    g.setAttribute("opacity", "0.95");
    let shape = "";
    if (a.type === "level") {
      const y = scale.yOfPrice(a.price);
      shape = `<line x1="${scale.padL}" y1="${y.toFixed(1)}" x2="${scale.padR}" y2="${y.toFixed(1)}" stroke="${info.color}" stroke-width="1.2" stroke-dasharray="6 4"/>
        <rect x="${(scale.padR - 86).toFixed(1)}" y="${(y - 8).toFixed(1)}" width="88" height="16" rx="3" fill="${info.color}" opacity="0.9"/>
        <text x="${(scale.padR - 82).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#0d1117" font-weight="600">${a.price}${a.text ? ` ${esc(a.text.slice(0, 5))}` : ""}</text>`;
    } else {
      const x = scale.xOfTime(a.time), y = scale.yOfPrice(a.price);
      if (a.type === "bull") shape = `<path d="M ${x} ${(y - 7).toFixed(1)} L ${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)} L ${(x + 5).toFixed(1)} ${(y + 4).toFixed(1)} Z" fill="${info.color}"/>`;
      else if (a.type === "bear") shape = `<path d="M ${x} ${(y + 7).toFixed(1)} L ${(x - 5).toFixed(1)} ${(y - 4).toFixed(1)} L ${(x + 5).toFixed(1)} ${(y - 4).toFixed(1)} Z" fill="${info.color}"/>`;
      else if (a.type === "risk") shape = `<rect x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9" fill="${info.color}" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      else shape = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#f5a623"/>`;
      if (a.text) {
        shape += `<rect x="${(x + 7).toFixed(1)}" y="${(y - 16).toFixed(1)}" width="${Math.min(a.text.length * 11 + 8, 150)}" height="17" rx="3" fill="rgba(13,17,23,.92)" stroke="${info.color}" stroke-width="0.6"/>
          <text x="${(x + 11).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" fill="${info.color}">${esc(a.text.slice(0, 13))}</text>`;
      }
    }
    g.innerHTML = shape + `<title>${a.time} ${info.label} ${a.price}${a.text ? `：${esc(a.text)}` : ""}（双击删除）</title>`;
    layer.appendChild(g);
  }
  svg.appendChild(layer);
}

function bindIntradayAnnot(el) {
  el.onclick = (ev) => {
    const mode = state.annotMode;
    const scale = el._iscale;
    if (!mode || !scale || !state.selected) return;
    const svg = el.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    const time = scale.timeOfX(sx), price = scale.priceOfY(sy);
    if (!time || price == null) return;
    const a = { id: `a${Date.now()}`, type: mode, time, price: Math.round(price * 10) / 10, ts: Date.now() };
    if (mode === "note" || mode === "level" || mode === "risk") {
      const hint = { note: "批注内容（走势推理/风险描述）", level: "价位含义（如：压力/支撑/止损）", risk: "风险描述（可留空）" }[mode];
      const text = prompt(`${ANNOT_INFO[mode].label} · ${hint}：`, "");
      if (mode === "note" && !text) return;
      if (text) a.text = text.slice(0, 30);
    }
    addAnnot(state.selected, scale.date, a);
    drawAnnotations(el);
    toast(`已标注 ${ANNOT_INFO[mode].label} @${a.price}`);
  };
  el.ondblclick = (ev) => {
    const g = ev.target.closest("[data-annot-id]");
    const scale = el._iscale;
    if (g && scale && state.selected) {
      delAnnot(state.selected, scale.date, g.dataset.annotId);
      drawAnnotations(el);
      toast("标注已删除");
    }
  };
}

function syncAnnotButtons() {
  document.querySelectorAll(".annot-btn[data-annot]").forEach((b) => {
    b.classList.toggle("active", b.dataset.annot === state.annotMode);
  });
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".annot-btn");
  if (!b) return;
  if (b.dataset.annot) {
    state.annotMode = state.annotMode === b.dataset.annot ? null : b.dataset.annot;
    syncAnnotButtons();
    if (state.annotMode) toast(`标注模式：${ANNOT_INFO[state.annotMode].label}，点击分时图放置（双击标注可删除）`);
  } else if (b.dataset.annotClear) {
    const el = $("intradayChart"), scale = el && el._iscale;
    if (scale && state.selected && getAnnots(state.selected, scale.date).length) {
      clearAnnots(state.selected, scale.date);
      drawAnnotations(el);
      toast("已清除当日标注");
    } else toast("当日暂无标注");
  } else if (b.id === "btnAnnotAi") {
    aiEvalAnnotations();
  } else if (b.id === "btnAnnotNote") {
    saveAnnotationsAsNote();
  }
});

async function aiEvalAnnotations() {
  const el = $("intradayChart"), scale = el && el._iscale;
  if (!scale || !state.selected) return toast("请先在合约详情页加载分时图", true);
  const anns = getAnnots(state.selected, scale.date);
  if (!anns.length) return toast("暂无标注，先在分时图上做标注", true);
  switchView("work");
  sendChat(`我在 ${state.selected}（${state.names[state.selected] || ""}）今日（${scale.date}）分时图上做了如下手工标注：\n${annotFmtList(anns).join("\n")}\n\n请：1) 逐条评估我的每个判定（依据是否充分、与量价结构是否一致）；2) 指出标注间的冲突或强化关系（如多头判定与风险位的关系）；3) 给出你基于当前盘面的独立趋势推演（方向、关键触发价位、失效条件），并说明与我的标注的分歧点。`);
}

async function saveAnnotationsAsNote() {
  const el = $("intradayChart"), scale = el && el._iscale;
  if (!scale || !state.selected) return toast("请先在合约详情页加载分时图", true);
  const anns = getAnnots(state.selected, scale.date);
  if (!anns.length) return toast("暂无标注", true);
  try {
    await api("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${state.selected} ${scale.date} 图形标注`,
        content: annotFmtList(anns).join("\n"),
        symbol: state.selected,
        tags: "图形标注",
        date: scale.date,
      }),
    });
    toast("标注已保存到交易心得");
    if (notesState.items.length) loadNotes();
  } catch (e) {
    toast(`保存失败：${e.message}`, true);
  }
}


/* ---------- 价格预警 ---------- */

function persistAlarms() {
  localStorage.setItem("fa_alarms", JSON.stringify(state.alarms));
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
          const word = e.dir === "up" ? "急涨" : "跳水";
          toast(`🤖 ${e.symbol} ${word} ${e.chg5 > 0 ? "+" : ""}${e.chg5}% → ${e.price}`, true);
          flashTitle(`${e.symbol} ${word}${e.chg5 > 0 ? "+" : ""}${e.chg5}%`);
          monitorBeep();
        }
      }
    }
    d.events.forEach((e) => monitorState.seen.add(e.id));
    list.innerHTML = d.events
      .map((e) => {
        const t = new Date(e.ts);
        const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
        const cls = e.dir === "up" ? "up" : "down";
        const word = e.dir === "up" ? "急涨" : "跳水";
        const sign = e.chg5 > 0 ? "+" : "";
        return `<div class="mon-event" data-sym="${e.symbol}">
          <div class="mon-line">
            <span class="mon-time">${hhmm}</span><b>${e.symbol}</b>
            <span class="${cls}">${word} ${sign}${e.chg5}%</span>
            <span>→ ${e.price}</span>
            <span class="muted small">5分 / 阈值${e.threshold}%</span>
          </div>
          ${e.ai ? `<div class="mon-ai">💡 ${esc(e.ai)}</div>` : `<div class="mon-ai muted">AI 解读生成中…</div>`}
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
        ${n.symbol ? `<span class="note-sym">${esc(n.symbol)}</span>` : ""}
        ${n.tags ? `<span class="note-tag">#${esc(n.tags)}</span>` : ""}
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

/* ---------- AI 复盘分析（对话存档 + 心得，按时间段/品种筛选） ---------- */

function rvDateStr(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function rvRangeDates() {
  const mode = $("rvRange").value;
  if (mode === "all") return { since: "", until: "" };
  if (mode === "custom") {
    return { since: $("rvFrom").value || "", until: $("rvTo").value || "" };
  }
  const n = parseInt(mode, 10);
  const until = new Date();
  const since = new Date(Date.now() - (n - 1) * 86400000);
  return { since: rvDateStr(since.getTime()), until: rvDateStr(until.getTime()) };
}

function rvSymFilters() {
  return [...new Set($("rvSymbols").value.split(/[,，\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

function rvMatchSym(target, filters, content) {
  if (!filters.length) return true;
  if (target) return filters.some((f) => target === f || target.startsWith(f) || f.startsWith(target));
  return filters.some((f) => (content || "").includes(f) || (content || "").includes(f.replace(/0$/, "")));
}

function rvCollect() {
  const { since, until } = rvRangeDates();
  const filters = rvSymFilters();
  const inRange = (d) => (!since || d >= since) && (!until || d <= until);
  const chats = [];
  const notes = [];
  if ($("rvChats").checked) {
    for (const m of state.chat) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const d = m.ts ? rvDateStr(m.ts) : "";
      // 旧存档无时间戳：仅在"全部时间"档纳入
      if (d ? !inRange(d) : (since || until)) continue;
      if (!rvMatchSym(m.sym, filters, m.content)) continue;
      chats.push({ role: m.role, content: m.content, ts: m.ts, sym: m.sym || "" });
    }
  }
  if ($("rvNotes").checked) {
    for (const n of notesState.items) {
      if (!inRange(n.date || "")) continue;
      if (!rvMatchSym(n.symbol, filters, n.title + " " + n.content)) continue;
      notes.push({ date: n.date, title: n.title, symbol: n.symbol || "", tags: n.tags || "", content: n.content });
    }
  }
  return { since, until, filters, chats, notes };
}

function rvUpdateStat() {
  const { since, until, filters, chats, notes } = rvCollect();
  const anySrc = $("rvChats").checked || $("rvNotes").checked;
  const rangeTxt = since || until ? `${since || "…"} ~ ${until || "…"}` : "全部时间";
  $("rvStat").textContent = anySrc
    ? `范围：${rangeTxt} · 品种：${filters.join("、") || "全部"} → 命中 AI 对话 ${chats.length} 条、心得 ${notes.length} 条${(!chats.length && !notes.length) ? "（无记录，请放宽条件）" : ""}`
    : "请至少选择一个数据源";
}

let rvLast = null;  // 最近一次生成的报告（存飞书用）

async function runAiReview() {
  const { since, until, filters, chats, notes } = rvCollect();
  if (!chats.length && !notes.length) {
    toast("所选范围内没有可分析的记录", true);
    return;
  }
  const btn = $("btnReviewRun");
  btn.disabled = true;
  $("rvStatus").textContent = "分析中，约 0.5~2 分钟…";
  $("reviewOut").classList.add("hidden");
  $("btnReviewSave").classList.add("hidden");
  try {
    const d = await api("/api/ai/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chats, notes, symbols: filters, since, until }),
    });
    $("reviewOut").innerHTML = renderMarkdown(d.report || "");
    $("reviewOut").classList.remove("hidden");
    $("rvStatus").textContent = `已生成（对话 ${d.stats.chats} 条 + 心得 ${d.stats.notes} 条）`;
    rvLast = { report: d.report || "", since, until, symbols: filters, stats: d.stats };
    $("btnReviewSave").classList.remove("hidden");
  } catch (e) {
    $("rvStatus").textContent = "";
    toast(`复盘生成失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
}

$("btnReviewSave").addEventListener("click", async () => {
  if (!rvLast) return;
  const btn = $("btnReviewSave");
  btn.disabled = true;
  try {
    await api("/api/ai/review-save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rvLast),
    });
    toast("已存入飞书《AI 复盘报告》");
  } catch (e) {
    toast(`存飞书失败：${e.message}`, true);
  } finally {
    btn.disabled = false;
  }
});

function openReviewModal() {
  if (!notesState.items.length) loadNotes();
  // 品种候选：心得中出现过的 + 当前自选 + 国际盘
  const syms = new Set([
    ...notesState.items.map((n) => n.symbol).filter(Boolean),
    ...state.watchlist,
    ...INTL_SYMBOLS,
  ]);
  $("rvSymbolList").innerHTML = [...syms].map((s) => `<option value="${esc(s)}">`).join("");
  $("reviewOut").classList.add("hidden");
  $("btnReviewSave").classList.add("hidden");
  $("rvStatus").textContent = "";
  $("reviewModal").classList.remove("hidden");
  rvUpdateStat();
}

$("btnAiReview").addEventListener("click", openReviewModal);
$("btnCloseReview").addEventListener("click", () => $("reviewModal").classList.add("hidden"));
$("btnReviewRun").addEventListener("click", runAiReview);
["rvChats", "rvNotes", "rvRange", "rvFrom", "rvTo"].forEach((id) =>
  $(id).addEventListener("change", () => {
    $("rvFrom").classList.toggle("hidden", $("rvRange").value !== "custom");
    $("rvTo").classList.toggle("hidden", $("rvRange").value !== "custom");
    rvUpdateStat();
  })
);
$("rvSymbols").addEventListener("input", rvUpdateStat);
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

const newsState = { seen: new Set(), loaded: false, items: [] };

function highlightKeywords(text, group) {
  let html = esc(text);
  const kws = group === "trump"
    ? ["特朗普", "白宫", "关税", "贝森特", "美国财政部"]
    : ["伊朗", "以色列", "空袭", "霍尔木兹", "停火", "中东", "红海", "胡塞", "加沙", "哈马斯", "导弹", "OPEC", "欧佩克", "沙特"];
  for (const kw of kws) {
    try {
      html = html.replace(new RegExp(`(${kw})`, "gi"), "<mark>$1</mark>");
    } catch (e) { /* 忽略非法正则 */ }
  }
  return html;
}

async function loadIntl() {
  try {
    const d = await api("/api/intl");
    $("intlTime").textContent = "行情时间 " + (d.items[0]?.time || "--");
    $("intlCards").innerHTML = d.items.map((it) => {
      const pct = it.chg_pct;
      const cls = pct > 0 ? "up" : pct < 0 ? "down" : "";
      return `<div class="intl-card">
        <div class="intl-name">${esc(it.name)}</div>
        <div class="intl-last ${cls}">${it.last ?? "--"}</div>
        <div class="intl-chg ${cls}">${pct != null ? (pct > 0 ? "+" : "") + pct + "%" : "--"}</div>
        <div class="muted small">高 ${it.high ?? "--"} / 低 ${it.low ?? "--"}</div>
      </div>`;
    }).join("");
  } catch (e) {
    $("intlCards").innerHTML = `<div class="muted small">国际盘数据加载失败：${e.message}</div>`;
  }
}

function renderNewsView() {
  const list = $("newsList");
  if (!list) return;
  if (!newsState.items.length) {
    list.innerHTML = `<div class="muted small monitor-hint">暂无特朗普/中东相关要闻（每 2 分钟扫描一次快讯流）</div>`;
    return;
  }
  list.innerHTML = newsState.items
    .map((it) => {
      const isTrump = (it.groups || []).includes("trump");
      const hm = it.time ? it.time.slice(11, 16) : "";
      const day = it.time ? it.time.slice(5, 10) : "";
      const tag = isTrump ? '<span class="news-aitag">🇺🇸 特朗普</span>' : '<span class="news-aitag">🌍 中东</span>';
      // 外链仅放行 http(s)，防 javascript: 等协议注入
      const safeLink = /^https?:\/\//i.test(it.link || "") ? it.link : "";
      const body = safeLink
        ? `<a href="${esc(safeLink)}" target="_blank" rel="noopener">${highlightKeywords(it.title, isTrump ? "trump" : "mideast")}</a>`
        : `<span>${highlightKeywords(it.title, isTrump ? "trump" : "mideast")}</span>`;
      return `<div class="news-item matched">
        <span class="news-time">${day} ${hm}</span>${tag} ${body}<span class="news-src">${esc(it.source)}</span>
      </div>`;
    })
    .join("");
}

async function pollNews() {
  try {
    const d = await api("/api/news");
    const fresh = d.items || [];
    if (newsState.loaded) {
      for (const it of fresh.slice(0, 10)) {
        if (!newsState.seen.has(it.title)) {
          const tag = (it.groups || []).includes("trump") ? "🇺🇸" : "🌍";
          toast(`${tag} ${it.title.slice(0, 46)}${it.title.length > 46 ? "…" : ""}`);
        }
      }
    }
    newsState.seen = new Set(fresh.map((it) => it.title));
    newsState.items = fresh;
    newsState.loaded = true;
    renderNewsView();
  } catch (e) { /* 快讯轮询失败静默 */ }
}

setInterval(() => {
  if (currentView() === "news") loadIntl();  // 停留监控页时每 5 秒跟随主轮询刷新报价
}, 5000);

/* ---------- 命令面板 Ctrl+K（上游 14ce111 整合，适配本地视图） ---------- */

const CMDK_COMMANDS = [
  { key: "工作台", desc: "视图", run: () => switchView("work") },
  { key: "详情", desc: "视图", run: () => switchView("detail") },
  { key: "国际盘", desc: "WTI/布伦特/黄金/美元指数", run: () => switchView("news") },
  { key: "纪律", desc: "开仓检查/交易记录", run: () => switchView("discipline") },
  { key: "心得", desc: "视图", run: () => switchView("notes") },
  { key: "晨报", desc: "生成/查看 AI 简报", run: () => $("btnReport").click() },
  { key: "皮肤", desc: "切换界面皮肤", run: () => $("btnTheme").click() },
  { key: "设置", desc: "AI/飞书/盯盘配置", run: () => $("btnSettings").click() },
];

const cmdkState = { hits: [], index: -1 };

function cmdkRender() {
  const q = $("cmdkInput").value.trim().toLowerCase();
  let hits = [];
  if (!q) {
    hits = CMDK_COMMANDS.slice(0, 6).map((c) => ({ type: "cmd", ...c }));
  } else {
    const cmds = CMDK_COMMANDS.filter((c) => c.key.toLowerCase().includes(q) || (c.desc || "").includes(q))
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
        <span>${h.type === "sym" ? `<b>${h.key}</b> ${esc(h.desc)}` : h.key}</span>
        <span class="desc">${h.type === "sym" ? "合约 →" : h.desc}</span>
      </div>`).join("")
    : `<div class="cmdk-item muted">无匹配</div>`;
}

function cmdkRun(i) {
  const h = cmdkState.hits[i];
  if (!h) return;
  cmdkClose();
  if (h.type === "sym") {
    if (!state.watchlist.includes(h.sym)) {
      state.watchlist.push(h.sym);
      saveWatchlist();
      doRefresh();
    }
    selectSymbol(h.sym);
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

/* ---------- 标签页标题实时价格（多标签盯盘） ---------- */

function setDocTitle() {
  const q = state.selected && state.quotes[state.selected];
  if (q && q.last != null && !titleFlashTimer) {
    const pct = q.change_pct;
    document.title = `${state.selected} ${q.last} ${pct != null ? (pct >= 0 ? "↑" : "↓") + Math.abs(pct).toFixed(2) + "%" : ""} | 期货助手`;
  }
}

/* ---------- 顶级视图路由（标签切换界面） ---------- */

const VIEW_ORDER = ["work", "detail", "news", "discipline", "notes"];

function currentView() {
  const el = document.querySelector(".view:not(.hidden)");
  return el ? el.dataset.view : "work";
}

function syncDetailSymSelect() {
  const sel = $("detailSym");
  if (sel && sel.value !== (state.selected || "")) sel.value = state.selected || "";
}

function fillDetailSymOptions() {
  const sel = $("detailSym");
  if (!sel) return;
  const intlOpts = INTL_SYMBOLS.map((s) => `<option value="${s}">${s} ${_INTL_NAMES[s]}（24H）</option>`).join("");
  const opts = state.candidates.length
    ? state.candidates.map((c) => `<option value="${c.symbol}">${c.symbol} ${c.name}</option>`).join("")
    : state.watchlist.map((s) => `<option value="${s}">${s}</option>`).join("");
  sel.innerHTML = `<optgroup label="国内期货">${opts}</optgroup><optgroup label="国际盘 24H">${intlOpts}</optgroup>`;
  if (INTL_SYMBOLS.includes(state.selected)) sel.value = state.selected;
}

function switchView(name) {
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  // 只更新 view 参数，保留 annot_test/selftest 等其它参数（上游修复整合）
  const params = new URLSearchParams(location.search);
  if (name === "work") params.delete("view"); else params.set("view", name);
  const qs = params.toString();
  history.replaceState(null, "", location.pathname + (qs ? `?${qs}` : ""));
  // 进入视图时按需初始化；图表按切换后的实际宽度重绘（隐藏容器 clientWidth=0 不能绘图）
  if (name === "detail") {
    fillDetailSymOptions();
    renderQuoteArea();
    renderAnalysisArea();
    renderSignalArea();
  }
  if (name === "discipline") initDisciplinePage();
  if (name === "notes") {
    if (!notesState.items.length) loadNotes();
    prefillNoteSymbol();
    const d = $("noteDate");
    if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
  }
  if (name === "news") { if (!newsState.loaded) pollNews(); loadIntl(); }
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// 快捷键：Alt+1..5 切换视图
document.addEventListener("keydown", (e) => {
  if (e.altKey && /^[1-5]$/.test(e.key)) {
    switchView(VIEW_ORDER[Number(e.key) - 1]);
    e.preventDefault();
  }
});

// 详情视图顶部合约选择
$("detailSym").addEventListener("change", (e) => {
  if (e.target.value) selectSymbol(e.target.value);
});

/* ---------- 交易纪律（开仓前检查 · 规则引擎） ---------- */

const dcState = { inited: false, lastResult: null };

function fillDcSymbolOptions() {
  const sel = $("dcSymbol");
  if (!sel) return;
  const intlOpts = INTL_SYMBOLS.map((s) => `<option value="${s}">${s} ${_INTL_NAMES[s]}（24H）</option>`).join("");
  const opts = state.candidates.length
    ? state.candidates.map((c) => `<option value="${c.symbol}">${c.symbol} ${c.name}</option>`).join("")
    : state.watchlist.map((s) => `<option value="${s}">${s}</option>`).join("");
  const prev = sel.value || state.selected || state.watchlist[0] || "RB0";
  sel.innerHTML = `<optgroup label="国内期货">${opts}</optgroup><optgroup label="国际盘 24H">${intlOpts}</optgroup>`;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

async function initDisciplinePage() {
  if (!dcState.inited) {
    fillDcSymbolOptions();
    dcState.inited = true;
  } else {
    fillDcSymbolOptions();  // 候选可能已更新
  }
  updateDcLast();
  loadDcConfig();
  loadDcLog();
}

/* 品种现价显示（优先用实时轮询缓存，非自选品种按需拉一次）+ 一键填入入场价 */
function updateDcLast() {
  const sym = $("dcSymbol").value;
  const el = $("dcLast");
  const q = state.quotes[sym];
  if (q && q.last != null) {
    el.textContent = `现价 ${q.last}`;
    el.dataset.last = q.last;
    return;
  }
  if (!sym) return;
  el.textContent = "现价 …";
  api(`/api/watchlist?symbols=${sym}`)
    .then((d) => {
      const it = d.items && d.items[0];
      if (it && it.last != null && $("dcSymbol").value === sym) {
        el.textContent = `现价 ${it.last}`;
        el.dataset.last = it.last;
      } else {
        el.textContent = "现价 --";
      }
    })
    .catch(() => { el.textContent = "现价 --"; });
}

$("dcSymbol").addEventListener("change", updateDcLast);
$("btnDcLast").addEventListener("click", () => {
  const last = $("dcLast").dataset.last;
  if (last) {
    $("dcEntry").value = last;
    toast(`已填入现价 ${last}`);
  } else {
    toast("现价未获取到，请稍后再试", true);
  }
});

async function loadDcConfig() {
  try {
    const d = await api("/api/discipline/config");
    const c = d.discipline;
    $("dcRisk").value = c.risk_per_trade;
    $("dcStop").value = c.daily_stop;
    $("dcWeekMax").value = c.weekly_max_trades;
    $("dcDayMax").value = c.daily_max_trades;
    $("dcSpacing").value = c.min_grid_spacing;
    $("dcAccount").value = c.account_size || "";
    $("dcMaxAdds").value = c.max_adds;
    $("dcRr").value = c.min_rr;
    $("dcCool").value = c.cooling_min;
    $("dcUniverse").value = (c.universe || []).join(",");
  } catch (e) {
    toast(`风控参数加载失败：${e.message}`, true);
  }
}

$("btnDcSave").addEventListener("click", async () => {
  try {
    await api("/api/discipline/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        account_size: parseFloat($("dcAccount").value) || 0,
        risk_per_trade: parseFloat($("dcRisk").value) || 1,
        daily_stop: parseFloat($("dcStop").value) || 3,
        weekly_max_trades: parseInt($("dcWeekMax").value) || 5,
        daily_max_trades: parseInt($("dcDayMax").value) || 3,
        min_grid_spacing: parseFloat($("dcSpacing").value) || 1.5,
        max_adds: parseInt($("dcMaxAdds").value) || 2,
        min_rr: parseFloat($("dcRr").value) || 2,
        cooling_min: parseInt($("dcCool").value) || 30,
        universe: $("dcUniverse").value.split(",").map((s) => s.trim()).filter(Boolean),
      }),
    });
    toast("风控参数已保存");
  } catch (e) {
    toast(`保存失败：${e.message}`, true);
  }
});

const MOOD_LABEL = { calm: "😌冷静", hesitant: "🤔犹豫", fomo: "🔥FOMO", revenge: "😡报复" };

function renderDcStats(s) {
  const moods = Object.entries(s.mood_stat || {})
    .filter(([m, v]) => v.total >= 2 && v.rejected > 0)
    .map(([m, v]) => `${MOOD_LABEL[m] || m} ${v.rejected}/${v.total} 被拦`)
    .join(" · ");
  const p = s.perf;
  let perfLine = "";
  if (p && p.closed_count > 0) {
    const wr = p.win_rate == null ? "--" : p.win_rate + "%";
    const rt = p.realized_total == null ? "--" :
      `<span class="${p.realized_total > 0 ? "up" : p.realized_total < 0 ? "down" : ""}">${p.realized_total > 0 ? "+" : ""}${p.realized_total}%</span>`;
    const aw = p.avg_win == null ? "--" : "+" + p.avg_win + "%";
    const al = p.avg_loss == null ? "--" : p.avg_loss + "%";
    const ml = p.max_loss == null ? "--" : p.max_loss + "%";
    const ar = p.avg_r == null ? "" : ` · 均R <b>${p.avg_r > 0 ? "+" : ""}${p.avg_r}</b>`;
    perfLine = `<br>📊 已平 ${p.closed_count} 笔 · 胜率 <b>${wr}</b> · 累计 ${rt} · 均盈 ${aw} / 均亏 ${al} · 最大单笔亏 <b class="down">${ml}</b>${ar}`;
  }
  // AI 评审价值：认可交易的实际表现 + 否决申请的反事实验证
  let aiLine = "";
  if (p && p.ai_approved && p.ai_approved.count > 0) {
    const a = p.ai_approved;
    aiLine += `<br>🤖 AI 认可且已平 ${a.count} 笔：胜率 <b>${a.win_rate ?? "--"}%</b> · 均盈亏 <b>${a.avg_pnl > 0 ? "+" : ""}${a.avg_pnl ?? "--"}%</b>`;
  }
  if (p && p.ai_rejected_hypothetical && p.ai_rejected_hypothetical.count > 0) {
    const h = p.ai_rejected_hypothetical;
    const good = h.avg_points < 0;
    aiLine += `<br>🛡 AI 否决的 ${h.count} 笔若执行：均 <span class="${good ? "down" : "up"}">${h.avg_points > 0 ? "+" : ""}${h.avg_points} 点</span>${good ? "（拦得值，避免了亏损）" : "（⚠ 反事实验证不利，AI 可能拦错了方向）"}`;
  }
  $("dcStats").innerHTML =
    `🔥 连续纪律 <b>${s.discipline_streak ?? 0}</b> 天 · ` +
    `今日 <b>${s.today_trades}</b> 笔 · 本周 <b>${s.week_trades}</b> 笔 · ` +
    `今日盈亏 <b class="${s.today_pnl > 0 ? "up" : s.today_pnl < 0 ? "down" : ""}">${s.today_pnl > 0 ? "+" : ""}${s.today_pnl}%</b> · ` +
    `持仓 <b>${s.open_count}</b> 笔` +
    (Object.keys(s.open_adds).length ? `（加仓：${Object.entries(s.open_adds).map(([k, v]) => `${k.replace(":", " ")}×${v}`).join("、")}）` : "") +
    perfLine + aiLine +
    (moods ? `<br>⚠️ 情绪画像：${moods}——这些状态下你最容易违反纪律` : "");
}

const dcLogState = { filter: "all", items: [] };

async function loadDcLog() {
  try {
    const d = await api("/api/discipline/log");
    dcLogState.items = d.items;
    renderDcStats(d.stats);
    renderDcLogBody();
  } catch (e) {
    $("dcStats").textContent = `日志加载失败：${e.message}`;
  }
}

function renderDcLogBody() {
  const body = $("dcLogBody");
  const f = dcLogState.filter;
  const items = dcLogState.items.filter((e) =>
    f === "all" ? true : e.status === f
  );
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="14" class="muted small" style="text-align:center;padding:14px">${
      dcLogState.items.length ? "当前筛选无记录" : "还没有交易申请记录"
    }</td></tr>`;
    return;
  }
  body.innerHTML = items.slice().reverse().map((e) => {
    const pnl = e.pnl_pct;
    const pnlTxt = pnl == null ? "--" :
      `<span class="${pnl > 0 ? "up" : pnl < 0 ? "down" : ""}">${pnl > 0 ? "+" : ""}${pnl}%</span>`;
    const status = e.status === "open" ? "持仓中" : e.status === "rejected" ? "已拒绝" : "已平仓";
    // 持仓中：用页面已有的实时行情算浮动点数
    let floatTxt = "--";
    if (e.status === "open" && e.allowed) {
      const last = state.quotes[e.symbol] && state.quotes[e.symbol].last;
      if (last != null) {
        const diff = e.side === "long" ? last - e.entry : e.entry - last;
        floatTxt = `<span class="${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff > 0 ? "+" : ""}${diff.toFixed(1)} 点</span>`;
      }
    }
    const rTxt = e.r_multiple == null ? "--" :
      `<span class="${e.r_multiple > 0 ? "up" : "down"}">${e.r_multiple > 0 ? "+" : ""}${e.r_multiple}R</span>`;
    const actions = [
      e.status === "open" ? `<button class="btn small-btn" data-settle="${e.ts}">平仓</button>` : "",
      e.status === "open" ? `<button class="btn small-btn" data-holdrev="${e.ts}" title="AI 持仓体检：这笔仓还该拿着吗">🩺</button>` : "",
      e.status === "closed" ? `<button class="btn small-btn" data-settle="${e.ts}" title="修改盈亏与出场价">改</button>` : "",
      e.status === "closed" ? `<button class="btn small-btn" data-traderev="${e.ts}" title="AI 单笔复盘：计划 vs 实际">复盘</button>` : "",
      `<button class="btn small-btn dc-del" data-del="${e.ts}" title="删除这条记录">✕</button>`,
    ].filter(Boolean).join(" ");
    const note = (e.note || "").replace(/"/g, "&quot;");
    const reviewTip = e.holding_review
      ? `\n[AI体检 ${e.holding_review.action}] ${e.holding_review.assessment}`
      : "";
    const tradeTip = e.review ? `\n[AI复盘 ${e.review.execution_grade || ""}] ${e.review.summary}` : "";
    const tip = (note + reviewTip + tradeTip).replace(/"/g, "&quot;");
    return `<tr>
      <td>${(e.ts || "").slice(5, 16).replace("T", " ")}</td>
      <td>${e.symbol}</td>
      <td>${e.side === "long" ? '<span class="up">多</span>' : '<span class="down">空</span>'}${e.is_add ? " 加" : ""}</td>
      <td>${e.entry ?? "--"}</td>
      <td>${e.sl ?? "--"}</td>
      <td>${e.rr ?? "--"}</td>
      <td>${rTxt}</td>
      <td>${e.allowed ? '<span class="up">✅</span>' : '<span class="down">⛔</span>'}</td>
      <td>${MOOD_LABEL[e.mood] || "--"}</td>
      <td>${floatTxt}</td>
      <td>${status}</td>
      <td>${pnlTxt}</td>
      <td title="${note}">${note ? "📝" : "--"}</td>
      <td>${actions}</td>
    </tr>`;
  }).join("");
  body.querySelectorAll("[data-settle]").forEach((btn) => {
    btn.addEventListener("click", () => settleDcTrade(btn.dataset.settle, btn.textContent === "平仓"));
  });
  body.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", () => deleteDcEntry(btn.dataset.del));
  });
  body.querySelectorAll("[data-holdrev]").forEach((btn) => {
    btn.addEventListener("click", () => dcHoldingReview(btn.dataset.holdrev));
  });
  body.querySelectorAll("[data-traderev]").forEach((btn) => {
    btn.addEventListener("click", () => dcTradeReview(btn.dataset.traderev));
  });
}

// 筛选切换
document.querySelectorAll(".dc-filter").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".dc-filter").forEach((b) => b.classList.toggle("active", b === btn));
    dcLogState.filter = btn.dataset.f;
    renderDcLogBody();
  });
});

async function deleteDcEntry(ts) {
  if (!confirm("确定删除这条记录？（不可恢复）")) return;
  try {
    await api("/api/discipline/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts }),
    });
    toast("已删除");
    loadDcLog();
  } catch (e) {
    toast(`删除失败：${e.message}`, true);
  }
}

/* 持仓 AI 体检 / 平仓 AI 复盘：结果在周报区显示（约 0.5~2 分钟） */
function showDcAiBox(loading, html) {
  const box = $("dcWeeklyBox");
  box.classList.remove("hidden");
  box.innerHTML = loading
    ? `<div class="muted small" style="padding:8px 0">${loading}</div>`
    : html;
}

async function dcHoldingReview(ts) {
  showDcAiBox("🩺 AI 持仓体检中（原计划 vs 当前行情，约 0.5~2 分钟）…", null);
  try {
    const d = await api("/api/discipline/holding-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts }),
    });
    const r = d.review;
    const actMap = { continue: ["✅ 继续持有", "up"], reduce: ["⚠️ 建议减仓", "warn"], exit: ["⛔ 建议离场", "down"] };
    const [actTxt, cls] = actMap[r.action] || ["未知", "warn"];
    showDcAiBox(false, `<div class="dc-aireview">
      <b>🩺 持仓体检：${actTxt}</b>（现价 ${r.last ?? "--"}，浮动 ${r.floating > 0 ? "+" : ""}${r.floating ?? "--"} 点）
      <div style="margin-top:4px">${esc(r.assessment)}</div>
      <div class="muted small" style="margin-top:4px">执行偏差：${esc(r.deviation) || "--"}</div>
      <div class="muted small">生死价位：${esc(r.key_levels) || "--"}${r.suggested_sl != null ? ` ｜ 建议止损：${r.suggested_sl}` : ""}</div>
    </div>`);
  } catch (e) {
    showDcAiBox(false, `<div class="msg error" style="margin:6px 0">体检失败：${e.message}</div>`);
  }
}

async function dcTradeReview(ts) {
  showDcAiBox("📋 AI 单笔复盘中（计划 vs 实际对照，约 0.5~2 分钟）…", null);
  try {
    const d = await api("/api/discipline/trade-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ts }),
    });
    const r = d.review;
    showDcAiBox(false, `<div class="dc-aireview">
      <b>📋 单笔复盘：执行评级 ${r.execution_grade || "--"}（${r.plan_followed ? "按计划执行" : "偏离计划"}）｜ AI 当初判定：${r.ai_verdict_check || "--"}</b>
      <div style="margin-top:4px">${esc(r.summary)}</div>
      <div class="muted small" style="margin-top:4px">💡 ${esc(r.lesson)}</div>
    </div>`);
  } catch (e) {
    showDcAiBox(false, `<div class="msg error" style="margin:6px 0">复盘失败：${e.message}</div>`);
  }
}

// CSV 导出（含 BOM，Excel 打开中文不乱码）
$("btnDcCsv").addEventListener("click", () => {
  const rows = dcLogState.items;
  if (!rows.length) { toast("没有记录可导出", true); return; }
  const head = ["时间", "品种", "方向", "加仓", "入场", "止损", "目标", "计划盈亏比", "出场价", "实际R",
    "裁决", "违反项", "情绪", "状态", "盈亏%", "AI决策", "AI评估摘要", "理由"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [head.map(esc).join(",")].concat(rows.map((e) => [
    e.ts, e.symbol, e.side === "long" ? "多" : "空", e.is_add ? "是" : "",
    e.entry, e.sl, e.tp ?? "", e.rr ?? "", e.exit ?? "", e.r_multiple ?? "",
    e.allowed ? "允许" : "禁止", (e.violations || []).join(" "),
    MOOD_LABEL[e.mood] || e.mood,
    e.status === "open" ? "持仓中" : e.status === "rejected" ? "已拒绝" : "已平仓",
    e.pnl_pct ?? "",
    e.ai_review ? (e.ai_review.decision_correct ? "✅值得执行" : "⛔不值得执行") : "",
    e.ai_review ? e.ai_review.assessment || "" : "",
    e.note || "",
  ].map(esc).join(","))).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `交易纪律记录_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`已导出 ${rows.length} 条记录`);
});

async function settleDcTrade(ts, fresh = true) {
  const td = document.querySelector(`[data-settle="${ts}"]`)?.parentElement;
  if (!td) return;
  // 点击平仓/改 → 该格变行内输入（盈亏% 必填、出场价选填用于算实际 R）
  td.innerHTML = `<input type="number" step="0.1" class="dc-in-pnl" style="width:52px;padding:2px 4px;font-size:11px" placeholder="±%">
    <input type="number" step="any" class="dc-in-exit" style="width:60px;padding:2px 4px;font-size:11px" placeholder="出场价">
    <button class="btn small-btn dc-settle-ok">✓</button>`;
  const pnlInput = td.querySelector(".dc-in-pnl");
  const exitInput = td.querySelector(".dc-in-exit");
  const okBtn = td.querySelector(".dc-settle-ok");
  pnlInput.focus();
  const submit = async () => {
    const pnl = parseFloat(pnlInput.value);
    if (Number.isNaN(pnl)) { toast("盈亏%必填（亏为负，如 -0.8）", true); pnlInput.focus(); return; }
    const exit = parseFloat(exitInput.value) || null;
    okBtn.disabled = true;
    try {
      await api("/api/discipline/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ts, pnl_pct: pnl, exit }),
      });
      toast(fresh ? "已记录平仓" : "已修改记录");
      loadDcLog();
    } catch (e) {
      toast(`保存失败：${e.message}`, true);
      okBtn.disabled = false;
    }
  };
  okBtn.addEventListener("click", submit);
  for (const inp of [pnlInput, exitInput]) {
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") renderDcLogBody();  // 取消并恢复
    });
  }
}

/* 纪律周报：近 7 天日志统计交给 AI 生成复盘（行为闭环的最后一环） */
$("btnDcWeekly").addEventListener("click", async () => {
  const box = $("dcWeeklyBox");
  const btn = $("btnDcWeekly");
  btn.disabled = true;
  box.classList.remove("hidden");
  box.innerHTML = `<div class="muted small" style="padding:8px 0">正在汇总近 7 天纪律日志并生成复盘周报…（约 0.5~2 分钟）</div>`;
  try {
    const d = await api("/api/discipline/log");
    const since = Date.now() - 7 * 86400000;
    const week = d.items.filter((e) => new Date(e.ts.replace("T", " ")).getTime() >= since);
    if (!week.length) {
      box.innerHTML = `<div class="muted small" style="padding:8px 0">近 7 天没有交易申请记录，先在纪律引擎里记录几笔再来生成周报。</div>`;
      return;
    }
    const lines = week.map((e) =>
      `${e.ts.slice(5, 16)} ${e.symbol} ${e.side === "long" ? "多" : "空"}${e.is_add ? "(加)" : ""} ` +
      `入场${e.entry} 止损${e.sl} ${e.allowed ? "✅允许" : `⛔禁止(${(e.violations || []).join(",")})`} ` +
      `情绪:${MOOD_LABEL[e.mood] || e.mood} 状态:${e.status === "open" ? "持仓" : e.status === "rejected" ? "被拒" : "已平"} ` +
      `盈亏:${e.pnl_pct == null ? "--" : e.pnl_pct + "%"} ` +
      `AI评审:${e.ai_review ? (e.ai_review.decision_correct ? "值得执行" : "不值得") + "（" + (e.ai_review.assessment || "") + "）" : "无"} ` +
      `理由:${e.note || "无"}`);
    const resp = await api("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{
          role: "user",
          content: `请基于我近 7 天的交易纪律日志（规则引擎的开仓申请与裁决记录），生成一份「纪律复盘周报」。要求：
1) 概览：申请次数、通过/拒绝数、被拦规则分布（哪条规则拦我最多，说明我的主要行为问题）；
2) 情绪分析：各情绪下的申请数与被拦率，指出我最危险的情绪状态；
3) 执行质量：已平仓交易的盈亏、盈亏与情绪/遵守情况的关系（样本少则明说不足）；
4) 下周改进：1~2 条可执行、可衡量的具体行为建议（不要空话）。
语气直接、不留情面，像教练复盘。用 Markdown，控制在 500 字内。
日志明细（时间 品种 方向 入场 止损 裁决 情绪 状态 盈亏 理由）：
${lines.join("\n")}`,
        }],
        symbol: null,
        light: 1,  // 周报分析历史日志，无需实时行情上下文（省 token）
      }),
    });
    box.innerHTML = `<div class="md" style="padding:4px 2px 8px;max-height:400px;overflow-y:auto;border-top:1px solid var(--border)">${renderMarkdown(resp.reply)}</div>`;
  } catch (e) {
    box.innerHTML = `<div class="msg error" style="margin:6px 0">周报生成失败：${e.message}</div>`;
  } finally {
    btn.disabled = false;
  }
});

$("btnDcCheck").addEventListener("click", async () => {
  const entry = parseFloat($("dcEntry").value);
  const sl = parseFloat($("dcSl").value);
  if (!$("dcSymbol").value || Number.isNaN(entry) || Number.isNaN(sl)) {
    toast("请先填写品种、入场价与止损价", true);
    return;
  }
  const btn = $("btnDcCheck");
  btn.disabled = true;
  btn.textContent = "检查中…";
  $("dcVerdict").className = "dc-verdict muted";
  const t0 = Date.now();
  $("dcVerdict").textContent = "① 客观规则判定中（行情/指标/次数）… 随后 ② AI 审查（约 0.5~2 分钟，请勿关闭页面）";
  const tick = setInterval(() => {
    if (!$("dcVerdict").isConnected) { clearInterval(tick); return; }
    if ($("dcVerdict").classList.contains("muted")) {
      $("dcVerdict").textContent = `① 客观规则判定中… 随后 ② AI 审查（已等待 ${Math.round((Date.now() - t0) / 1000)}s，AI 判定较慢属正常）`;
    }
  }, 5000);
  try {
    const d = await api("/api/discipline/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: $("dcSymbol").value,
        side: $("dcSide").value,
        entry, sl,
        tp: parseFloat($("dcTp").value) || null,
      }),
    });
    dcState.lastResult = d;
    renderDcVerdict(d);
    loadDcLog();
  } catch (e) {
    $("dcVerdict").className = "dc-verdict bad";
    $("dcVerdict").innerHTML = `检查失败：${e.message}<br><span class="muted small">AI 审查失败时不会放行——请稍后重试（主观项已全部由 AI 判定）</span>`;
  } finally {
    clearInterval(tick);
    btn.disabled = false;
    btn.textContent = "🛡 运行开仓检查（规则引擎 + AI 审查）";
  }
});

function renderDcVerdict(d) {
  const v = $("dcVerdict");
  v.className = "dc-verdict " + (d.allowed ? "ok" : "bad");
  const hint = d.position_hint
    ? `<div class="dc-poshint">📐 头寸建议（海龟 1N 法则）：${d.position_hint.basis}</div>`
    : "";
  const ai = d.ai_review;
  const e0 = d.log_entry || {};
  const planBlock = e0.note
    ? `<div class="dc-aireview"><b>📝 AI 生成的交易计划（许可单第 5 项）：</b>${esc(e0.note)}</div>`
    : "";
  const aiBlock = ai
    ? `<div class="dc-aireview"><b>🤖 AI 决策评估：${ai.decision_correct ? "✅ 计划值得执行" : "⛔ 计划不值得执行"}</b>（置信度 ${esc(ai.confidence) || "--"}）
        <div class="muted small" style="margin-top:4px">${esc(ai.assessment)}</div>
        <div class="muted small">反转确认：${ai.reversal_confirmed ? "✅ " + esc(ai.reversal_evidence) : "❌ " + (esc(ai.reversal_evidence) || "证据不足")} · 品种逻辑：${ai.knows_variety ? "✅" : "❌"} · 情绪推断：${MOOD_LABEL[e0.mood] || e0.mood || "--"} · 冲动检测：${ai.impulse_detected ? "⚠ 检出冲动" : "✅ 未检出"}</div></div>`
    : "";
  v.innerHTML = (d.allowed
    ? `✅ <b>允许开仓</b>${d.warn_count ? `（${d.warn_count} 项严重警告，注意风险）` : "（14 项检查全部通过或仅警告）"}`
    : `⛔ <b>禁止开仓</b>（${d.fatal_count} 项致命违反：<b>${d.rules.filter((r) => r.status === "violation" && r.severity === "致命").map((r) => r.id).join("、")}</b>）`)
    + hint + planBlock + aiBlock;
  $("dcRules").innerHTML = d.rules.map((r) => {
    const icon = r.status === "pass" ? "✅" : (r.severity === "致命" ? "⛔" : "⚠️");
    return `<div class="dc-rule ${r.status}">
      <span class="dc-rule-icon">${icon}</span>
      <div><b>${r.id} ${r.name}</b> <span class="dc-sev sev-${r.severity === "致命" ? "fatal" : "warn"}">${r.severity}</span>
        <div class="muted small">${r.detail}</div></div>
    </div>`;
  }).join("");
}

/* ---------- AI 对话历史（本地存档查看 + 飞书导出；上游整合） ---------- */
let chatHistShown = false;

function renderChatHistoryBox() {
  const box = $("chatHistoryBox");
  const msgs = (state.chat || []).filter((m) => m.role === "user" || m.role === "assistant").slice(-40);
  if (!msgs.length) {
    box.innerHTML = `<div class="muted small monitor-hint">暂无对话历史。工作台的 AI 对话会自动存档到本地，也可导出飞书。</div>`;
    return;
  }
  const fmtTs = (ts) => ts
    ? new Date(ts).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  const items = msgs.map((m, i) => `
    <div class="chat-hist-item">
      <span class="chat-hist-role ${m.role}">${m.role === "user" ? "我" : "AI"}</span>
      <span class="muted small" style="white-space:nowrap">${esc([fmtTs(m.ts), m.sym].filter(Boolean).join(" · "))}</span>
      <div class="chat-hist-text">${esc(m.content.slice(0, 300))}${m.content.length > 300 ? "…" : ""}</div>
      <button class="btn small-btn" data-copy="${i}" title="复制全文">📋</button>
    </div>`).join("");
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 14px">
      <span class="muted small">最近 ${msgs.length} 条（本地存档，刷新不丢）</span>
      <span>
        <button id="btnChatExport" class="btn accent small-btn">☁ 导出飞书</button>
        <button id="btnChatClear" class="btn small-btn">🗑 清空</button>
      </span>
    </div>
    <div class="chat-hist-list">${items}</div>`;
  box.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(msgs[Number(btn.dataset.copy)].content)
        .then(() => toast("已复制"))
        .catch(() => toast("复制失败", true));
    });
  });
  $("btnChatClear").addEventListener("click", () => {
    if (!confirm("清空全部对话历史（本地存档）？")) return;
    localStorage.removeItem("fa_chat_history");
    toast("已清空，刷新后工作台对话不再恢复");
    renderChatHistoryBox();
  });
  $("btnChatExport").addEventListener("click", async () => {
    const text = msgs.map((m) => {
      const meta = [fmtTs(m.ts), m.sym].filter(Boolean).join(" · ");
      return `【${m.role === "user" ? "我" : "AI"}${meta ? "｜" + meta : ""}】\n${m.content}`;
    }).join("\n\n---\n\n");
    try {
      await api("/api/chat-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: `【AI 对话导出 ${new Date().toLocaleString("zh-CN")}】\n\n${text}`, title: "AI 对话记录" }),
      });
      toast("已导出到飞书《AI 对话记录》");
    } catch (e) {
      toast(`导出失败：${e.message}`, true);
    }
  });
}

$("btnChatHist").addEventListener("click", () => {
  chatHistShown = !chatHistShown;
  $("chatHistoryBox").classList.toggle("hidden", !chatHistShown);
  if (chatHistShown) renderChatHistoryBox();
});

/* ---------- AI 晨报 ---------- */

let reportTimer = null;

async function pollReport(force = 0) {
  try {
    const d = await api(`/api/report${force ? "?force=1" : ""}`);
    const body = $("reportBody");
    const timeEl = $("reportTime");
    if (d.status === "ready") {
      clearInterval(reportTimer);
      reportTimer = null;
      timeEl.textContent = new Date(d.ts).toLocaleString("zh-CN");
      body.innerHTML = `<div class="md">${renderMarkdown(d.report)}</div>`;
    } else if (d.status === "generating") {
      timeEl.textContent = "";
      body.innerHTML = `<div class="report-generating">
        <span class="typing-dots"><span></span><span></span><span></span></span>
        <div class="muted" style="margin-top:10px">AI 正在汇总要闻与自选品种数据生成简报，约 1~2 分钟…</div>
      </div>`;
      if (!reportTimer) reportTimer = setInterval(() => pollReport(), 8000);
    }
  } catch (e) {
    $("reportBody").innerHTML = `<div class="msg error">简报获取失败：${e.message}</div>`;
  }
}

$("btnReport").addEventListener("click", () => {
  $("reportModal").classList.remove("hidden");
  pollReport();
});
$("btnCloseReport").addEventListener("click", () => {
  $("reportModal").classList.add("hidden");
  if (reportTimer) { clearInterval(reportTimer); reportTimer = null; }
});
$("reportModal").addEventListener("click", (e) => {
  if (e.target === $("reportModal")) $("btnCloseReport").click();
});
$("btnReportRegen").addEventListener("click", () => pollReport(1));

/* ---------- 主力合约候选与拼音搜索 ---------- */

async function loadCandidates() {
  try {
    const data = await api("/api/main-list");
    state.candidates = data.items;
    data.items.forEach((it) => {
      state.names[it.symbol] = it.name || "";
    });
    renderTable();
    if (state.selected && state.quotes[state.selected]) renderQuoteArea();
    // 心得品种下拉候选
    const dl = $("noteSymbolList");
    if (dl) dl.innerHTML = data.items.map((c) => `<option value="${c.symbol}">${c.name}</option>`).join("");
    fillDetailSymOptions();  // 详情页合约下拉
    syncDetailSymSelect();
  } catch (e) {
    /* 候选列表失败不阻塞主流程 */
  }
}

function addFromCandidate(sym) {
  if (!sym) return;
  if (!state.watchlist.includes(sym)) {
    state.watchlist.push(sym);
    saveWatchlist();
    renderTable();
  }
  $("symbolInput").value = "";
  $("searchDrop").classList.add("hidden");
  state.dropIndex = -1;
  selectSymbol(sym);
  doRefresh();
}

function renderSearchDrop(keepIndex = false) {
  const drop = $("searchDrop");
  const q = $("symbolInput").value.trim().toLowerCase();
  if (!q) { drop.classList.add("hidden"); state.dropHits = []; return; }
  const hits = state.candidates.filter((c) =>
    c.symbol.toLowerCase().includes(q) ||
    (c.name || "").toLowerCase().includes(q) ||
    (c.py || "").startsWith(q) ||
    (c.pyf || "").includes(q)
  ).slice(0, 12);
  if (!hits.length) { drop.classList.add("hidden"); state.dropHits = []; return; }
  state.dropHits = hits;
  if (!keepIndex || state.dropIndex >= hits.length) state.dropIndex = hits.length === 1 ? 0 : -1;
  drop.innerHTML = hits.map((h, i) => `
    <div class="drop-item${i === state.dropIndex ? " hl" : ""}" data-sym="${h.symbol}">
      <b>${h.symbol}</b><span>${h.name}</span><span class="muted small">${h.exchange.toUpperCase()}</span>
    </div>`).join("");
  drop.classList.remove("hidden");
}

$("symbolInput").addEventListener("input", () => {
  state.dropIndex = -1;
  renderSearchDrop();
});

$("symbolInput").addEventListener("keydown", (e) => {
  const drop = $("searchDrop");
  const open = !drop.classList.contains("hidden");
  if (e.key === "ArrowDown" && open) {
    e.preventDefault();
    state.dropIndex = Math.min(state.dropIndex + 1, state.dropHits.length - 1);
    renderSearchDrop(true);
  } else if (e.key === "ArrowUp" && open) {
    e.preventDefault();
    state.dropIndex = Math.max(state.dropIndex - 1, 0);
    renderSearchDrop(true);
  } else if (e.key === "Enter") {
    if (open && state.dropIndex >= 0 && state.dropHits[state.dropIndex]) {
      addFromCandidate(state.dropHits[state.dropIndex].symbol);
    } else if (open && state.dropHits.length === 1) {
      addFromCandidate(state.dropHits[0].symbol);
    } else {
      addSymbol();
    }
  } else if (e.key === "Escape") {
    drop.classList.add("hidden");
  }
});

$("symbolInput").addEventListener("blur", () => {
  // 延迟关闭，让下拉项的 click 先触发
  setTimeout(() => $("searchDrop").classList.add("hidden"), 150);
});

$("searchDrop").addEventListener("click", (e) => {
  const item = e.target.closest(".drop-item");
  if (item) addFromCandidate(item.dataset.sym);
});

/* ---------- 实时解读：最新行情 → AI 盘中快评（手动 + 可选自动 15 分钟） ---------- */
const rtState = { loading: false, timer: null, sym: null, lastAutoPrice: null };

function rtTarget() {
  return state.selected || state.watchlist[0] || "RB0";
}

// token 优化：自动模式跳过条件——周末休市、或最新价与上次解读时完全一致（数据无变化）
function rtAutoSkip() {
  const day = new Date().getDay();
  if (day === 0 || day === 6) return "周末休市";
  const q = state.quotes[rtTarget()];
  if (q && q.last != null && q.last === rtState.lastAutoPrice) return "价格未变";
  return null;
}

async function loadRealtime(force = 0) {
  if (rtState.loading) return;
  const sym = rtTarget();
  if (!sym) return;
  rtState.loading = true;
  rtState.sym = sym;
  const btn = $("btnRealtime");
  btn.disabled = true;
  $("rtBox").classList.remove("hidden");
  if (force || !$("rtBox").dataset.loaded) {
    $("rtBox").innerHTML = `<div class="muted small" style="padding:6px 0">正在按此刻最新数据生成 ${sym} 盘中快评…（AI 生成约 0.5~1.5 分钟）</div>`;
  }
  try {
    const d = await api(`/api/ai/realtime?symbol=${sym}${force ? "&force=1" : ""}`);
    if (rtState.sym !== sym) return;  // 已切换合约，丢弃过期结果
    rtState.lastAutoPrice = d.last;   // 记录本次解读时的价格
    $("rtSym").textContent = `${d.symbol} ${d.name || ""} · ${d.last} · 生成于 ${d.generated_at}`;
    $("rtBox").dataset.loaded = "1";
    $("rtBox").innerHTML = `<div class="md">${renderMarkdown(d.analysis)}</div>`;
  } catch (e) {
    $("rtBox").innerHTML = `<div class="msg error" style="margin:4px 0">实时解读失败：${e.message}</div>`;
  } finally {
    rtState.loading = false;
    btn.disabled = false;
  }
}

$("btnRealtime").addEventListener("click", () => loadRealtime(1));

// 自动模式：每 15 分钟按当前选中合约刷新（休市/价格未变时自动跳过，零消耗）
function rtAutoTick() {
  if (currentView() !== "work") return;  // 仅工作台可见时刷新
  const skip = rtAutoSkip();
  if (skip) {
    $("rtSym").textContent = `自动解读待机（${skip}）`;
    return;
  }
  loadRealtime(1);
}
$("rtAuto").addEventListener("change", (e) => {
  localStorage.setItem("fa_rt_auto", e.target.checked ? "1" : "");
  if (e.target.checked) {
    loadRealtime(1);
    rtState.timer = setInterval(rtAutoTick, 15 * 60 * 1000);
  } else {
    clearInterval(rtState.timer);
    rtState.timer = null;
  }
});
if (localStorage.getItem("fa_rt_auto")) {
  $("rtAuto").checked = true;
  rtState.timer = setInterval(rtAutoTick, 15 * 60 * 1000);
}

/* ---------- AI 对话 ---------- */

/* 图片输入：📎 选择 / Ctrl+V 粘贴截图 / 拖拽；压缩后随消息发给视觉模型 */
const pendingImgs = [];  // {dataUrl, name}
const MAX_IMGS = 4;

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 缩到最大边 1120px（视觉模型按分辨率计 token，1120 已足够看清图表/K线）转 JPEG 控制体积
        const MAX_SIDE = 1120;
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        // PNG 透明截图转 JPEG 时铺白底，避免黑底
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("图片无法解析"));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

async function addImages(files) {
  const list = [...files].filter((f) => f.type.startsWith("image/"));
  if (!list.length) return;
  for (const f of list) {
    if (pendingImgs.length >= MAX_IMGS) {
      toast(`一次最多附 ${MAX_IMGS} 张图`, true);
      break;
    }
    try {
      const dataUrl = await compressImage(f);
      pendingImgs.push({ dataUrl, name: f.name || "截图" });
    } catch (e) {
      toast(`图片处理失败：${e.message}`, true);
    }
  }
  renderImgPreviews();
}

function removePendingImg(i) {
  pendingImgs.splice(i, 1);
  renderImgPreviews();
}

function renderImgPreviews() {
  const box = $("imgPreviews");
  if (!pendingImgs.length) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = pendingImgs
    .map((p, i) => `<div class="img-preview"><img src="${p.dataUrl}" title="${p.name}"><button class="img-remove" data-i="${i}" title="移除">✕</button></div>`)
    .join("");
  box.querySelectorAll(".img-remove").forEach((btn) => {
    btn.addEventListener("click", () => removePendingImg(Number(btn.dataset.i)));
  });
}

// 全局粘贴截图：截图后在页面任意位置 Ctrl+V 即可附图；
// 只有剪贴板含图片时才拦截，纯文本粘贴不受影响。
document.addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith("image/"));
  if (!items.length) return;
  e.preventDefault();
  addImages(items.map((it) => it.getAsFile()).filter(Boolean));
});

// 拖拽图片到输入行
const inputRow = $("chatInputRow");
["dragenter", "dragover"].forEach((ev) =>
  inputRow.addEventListener(ev, (e) => {
    e.preventDefault();
    inputRow.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((ev) =>
  inputRow.addEventListener(ev, (e) => {
    e.preventDefault();
    inputRow.classList.remove("drag-over");
  })
);
inputRow.addEventListener("drop", (e) => {
  if (e.dataTransfer?.files?.length) addImages(e.dataTransfer.files);
});

// 点击气泡中的图片放大查看
document.addEventListener("click", (e) => {
  const img = e.target.closest(".msg-imgs img");
  if (!img) return;
  const overlay = document.createElement("div");
  overlay.className = "img-lightbox";
  overlay.innerHTML = `<img src="${img.src}">`;
  overlay.addEventListener("click", () => overlay.remove());
  document.body.appendChild(overlay);
});

function pushMsg(role, content, cls, images) {
  // ts/sym 供「AI 复盘」按时间段/品种筛选（旧存档无此字段则仅在全部时间档纳入）
  state.chat.push({ role, content, images: images || undefined, ts: Date.now(), sym: state.selected || "" });
  // 对话自动存档（最近 60 条，含 AI 回复与错误提示不存；剥离 base64 图片防撑爆 localStorage 配额）
  try {
    const keep = state.chat.slice(-60);
    localStorage.setItem("fa_chat_history", JSON.stringify(
      keep.filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content, ts: m.ts, sym: m.sym || "" }))));
  } catch (e) { /* 存储满等异常不阻塞 */ }
  const box = $("chatBox");
  const div = document.createElement("div");
  div.className = `msg ${cls || role}`;
  const who = role === "user" ? "我" : "AI 助手";
  div.innerHTML = `<div class="who">${who}</div>`;
  if (role === "user" && images && images.length) {
    const wrap = document.createElement("div");
    wrap.className = "msg-imgs";
    wrap.innerHTML = images.map((u) => `<img src="${u}" loading="lazy">`).join("");
    div.appendChild(wrap);
  }
  if (content) {
    if (role === "assistant" && !cls) {
      const body = document.createElement("div");
      body.className = "md";
      body.innerHTML = renderMarkdown(content);
      div.appendChild(body);
    } else {
      div.appendChild(document.createTextNode(content));
    }
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function removeWelcome() {
  const w = document.querySelector(".chat-welcome");
  if (w) w.remove();
}

/* 全局错误可见化：任何脚本错误都显示出来，不静默失败 */
window.addEventListener("error", (e) => {
  toast(`脚本错误：${e.message || e.type}`, true);
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e.reason && e.reason.message) || String(e.reason);
  toast(`异步错误：${msg}`, true);
});

async function sendChat(text, opts = {}) {
  text = (text || "").trim();
  if (!text && !pendingImgs.length) return;
  const images = pendingImgs.map((p) => p.dataUrl);
  if (images.length && state.aiModel && !/vision|-v\d|4v|vl|vlm|image/i.test(state.aiModel)) {
    toast(`当前模型 ${state.aiModel} 可能不支持图片，建议在「⚙ AI 设置」改用视觉模型（如 deepseek-v4-flash-vision-exp）`, true);
  }
  try {
    removeWelcome();
    pushMsg("user", text, undefined, images.length ? images : undefined);
  } catch (e) {
    toast(`发送失败：${e.message}`, true);
    return;
  }
  $("chatInput").value = "";
  pendingImgs.length = 0;
  renderImgPreviews();

  const typing = document.createElement("div");
  typing.className = "msg assistant";
  typing.innerHTML = `AI 分析中<span class="typing-dots"><span></span><span></span><span></span></span><span class="typing-timer"></span>
    <div class="muted small" style="margin-top:4px">已附带实时行情、技术指标与信号上下文${images.length ? `及 ${images.length} 张图片（视觉模型）` : ""}。思维链模型完整分析约需 1~3 分钟，计时在走即正常等待中。</div>`;
  $("chatBox").appendChild(typing);
  $("chatBox").scrollTop = $("chatBox").scrollHeight;

  const t0 = Date.now();
  const timerEl = typing.querySelector(".typing-timer");
  const tick = setInterval(() => {
    if (!typing.isConnected) { clearInterval(tick); return; }
    timerEl.textContent = ` ${Math.round((Date.now() - t0) / 1000)}s`;
  }, 1000);

  let abortTimer = null;
  try {
    const ctrl = new AbortController();
    abortTimer = setTimeout(() => ctrl.abort(), 300000);  // 思维链模型长分析实测 2~3 分钟，须盖过后端 180s+续写轮次
    // token 优化：历史裁剪——最近 4 条完整，更早的截到 120 字；窗口 14 条
    const allMsgs = state.chat.filter((m) => m.role === "user" || m.role === "assistant");
    const msgs = allMsgs.slice(-14).map((m, i, arr) => {
      const keepFull = i >= arr.length - 4 || m.role === "user";
      return m.content && m.content.length > 120 && !keepFull
        ? { ...m, content: m.content.slice(0, 120) + "…（已截断）" }
        : m;
    });
    const data = await api("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: msgs,
        symbol: state.selected,
        light: opts.light ? 1 : 0,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(abortTimer);
    clearInterval(tick);
    if (data.fallback) toast("⚠ 主服务商限流/额度不足，本次由备用服务商兜底完成");
    typing.remove();
    pushMsg("assistant", data.reply);
  } catch (e) {
    if (abortTimer) clearTimeout(abortTimer);
    clearInterval(tick);
    typing.remove();
    const msg = e.name === "AbortError"
        ? "等待超时（超过 5 分钟），请稍后重试或换个更快的模型"
      : `${e.message}\n请检查 AI 设置中的 API Key 是否正确、是否有余额。`;
    pushMsg("error", `调用失败：${msg}`, "error");  // error 角色：不进存档/复盘语料/AI 上下文
  }
}

$("btnSend").addEventListener("click", () => sendChat($("chatInput").value));
$("chatInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendChat($("chatInput").value);
});
$("btnAnalyze").addEventListener("click", () => {
  if (!state.selected) {
    toast("请先在左侧选择一个合约", true);
    return;
  }
  sendChat(`请综合分析 ${state.selected}（${state.names[state.selected] || ""}），按系统设定权重组织（资金情绪与宏观消息面为主，技术面仅时机与价位参考）。输出：资金面结论、消息面影响、关键支撑压力位、综合观点（明确多空倾向与置信度）、主要风险；资金面与技术面矛盾时明确指出并以资金面为准。`);
});

/* ---------- AI 设置 ---------- */

async function loadAiConfig() {
  try {
    const cfg = await api("/api/ai/config");
    state.aiReady = cfg.has_key;
    state.aiModel = cfg.model || "";
    const badge = $("aiBadge");
    badge.textContent = cfg.has_key ? `${cfg.provider_label} · ${cfg.model}` : "未配置 API Key";
    badge.className = "ai-badge" + (cfg.has_key ? " ready" : "");
    $("cfgProvider").value = cfg.provider;
    $("cfgModel").value = cfg.model;
    $("cfgBaseUrl").value = cfg.custom_base_url || "";
    $("rowBaseUrl").classList.toggle("hidden", cfg.provider !== "custom");
    $("cfgStatus").textContent = cfg.has_key ? "已保存 Key，可直接使用" : "";
    if (cfg.keys_status) {
      $("keyStatus").textContent =
        `Key 状态 — 智谱：${cfg.keys_status.zhipu ? "✓ 已保存" : "✗ 未保存"}　DeepSeek：${cfg.keys_status.deepseek ? "✓ 已保存" : "✗ 未保存"}　自定义：${cfg.keys_status.custom ? "✓ 已保存" : "✗ 未保存"}`;
    }
    if (typeof cfg.feishu_configured !== "undefined") {
      $("feishuStatus").textContent = `飞书同步：${cfg.feishu_configured ? "✓ 已配置，心得可云端同步" : "未配置（不影响本地记录）"}`;
    }
  } catch (e) {
    $("aiBadge").textContent = "配置加载失败";
  }
  try {
    const mon = await api("/api/monitor/events?limit=1");
    $("cfgMonitor").value = mon.enabled ? "on" : "off";
    const sens = String(mon.sensitivity);
    $("cfgSens").value = ["0.5", "1", "2"].includes(sens) ? sens : "1";
  } catch (e) { /* 盯盘配置读取失败不影响其它 */ }
}

$("btnSettings").addEventListener("click", () => {
  $("settingsModal").classList.remove("hidden");
  loadAiConfig();
});
$("btnCloseSettings").addEventListener("click", () => $("settingsModal").classList.add("hidden"));
$("settingsModal").addEventListener("click", (e) => {
  if (e.target === $("settingsModal")) $("settingsModal").classList.add("hidden");
});

const DEFAULT_MODELS = { zhipu: "glm-4-flash", deepseek: "deepseek-flash", custom: "glm-5.3-flash" };
$("cfgProvider").addEventListener("change", () => {
  $("cfgModel").value = DEFAULT_MODELS[$("cfgProvider").value] || "";
  $("rowBaseUrl").classList.toggle("hidden", $("cfgProvider").value !== "custom");
});

$("btnSaveSettings").addEventListener("click", async () => {
  const body = {
    provider: $("cfgProvider").value,
    model: $("cfgModel").value.trim() || DEFAULT_MODELS[$("cfgProvider").value],
    api_key: $("cfgApiKey").value.trim(),
    custom_base_url: $("cfgBaseUrl").value.trim(),
  };
  try {
    await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await api("/api/monitor/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: $("cfgMonitor").value === "on",
        sensitivity: parseFloat($("cfgSens").value) || 1,
      }),
    });
    await api("/api/feishu/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: $("cfgFeishuId").value.trim(),
        app_secret: $("cfgFeishuSecret").value.trim(),
        doc_title: $("cfgFeishuTitle").value.trim() || "期货交易心得",
        webhook_url: $("cfgWebhook").value.trim(),
      }),
    });
    $("cfgWebhook").value = "";
    $("cfgFeishuId").value = "";
    $("cfgFeishuSecret").value = "";
    $("cfgApiKey").value = "";
    $("cfgStatus").textContent = "已保存 ✓";
    await loadAiConfig();
    pollMonitor();
    toast("AI 配置已保存");
  } catch (e) {
    $("cfgStatus").textContent = `保存失败：${e.message}`;
  }
});

$("btnPushTest").addEventListener("click", async () => {
  try {
    await api("/api/feishu/push-test", { method: "POST" });
    toast("测试消息已推送，请查看飞书群");
  } catch (e) {
    toast(`推送测试失败：${e.message}`, true);
  }
});

$("btnClearKey").addEventListener("click", async () => {
  try {
    await api("/api/ai/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: $("cfgProvider").value,
        model: $("cfgModel").value.trim(),
        clear_key: true,
      }),
    });
    $("cfgStatus").textContent = "已清除 Key";
    await loadAiConfig();
    toast("已清除保存的 API Key");
  } catch (e) {
    $("cfgStatus").textContent = `清除失败：${e.message}`;
  }
});

/* ---------- 启动 ---------- */

/* ---------- 可拖拽分隔条（栏宽/区高调节，位置记忆） ---------- */

function redrawCharts() {
  renderTickChart();
  if (state.selected) {
    loadIntraday(state.selected);
    loadKline(state.selected);
  }
}

function saveSplitterState() {
  const layout = document.querySelector(".layout");
  const watch = document.querySelector(".watch-panel");
  const cs = getComputedStyle(layout);
  const ws = getComputedStyle(watch);
  localStorage.setItem("fa_split", JSON.stringify({
    list: cs.getPropertyValue("--w-list").trim(),
    chat: cs.getPropertyValue("--w-chat").trim(),
    mon: ws.getPropertyValue("--h-monitor").trim(),
  }));
}

function restoreSplitterState() {
  try {
    const s = JSON.parse(localStorage.getItem("fa_split") || "{}");
    if (s.list) document.querySelector(".layout").style.setProperty("--w-list", s.list);
    if (s.chat) document.querySelector(".layout").style.setProperty("--w-chat", s.chat);
    if (s.mon) document.querySelector(".watch-panel").style.setProperty("--h-monitor", s.mon);
  } catch (e) { /* 忽略损坏的存储 */ }
}

function initSplitters() {
  document.querySelectorAll(".splitter").forEach((sp) => {
    sp.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      const target = sp.dataset.target;
      const layout = document.querySelector(".layout");
      const watch = document.querySelector(".watch-panel");
      const lRect = layout.getBoundingClientRect();
      const wRect = watch.getBoundingClientRect();
      sp.setPointerCapture(e.pointerId);
      sp.classList.add("dragging");
      document.body.classList.add("splitter-dragging");

      const onMove = (ev) => {
        if (target === "list") {
          const w = Math.min(Math.max(ev.clientX - lRect.left, 170), lRect.width * 0.45);
          layout.style.setProperty("--w-list", Math.round(w) + "px");
        } else if (target === "chat") {
          const w = Math.min(Math.max(lRect.right - ev.clientX, 280), lRect.width * 0.55);
          layout.style.setProperty("--w-chat", Math.round(w) + "px");
        } else if (target === "monitor") {
          const h = Math.min(Math.max(wRect.bottom - ev.clientY, 100), wRect.height - 200);
          watch.style.setProperty("--h-monitor", Math.round(h) + "px");
        }
      };
      const onUp = () => {
        sp.classList.remove("dragging");
        document.body.classList.remove("splitter-dragging");
        sp.removeEventListener("pointermove", onMove);
        sp.removeEventListener("pointerup", onUp);
        sp.removeEventListener("pointercancel", onUp);
        saveSplitterState();
        redrawCharts();
      };
      sp.addEventListener("pointermove", onMove);
      sp.addEventListener("pointerup", onUp);
      sp.addEventListener("pointercancel", onUp);
    });
  });
}

(async function init() {
  restoreSplitterState();
  initSplitters();
  renderTable();
  selectSymbol(state.selected);
  loadCandidates();
  loadAiConfig();
  pollMonitor();
  pollNews();
  // 恢复历史对话（localStorage 存档；上游整合）
  if (state.chat.length) {
    removeWelcome();
    for (const m of state.chat.slice(-20)) {
      if (m.role === "user" || m.role === "assistant") {
        pushMsg(m.role, m.content, undefined, m.images);
      }
    }
  }
  // 顶级视图路由：?view=news|notes（兼容旧 ?tab= 参数）；?report=1 直开晨报
  const params = new URLSearchParams(location.search);
  const legacyTab = params.get("tab");
  const view = params.get("view") || (legacyTab === "notes" ? "notes" : null);
  if (view) switchView(view);
  if (params.get("report") === "1") $("btnReport").click();
  await doRefresh();
  state.polling = setInterval(doRefresh, 5000);

  // 自检模式：打开 /?selftest=1 会自动发一条消息，用于验证对话链路
  if (new URLSearchParams(location.search).get("selftest") === "1") {
    setTimeout(() => sendChat("自检：请只回复『链路正常』四个字", { light: true }), 4000);
  }

  // 窗口尺寸变化后按新宽度重绘图表（后端有缓存，代价很小）
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawCharts, 300);
  });
})();
