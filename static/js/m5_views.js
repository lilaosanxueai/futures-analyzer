/* m5_views —— 视图：路由/对比/晨报/搜索/AI对话 */

/* ---------- 顶级视图路由（标签切换界面） ---------- */

const VIEW_ORDER = ["work", "detail", "compare", "news", "notes", "trades", "heat"];

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
  if (name === "heat") renderHeatView();
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});

// 快捷键：Alt+1..6 切换视图
document.addEventListener("keydown", (e) => {
  if (e.key === "?" && !["INPUT", "SELECT", "TEXTAREA"].includes((document.activeElement || {}).tagName)) {
    toggleShortcuts();
  }
  if (e.altKey && /^[1-7]$/.test(e.key)) {
    switchView(VIEW_ORDER[Number(e.key) - 1]);
    e.preventDefault();
  }
});

// 详情视图顶部合约选择
$("detailSym").addEventListener("change", (e) => {
  if (e.target.value) selectSymbol(e.target.value);
});

/* ---------- 对比分析 ---------- */

const cmpState = { loaded: false, a: null, b: null };  // 默认取自选前两个

function fillCmpOptions() {
  const dom = state.watchlist
    .map((s) => `<option value="${s}">${s} ${state.names[s] || ""}</option>`).join("");
  const intl = INTL_LIST
    .map((c) => `<option value="${c.symbol}">${c.symbol} ${c.name}</option>`).join("");
  const opts = `<optgroup label="🇨🇳 国内自选">${dom}</optgroup><optgroup label="🌍 国际品种">${intl}</optgroup>`;
  $("cmpA").innerHTML = opts;
  $("cmpB").innerHTML = opts;
  // 默认：自选前两个；不足则用国际补位
  if (!cmpState.a) cmpState.a = state.watchlist[0] || "CL";
  if (!cmpState.b || cmpState.b === cmpState.a) {
    cmpState.b = state.watchlist[1] || (INTL_LIST[0].symbol !== cmpState.a ? "CL" : "GC");
  }
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
  store.remove("fa_chat_history");
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
    store.set("fa_chat_history", state.chat.slice(-state.chatHistoryLen));
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
