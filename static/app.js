/* 期货实时分析助手 - 前端逻辑 */

const $ = (id) => document.getElementById(id);

const state = {
  watchlist: JSON.parse(localStorage.getItem("fa_watchlist") || "null") || ["RB0", "CU0", "M0", "SC0", "IF0"],
  selected: localStorage.getItem("fa_selected") || null,
  quotes: {},        // symbol -> quote
  names: {},         // symbol -> name/exchange（来自主力列表）
  chat: [],          // {role, content}
  aiReady: false,
  polling: null,
  sort: { key: null, dir: -1 },                          // 表格排序
  alarms: JSON.parse(localStorage.getItem("fa_alarms") || "{}"), // {sym: {up, down}}
  prevLast: {},     // symbol -> 上次最新价（用于闪烁）
  ticks: { sym: null, points: [] },   // 实时走势：本次会话对选中合约的 5 秒采样
  refreshCount: 0,  // 轮询计数（分时图自动刷新节流）
  klinePeriod: "day",                 // K线周期
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
    $("lastUpdate").textContent = data.ts ? new Date(data.ts).toLocaleTimeString("zh-CN") : "";
    recordTick();
    if (state.selected && state.quotes[state.selected]) renderQuoteArea();
    // 行情到达后补画一次分时图（选中时行情未到，昨结线缺失）
    if (state.selected && state.quotes[state.selected]?.prev_settle != null && !state.intradayDrawn) {
      state.intradayDrawn = true;
      loadIntraday(state.selected);
    }
    // 交易时段内每 30 秒（6 轮轮询）静默刷新一次分时图与 K 线；每 20 秒拉一次盯盘事件
    state.refreshCount += 1;
    if (data.market_open && state.refreshCount % 6 === 0 && state.selected) {
      loadIntraday(state.selected);
      loadKline(state.selected);
    }
    if (state.refreshCount % 4 === 0) pollMonitor();
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
  renderAnalysisArea();
  renderSignalArea();
  updateAlarmRow();
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
      </div>
      <div id="intradayChart"><span class="muted small">分时加载中…</span></div>
    </div>
    <div class="kline-wrap">
      <div class="kline-head">
        <span class="kline-title">K 线 · <span class="muted">MA5 <i class="legend-dot" style="background:#ffffff"></i> MA10 <i class="legend-dot" style="background:#f5c542"></i> MA20 <i class="legend-dot" style="background:#c084fc"></i></span></span>
        <div class="period-tabs" id="periodTabs">
          ${Object.keys(PERIOD_LABEL).map((p) => `<button data-p="${p}" class="${state.klinePeriod === p ? "active" : ""}">${PERIOD_LABEL[p]}</button>`).join("")}
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
  const label = opts.minMax !== false ? `<text x="${pad}" y="11" fill="#8a93a6" font-size="10">${max}</text><text x="${pad}" y="${h - 5}" fill="#8a93a6" font-size="10">${min}</text>` : "";
  container.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${polylines}${label}</svg>`;
}

/* ---------- K 线蜡烛图（红涨绿跌 + MA + 成交量副图 + 信号标记 + 十字光标） ---------- */

const PERIOD_LABEL = { "1m": "1分", "5m": "5分", "15m": "15分", "30m": "30分", "60m": "60分", "day": "日K" };

async function loadKline(sym) {
  const el = $("klineChart");
  if (!el) return;
  try {
    const d = await api(`/api/kline/${sym}?period=${state.klinePeriod}&limit=90`);
    if (!d.items.length) { el.textContent = "暂无K线数据"; return; }
    renderKlineChart(el, d);
    const tabs = document.querySelectorAll("#periodTabs button");
    tabs.forEach((b) => b.classList.toggle("active", b.dataset.p === state.klinePeriod));
  } catch (e) {
    el.textContent = `K线加载失败：${e.message}`;
  }
}

function renderKlineChart(el, data) {
  const items = data.items;
  const w = el.clientWidth || 540;
  const padL = 6, padR = 58, padT = 8, mainH = 225, gap = 6, volH = 56, padB = 18;
  const plotW = w - padL - padR;
  const n = items.length;
  const cw = plotW / n;
  const volTop = padT + mainH + gap;
  const volBase = volTop + volH - 4;

  const highs = [], lows = [];
  items.forEach((it) => { highs.push(it.high ?? it.close ?? 0); lows.push(it.low ?? it.close ?? 0); });
  for (const k of ["ma5", "ma10", "ma20"]) {
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
  // 均线
  const maColors = { ma5: "#ffffff", ma10: "#f5c542", ma20: "#c084fc" };
  for (const [k, c] of Object.entries(maColors)) {
    const pts = items.map((it, i) => (it[k] == null ? null : `${cx(i).toFixed(1)},${yMain(it[k]).toFixed(1)}`)).filter(Boolean);
    if (pts.length > 1) els.push(`<polyline points="${pts.join(" ")}" fill="none" stroke="${c}" stroke-width="1" opacity="0.9"/>`);
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
function renderIntradayChart(el, items, prevSettle) {
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
}

async function loadIntraday(sym) {
  try {
    const data = await api(`/api/intraday/${sym}`);
    const el = $("intradayChart");
    const dateEl = $("intradayDate");
    if (dateEl) dateEl.textContent = `（${data.date}）`;
    if (!el) return;
    if (!data.items.length) { el.textContent = "暂无分时数据"; return; }
    renderIntradayChart(el, data.items, state.quotes[sym]?.prev_settle);
  } catch (e) {
    const el = $("intradayChart");
    if (el) el.textContent = "分时数据加载失败";
  }
}

async function loadSparkline(sym) { /* 已被 K 线图替代，保留空实现避免旧引用 */ }

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
          ${e.ai ? `<div class="mon-ai">💡 ${e.ai}</div>` : `<div class="mon-ai muted">AI 解读生成中…</div>`}
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

/* ---------- 主题要闻（原油/黄金） ---------- */

const newsState = { seen: new Set(), loaded: false, keywords: [] };

function highlightKeywords(text) {
  let html = text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  for (const kw of newsState.keywords) {
    if (!kw) continue;
    try {
      html = html.replace(new RegExp(`(${kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    } catch (e) { /* 忽略非法正则 */ }
  }
  return html;
}

