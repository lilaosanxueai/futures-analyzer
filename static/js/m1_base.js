/* m1_base —— 基础：工具/错误处理/存储/Markdown/行情轮询/自选列表 */

/* ---------- 统一存储层（版本号 + 迁移 + 容错） ---------- */

const FA_STORE_VERSION = 2;

const FA_STORE_KEYS = [
  "fa_watchlist", "fa_selected", "fa_alarms", "fa_chat_history",
  "fa_intl_expanded", "fa_news_filter", "fa_skin", "fa_split", "fa_heat_collapse",
];

const store = {
  _cache: null,

  _load() {
    if (this._cache !== null) return this._cache;
    let data = {};
    try {
      const raw = localStorage.getItem("fa_store");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.__v === FA_STORE_VERSION) data = parsed;
      }
    } catch (e) { /* 损坏则重建 */ }
    // 迁移：从旧散键收编
    let migrated = false;
    for (const k of FA_STORE_KEYS) {
      if (data[k] !== undefined) continue;
      const v = localStorage.getItem(k);
      if (v !== null) {
        try { data[k] = JSON.parse(v); } catch (e) { data[k] = v; }
        migrated = true;
      }
    }
    this._cache = data;
    if (migrated || !localStorage.getItem("fa_store")) this._flush();
    return data;
  },

  _flush() {
    try {
      const out = Object.assign({ __v: FA_STORE_VERSION }, this._cache || {});
      localStorage.setItem("fa_store", JSON.stringify(out));
      // 迁移成功后清理旧散键
      for (const k of FA_STORE_KEYS) localStorage.removeItem(k);
    } catch (e) { /* 存储满：静默，内存态继续可用 */ }
  },

  get(key, fallback = null) {
    const v = this._load()[key];
    return v === undefined || v === null ? fallback : v;
  },

  set(key, value) {
    this._load()[key] = value;
    this._flush();
  },

  remove(key) {
    delete this._load()[key];
    this._flush();
  },
};




/* 期货实时分析助手 - 前端逻辑 */

const $ = (id) => document.getElementById(id);

const state = {
  watchlist: store.get("fa_watchlist", ["RB0", "CU0", "M0", "SC0", "IF0"]),
  selected: store.get("fa_selected", null),
  quotes: {},        // symbol -> quote
  names: {},         // symbol -> name/exchange（来自主力列表）
  chat: store.get("fa_chat_history", []),  // {role, content}，持久化到 localStorage
  chatHistoryLen: 60,  // 自动存档条数上限
  aiReady: false,
  polling: null,
  sort: { key: null, dir: -1 },                          // 表格排序
  alarms: store.get("fa_alarms", {}), // {sym: {up, down}}
  prevLast: {},     // symbol -> 上次最新价（用于闪烁）
  ticks: { sym: null, points: [] },   // 实时走势：本次会话对选中合约的 5 秒采样
  refreshCount: 0,  // 轮询计数（分时图自动刷新节流）
  klinePeriod: "day",                 // K线周期
  annotMode: null,                    // 分时图标注模式：bull/bear/risk/level/note
  candidates: [],    // 合约候选（含拼音）
  dropHits: [],      // 搜索下拉当前匹配项
  dropIndex: -1,     // 搜索下拉键盘高亮索引
};

/* ---------- 工具 ---------- */

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
  store.set("fa_watchlist", state.watchlist);
}

/* ---------- 行情轮询 ---------- */

async function doRefresh() {
  if (pollPaused) return;
  if (!state.watchlist.length) {
    $("quoteBody").innerHTML = `<tr><td colspan="5" class="muted center pad">暂无自选合约，请在上方添加</td></tr>`;
    return;
  }
  try {
    const data = await api(`/api/watchlist?symbols=${state.watchlist.join(",")}`);
    data.quotes.forEach((q) => (state.quotes[q.symbol] = q));
    checkAlarms();
    renderTable();
    renderMarketStatus(data.market_open);
    $("marketStatus").textContent += ` · ${sessionCountdown()}`;
    renderHeatView();
    setDocTitle();
    $("lastUpdate").textContent = data.ts ? new Date(data.ts).toLocaleTimeString("zh-CN") : "";
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
    if (state.refreshCount % 4 === 0) pollIntl();
    if (state.refreshCount % 8 === 0) pollNews();
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
    <td class="spark-cell"></td>
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
    tbody.innerHTML = `<tr><td colspan="5" class="muted center pad">暂无自选合约</td></tr>`;
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
    const sp = tds[3];
    if (sp) {
      const svg = sparkSvg(sparkState.data[sym]);
      if (sp.dataset.sig !== (svg ? svg.length + closesSig(sparkState.data[sym]) : "e")) {
        sp.innerHTML = svg || "";
        sp.dataset.sig = svg ? svg.length + closesSig(sparkState.data[sym]) : "e";
      }
    }
  }
}

