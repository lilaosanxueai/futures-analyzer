/* 期货实时分析助手 - 前端逻辑 */

const $ = (id) => document.getElementById(id);

const state = {
  watchlist: JSON.parse(localStorage.getItem("fa_watchlist") || "null") || ["RB0", "CU0", "M0", "SC0", "IF0"],
  selected: localStorage.getItem("fa_selected") || null,
  quotes: {},        // symbol -> quote
  names: {},         // symbol -> name/exchange（来自主力列表）
  chat: JSON.parse(localStorage.getItem("fa_chat_history") || "[]") || [],  // {role, content}，持久化到 localStorage
  chatHistoryLen: 60,  // 自动存档条数上限
  aiReady: false,
  polling: null,
  sort: { key: null, dir: -1 },                          // 表格排序
  alarms: JSON.parse(localStorage.getItem("fa_alarms") || "{}"), // {sym: {up, down}}
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
  localStorage.setItem("fa_watchlist", JSON.stringify(state.watchlist));
}

/* ---------- 行情轮询 ---------- */

async function doRefresh() {
  if (pollPaused) return;
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
  }
}

async function renderSignalArea() {
  const sym = state.selected;
  const box = $("sigArea");
  if (!sym || isIntl(sym)) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="sig-box"><div class="sig-title">技术信号与指标（日线）</div><span class="muted small">加载中…</span></div>`;
  try {
    const d = await api(`/api/indicators/${sym}`);
    const v = d.values || {};
    const chips = (d.signals || []).length
      ? d.signals.map((s) => `<span class="sig ${s.dir}" title="${s.detail}">${s.name}<span class="d">${s.detail}</span></span>`).join("")
      : `<span class="muted small">当前无明显技术信号</span>`;
    const fv = (x) => (x == null ? "--" : x);
    box.innerHTML = `
      <div class="sig-box">
        <div class="sig-title">技术信号（${d.date} 日线）</div>
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

/* ---------- 实时走势（本次会话的 5 秒采样轨迹） ---------- */

function recordTick() {
  const sym = state.selected;
  const q = sym && state.quotes[sym];
  if (!q || q.last == null) return;
  if (state.ticks.sym !== sym) state.ticks = { sym, points: [] };
  state.ticks.points.push({ t: Date.now(), p: q.last, v: q.volume });
  if (state.ticks.points.length > 300) state.ticks.points.shift(); // 2秒/笔 ≈ 10 分钟
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
    <text x="${pad}" y="${h - 3}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9">近 ${durMin} 分钟（5 秒采样）</text>
    <text x="${w - pad}" y="${h - 3}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9" text-anchor="end">高 ${max} / 低 ${min}</text>
  </svg>`;
}

function dg(k, v) {
  return `<div class="dg-item"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

/* SVG 折线图（一条或多条） */
function renderLines(container, series, opts = {}) {
  const w = opts.width || 600;
  const h = opts.height || 110;
  const pad = 4;
  const all = series.flatMap((s) => s.points.filter((p) => p != null));
  if (all.length < 2) { container.textContent = "暂无数据"; return; }
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const n = Math.max(...series.map((s) => s.points.length));
  const polylines = series
    .map((s) => {
      const pts = s.points.map((c, i) => {
        if (c == null) return null;
        const x = pad + (i / (n - 1)) * (w - pad * 2);
        const y = pad + (1 - (c - min) / span) * (h - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).filter(Boolean);
      return `<polyline points="${pts.join(" ")}" fill="none" stroke="${s.color}" stroke-width="1.4"/>`;
    })
    .join("");
  const label = opts.minMax !== false ? `<text x="${pad}" y="11" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="10">${max}</text><text x="${pad}" y="${h - 5}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="10">${min}</text>` : "";
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${polylines}${label}</svg>`;
}

/* ---------- K 线蜡烛图（红涨绿跌 + MA + 成交量副图 + 信号标记 + 十字光标） ---------- */

const INTL_LIST = [
  { symbol: "CL", name: "WTI 原油" }, { symbol: "OIL", name: "布伦特原油" },
  { symbol: "GC", name: "COMEX 黄金" }, { symbol: "XAU", name: "伦敦金" },
  { symbol: "S", name: "CBOT 美豆" }, { symbol: "HG", name: "COMEX 铜" },
  { symbol: "DINIW", name: "美元指数" },
];
const isIntl = (sym) => INTL_LIST.some((s) => s.symbol === sym);

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
  if (state.klineShowMA !== false) overlayKeys.push("ma5", "ma10", "ma20");
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
  for (let g = 0; g <= 3; g++) {
    const p = pmin + ((pmax - pmin) * g) / 3;
    const yy = yMain(p);
    els.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="#232b3b" style="stroke:var(--chart-grid)" stroke-dasharray="2 4"/>`);
    els.push(`<text x="${w - padR + 4}" y="${(yy + 3).toFixed(1)}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9">${fp(p)}</text>`);
  }
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
  const maColors = { ma5: "#ffffff", ma10: "#f5c542", ma20: "#c084fc", boll_up: "#38bdf8", boll_mid: "#94a3b8", boll_low: "#38bdf8" };
  for (const k of overlayKeys) {
    const pts = items.map((it, i) => (it[k] == null ? null : `${cx(i).toFixed(1)},${yMain(it[k]).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) els.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${maColors[k]}" stroke-width="1" opacity="${k.startsWith("boll") ? 0.75 : 0.9}"${k === "boll_mid" ? ' stroke-dasharray="4 3"' : ""}/>`);
  }
  const last = items[n - 1];
  if (last.close != null) {
    const up = last.close >= (last.open ?? last.close);
    const c = up ? "#f34e4e" : "#22c55e";
    const yy = yMain(last.close);
    els.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${c}" stroke-width="0.8" stroke-dasharray="3 3" opacity="0.8"/>`);
    els.push(`<rect x="${w - padR + 1}" y="${(yy - 7).toFixed(1)}" width="${padR - 3}" height="14" rx="2" fill="${c}"/>`);
    els.push(`<text x="${w - padR + 5}" y="${(yy + 4).toFixed(1)}" fill="#fff" font-size="9">${fp(last.close)}</text>`);
  }
  // 价格预警线
  const kAlarms = (state.alarms[state.selected] || {});
  for (const [key, color] of [["up", "#f5a623"], ["down", "#38bdf8"]]) {
    const p = kAlarms[key];
    if (p == null || p < pmin || p > pmax) continue;
    const yy = yMain(p);
    els.push(`<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${padL + plotW}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="2 5" opacity="0.9"/>
      <text x="${(padL + 4).toFixed(1)}" y="${(yy - 3).toFixed(1)}" font-size="9" fill="${color}">🔔${key === "up" ? "上破" : "下破"} ${p}</text>`);
  }
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
  const tickIdx = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
  tickIdx.forEach((i) => {
    const label = data.period === "day" ? items[i].datetime.slice(5) : items[i].datetime.slice(5, 16);
    els.push(`<text x="${cx(i).toFixed(1)}" y="${volBase + 12}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9" text-anchor="middle">${label}</text>`);
  });
  els.push(`<line id="kCross" x1="0" y1="${padT}" x2="0" y2="${volBase}" stroke="#8a93a6" style="stroke:var(--chart-axis)" stroke-dasharray="3 3" visibility="hidden"/>`);

  const H = volBase + padB;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${H}" width="${w}" height="${H}">${els.join("")}</svg>`;
  el._kdata = { items, cx, padL, plotW, period: data.period };
  bindKlineHover(el);
  bindKlineZoomPan(el, data);
}

/* 滚轮缩放 + 拖拽平移 + 双击复位 */
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

/* ---------- 日内走势图形标注 ---------- */

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
  const alarms = (state.alarms[state.selected] || {});
  if (!annots.length && alarms.up == null && alarms.down == null) return;
  const NS = "http://www.w3.org/2000/svg";
  const layer = document.createElementNS(NS, "g");
  layer.id = "annotLayer";
  // 价格预警线（🔔 上破/下破，随行情刷新重画）
  for (const [key, color] of [["up", "#f5a623"], ["down", "#38bdf8"]]) {
    const p = alarms[key];
    if (p == null) continue;
    const y = scale.yOfPrice(p);
    layer.innerHTML += `<line x1="${scale.padL}" y1="${y.toFixed(1)}" x2="${scale.padR}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="1" stroke-dasharray="2 5" opacity="0.9"/>
      <text x="${(scale.padL + 4).toFixed(1)}" y="${(y - 3).toFixed(1)}" font-size="9" fill="${color}">🔔${key === "up" ? "上破" : "下破"} ${p}</text>`;
  }

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
        <text x="${(scale.padR - 82).toFixed(1)}" y="${(y + 4).toFixed(1)}" font-size="10" fill="#0d1117" font-weight="600">${a.price}${a.text ? ` ${a.text.slice(0, 5)}` : ""}</text>`;
    } else {
      const x = scale.xOfTime(a.time), y = scale.yOfPrice(a.price);
      if (a.type === "bull") shape = `<path d="M ${x} ${(y - 7).toFixed(1)} L ${(x - 5).toFixed(1)} ${(y + 4).toFixed(1)} L ${(x + 5).toFixed(1)} ${(y + 4).toFixed(1)} Z" fill="${info.color}"/>`;
      else if (a.type === "bear") shape = `<path d="M ${x} ${(y + 7).toFixed(1)} L ${(x - 5).toFixed(1)} ${(y - 4).toFixed(1)} L ${(x + 5).toFixed(1)} ${(y - 4).toFixed(1)} Z" fill="${info.color}"/>`;
      else if (a.type === "risk") shape = `<rect x="${(x - 4.5).toFixed(1)}" y="${(y - 4.5).toFixed(1)}" width="9" height="9" fill="${info.color}" transform="rotate(45 ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
      else shape = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#f5a623"/>`;
      if (a.text) {
        shape += `<rect x="${(x + 7).toFixed(1)}" y="${(y - 16).toFixed(1)}" width="${Math.min(a.text.length * 11 + 8, 150)}" height="17" rx="3" fill="rgba(13,17,23,.92)" stroke="${info.color}" stroke-width="0.6"/>
          <text x="${(x + 11).toFixed(1)}" y="${(y - 4).toFixed(1)}" font-size="10" fill="${info.color}">${a.text.slice(0, 13)}</text>`;
      }
    }
    g.innerHTML = shape + `<title>${a.time} ${info.label} ${a.price}${a.text ? `：${a.text}` : ""}（双击删除）</title>`;
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
    ? `<line x1="${padX}" y1="${y(prevSettle)}" x2="${w - padX}" y2="${y(prevSettle)}" stroke="#8a93a6" style="stroke:var(--chart-axis)" stroke-width="1" stroke-dasharray="4 4"/>
       <text x="${padX + 2}" y="${y(prevSettle) - 3}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9">昨结 ${prevSettle}</text>`
    : "";
  const tickIdx = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
  const tickEls = tickIdx
    .map((i) => `<text x="${x(i).toFixed(1)}" y="${h - 4}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9" text-anchor="middle">${items[i].time}</text>`)
    .join("");
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    ${settleLine}
    ${line("avg", "#7aa2f7")}
    ${line("price", "#f5c542")}
    <circle cx="${x(n - 1)}" cy="${y(last.price)}" r="2.5" fill="${dotColor}"/>
    <text x="${(x(n - 1) - 5).toFixed(1)}" y="${y(last.price) - 6}" fill="${dotColor}" font-size="10" text-anchor="end">${last.price}</text>
    ${tickEls}
  </svg>`;
  // 标注坐标系（数据坐标存储，图重绘后位置不丢）+ 标注层 + 点击放置
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

async function loadSparkline(sym) { /* 已被 K 线图替代，保留空实现避免旧引用 */ }

/* ---------- 开仓风险评估（日内短线） ---------- */

const teState = { entryTouched: false };

// 切换合约时若用户未手动改过开仓价，自动跟随现价
function syncTradeEvalEntry() {
  const input = $("teEntry");
  if (!input) return;
  if (!teState.entryTouched || !input.value) {
    const q = state.selected && state.quotes[state.selected];
    if (q && q.last != null) input.value = q.last;
  }
  renderTeCalc();
}

// 输入变化即实时计算止损/止盈价与盈亏比（不调 AI）
function renderTeCalc() {
  const box = $("teCalc");
  if (!box) return;
  const q = state.selected && state.quotes[state.selected];
  const dir = $("teDir").value;
  const entry = parseFloat($("teEntry").value);
  const sp = parseFloat($("teStop").value);
  const tp = parseFloat($("teTarget").value);
  const lots = parseFloat($("teLots").value) || 1;
  if (!entry || !sp || !tp || sp <= 0 || tp <= 0) { box.innerHTML = ""; return; }
  const sign = dir === "long" ? 1 : -1;
  const stop = (entry - sign * sp).toFixed(1);
  const target = (entry + sign * tp).toFixed(1);
  const rr = (tp / sp).toFixed(2);
  const items = [
    `止损价 <b>${stop}</b>`, `止盈价 <b>${target}</b>`, `盈亏比 <b>${rr}</b>`,
  ];
  if (q && q.last != null) {
    const dev = ((entry / q.last - 1) * 100).toFixed(2);
    items.push(`开仓偏离现价 <b>${dev > 0 ? "+" : ""}${dev}%</b>`);
  }
  box.innerHTML = items.map((s) => `<span class="cmp-stat">${s}</span>`).join("");
}

["teDir", "teEntry", "teStop", "teTarget", "teLots"].forEach((id) => {
  $(id).addEventListener("input", () => {
    if (id === "teEntry") teState.entryTouched = true;
    renderTeCalc();
  });
  $(id).addEventListener("change", renderTeCalc);
});

$("btnTradeEval").addEventListener("click", async () => {
  const sym = state.selected;
  if (!sym) return toast("请先选择合约", true);
  const entry = parseFloat($("teEntry").value);
  const sp = parseFloat($("teStop").value);
  const tp = parseFloat($("teTarget").value);
  if (!entry || !sp || !tp || sp <= 0 || tp <= 0) return toast("请填写开仓价、止损与止盈点数", true);
  const lots = parseFloat($("teLots").value) || 1;
  const result = $("teResult");
  result.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>
    <span class="muted small" style="margin-left:6px">AI 正在结合实时行情、指标、消息面评估开仓计划…</span>`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 150000);
    const d = await api("/api/trade-eval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: sym, direction: $("teDir").value, entry, stop_points: sp, target_points: tp, lots }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const c = d.calc || {};
    const stats = [
      `止损价 ${c.stop_price}`, `止盈价 ${c.target_price}`, `盈亏比 ${c.rr}`,
      c.day_high ? `日内波幅 ${c.day_low}~${c.day_high}` : "",
      c.stop_vs_range != null ? `止损占日内波幅 ${c.stop_vs_range}%` : "",
      c.stop_vs_avg != null ? `占5日均幅 ${c.stop_vs_avg}%` : "",
      c.risk_amt ? `风险 ¥${c.risk_amt.toLocaleString()}` : "",
      c.reward_amt ? `潜在盈利 ¥${c.reward_amt.toLocaleString()}` : "",
    ].filter(Boolean).map((s) => `<span class="cmp-stat">${s}</span>`).join("");
    $("teCalc").innerHTML = stats;
    result.innerHTML = `<div class="md">${renderMarkdown(d.advice)}</div>`;
  } catch (e) {
    const msg = e.name === "AbortError" ? "评估超时，请重试" : e.message;
    result.innerHTML = `<div class="msg error">评估失败：${msg}</div>`;
  }
});

