/* m3_panels —— 面板：交易日志/外盘/日历/CSV/快捷键/热力图 */

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

const INTL_CORE = ["CL", "GC", "DINIW"];  // 紧凑模式只显示：WTI / COMEX金 / 美元

async function pollIntl() {
  const bar = $("intlBar");
  if (!bar) return;
  try {
    const d = await api("/api/intl-quotes");
    state.intlQuotes = (d.items || []).filter((q) => !q.error && q.last != null);
    const expanded = store.get("fa_intl_expanded") === "1";
    let items = state.intlQuotes;
    if (!expanded) items = items.filter((q) => INTL_CORE.includes(q.symbol));
    if (!items.length) return;
    bar.classList.toggle("expanded", expanded);
    bar.innerHTML = `<span class="intl-title muted small" title="点击展开/收起">🌍 外盘${expanded ? " ▾" : " ▸"}</span>` + items.map((q) => {
      const cls = q.change_pct >= 0 ? "up" : "down";
      const pct = q.change_pct != null ? `${q.change_pct >= 0 ? "+" : ""}${q.change_pct.toFixed(2)}%` : "--";
      const short = q.name.replace("原油", "油").replace("COMEX ", "").replace("CBOT-", "").replace("WTI ", "WTI").replace("美元指数", "美元");
      const price = q.last >= 1000 ? Math.round(q.last).toLocaleString() : q.last;
      return `<span class="intl-item" title="${q.name} ${q.date} ${q.time}"><span class="n">${short}</span><b class="${cls}">${price}</b> <span class="${cls}">${pct}</span></span>`;
    }).join("");
    renderHeatView();
  } catch (e) { /* 外盘失败静默 */ }
}

$("intlBar").addEventListener("click", () => {
  const next = store.get("fa_intl_expanded") === "1" ? "0" : "1";
  store.set("fa_intl_expanded", next);
  pollIntl();
});

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

/* ---------- 自选迷你走势线（sparkline） ---------- */

const sparkState = { data: {}, ts: 0 };

async function loadSparklines(force = false) {
  const now = Date.now();
  if (!force && now - sparkState.ts < 5 * 60000) return;
  sparkState.ts = now;
  await Promise.all(state.watchlist.map(async (sym) => {
    try {
      const d = await api(`/api/daily/${sym}?limit=30`);
      sparkState.data[sym] = d.items.map((it) => it.close).filter((c) => c != null);
    } catch (e) { /* 单品种失败静默 */ }
  }));
  renderTable();
}

function sparkSvg(closes) {
  if (!closes || closes.length < 2) return "";
  const w = 44, h = 16;
  const min = Math.min(...closes), max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes.map((c, i) => `${(2 + (i / (closes.length - 1)) * (w - 4)).toFixed(1)},${(2 + (1 - (c - min) / span) * (h - 4)).toFixed(1)}`).join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  return `<svg width="${w}" height="${h}" style="display:block"><polyline points="${pts}" fill="none" stroke="${up ? "#f34e4e" : "#22c55e"}" stroke-width="1.2"/></svg>`;
}

/* ---------- CSV 导出 ---------- */

function downloadCSV(name, rows) {
  const csv = "﻿" + rows.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join("," + String.fromCharCode(10)));
const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

$("btnTradesCsv").addEventListener("click", () => {
  const rows = [["日期", "品种", "方向", "开仓价", "止损点", "止盈点", "手数", "AI评级", "状态", "结果(点)", "备注"]];
  tradesState.items.forEach((t) => rows.push([
    t.date, t.symbol, t.direction === "long" ? "多" : "空", t.entry, t.stop_points,
    t.target_points, t.lots, t.ai_grade || "", t.status, t.result_pts ?? "", t.note || "",
  ]));
  downloadCSV(`交易日志_${new Date().toISOString().slice(0, 10)}.csv`, rows);
});

/* ---------- 快捷键速查表 ---------- */

const SHORTCUTS = [
  ["Ctrl + K", "命令面板（搜合约/跳页面/开功能）"],
  ["Alt + 1~6", "切换六个页面"],
  ["1 ~ 6", "K 线周期（详情页，非输入状态）"],
  ["滚轮 / 拖拽", "K 线缩放 / 平移（双击复位）"],
  ["点击分时图", "放置当前标注（双击标注删除）"],
  ["点击 🌍 外盘", "展开/收起外盘全量"],
  ["⏸", "暂停/恢复行情轮询"],
  ["Esc", "关闭弹层"],
];