async function pollNews() {
  try {
    const d = await api("/api/news");
    newsState.keywords = d.keywords || [];
    const list = $("newsList");
    if (!list) return;
    if (!d.items.length) {
      list.innerHTML = `<div class="muted small monitor-hint">暂无要闻（数据源可能暂时不可用）</div>`;
      return;
    }
    // 新命中的要闻提醒（首次加载静默）
    if (newsState.loaded && newsState.seen.size) {
      for (const it of d.items.slice(0, 10)) {
        const key = it.title;
        if (it.matched && !newsState.seen.has(key)) {
          toast(`📰 ${it.title.slice(0, 46)}${it.title.length > 46 ? "…" : ""}`);
        }
      }
    }
    d.items.forEach((it) => newsState.seen.add(it.title));
    newsState.loaded = true;
    list.innerHTML = d.items
      .map((it) => {
        const hm = it.time ? it.time.slice(11, 16) : "";
        const day = it.time ? it.time.slice(5, 10) : "";
        const body = it.link
          ? `<a href="${it.link}" target="_blank" rel="noopener" title="${(it.summary || "").replace(/"/g, "&quot;")}">${highlightKeywords(it.title)}</a>`
          : `<span title="${(it.summary || "").replace(/"/g, "&quot;")}">${highlightKeywords(it.title)}</span>`;
        return `<div class="news-item${it.matched ? " matched" : ""}">
          <span class="news-time">${day} ${hm}</span>${body}<span class="news-src">${it.source}</span>
        </div>`;
      })
      .join("");
  } catch (e) { /* 新闻轮询失败静默 */ }
}

document.querySelectorAll(".mon-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mon-tab").forEach((b) => b.classList.toggle("active", b === btn));
    $("monitorList").classList.toggle("hidden", btn.dataset.tab !== "monitor");
    $("newsList").classList.toggle("hidden", btn.dataset.tab !== "news");
    if (btn.dataset.tab === "news" && !newsState.loaded) pollNews();
  });
});

/* ---------- 中栏 Tab：合约详情 / 对比分析 ---------- */

document.querySelectorAll("[data-dtab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-dtab]").forEach((b) => b.classList.toggle("active", b === btn));
    $("detailPane").classList.toggle("hidden", btn.dataset.dtab !== "detail");
    $("comparePane").classList.toggle("hidden", btn.dataset.dtab !== "compare");
    if (btn.dataset.dtab === "detail") {
      $("detailTime").textContent = $("detailTime").dataset.txt || "";
    } else {
      $("detailTime").dataset.txt = $("detailTime").textContent;
      $("detailTime").textContent = "";
      initComparePage();
    }
  });
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
    els.push(`<line x1="${padX}" y1="${yy.toFixed(1)}" x2="${padX + plotW}" y2="${yy.toFixed(1)}" stroke="#232b3b" stroke-dasharray="2 4"/>`);
    els.push(`<text x="${w - padR + 4}" y="${(yy + 3).toFixed(1)}" fill="#8a93a6" font-size="9">${fp(v)}</text>`);
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
    els.push(`<text x="${x(i).toFixed(1)}" y="${h - 4}" fill="#8a93a6" font-size="9" text-anchor="middle">${items[i].date.slice(5)}</text>`);
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
  sendChat(`请从套利/对冲视角分析 ${a} 与 ${b} 的${mode}（${$("cmpDays").value} 个交易日，当前分位与统计见页面数据）：当前处于什么水平、历史极端区间的含义、适合什么样的策略思路与风险点。`);
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
    if (cmpState.loaded) fillCmpOptions();  // 对比页可能先于候选加载完成初始化
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

const DEFAULT_MODELS = { zhipu: "glm-4-flash", deepseek: "deepseek-chat" };
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
    $("cfgApiKey").value = "";
    $("cfgStatus").textContent = "已保存 ✓";
    await loadAiConfig();
    pollMonitor();
    toast("AI 配置已保存");
  } catch (e) {
    $("cfgStatus").textContent = `保存失败：${e.message}`;
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
  // 支持 ?tab=compare 直链对比页 / ?report=1 直开晨报
  const params = new URLSearchParams(location.search);
  if (params.get("tab") === "compare") document.querySelector('[data-dtab="compare"]').click();
  if (params.get("report") === "1") $("btnReport").click();
  await doRefresh();
  state.polling = setInterval(doRefresh, 5000);

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