/* ---------- 交易日志与复盘统计 ---------- */

const tradesState = { items: [], loaded: false };

async function loadTrades() {
  try {
    const d = await api("/api/trades");
    tradesState.items = d.items || [];
    tradesState.loaded = true;
    renderTrades();
    loadTradeStats();
  } catch (e) {
    $("tradesList").innerHTML = `<div class="muted small monitor-hint">加载失败：${e.message}</div>`;
  }
}

async function loadTradeStats() {
  try {
    const d = await api("/api/trades/stats");
    renderTradeStats(d);
  } catch (e) { /* 统计失败不影响列表 */ }
}

function statCard(k, v, warn) {
  return `<span class="cmp-stat"><span class="k">${k}</span><b class="${warn || ""}">${v}</b></span>`;
}

function renderTradeStats(d) {
  const box = $("tradeStats");
  if (!box) return;
  const o = d.overview || {};
  if (!o.count) {
    box.innerHTML = `<span class="muted small">了结 ${d.open_count || 0} 笔待验证交易后，此处显示胜率/盈亏比/分品种统计</span>`;
    return;
  }
  box.innerHTML = [
    statCard("已了结", o.count),
    statCard("胜率", `${o.win_rate}%`, o.win_rate >= 50 ? "up" : "down"),
    statCard("累计", `${o.total_pts > 0 ? "+" : ""}${o.total_pts} 点`, o.total_pts >= 0 ? "up" : "down"),
    statCard("均盈", `+${o.avg_win} 点`, "up"),
    statCard("均亏", `${o.avg_loss} 点`, "down"),
    o.profit_factor ? statCard("盈亏因子", o.profit_factor, o.profit_factor >= 1 ? "up" : "down") : "",
    statCard("待验证", d.open_count || 0),
    statCard("计划盈亏比", o.avg_plan_rr || "--"),
  ].join("");
  // 分品种 + AI 评级表
  let tables = "";
  if (Object.keys(d.by_symbol || {}).length) {
    tables += `<div class="corr-head"><span class="kline-title">分品种表现</span></div>` +
      tradeGroupTable(d.by_symbol, (s) => s);
  }
  if (Object.keys(d.by_grade || {}).length > 1 || (Object.keys(d.by_grade || {}).length === 1 && !d.by_grade["未评估"])) {
    tables += `<div class="corr-head"><span class="kline-title">按 AI 风险评级（AI 建议值不值得听？）</span></div>` +
      tradeGroupTable(d.by_grade, (g) => g);
  }
  const list = $("tradesList");
  if (list && tables) {
    list.insertAdjacentHTML("afterend", `<div id="tradeGroupTables" class="trade-group-tables">${tables}</div>`);
  }
}