function toggleShortcuts(force) {
  const m = $("shortcutModal");
  const show = force !== undefined ? force : m.classList.contains("hidden");
  m.classList.toggle("hidden", !show);
}

/* ---------- 开收盘倒计时 ---------- */

const SESSIONS = [["09:00", "10:15"], ["10:30", "11:30"], ["13:30", "15:00"], ["21:00", "23:00"]];

function sessionCountdown() {
  const now = new Date();
  const day = now.getDay();
  if (day === 0 || day === 6) return "周末休市";
  const mins = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const cur = mins(now.toTimeString().slice(0, 5));
  for (const [a, b] of SESSIONS) {
    if (cur >= mins(a) && cur <= mins(b)) return `交易中·距收盘 ${mins(b) - cur} 分`;
    if (cur < mins(a)) {
      const d = mins(a) - cur;
      return `距开盘 ${d >= 60 ? Math.floor(d / 60) + "时" : ""}${d % 60}分`;
    }
  }
  return "今日已收盘";
}


/* ---------- 涨跌热力图（独立视图：国内自选 + 国际，强度着色） ---------- */

function heatTiles() {
  const tiles = [];
  for (const sym of state.watchlist) {
    const q = state.quotes[sym];
    if (q && q.change_pct != null) tiles.push({ sym, name: state.names[sym] || sym, pct: q.change_pct, last: q.last, intl: false });
  }
  for (const q of state.intlQuotes || []) tiles.push({ sym: q.symbol, name: q.name, pct: q.change_pct, last: q.last, intl: true });
  tiles.sort((a, b) => b.pct - a.pct);
  return tiles;
}

function renderHeatView() {
  const dom = $("heatDomestic"), intlBox = $("heatIntl"), stats = $("heatStats");
  if (!dom || currentView() !== "heat") return;
  const tiles = heatTiles();
  if (!tiles.length) {
    dom.innerHTML = `<span class="muted small">等待行情数据…</span>`;
    intlBox.innerHTML = "";
    return;
  }
  const up = tiles.filter((t) => t.pct > 0).length;
  const down = tiles.filter((t) => t.pct < 0).length;
  const flat = tiles.length - up - down;
  const avg = (tiles.reduce((s, t) => s + t.pct, 0) / tiles.length).toFixed(2);
  stats.textContent = `涨 ${up} · 跌 ${down} · 平 ${flat} · 平均 ${avg > 0 ? "+" : ""}${avg}% · 强者居左`;

  const tileHtml = (t) => {
    const a = Math.min(Math.abs(t.pct) / 3, 1) * 0.72 + 0.08;
    const bg = t.pct >= 0 ? `rgba(243,78,78,${a.toFixed(2)})` : `rgba(34,197,94,${a.toFixed(2)})`;
    const tag = t.intl ? "🌍 " : "";
    const lp = t.last != null ? (t.last >= 1000 ? Math.round(t.last).toLocaleString() : t.last) : "--";
    return `<div class="heat-big" data-hsym="${t.sym}" style="background:${bg}" title="${t.name}">
      <span class="hs">${tag}${t.sym}</span><span class="hn">${t.name}</span>
      <span class="hp">${t.pct >= 0 ? "+" : ""}${t.pct.toFixed(2)}%</span>
      <span class="hl">${lp}</span>
    </div>`;
  };
  const domTiles = tiles.filter((t) => !t.intl);
  const intlTiles = tiles.filter((t) => t.intl);
  dom.innerHTML = domTiles.length ? `<div class="heat-grid">${domTiles.map(tileHtml).join("")}</div>` : `<span class="muted small">暂无国内自选</span>`;
  intlBox.innerHTML = intlTiles.length ? `<div class="heat-group-title">🌍 国际品种</div><div class="heat-grid">${intlTiles.map(tileHtml).join("")}</div>` : "";
}


// 热力图色块点击 → 直达详情
document.querySelector(".heat-view").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-hsym]");
  if (tile) {
    selectSymbol(tile.dataset.hsym);
    switchView("detail");
  }
});
