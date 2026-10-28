/* base.js：存储 / API / 工具 / 行情轮询 / 事件流 */
(function () {
  "use strict";
  window.FA = {};

  // ---------- 工具 ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  FA.$ = $; FA.$$ = $$;

  FA.esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  FA.pctCls = (v) => (v > 0 ? "num-up" : v < 0 ? "num-down" : "");
  FA.fmtPct = (v) => (v == null ? "--" : (v > 0 ? "+" : "") + Number(v).toFixed(2) + "%");
  FA.fmtNum = (v, d) => (v == null || isNaN(v) ? "--" : Number(v).toLocaleString("zh-CN", { maximumFractionDigits: d == null ? 2 : d }));

  // 迷你 Markdown（AI 输出渲染）
  FA.md = (src) => {
    let s = FA.esc(src || "");
    s = s.replace(/^### (.*)$/gm, "<h3>$1</h3>")
         .replace(/^## (.*)$/gm, "<h2>$1</h2>")
         .replace(/^# (.*)$/gm, "<h2>$1</h2>")
         .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
         .replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/^- (.*)$/gm, "<li>$1</li>");
    s = s.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, (m) => "<ul>" + m + "</ul>");
    s = s.split(/\n{2,}/).map((p) => (/^\s*<(h|ul)/.test(p) ? p : "<p>" + p.replace(/\n/g, "<br>") + "</p>")).join("");
    return s;
  };

  // ---------- API ----------
  FA.api = async (path, opts) => {
    const res = await fetch(path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch (e) { /* ignore */ }
    if (!res.ok || (data && data.ok === false)) {
      throw new Error((data && data.detail) || ("HTTP " + res.status));
    }
    return data;
  };

  // ---------- 本地存储 ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };
  FA.ls = LS;
  FA.watch = () => LS.get("fa_watch", ["RB0", "SA0", "MA0", "AU0"]);
  FA.setWatch = (arr) => LS.set("fa_watch", arr);

  // ---------- 状态 ----------
  FA.state = {
    quotes: {},      // symbol -> quote
    psych: {},       // symbol -> psych snapshot
    dirItems: [],    // 品种目录
    currentView: "work",
    psychSymbol: "",
  };

  // ---------- 皮肤（4 套主题，色卡选择器 + localStorage + 防闪烁恢复在 index.html 内联脚本） ----------
  const THEMES = [
    { id: "default", name: "深夜蓝", bg: "#0d1117", panel: "#1c2330", accent: "#3b82f6" },
    { id: "light", name: "浅色", bg: "#f3f5f9", panel: "#ffffff", accent: "#2563eb" },
    { id: "warm", name: "暖白纸面", bg: "#faf8f4", panel: "#f2efe8", accent: "#b8720a" },
    { id: "cool", name: "冷灰蓝", bg: "#f0f4f8", panel: "#e6edf5", accent: "#0a6ebd" },
    { id: "mint", name: "薄荷绿", bg: "#f0f8f3", panel: "#e4f1ea", accent: "#0e9f6e" },
    { id: "cream", name: "羊皮纸", bg: "#f7f2e8", panel: "#efe8dc", accent: "#8b6c2a" },
  ];
  function applyTheme(id) {
    // 白名单校验：历史遗留的已删主题 id（rose/sepia 等）自动回落默认
    const known = THEMES.some((t) => t.id === id);
    if (id && known && id !== "default") document.documentElement.setAttribute("data-theme", id);
    else document.documentElement.removeAttribute("data-theme");
    try { localStorage.setItem("fa_theme", known ? id : "default"); } catch (e) { /* ignore */ }
    const pop = $("#themePop");
    if (pop) {
      pop.innerHTML = THEMES.map((t) =>
        '<div class="theme-item' + (t.id === id ? " active" : "") + '" data-t="' + t.id + '">' +
        '<span class="theme-swatch"><i style="background:' + t.bg + '"></i><i style="background:' + t.panel + '"></i><i style="background:' + t.accent + '"></i></span>' +
        '<span>' + t.name + "</span></div>").join("");
      $$(".theme-item", pop).forEach((el) => {
        el.addEventListener("click", () => { applyTheme(el.getAttribute("data-t")); });
      });
    }
  }
  applyTheme(LS.get("fa_theme", "default"));
  const themeBtn = $("#btnTheme");
  if (themeBtn) {
    themeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      $("#themePop").classList.toggle("hidden");
    });
    document.addEventListener("click", (e) => {
      const pop = $("#themePop");
      if (pop && !pop.classList.contains("hidden") && !pop.contains(e.target)) pop.classList.add("hidden");
    });
  }

  // ---------- 时钟与市场状态 ----------
  function tickClock() {
    const el = $("#clock");
    if (el) el.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }
  setInterval(tickClock, 1000); tickClock();

  // ---------- 自选行情轮询 ----------
  let quoteTimer = null;
  let lastQuoteTs = 0;
  async function pollQuotes() {
    const syms = FA.watch();
    if (!syms.length) { $("#watchBody").innerHTML = '<tr><td colspan="6" class="empty">点击「＋ 添加」加入自选品种</td></tr>'; return; }
    try {
      const d = await FA.api("/api/watchlist?symbols=" + encodeURIComponent(syms.join(",")));
      lastQuoteTs = Date.now();
      const ms = $("#marketStatus");
      if (ms) {
        ms.textContent = d.market_open ? "● 交易中" : "○ 休市";
        ms.className = "chip " + (d.market_open ? "open" : "closed");
      }
      // 数据延迟检测（>30 秒无新数据 → 可见警告）
      const staleEl = $("#staleWarn");
      if (staleEl) staleEl.classList.add("hidden");
      d.quotes.forEach((q) => { FA.state.quotes[q.symbol] = q; });
      renderWatch();
      FA.emit && FA.emit("quotes");
    } catch (e) {
      // 静默重试；但连续失败 >30 秒时显示延迟警告
      if (Date.now() - lastQuoteTs > 30000) {
        const staleEl = $("#staleWarn");
        if (staleEl) staleEl.classList.remove("hidden");
      }
    }
  }
  FA.pollQuotes = pollQuotes;

  function trapCell(trap) {
    if (trap == null) return '<span class="muted">--</span>';
    const cls = trap >= 70 ? "high" : trap >= 45 ? "mid" : "low";
    return '<span class="trap ' + cls + '"><span class="trap-bar"><i style="width:' +
      Math.min(100, trap) + '%"></i></span><span class="trap-num">' + trap + '</span></span>';
  }

  function capitalBadge(cap) {
    if (!cap || !cap.state5) return '<span class="badge neutral">数据不足</span>';
    const st = cap.state5;
    const cls = st === "增仓上行" ? "bull" : st === "增仓下行" ? "bear" : "neutral";
    return '<span class="badge ' + cls + '">' + st + "</span>";
  }

  function renderWatch() {
    const body = $("#watchBody");
    if (!body) return;
    const syms = FA.watch();
    const rows = syms.map((sym) => {
      const q = FA.state.quotes[sym];
      const p = FA.state.psych[sym];
      if (!q || q.error) {
        return '<tr data-sym="' + sym + '"><td>' + sym + '</td><td colspan="5" class="muted small">加载中…</td></tr>';
      }
      const oiChg = p && p.oi_chg_today != null ? p.oi_chg_today : null;
      const oiHtml = oiChg == null ? "--" :
        '<span class="' + (oiChg > 0 ? "num-up" : oiChg < 0 ? "num-down" : "") + '">' +
        (oiChg > 0 ? "+" : "") + FA.fmtNum(oiChg, 0) + "</span>";
      const regime = p ? '<span class="muted small">' + FA.esc(p.regime.label) + "</span>" : "";
      return '<tr data-sym="' + sym + '" title="' + FA.esc(p ? p.conclusion : "") + '">' +
        "<td><b>" + FA.esc(q.name || sym) + "</b><br><span class=\"muted small\">" + sym + "</span></td>" +
        '<td class="r">' + FA.fmtNum(q.last) + "</td>" +
        '<td class="r ' + FA.pctCls(q.change_pct) + '">' + FA.fmtPct(q.change_pct) + "</td>" +
        '<td class="r">' + oiHtml + "</td>" +
        "<td>" + capitalBadge(p && p.capital) + (regime ? "<br>" + regime : "") + "</td>" +
        "<td>" + trapCell(p && p.parties && p.parties.retail ? p.parties.retail.trap_risk : null) + "</td>" +
        "</tr>";
    });
    body.innerHTML = rows.join("") || '<tr><td colspan="6" class="empty">暂无自选</td></tr>';
    $$("#watchBody tr").forEach((tr) => {
      tr.addEventListener("click", () => {
        const sym = tr.getAttribute("data-sym");
        FA.openPsych(sym);
      });
    });
  }
  // ---------- 分时图客户端回退（分钟源故障时用 5 秒轮询现价逐点画线） ----------
  FA.intradayFallback = {};   // symbol -> [{t:"HH:MM:SS", p:price}]
  const origRenderWatch = renderWatch;
  renderWatch = function () {
    origRenderWatch();
    // 每 5 秒轮询后，把现价喂给回退缓冲
    Object.keys(FA.state.quotes).forEach((sym) => {
      const q = FA.state.quotes[sym];
      if (q && q.last != null) {
        const buf = FA.intradayFallback[sym] = FA.intradayFallback[sym] || [];
        const now = new Date().toLocaleTimeString("zh-CN", { hour12: false });
        if (!buf.length || buf[buf.length - 1].p !== q.last) {
          buf.push({ t: now, p: q.last });
          if (buf.length > 600) buf.shift();   // 保留最近 50 分钟
        }
      }
    });
  };
  FA.renderWatch = renderWatch;

  // ---------- 心理快照轮询（低频，错峰） ----------
  async function pollPsych() {
    const syms = FA.watch();
    for (let i = 0; i < syms.length; i++) {
      const sym = syms[i];
      try {
        FA.state.psych[sym] = await FA.api("/api/psych/" + encodeURIComponent(sym));
      } catch (e) { /* 跳过该品种 */ }
      renderWatch();
      if (i < syms.length - 1) await new Promise((r) => setTimeout(r, 350));
    }
    FA.emit && FA.emit("psych");
  }
  FA.pollPsych = pollPsych;

  // ---------- 品种目录与搜索 ----------
  async function loadDirectory() {
    try {
      const d = await FA.api("/api/main-list");
      FA.state.dirItems = d.items || [];
      // 自选看板对齐核心品种池：目录（=核心池）之外的旧自选自动移除
      const coreSet = new Set(FA.state.dirItems.map((it) => it.symbol));
      const w = FA.watch().filter((s) => coreSet.has(s));
      if (w.length !== FA.watch().length) {
        FA.setWatch(w);
        if (w.length) pollQuotes();
      }
    } catch (e) { /* 目录失败不阻塞 */ }
    fillSymbolSelects();
    if (!FA.state.dirItems.length) setTimeout(loadDirectory, 60000);  // 目录未就绪/失败退避中，1 分钟后自动重试
  }
  FA.loadDirectory = loadDirectory;

  function fillSymbolSelects() {
    const items = FA.state.dirItems;
    ["#psychSymbol", "#tfSymbol"].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      if (!items.length) {
        // 目录未就绪（数据源限流退避中）：明确提示而非留空，重试到位后自动填充
        el.innerHTML = '<option value="">目录加载中…（每分钟自动重试）</option>';
        return;
      }
      const cur = el.value;
      el.innerHTML = '<option value="">选择品种…</option>' + items.map((it) =>
        '<option value="' + it.symbol + '">' + FA.esc(it.symbol + " " + it.name) + "</option>").join("");
      if (cur) el.value = cur;
    });
    // 聊天品种下拉：自选 + 目录前 60
    const chatSel = $("#chatSymbol");
    if (chatSel) {
      const cur = chatSel.value;
      const watch = FA.watch();
      const extra = items.filter((it) => !watch.includes(it.symbol)).slice(0, 60);
      chatSel.innerHTML = '<option value="">不关联品种</option>' +
        watch.concat(extra.map((i) => i.symbol)).map((s) => {
          const it = items.find((x) => x.symbol === s);
          return '<option value="' + s + '">' + s + " " + FA.esc(it ? it.name : "") + "</option>";
        }).join("");
      if (cur) chatSel.value = cur;
    }
    // 心得页品种候选（datalist）：同样只给核心池
    const dl = $("#coreSymbolList");
    if (dl) {
      dl.innerHTML = items.map((it) =>
        '<option value="' + it.symbol + '">' + FA.esc(it.name) + "</option>").join("");
    }
  }
  FA.fillSymbolSelects = fillSymbolSelects;

  function bindSearch() {
    const btn = $("#btnAddSymbol"), box = $("#symbolSearch"), input = $("#symbolSearchInput"), res = $("#searchResults");
    if (!btn) return;
    btn.addEventListener("click", () => { box.classList.toggle("hidden"); if (!box.classList.contains("hidden")) input.focus(); });
    let timer = null;
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const kw = input.value.trim().toLowerCase();
        if (!kw) { res.innerHTML = ""; return; }
        const items = FA.state.dirItems.filter((it) => {
          const sym = it.symbol.toLowerCase(), nm = (it.name || "").toLowerCase();
          return sym.includes(kw) || nm.includes(kw) || (it.py || "").startsWith(kw) || (it.pyf || "").includes(kw);
        }).slice(0, 30);
        res.innerHTML = items.map((it) =>
          '<div class="search-item" data-sym="' + it.symbol + '"><span>' + FA.esc(it.name) +
          '</span><span class="code">' + it.symbol + " · " + FA.esc(it.exchange) + "</span></div>").join("") ||
          '<div class="search-item muted">无匹配</div>';
        $$(".search-item[data-sym]", res).forEach((el) => {
          el.addEventListener("click", () => {
            const sym = el.getAttribute("data-sym");
            const w = FA.watch();
            if (!w.includes(sym)) { w.push(sym); FA.setWatch(w); }
            input.value = ""; res.innerHTML = ""; box.classList.add("hidden");
            pollQuotes(); pollPsych(); fillSymbolSelects();
          });
        });
      }, 180);
    });
  }
  FA.bindSearch = bindSearch;

  // ---------- 外盘 ----------
  async function pollIntl() {
    const row = $("#intlRow");
    if (!row) return;
    try {
      const d = await FA.api("/api/intl");
      row.innerHTML = (d.items || []).map((it) => {
        if (it.last == null) return '<div class="intl-item"><div class="nm">' + FA.esc(it.name) + '</div><div class="px muted">--</div></div>';
        return '<div class="intl-item"><div class="nm">' + FA.esc(it.name) + '</div><div class="px">' +
          FA.fmtNum(it.last) + ' <span class="small ' + FA.pctCls(it.chg_pct) + '">' + FA.fmtPct(it.chg_pct) + "</span></div></div>";
      }).join("");
    } catch (e) { /* ignore */ }
  }
  FA.pollIntl = pollIntl;

  // ---------- 要闻（辅助参考：品种 + 宏观，5 分钟一轮） ----------
  const NEWS_ICON = { trump: "🇺🇸", mideast: "🌍", fed: "🏦" };
  function newsRow(time, tagHtml, title) {
    const t = (time || "").length >= 5 ? time.slice(-5) : (time || "");
    return '<div class="news-item"><span class="ntime">' + FA.esc(t) + '</span><span class="ntag">' + tagHtml +
      '</span><span class="ntitle" title="' + FA.esc(title) + '">' + FA.esc(title) + "</span></div>";
  }
  async function pollNews() {
    const el = $("#newsList");
    if (!el) return;
    try {
      const d = await FA.api("/api/news?symbols=" + encodeURIComponent(FA.watch().join(",")));
      const variety = (d.variety || []).slice(0, 6);
      const macro = (d.items || []).slice(0, 4);
      el.innerHTML = variety.map((it) =>
        newsRow(it.time, '<span class="vchip">' + FA.esc(it.variety_name || it.prefix || "") + "</span>", it.title)
      ).join("") + macro.map((it) => {
        const icon = (it.groups || []).map((g) => NEWS_ICON[g] || "·").join(" ");
        return newsRow(it.time, icon, it.title);
      }).join("") || '<span class="empty">暂无要闻（品种影响事件 / 特朗普 / 中东 / 美联储）</span>';
    } catch (e) { /* ignore */ }
  }
  FA.pollNews = pollNews;

  // ---------- 事件流 ----------
  // 桌面通知：fatal 级事件与哨兵触发弹系统通知（页面最小化也能看到）；首次点击时申请权限
  let notifyReady = false;
  function requestNotify() {
    if (notifyReady || !("Notification" in window)) return;
    notifyReady = true;
    if (Notification.permission === "default") Notification.requestPermission();
  }
  document.addEventListener("click", requestNotify, { once: true });

  function desktopNotify(ev) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try {
      const body = (ev.text || "").slice(0, 120);
      new Notification(ev.symbol ? `${ev.symbol} 盾预警` : "盾预警", { body, tag: ev.id, silent: false });
    } catch (e) { /* ignore */ }
  }

  function eventHtml(ev) {
    const t = new Date(ev.ts || Date.now());
    const hhmm = t.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    let head = "";
    if (ev.kind === "trail") {
      head = '<span class="esym">' + FA.esc(ev.symbol) + "</span>";
    } else if (ev.kind === "psych") {
      head = '<span class="esym">📡 ' + FA.esc(ev.symbol) + "</span>";
    } else if (ev.kind === "diag") {
      head = '<span class="esym">🚨 诊断</span>';
    } else {
      const chgCls = ev.dir === "up" ? "chg-up" : "chg-down";
      const chgTxt = ev.chg5 != null ? '<span class="' + chgCls + '">' + (ev.chg5 > 0 ? "+" : "") + ev.chg5 + "%</span>" : "";
      head = '<span class="esym">' + FA.esc(ev.symbol) + "</span> " + chgTxt +
        (ev.price != null && ev.price !== "" ? ' <span class="muted small">@ ' + ev.price + "</span>" : "");
    }
    let body = ev.text ? '<div class="etext">' + FA.esc(ev.text) + "</div>" : "";
    if (ev.ai) body += '<div class="eai">' + FA.md(ev.ai) + "</div>";
    const lvl = ev.level ? " level-" + ev.level : "";
    return '<div class="event' + lvl + '"><div class="ehead"><span class="etime">' + hhmm + "</span>" + head + "</div>" + body + "</div>";
  }

  async function pollEvents() {
    const el = $("#eventList");
    if (!el) return;
    try {
      const d = await FA.api("/api/monitor/events?limit=30");
      const evs = d.events || [];
      el.innerHTML = evs.map(eventHtml).join("") || '<div class="empty">暂无事件</div>';
      // 桌面通知：新到的 fatal / 哨兵触发（以 ts 去重，localStorage 记最后通知时间）
      const lastKey = "fa_last_notify_ts";
      const lastTs = LS.get(lastKey, 0);
      let maxTs = lastTs;
      evs.forEach((ev) => {
        const ts = ev.ts || 0;
        if (ts > maxTs) maxTs = ts;
        if (ts > lastTs && (ev.level === "fatal" || ev.kind === "alert")) desktopNotify(ev);
      });
      if (maxTs > lastTs) LS.set(lastKey, maxTs);
    } catch (e) { /* ignore */ }
  }
  FA.pollEvents = pollEvents;
  FA.eventHtml = eventHtml;

  // ---------- 简易事件总线 ----------
  const listeners = {};
  FA.on = (name, fn) => { (listeners[name] = listeners[name] || []).push(fn); };
  FA.emit = (name) => { (listeners[name] || []).forEach((fn) => { try { fn(); } catch (e) { } }); };

  // ---------- 🛡️ 盾状态（60 秒一轮） ----------
  async function pollShield() {
    const grid = $("#shieldGrid");
    if (!grid) return;
    try {
      const d = await FA.api("/api/shield");
      const hint = $("#shieldHint");
      if (hint) {
        const streak = "连续纪律 " + d.streak + " 天";
        hint.textContent = d.no_stop_open > 0
          ? "⚠ " + d.no_stop_open + " 笔未止损 · " + streak
          : streak + (d.active_alerts ? " · 🔔" + d.active_alerts : "");
      }
      const cell = (v, k, cls) =>
        '<div class="stat-cell"><div class="sc-v ' + (cls || "") + '">' + v + '</div><div class="sc-k">' + k + "</div></div>";
      const expCls = (d.exposure_pct == null || d.exposure_pct <= 3) ? "" : d.exposure_pct <= 6 ? "" : "num-up";
      const stopCls = (d.stop_used_pct == null || d.stop_used_pct < 60) ? "" : d.stop_used_pct < 90 ? "" : "num-up";
      let alertLine = "";
      if (d.active_alerts) {
        try {
          const al = await FA.api("/api/alerts");
          alertLine = '<div class="mini-note" style="grid-column:1/-1">' + (al.items || []).slice(-4).map((a) =>
            '🔔 ' + FA.esc(a.symbol) + (a.dir === "above" ? " 升破 " : " 跌破 ") + a.price +
            (a.note ? " · " + FA.esc(a.note) : "") +
            ' <a class="link-btn danger" data-del-alert="' + a.id + '">删</a>').join("　") + "</div>";
        } catch (e) { /* ignore */ }
      }
      // 自动模拟开关 + 战绩 + 信号漏斗
      let simLine = "";
      try {
        const sim = await FA.api("/api/auto-sim");
        const st = sim.stats || {};
        const t = st.today || {};
        const fn = st.funnel || {};
        const fnTxt = fn.scans ? ' <span class="muted">漏斗: ' + fn.scans + "扫→" + (fn.resonance || 0) + "共振→" +
          (fn.funding || 0) + "顺资→" + (fn.opened || 0) + "开" + (fn.gate_blocked ? "（闸拦" + fn.gate_blocked + "）" : "") + "</span>" : "";
        simLine = '<div class="mini-note" style="grid-column:1/-1;display:flex;flex-direction:column;gap:2px">' +
          '<span>🤖 自动模拟 <label style="cursor:pointer"><input type="checkbox" id="simToggle"' + (sim.enabled ? " checked" : "") + '> 启用</label>' +
          (t.count ? ' 今日 ' + t.count + ' 笔 · 胜率 ' + t.win_rate + '% · <b class="' + (t.total_pts > 0 ? "num-up" : t.total_pts < 0 ? "num-down" : "") + '">' + (t.total_pts > 0 ? "+" : "") + t.total_pts + '点</b>' : "（今日暂无平仓）") +
          ' <span class="muted">持仓 ' + (st.open_count || 0) + "</span>" + fnTxt +
          ' <a class="link-btn" id="simBtBtn">📊 策略回测</a></span>' +
          '<div id="simBtBody" class="hidden" style="margin-top:4px"></div></div>';
      } catch (e) { /* ignore */ }
      grid.innerHTML =
        simLine +
        cell(d.blocked_today, "今日闸门拦截", "num-down") +
        cell(d.forced_today, "今日强行违规", d.forced_today ? "num-up" : "") +
        cell((d.exposure_pct == null ? "--" : d.exposure_pct + "%"), "持仓风险敞口", expCls) +
        cell((d.stop_used_pct == null ? "--" : d.stop_used_pct + "%"), "停手线消耗", stopCls) +
        alertLine;
      $$("#shieldGrid [data-del-alert]").forEach((b) => {
        b.addEventListener("click", async () => {
          try { await api("/api/alerts/" + b.getAttribute("data-del-alert"), { method: "DELETE" }); } catch (e) { /* ignore */ }
          pollShield();
        });
      });
      const simTgl = $("#simToggle");
      if (simTgl) {
        simTgl.addEventListener("change", async () => {
          try {
            await FA.api("/api/auto-sim", { method: "POST", body: JSON.stringify({ enabled: simTgl.checked }) });
            pollShield();
          } catch (e) { alert("设置失败：" + e.message); simTgl.checked = !simTgl.checked; }
        });
      }
      const simBtBtn = $("#simBtBtn");
      if (simBtBtn) {
        simBtBtn.addEventListener("click", async () => {
          const body = $("#simBtBody");
          body.classList.remove("hidden");
          body.innerHTML = '<span class="muted small">回测计算中（拉取自选品种历史，首次约 10-30 秒）…</span>';
          try {
            const d = await FA.api("/api/auto-sim/backtest");
            const bt = d.backtest || {};
            if (!bt.n) {
              body.innerHTML = '<span class="muted small">样本不足</span>';
              return;
            }
            const cls = bt.exp_pct < 0 ? "num-down" : "num-up";
            body.innerHTML =
              '<span class="small">近两个月 15 分钟口径：' + bt.n + ' 笔 · 胜率 <b>' + bt.win_rate + '%</b> · 期望 <b class="' + cls + '">' +
              (bt.exp_pct > 0 ? "+" : "") + bt.exp_pct + '%/笔</b> · 均持 ' + bt.avg_bars + ' bar · 最差 ' + bt.worst + '% / 最好 +' + bt.best + '%' +
              '<br>多 ' + (bt.long_n || 0) + ' 笔(胜率' + (bt.long_wr != null ? bt.long_wr + "%" : "--") + '，期望' + (bt.long_exp > 0 ? "+" : "") + (bt.long_exp != null ? bt.long_exp : "--") + '%)' +
              ' ｜ 空 ' + (bt.short_n || 0) + ' 笔(胜率' + (bt.short_wr != null ? bt.short_wr + "%" : "--") + '，期望' + (bt.short_exp > 0 ? "+" : "") + (bt.short_exp != null ? bt.short_exp : "--") + '%)' +
              ' <span class="muted">品种: ' + (bt.universe || []).join(",") + '</span></span>';
          } catch (e) {
            body.innerHTML = '<span class="muted small">回测失败：' + FA.esc(e.message) + "</span>";
          }
        });
      }
    } catch (e) { /* ignore */ }
  }
  FA.pollShield = pollShield;

  // ---------- 热度榜（全市场成交量 Top10，5 分钟一轮） ----------
  async function pollHot() {
    const el = $("#hotList");
    if (!el) return;
    try {
      const d = await FA.api("/api/hot-rank");
      const items = d.items || [];
      el.innerHTML = items.map((it, i) => {
        const vol = it.volume >= 1e8 ? (it.volume / 1e8).toFixed(2) + "亿手"
          : (it.volume / 1e4).toFixed(0) + "万手";
        return '<div class="news-item hot-row" data-sym="' + FA.esc(it.symbol) + '" style="cursor:pointer">' +
          '<span class="ntime">#' + (i + 1) + "</span>" +
          '<span class="ntag">' + (i < 3 ? "🔥" : "") + "</span>" +
          '<span class="ntitle"><b>' + FA.esc(it.name) + "</b> " + FA.esc(it.symbol) +
          ' <span class="' + FA.pctCls(it.change_pct) + '">' + FA.fmtPct(it.change_pct) + "</span>" +
          ' <span class="muted small">' + vol + "</span></span></div>";
      }).join("") || '<span class="empty">行情源暂不可用</span>';
      $$("#hotList .hot-row").forEach((row) => {
        row.addEventListener("click", () => FA.openPsych(row.getAttribute("data-sym")));
      });
    } catch (e) { /* ignore */ }
  }
  FA.pollHot = pollHot;

  // ---------- 启动轮询 ----------
  FA.startPolling = function () {
    pollQuotes(); pollIntl(); pollEvents(); pollNews(); pollShield(); pollHot();
    loadDirectory().then(pollPsych);
    clearInterval(quoteTimer);
    quoteTimer = setInterval(pollQuotes, 5000);
    setInterval(pollEvents, 15000);
    setInterval(pollIntl, 30000);
    setInterval(pollPsych, 60000);
    setInterval(pollNews, 300000);
    setInterval(pollShield, 60000);
    setInterval(pollHot, 300000);
  };

  // 自选删除：行右键移除
  document.addEventListener("contextmenu", (e) => {
    const tr = e.target.closest && e.target.closest("#watchBody tr[data-sym]");
    if (!tr) return;
    e.preventDefault();
    const sym = tr.getAttribute("data-sym");
    if (confirm("从自选移除 " + sym + "？")) {
      FA.setWatch(FA.watch().filter((s) => s !== sym));
      pollQuotes(); pollPsych(); fillSymbolSelects();
    }
  });
})();