function tradeGroupTable(groups, keyFn) {
  const rows = Object.entries(groups).map(([k, v]) => {
    if (!v.count) return "";
    return `<tr><td>${keyFn === (x => x) ? k : k}</td><td>${v.count}</td>
      <td class="${v.win_rate >= 50 ? "up" : "down"}">${v.win_rate}%</td>
      <td class="${v.total_pts >= 0 ? "up" : "down"}">${v.total_pts > 0 ? "+" : ""}${v.total_pts}</td>
      <td>${v.avg_plan_rr ?? "--"}</td></tr>`;
  }).join("");
  return `<table class="corr-table"><tr><th>组</th><th>笔数</th><th>胜率</th><th>累计点数</th><th>计划盈亏比</th></tr>${rows}</table>`;
}

function renderTrades() {
  const list = $("tradesList");
  const items = tradesState.items;
  if (!items.length) {
    list.innerHTML = `<div class="muted small monitor-hint">暂无交易记录。在合约详情页做开仓评估后点「📥 记入日志」，事后在此了结并统计。</div>`;
    return;
  }
  list.innerHTML = items.map((t) => {
    const dirCls = t.direction === "long" ? "up" : "down";
    const dirTxt = t.direction === "long" ? "多" : "空";
    const res = t.result_pts == null ? "" : (t.result_pts > 0 ? "up" : "down");
    const statusTxt = { open: "待验证", closed: "已了结", abandoned: "已放弃" }[t.status] || t.status;
    return `<div class="trade-item" data-id="${t.id}">
      <div class="trade-line">
        <span class="note-time">${t.date}</span>
        <b class="${dirCls}">${t.symbol} ${dirTxt}</b>
        <span>@${t.entry} · SL ${t.stop_points}/TP ${t.target_points} · ${t.lots}手</span>
        ${t.ai_grade ? `<span class="note-tag">AI:${t.ai_grade}</span>` : ""}
        ${t.status === "closed" && t.result_pts != null ? `<b class="${res}">${t.result_pts > 0 ? "+" : ""}${t.result_pts}点</b>` : `<span class="muted small">${statusTxt}</span>`}
        <span class="note-ops">
          ${t.status === "open" ? `<button data-close="${t.id}" title="了结：输入平仓价或直接盈亏点数">✓了结</button>` : ""}
          ${t.status === "open" ? `<button data-abandon="${t.id}" title="标记为放弃（未执行）">—放弃</button>` : ""}
          <button data-del="${t.id}" title="删除">✕</button>
        </span>
      </div>
    </div>`;
  }).join("");
}