function closesSig(arr) { return (arr || []).length + ":" + (arr ? arr[arr.length - 1] : ""); }

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
  store.set("fa_selected", state.selected || "");
  state.intradayDrawn = false;
  renderTable();
  renderQuoteArea();
  if (currentView() === "detail") {
    // 详情视图可见才绘制图表（隐藏容器 clientWidth=0，无法绘图）
    renderAnalysisArea();
    if (!isIntl(sym)) renderSignalArea(); else $("sigArea").innerHTML = "";
    syncTradeEvalEntry();
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
  let q = state.quotes[sym];
  if (isIntl(sym)) {
    const iq = (state.intlQuotes || []).find((x) => x.symbol === sym);
    if (iq && iq.last != null) {
      q = { symbol: sym, name: iq.name, exchange: "国际", last: iq.last,
            open: iq.open, high: iq.high, low: iq.low, prev_settle: iq.prev_close,
            change: iq.prev_close ? +(iq.last - iq.prev_close).toFixed(2) : null,
            change_pct: iq.change_pct, volume: null, position: null,
            time: iq.time, date: iq.date, digits: 2 };
      state.quotes[sym] = q;
    }
  }
  if (!q) {
    box.innerHTML = `<div class="muted center pad">加载 ${sym} …</div>`;
    return;
  }
  const cls = chgClass(q.change_pct);
  const sign = q.change_pct > 0 ? "+" : "";
  const name = state.names[sym] || "";
  box.innerHTML = `
    <div class="detail-top">
      <span class="detail-name">${sym}<span class="exch">${q.exchange || ""}${name ? " · " + name : ""}</span></span>
      <span id="detailLast" class="detail-last ${cls}">${fmt(q.last, q.digits ?? 1)}</span>
      <span class="detail-chg ${cls}">${sign}${fmt(q.change, q.digits ?? 1)}（${sign}${fmt(q.change_pct, 2)}%）</span>
    </div>
    <div class="detail-grid">
      ${dg("今开", fmt(q.open, q.digits ?? 1))}
      ${dg("最高", fmt(q.high, q.digits ?? 1))}
      ${dg("最低", fmt(q.low, q.digits ?? 1))}
      ${dg("昨结", fmt(q.prev_settle, q.digits ?? 1))}
      ${dg(`买一${q.bid != null ? `（${fmt(q.bid_vol)}）` : ""}`, q.bid != null ? fmt(q.bid, q.digits ?? 1) : "--")}
      ${dg(`卖一${q.ask != null ? `（${fmt(q.ask_vol)}）` : ""}`, q.ask != null ? fmt(q.ask, q.digits ?? 1) : "--")}
      ${dg("成交量", fmt(q.volume))}
      ${dg("持仓量", fmt(q.position))}
    </div>
    <div class="tick-wrap">
      <div class="spark-title">Tick 实时走势（2 秒采样，详情页打开时记录）</div>
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
  const intl = isIntl(sym);

  // 分时区：国际品种无分钟历史，仅提示；国内含标注工具条
  const intradayHtml = intl
    ? `<div class="muted small" style="margin-bottom:6px">🌍 国际品种暂无分钟级历史分时，下方 Tick 采样在开盘时段自动记录。</div>
       <div id="intradayChart"><span class="muted small">开盘后 Tick 自动记录…</span></div>`
    : `<div class="intraday-legend">
        <span><i class="legend-dot" style="background:#f5c542"></i>价格</span>
        <span><i class="legend-dot" style="background:#7aa2f7"></i>均价</span>
        <span id="intradayDate" class="muted"></span>
        <span class="annot-bar">
          <button class="annot-btn" data-annot="bull" title="标注多头判定">📈多</button>
          <button class="annot-btn" data-annot="bear" title="标注空头判定">📉空</button>
          <button class="annot-btn" data-annot="risk" title="标注风险点">⚠️</button>
          <button class="annot-btn" data-annot="level" title="画关键价位线（支撑/压力/止损）">📏</button>
          <button class="annot-btn" data-annot="note" title="文字批注（趋势推理）">📝</button>
          <button class="annot-btn" data-annot-clear="1" title="清除当日全部标注">🧹</button>
          <button class="annot-btn" id="btnAnnotAi" title="把标注交给 AI 逐条评估并给独立推演">🤖评估</button>
          <button class="annot-btn" id="btnAnnotNote" title="把标注保存为一条交易心得">💾</button>
        </span>
      </div>
      <div id="intradayChart"><span class="muted small">分时加载中…</span></div>`;

  // K 线头：国际品种仅日线（隐藏周期/开关）
  const klineCtrl = intl ? "" : `
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <div class="period-tabs" id="periodTabs">
            ${Object.keys(PERIOD_LABEL).map((p) => `<button data-p="${p}" class="${state.klinePeriod === p ? "active" : ""}">${PERIOD_LABEL[p]}</button>`).join("")}
          </div>
          <button class="kline-toggle${state.klineShowMA !== false ? " on" : ""}" id="tglMA" title="均线开关">MA</button>
          <button class="kline-toggle${state.klineShowBoll ? " on" : ""}" id="tglBoll" title="布林带开关">BOLL</button>
          <button class="kline-toggle" id="btnKlineCsv" title="导出当前 K 线数据 CSV">⬇</button>
          <span class="muted small" title="滚轮缩放 · 拖拽平移 · 双击复位">🖱️缩放/平移</span>
        </div>`;

  box.innerHTML = `
    <div class="intraday-wrap">
      ${intradayHtml}
    </div>
    <div class="kline-wrap">
      <div class="kline-head">
        <span class="kline-title">K 线 · <span class="muted">MA5 <i class="legend-dot" style="background:#ffffff"></i> MA10 <i class="legend-dot" style="background:#f5c542"></i> MA20 <i class="legend-dot" style="background:#c084fc"></i>${intl ? " · 国际品种仅日线" : ""}</span></span>
        ${klineCtrl}
      </div>
      <div class="kline-chart-box">
        <div id="klineChart"><span class="muted small">K线加载中…</span></div>
        <div id="klineTip" class="kline-tip hidden"></div>
      </div>
    </div>`;
  if (!intl) loadIntraday(sym);
  loadKline(sym);
  if (!intl) {
    $("periodTabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-p]");
      if (!b || b.dataset.p === state.klinePeriod) return;
      state.klinePeriod = b.dataset.p;
      loadKline(sym);
    });
    $("tglMA").addEventListener("click", () => {
      state.klineShowMA = state.klineShowMA === false;
      $("tglMA").classList.toggle("on", state.klineShowMA !== false);
      const el = $("klineChart");
      if (el && el._kfull) renderKlineChart(el, el._kfull);
    });
    $("tglBoll").addEventListener("click", () => {
      state.klineShowBoll = !state.klineShowBoll;
      $("tglBoll").classList.toggle("on", state.klineShowBoll);
      const el = $("klineChart");
      if (el && el._kfull) renderKlineChart(el, el._kfull);
    });
  $("btnKlineCsv").addEventListener("click", () => {
    const el = $("klineChart");
    const full = el && el._kfull;
    if (!full || !full.items.length) return toast("暂无 K 线数据", true);
    const rows = [["时间", "开", "高", "低", "收", "成交量"]];
    full.items.forEach((it) => rows.push([it.datetime, it.open, it.high, it.low, it.close, it.volume ?? ""]));
    downloadCSV(`K线_${sym}_${state.klinePeriod}.csv`, rows);
    toast(`已导出 ${full.items.length} 根 K 线`);
  });
  }
}

async function renderSignalArea() {
  const sym = state.selected;
  const box = $("sigArea");
  if (!sym || isIntl(sym)) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="sig-box"><div class="sig-title">技术信号与指标（日线）</div><span class="muted small">加载中…</span></div>`;
  try {
    const [d, acc] = await Promise.all([
      api(`/api/indicators/${sym}`),
      api(`/api/signal-accuracy/${sym}?lookforward=5`).catch(() => ({ results: {} })),
    ]);
    const v = d.values || {};
    const accData = acc.results || {};
    const chips = (d.signals || []).length
      ? d.signals.map((s) => {
          const a = accData[s.name];
          const wr = a && a.count >= 3 ? ` <span class="sig-wr ${a.win_rate >= 55 ? "wr-hi" : a.win_rate <= 45 ? "wr-lo" : ""}">${a.win_rate}%(${a.count}次)</span>` : "";
          return `<span class="sig ${s.dir}" title="${s.detail}${a ? `
历史5日胜率: ${a.win_rate}% (${a.count}次)` : ""}">${s.name}${wr}<span class="d">${s.detail}</span></span>`;
        }).join("")
      : `<span class="muted small">当前无明显技术信号</span>`;
    const fv = (x) => (x == null ? "--" : x);
    box.innerHTML = `
      <div class="sig-box">
        <div class="sig-title">技术信号（${d.date} 日线）<span class="muted" style="font-weight:400"> · 括号内为历史5日胜率(样本数)</span></div>
        <div class="sig-chips">${chips}</div>
        <div class="detail-grid" style="margin-top:10px">
          ${dg("MA5", fv(v.ma5))}${dg("MA10", fv(v.ma10))}${dg("MA20", fv(v.ma20))}${dg("MA60", fv(v.ma60))}
          ${dg("DIF", fv(v.dif))}${dg("DEA", fv(v.dea))}${dg("MACD柱", fv(v.macd_hist))}${dg("RSI6", fv(v.rsi6))}
          ${dg("RSI12", fv(v.rsi12))}${dg("K", fv(v.k))}${dg("D", fv(v.d))}${dg("J", fv(v.j))}
          ${dg("BOLL上轨", fv(v.boll_up))}${dg("BOLL中轨", fv(v.boll_mid))}${dg("BOLL下轨", fv(v.boll_low))}
        </div>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div class="sig-box"><div class="sig-title">技术信号与指标</div><span class="muted small">加载失败：${e.message}</span></div>`;
  }
}
