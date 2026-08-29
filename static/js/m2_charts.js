/* m2_charts —— 图表：详情/K线/Tick/分时/图形标注 */

/* ---------- 实时走势（本次会话的 5 秒采样轨迹） ---------- */


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

function annotStore() { return store.get("fa_annot", {}); }
function saveAnnotStore(s) { store.set("fa_annot", s); }
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