$("tradesList").addEventListener("click", async (e) => {
  const close = e.target.closest("[data-close]");
  const abandon = e.target.closest("[data-abandon]");
  const del = e.target.closest("[data-del]");
  const id = (close || abandon || del)?.dataset.close || (close || abandon || del)?.dataset.abandon || (close || abandon || del)?.dataset.del;
  if (del) {
    api(`/api/trades/${del.dataset.del}`, { method: "DELETE" }).then(loadTrades).catch(() => {});
    return;
  }
  if (abandon) {
    await api(`/api/trades/${abandon.dataset.abandon}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "abandoned" }),
    });
    loadTrades();
    return;
  }
  if (close) {
    const input = prompt("了结方式：输入平仓价（如 3130）或直接输入盈亏点数（如 +25 / -15）：", "");
    if (input == null) return;
    const v = parseFloat(input.replace("+", ""));
    if (!Number.isFinite(v)) return toast("请输入数字", true);
    const body = input.trim().startsWith("+") || input.trim().startsWith("-")
      ? { result_pts: v }
      : { exit: v };
    try {
      await api(`/api/trades/${close.dataset.close}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      loadTrades();
      toast("已了结");
    } catch (err) {
      toast(`失败：${err.message}`, true);
    }
  }
});

/* 开仓评估面板：一键记入交易日志 */
$("btnTradeLog").addEventListener("click", async () => {
  const sym = state.selected;
  if (!sym) return toast("请先选择合约", true);
  const entry = parseFloat($("teEntry").value);
  const sp = parseFloat($("teStop").value);
  const tp = parseFloat($("teTarget").value);
  if (!entry || !sp || !tp) return toast("请先填写完整的开仓计划", true);
  // 抓取最近一次 AI 评估的风险评级（从结果区文本提取 低/中/高）
  const resultText = $("teResult").textContent || "";
  const gradeM = resultText.match(/风险评级[^低中高]*([低中高])/);
  try {
    await api("/api/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: sym, direction: $("teDir").value, entry,
        stop_points: sp, target_points: tp,
        lots: parseFloat($("teLots").value) || 1,
        ai_grade: gradeM ? gradeM[1] : "",
      }),
    });
    toast("已记入交易日志（待验证）");
  } catch (e) {
    toast(`保存失败：${e.message}`, true);
  }
});


/* ---------- 外盘参考条（国际品种行情） ---------- */

async function pollIntl() {
  const bar = $("intlBar");
  if (!bar) return;
  try {
    const d = await api("/api/intl-quotes");
    state.intlQuotes = (d.items || []).filter((q) => !q.error && q.last != null);
    const items = state.intlQuotes;
    if (!items.length) return;
    bar.innerHTML = `<span class="intl-title muted small">🌍 外盘</span>` + items.map((q) => {
      const cls = q.change_pct >= 0 ? "up" : "down";
      const pct = q.change_pct != null ? `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%` : "--";
      const short = q.name.replace("原油", "油").replace("COMEX ", "").replace("CBOT-", "").replace("WTI ", "WTI");
      return `<span class="intl-item" title="${q.name} ${q.date} ${q.time}"><span class="n">${short}</span><b class="${cls}">${q.last}</b> <span class="${cls}">${pct}</span></span>`;
    }).join("");
  } catch (e) { /* 外盘失败静默 */ }
}

/* ---------- 宏观事件日历 ---------- */

let calLoaded = false;

async function loadCalendar() {
  const box = $("calStrip");
  if (!box) return;
  try {
    const d = await api("/api/calendar");
    const items = (d.items || []).filter((it) => it.importance >= 2);
    if (!items.length) {
      box.innerHTML = `<span class="muted small">📅 今日无重要性≥2 的宏观事件</span>`;
      return;
    }
    const nowHm = new Date().toTimeString().slice(0, 5);
    box.innerHTML = `<span class="muted small">📅 今日宏观（重要）</span>` + items.map((it) => {
      const upcoming = it.time > nowHm;
      const stars = "★".repeat(it.importance);
      const actual = it.actual ? `公布 <b>${it.actual}</b>` : (it.forecast ? `预期 ${it.forecast}` : "");
      return `<span class="cal-ev${upcoming ? " upcoming" : ""}" title="${it.region} ${it.event}｜前值 ${it.previous || "--"}">
        <span class="t">${it.time}</span><span class="star">${stars}</span><span class="reg">${it.region}</span>${(it.event.split(/[（(]/)[0] || "").slice(0, 16)} ${actual}${upcoming ? " ⏳" : ""}
      </span>`;
    }).join("");
  } catch (e) {
    box.innerHTML = `<span class="muted small">📅 日历加载失败</span>`;
  }
}

/* ---------- 轮询暂停 ---------- */

let pollPaused = false;

$("btnPause").addEventListener("click", () => {
  pollPaused = !pollPaused;
  $("btnPause").textContent = pollPaused ? "▶" : "⏸";
  $("btnPause").classList.toggle("accent", pollPaused);
  toast(pollPaused ? "行情轮询已暂停（AI 对话不受影响）" : "行情轮询已恢复");
});

/* ---------- 周期快捷键（详情视图内 1-6） ---------- */

document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const tag = (document.activeElement || {}).tagName || "";
  if (["INPUT", "SELECT", "TEXTAREA"].includes(tag)) return;
  if (currentView() !== "detail") return;
  const map = { "1": "1m", "2": "5m", "3": "15m", "4": "30m", "5": "60m", "6": "day" };
  if (map[e.key] && map[e.key] !== state.klinePeriod) {
    state.klinePeriod = map[e.key];
    if (state.selected) loadKline(state.selected);
  }
});


/* ---------- Tick 轮询器（2 秒，仅详情视图可见时采样） ---------- */

async function tickPoll() {
  if (currentView() !== "detail" || !state.selected || pollPaused) return;
  const sym = state.selected;
  try {
    const d = await api(`/api/tick/${sym}`);
    if (d.last == null) return;
    if (state.ticks.sym !== sym) state.ticks = { sym, points: [] };
    // 与 watchlist 缓存互通（报价区数字用）
    state.quotes[sym] = Object.assign({}, state.quotes[sym] || {}, { last: d.last, volume: d.volume, time: d.time });
    state.ticks.points.push({ t: Date.now(), p: d.last, v: d.volume });
    if (state.ticks.points.length > 300) state.ticks.points.shift();
    renderTickChart();
    renderQuoteArea();
  } catch (e) { /* 非交易时段接口可能失败，静默 */ }
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
  filter: localStorage.getItem("fa_news_filter") || "all",
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
    localStorage.setItem("fa_news_filter", newsState.filter);
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
  localStorage.setItem("fa_skin", id);
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

/* ---------- 顶级视图路由（标签切换界面） ---------- */

const VIEW_ORDER = ["work", "detail", "compare", "news", "notes", "trades"];

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
  const dom = state.watchlist
    .map((s) => `<option value="${s}">${s} ${state.names[s] || ""}</option>`).join("");
  const intl = INTL_LIST
    .map((c) => `<option value="${c.symbol}">${c.symbol} ${c.name}</option>`).join("");
  sel.innerHTML = `<optgroup label="🇨🇳 国内自选">${dom}</optgroup><optgroup label="🌍 国际品种">${intl}</optgroup>`;
  sel.value = state.selected || "";
}

function switchView(name) {
  document.querySelectorAll(".view-tab").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("hidden", v.dataset.view !== name));
  // 只更新 view 参数，保留 annot_test/selftest 等其它参数
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
    syncTradeEvalEntry();
  }
  if (name === "compare") initComparePage();
  if (name === "notes") {
    if (!notesState.items.length) loadNotes();
    prefillNoteSymbol();
    const d = $("noteDate");
    if (d && !d.value) d.value = new Date().toISOString().slice(0, 10);
  }
  if (name === "news") {
    if (!newsState.loaded) pollNews();
    if (!calLoaded) { calLoaded = true; loadCalendar(); }
  }
  if (name === "trades" && !tradesState.loaded) loadTrades();
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// 快捷键：Alt+1..6 切换视图
document.addEventListener("keydown", (e) => {
  if (e.altKey && /^[1-6]$/.test(e.key)) {
    switchView(VIEW_ORDER[Number(e.key) - 1]);
    e.preventDefault();
  }
});

// 详情视图顶部合约选择
$("detailSym").addEventListener("change", (e) => {
  if (e.target.value) selectSymbol(e.target.value);
});

/* ---------- 对比分析 ---------- */

const cmpState = { loaded: false, a: "RB0", b: "HC0" };

function fillCmpOptions() {
  const opts = state.candidates.length
    ? state.candidates.map((c) => `<option value="${c.symbol}">${c.symbol} ${c.name}</option>`).join("")
    : ["RB0", "HC0"].map((s) => `<option value="${s}">${s}</option>`).join("");
  $("cmpA").innerHTML = opts;
  $("cmpB").innerHTML = opts;
  $("cmpA").value = cmpState.a;
  $("cmpB").value = cmpState.b;
}

async function initComparePage() {
  if (!cmpState.loaded) {
    fillCmpOptions();
    cmpState.loaded = true;
  }
  loadCompare();
  loadCorrelation();
}

async function loadCompare() {
  const a = $("cmpA").value, b = $("cmpB").value;
  const mode = $("cmpMode").value, days = $("cmpDays").value;
  cmpState.a = a; cmpState.b = b;
  const el = $("cmpChart");
  el.innerHTML = `<span class="muted small">加载对比数据…</span>`;
  try {
    const d = await api(`/api/compare?symbols=${a},${b}&mode=${mode}&limit=${days}`);
    renderCompareChart(el, d);
    renderCompareStats(d, a, b);
  } catch (e) {
    el.textContent = `对比加载失败：${e.message}`;
    $("cmpStats").innerHTML = "";
  }
}

function renderCompareStats(d, a, b) {
  const box = $("cmpStats");
  const s = d.stats;
  if (!s) {
    box.innerHTML = `<span class="cmp-stat"><span class="k">归一化对比</span>首日=100，看相对强弱</span>`;
    return;
  }
  const ext = s.percentile >= 80 || s.percentile <= 20;
  const unit = d.mode === "ratio" ? "" : "（价差）";
  box.innerHTML = `
    <span class="cmp-stat"><span class="k">当前${unit}</span><b>${s.current}</b></span>
    <span class="cmp-stat"><span class="k">均值</span>${s.mean}</span>
    <span class="cmp-stat"><span class="k">±1σ</span>${s.lower1} ~ ${s.upper1}</span>
    <span class="cmp-stat"><span class="k">区间</span>${s.min} ~ ${s.max}</span>
    <span class="cmp-stat${ext ? " extreme" : ""}"><span class="k">分位</span><b>${s.percentile}%</b>${ext ? " ⚠ 极端" : ""}</span>`;
}

function renderCompareChart(el, d) {
  const items = d.items;
  const w = el.clientWidth || 560, h = 220, padT = 10, padB = 18, padX = 8, padR = 58;
  const plotW = w - padX - padR;
  const n = items.length;
  const all = items.flatMap((it) => it.values.filter((v) => v != null));
  let min = Math.min(...all), max = Math.max(...all);
  if (d.stats) { min = Math.min(min, d.stats.lower2); max = Math.max(max, d.stats.upper2); }
  const span = (max - min) || 1;
  min -= span * 0.05; max += span * 0.05;
  const x = (i) => padX + (i / Math.max(1, n - 1)) * plotW;
  const y = (v) => padT + (1 - (v - min) / (max - min)) * (h - padT - padB);
  const fp = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3));

  const els = [];
  // 网格与右轴
  for (let g = 0; g <= 3; g++) {
    const v = min + ((max - min) * g) / 3;
    const yy = y(v);
    els.push(`<line x1="${padX}" y1="${yy.toFixed(1)}" x2="${padX + plotW}" y2="${yy.toFixed(1)}" stroke="#232b3b" style="stroke:var(--chart-grid)" stroke-dasharray="2 4"/>`);
    els.push(`<text x="${w - padR + 4}" y="${(yy + 3).toFixed(1)}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9">${fp(v)}</text>`);
  }
  // 比价模式：均值/±1σ/±2σ 通道
  if (d.stats) {
    const bands = [
      [d.stats.mean, "#8a93a6", "1", `均值 ${d.stats.mean}`],
      [d.stats.upper1, "#f5a623", "3 3", `+1σ ${d.stats.upper1}`],
      [d.stats.lower1, "#f5a623", "3 3", `-1σ ${d.stats.lower1}`],
      [d.stats.upper2, "#f34e4e", "2 5", `+2σ ${d.stats.upper2}`],
      [d.stats.lower2, "#22c55e", "2 5", `-2σ ${d.stats.lower2}`],
    ];
    for (const [v, c, dash, label] of bands) {
      els.push(`<line x1="${padX}" y1="${y(v).toFixed(1)}" x2="${padX + plotW}" y2="${y(v).toFixed(1)}" stroke="${c}" stroke-width="1" stroke-dasharray="${dash}" opacity="0.7"><title>${label}</title></line>`);
    }
  }
  // 数值线（比价单线 / 归一化多线）
  const colors = ["#f5c542", "#7aa2f7", "#c084fc", "#22c55e"];
  const lineCount = items[0].values.length;
  for (let li = 0; li < lineCount; li++) {
    const pts = items.map((it, i) => (it.values[li] == null ? null : `${x(i).toFixed(1)},${y(it.values[li]).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) els.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${colors[li % colors.length]}" stroke-width="1.5"/>`);
  }
  // 最新点
  const lastVals = items[n - 1].values;
  lastVals.forEach((v, li) => {
    if (v == null) return;
    els.push(`<circle cx="${x(n - 1).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${colors[li % colors.length]}"/>`);
    els.push(`<text x="${(x(n - 1) - 5).toFixed(1)}" y="${(y(v) - 6).toFixed(1)}" fill="${colors[li % colors.length]}" font-size="10" text-anchor="end">${fp(v)}</text>`);
  });
  // X 刻度
  const tickIdx = [...new Set([0, Math.floor(n / 3), Math.floor((2 * n) / 3), n - 1])];
  tickIdx.forEach((i) => {
    els.push(`<text x="${x(i).toFixed(1)}" y="${h - 4}" fill="#8a93a6" style="fill:var(--chart-axis)" font-size="9" text-anchor="middle">${items[i].date.slice(5)}</text>`);
  });
  const legend = d.mode === "normalized"
    ? d.symbols.map((s, i) => `<span><i class="legend-dot" style="background:${colors[i % colors.length]}"></i>${s}</span>`).join("")
    : `<span><i class="legend-dot" style="background:#f5c542"></i>${d.mode === "ratio" ? "比价" : "价差"}</span> <span class="muted">橙虚线 ±1σ · 红/绿虚线 ±2σ</span>`;
  el.innerHTML = `<div class="intraday-legend" style="margin-bottom:4px">${legend}</div><svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${els.join("")}</svg>`;
}

async function loadCorrelation() {
  const box = $("corrMatrix");
  const syms = state.watchlist.slice(0, 8);
  if (syms.length < 2) {
    box.innerHTML = `<span class="muted small">自选不足 2 个品种</span>`;
    return;
  }
  box.innerHTML = `<span class="muted small">计算中…</span>`;
  try {
    const d = await api(`/api/correlation?symbols=${syms.join(",")}&days=${$("corrDays").value}`);
    const n = d.labels.length;
    let html = `<table class="corr-table"><tr><th></th>${d.labels.map((l) => `<th>${l}</th>`).join("")}</tr>`;
    for (let i = 0; i < n; i++) {
      html += `<tr><th>${d.labels[i]}</th>`;
      for (let j = 0; j < n; j++) {
        const v = d.matrix[i][j];
        if (v == null) { html += `<td class="val">--</td>`; continue; }
        const alpha = Math.min(Math.abs(v), 1) * 0.55;
        const bg = v >= 0 ? `rgba(243,78,78,${alpha})` : `rgba(34,197,94,${alpha})`;
        const strong = Math.abs(v) >= 0.7;
        html += `<td class="val" style="background:${bg}" title="${d.labels[i]} vs ${d.labels[j]}：${v}">${strong ? `<b>${v}</b>` : v}</td>`;
      }
      html += `</tr>`;
    }
    box.innerHTML = html + `</table>`;
  } catch (e) {
    box.innerHTML = `<span class="muted small">相关性计算失败：${e.message}</span>`;
  }
}

["cmpA", "cmpB", "cmpMode", "cmpDays"].forEach((id) => {
  $(id).addEventListener("change", loadCompare);
});
$("corrDays").addEventListener("change", loadCorrelation);

$("btnCmpAi").addEventListener("click", () => {
  const a = $("cmpA").value, b = $("cmpB").value;
  const mode = { ratio: "比价", spread: "价差", normalized: "归一化走势对比" }[$("cmpMode").value];
  switchView("work");  // 回到工作台查看 AI 回复
  sendChat(`请从套利/对冲视角分析 ${a} 与 ${b} 的${mode}（${$("cmpDays").value} 个交易日，当前分位与统计见页面数据）：当前处于什么水平、历史极端区间的含义、适合什么样的策略思路与风险点。`);
});

/* ---------- AI 对话历史（存档 + 飞书导出） ---------- */

let chatHistShown = false;

function renderChatHistoryBox() {
  const box = $("chatHistoryBox");
  if (!box) return;
  const msgs = state.chat;
  if (!msgs.length) {
    box.innerHTML = `<div class="muted small monitor-hint">暂无对话历史。工作台的 AI 对话会自动存档到本地，也可导出飞书。</div>`;
    return;
  }
  const fmt = (m, i) => {
    const who = m.role === "user" ? "我" : "AI";
    const safe = m.content.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `<div class="news-item">
      <span class="news-time">${who}</span><span style="white-space:pre-wrap">${safe.slice(0, 260)}</span>
      <button class="cmd-copy" data-i="${i}" title="复制该条">📋</button>
    </div>`;
  };
  box.innerHTML = `<div class="muted small" style="padding:4px 10px;display:flex;justify-content:space-between;align-items:center">
    <span>共 ${msgs.length} 条（最近 60 条自动存档）</span>
    <span>
      <button id="btnChatExport" class="btn accent small-btn">☁ 导出飞书《AI 对话记录》</button>
      <button id="btnChatClear" class="btn ghost small-btn">清空本地</button>
    </span>
  </div>` + msgs.slice(-40).map(fmt).join("");
}

$("btnChatHistory").addEventListener("click", () => {
  chatHistShown = !chatHistShown;
  if (chatHistShown) {
    $("chatHistoryBox").classList.remove("hidden");
    $("notesList").classList.add("hidden");
    renderChatHistoryBox();
  } else {
    $("chatHistoryBox").classList.add("hidden");
    $("notesList").classList.remove("hidden");
  }
});

// 事件委托：导出/清空/复制（容器动态渲染）
document.addEventListener("click", (e) => {
  if (e.target.closest("#btnChatExport")) {
    exportChatToFeishu();
  } else if (e.target.closest("#btnChatClear")) {
    clearChatHistory();
    renderChatHistoryBox();
  } else if (e.target.closest(".cmd-copy")) {
    const i = Number(e.target.closest(".cmd-copy").dataset.i);
    const m = state.chat.slice(-40)[i];
    if (m) {
      navigator.clipboard?.writeText(m.content).then(() => toast("已复制")).catch(() => {});
    }
  }
});

async function exportChatToFeishu() {
  const msgs = state.chat;
  if (!msgs.length) return toast("暂无对话历史", true);
  const content = msgs.map((m) => `${m.role === "user" ? "🧑‍💼 我" : "🤖 AI"}：${m.content}`).join("\n\n");
  try {
    const d = await api("/api/chat-export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, title: "AI 对话记录" }),
    });
    toast(`已导出飞书（共 ${msgs.length} 条）：${d.doc_id ? "文档已更新" : ""}`);
  } catch (e) {
    toast(`导出失败：${e.message}`, true);
  }
}

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
    if (cmpState.loaded) fillCmpOptions();  // 对比页可能先于候选加载完成初始化
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

/* ---------- AI 对话 ---------- */

function renderStoredChat() {
  const box = $("chatBox");
  if (!box || !state.chat.length) return;
  box.innerHTML = "";
  state.chat.slice(-30).forEach((m) => {
    // 复用 pushMsg 渲染结构（不重复存入 history）
    const div = document.createElement("div");
    div.className = "msg " + (m.role === "user" ? "user" : "assistant");
    const who = m.role === "user" ? "我" : "AI 助手";
    div.innerHTML = `<div class="who">${who}</div>`;
    if (m.role === "assistant") {
      const body = document.createElement("div");
      body.className = "md";
      body.innerHTML = renderMarkdown(m.content);
      div.appendChild(body);
    } else {
      div.appendChild(document.createTextNode(m.content));
    }
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function clearChatHistory() {
  state.chat = [];
  localStorage.removeItem("fa_chat_history");
  const box = $("chatBox");
  if (box) box.innerHTML = `<div class="chat-welcome"><p>👋 我是你的期货分析助手，可以结合左侧实时行情回答问题。</p><p class="muted">例如：「螺纹钢现在的盘面怎么看？」「帮我对比一下豆粕和菜粕」「沪铜最近趋势如何」</p><p class="muted small">AI 输出仅代表模型观点，不构成投资建议，请自主决策、注意风控。</p></div>`;
  toast("对话历史已清空");
}

function pushMsg(role, content, cls) {
  state.chat.push({ role, content });
  const box = $("chatBox");
  const div = document.createElement("div");
  div.className = `msg ${cls || role}`;
  const who = role === "user" ? "我" : "AI 助手";
  div.innerHTML = `<div class="who">${who}</div>`;
  if (role === "assistant" && !cls) {
    const body = document.createElement("div");
    body.className = "md";
    body.innerHTML = renderMarkdown(content);
    div.appendChild(body);
  } else {
    div.appendChild(document.createTextNode(content));
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  try {
    localStorage.setItem("fa_chat_history", JSON.stringify(state.chat.slice(-state.chatHistoryLen)));
  } catch (e) { /* 存储满/不可用时静默 */ }
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

async function sendChat(text) {
  text = (text || "").trim();
  if (!text) return;
  try {
    removeWelcome();
    pushMsg("user", text);
  } catch (e) {
    toast(`发送失败：${e.message}`, true);
    return;
  }
  $("chatInput").value = "";

  const typing = document.createElement("div");
  typing.className = "msg assistant";
  typing.innerHTML = `AI 分析中<span class="typing-dots"><span></span><span></span><span></span></span><span class="typing-timer"></span>
    <div class="muted small" style="margin-top:4px">已附带实时行情、技术指标与信号上下文。推理型模型可能需要 1~2 分钟，计时在走即正常等待中。</div>`;
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
    abortTimer = setTimeout(() => ctrl.abort(), 120000);
    const data = await api("/api/ai/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: state.chat.filter((m) => m.role === "user" || m.role === "assistant").slice(-20),
        symbol: state.selected,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(abortTimer);
    clearInterval(tick);
    typing.remove();
    pushMsg("assistant", data.reply);
  } catch (e) {
    if (abortTimer) clearTimeout(abortTimer);
    clearInterval(tick);
    typing.remove();
    const msg = e.name === "AbortError"
      ? "等待超时（超过 2 分钟），请稍后重试或换个更快的模型"
      : `${e.message}\n请检查 AI 设置中的 API Key 是否正确、是否有余额。`;
    pushMsg("assistant", `调用失败：${msg}`, "error");
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
  sendChat(`请结合实时行情、技术指标（均线/MACD/KDJ/RSI/BOLL）和最新信号，综合分析 ${state.selected}（${state.names[state.selected] || ""}）：当前趋势与动能状态、关键支撑压力位、量仓变化含义、指标间的冲突或共振，以及需要关注的风险点。`);
});

/* ---------- AI 设置 ---------- */

async function loadAiConfig() {
  try {
    const cfg = await api("/api/ai/config");
    state.aiReady = cfg.has_key;
    const badge = $("aiBadge");
    badge.textContent = cfg.has_key ? `${cfg.provider_label} · ${cfg.model}` : "未配置 API Key";
    badge.className = "ai-badge" + (cfg.has_key ? " ready" : "");
    $("cfgProvider").value = cfg.provider;
    $("cfgModel").value = cfg.model;
    $("cfgStatus").textContent = cfg.has_key ? "已保存 Key，可直接使用" : "";
    if (cfg.keys_status) {
      $("keyStatus").textContent =
        `Key 状态 — 智谱：${cfg.keys_status.zhipu ? "✓ 已保存" : "✗ 未保存"}　DeepSeek：${cfg.keys_status.deepseek ? "✓ 已保存" : "✗ 未保存"}`;
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

const DEFAULT_MODELS = { zhipu: "glm-4-flash", deepseek: "deepseek-v4-flash-vision-exp" };
$("cfgProvider").addEventListener("change", () => {
  $("cfgModel").value = DEFAULT_MODELS[$("cfgProvider").value] || "";
});

$("btnSaveSettings").addEventListener("click", async () => {
  const body = {
    provider: $("cfgProvider").value,
    model: $("cfgModel").value.trim() || DEFAULT_MODELS[$("cfgProvider").value],
    api_key: $("cfgApiKey").value.trim(),
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
    $("cfgFeishuId").value = "";
    $("cfgFeishuSecret").value = "";
    $("cfgWebhook").value = "";
    $("cfgApiKey").value = "";
    $("cfgStatus").textContent = "已保存 ✓";
    await loadAiConfig();
    pollMonitor();
    toast("AI 配置已保存");
  } catch (e) {
    $("cfgStatus").textContent = `保存失败：${e.message}`;
  }
});

$("btnWebhookTest").addEventListener("click", async () => {
  // 先保存输入框中的 webhook 再测试
  try {
    await api("/api/feishu/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ webhook_url: $("cfgWebhook").value.trim() }),
    });
    await api("/api/feishu/push-test", { method: "POST" });
    $("cfgWebhook").value = "";
    $("cfgStatus").textContent = "推送测试已发送 ✓（去飞书群查看）";
  } catch (e) {
    $("cfgStatus").textContent = `推送测试失败：${e.message}`;
  }
});

$("btnClearKey").addEventListener("click", async () => {  try {
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
  const skinParam = new URLSearchParams(location.search).get("skin");
  applySkin(skinParam || localStorage.getItem("fa_skin") || "dark");
  restoreSplitterState();
  initSplitters();
  renderTable();
  selectSymbol(state.selected);
  renderStoredChat();  // 恢复上次 AI 对话历史
  loadCandidates();
  loadAiConfig();
  pollMonitor();
  pollNews();
  pollIntl();
  // 顶级视图路由：?view=compare|news|notes（兼容旧 ?tab= 参数）；?report=1 直开晨报
  const params = new URLSearchParams(location.search);
  const legacyTab = params.get("tab");
  const view = params.get("view") || (legacyTab === "compare" ? "compare" : legacyTab === "notes" ? "notes" : null);
  if (view) switchView(view);
  if (params.get("report") === "1") $("btnReport").click();
  await doRefresh();
  state.polling = setInterval(doRefresh, 5000);
  setInterval(tickPoll, 2000);

  // 自检模式：打开 /?selftest=1 会自动发一条消息，用于验证对话链路
  if (new URLSearchParams(location.search).get("selftest") === "1") {
    setTimeout(() => sendChat("自检：请只回复『链路正常』四个字"), 4000);
  }

  // 窗口尺寸变化后按新宽度重绘图表（后端有缓存，代价很小）
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(redrawCharts, 300);
  });
})();
