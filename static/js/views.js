/* views.js：品种博弈视图 / 交易诊断视图 / 心得视图 / 弹窗 */
(function () {
  "use strict";
  const { $, $$, esc, api, md, fmtNum, fmtPct, pctCls } = FA;

  // ---------- 页签切换 ----------
  $$(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      $$(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const v = t.getAttribute("data-view");
      FA.state.currentView = v;
      $$(".view").forEach((s) => s.classList.remove("active"));
      $("#view-" + v).classList.add("active");
      if (v === "trades") { loadTrades(); loadStats(); loadDiagnosis(); }
      if (v === "notes") loadNotes();
    });
  });

  // 所有 data-close 按钮关闭弹窗
  $$("[data-close]").forEach((b) => {
    b.addEventListener("click", () => $("#" + b.getAttribute("data-close")).classList.add("hidden"));
  });
  $$(".modal-mask").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.add("hidden"); });
  });

  // ================================================================ 品种博弈视图

  FA.openPsych = function (sym) {
    FA.state.psychSymbol = sym;
    const sel = $("#psychSymbol");
    if (sel) sel.value = sym;
    $$(".tab").forEach((x) => x.classList.toggle("active", x.getAttribute("data-view") === "psych"));
    $$(".view").forEach((s) => s.classList.remove("active"));
    $("#view-psych").classList.add("active");
    FA.state.currentView = "psych";
    loadPsych(sym);
  };

  $("#psychSymbol").addEventListener("change", (e) => { if (e.target.value) loadPsych(e.target.value); });
  $("#btnPsychRefresh").addEventListener("click", () => { if (FA.state.psychSymbol) loadPsych(FA.state.psychSymbol, true); });

  async function loadPsych(sym, force) {
    FA.state.psychSymbol = sym;
    $("#psychPrice").textContent = "…";
    $("#psychChg").textContent = "";
    $("#psychInfo").textContent = "";
    $("#psychBody").innerHTML = '<div class="empty pad">博弈快照计算中…</div>';
    let snap;
    try {
      snap = await api("/api/psych/" + encodeURIComponent(sym) + (force ? "?force=1" : ""));
    } catch (e) {
      $("#psychBody").innerHTML = '<div class="empty pad">快照获取失败：' + esc(e.message) + "</div>";
      return;
    }
    FA.state.psych[sym] = snap;
    renderPsychHeader(snap);
    renderPsychBody(snap);
    loadMiniChart(sym);
    loadIntradayChart(sym);
  }
  FA.loadPsych = loadPsych;

  function renderPsychHeader(s) {
    $("#psychPrice").textContent = fmtNum(s.last);
    const chg = $("#psychChg");
    chg.textContent = fmtPct(s.change_pct);
    chg.className = "psych-chg " + pctCls(s.change_pct);
    const oi = s.oi_chg_today != null
      ? "，持仓较昨收 " + (s.oi_chg_today > 0 ? "+" : "") + fmtNum(s.oi_chg_today, 0)
      : "";
    $("#psychInfo").textContent = (s.name || "") + " · 持仓 " + fmtNum(s.position, 0) + oi + " · " + (s.time || "");
  }

  function partyCard(key, title, p, isRetail) {
    let inner = "";
    if (isRetail) {
      const think = (p.thinking || []).map((t) => "<li>" + esc(t) + "</li>").join("");
      const act = (p.actions || []).map((t) => "<li>" + esc(t) + "</li>").join("");
      const natureHtml = (p.nature || []).map((n) =>
        '<span class="badge warn" style="margin:1px 3px 1px 0" title="' + esc(n.text) + '">' + esc(n.tag === "loss_aversion" ? "损失厌恶" :
          n.tag === "disposition" ? "处置效应" : n.tag === "anchoring" ? "锚定" : n.tag === "recency" ? "近因外推" :
          n.tag === "fomo" ? "踏空焦虑" : n.tag === "fair_world" ? "公平世界幻觉" : n.tag === "confirmation" ? "确认偏误" : "控制幻觉") + "</span>").join("");
      const trap = p.trap_risk != null
        ? '<div class="pc-row"><b>陷阱指数</b><span class="' + (p.trap_risk >= 70 ? "num-up" : p.trap_risk >= 45 ? "" : "num-down") + '" style="font-weight:700">' + p.trap_risk + "/100</span></div>"
        : "";
      inner = trap +
        (natureHtml ? '<div class="pc-row"><b>人性定律</b><div>' + natureHtml + "</div></div>" : "") +
        '<div class="pc-row"><b>散户在想</b></div><ul>' + (think || "<li>--</li>") + "</ul>" +
        '<div class="pc-row" style="margin-top:6px"><b>可能操作</b></div><ul>' + (act || "<li>--</li>") + "</ul>";
    } else {
      inner = '<div class="pc-row"><b>证据</b><span>' + esc(p.evidence || "--") + "</span></div>" +
        '<div class="pc-row"><b>意图</b><span>' + esc(p.intent || "--") + "</span></div>" +
        '<div class="pc-row"><b>置信度</b><span class="muted">' + esc(p.confidence || "--") + "</span></div>";
    }
    return '<div class="party-card' + (isRetail ? " retail" : "") + '">' +
      '<div class="pc-head"><h3>' + title + '</h3><span class="pc-stance">' + esc(p.stance || "") + "</span></div>" + inner + "</div>";
  }

  function renderPsychBody(s) {
    const t = s.trend || {}, cap = s.capital || {}, intra = s.intraday || {}, r = s.parties.retail;
    const factors = (cap.factors || []).map((f) => '<div class="kv"><span class="k">·</span><span class="v" style="text-align:left">' + esc(f) + "</span></div>").join("");
    const warns = (s.warnings || []).map((w) => "<li>" + esc(w) + "</li>").join("");
    const trapsHtml = (s.traps || []).length
      ? (s.traps).map((t) =>
          '<div class="trap-item"><div class="t-name">' + esc(t.name) + '</div><div class="t-evi">' + esc(t.evidence) + '</div><div class="t-note">→ ' + esc(t.note) + "</div></div>").join("")
      : '<div class="empty">未检测到典型陷阱结构（扫损/假突破/双杀/关口扎堆均未触发）</div>';

    const html = `
      <div class="regime-banner">
        <div>
          <div class="rb-label">${esc(s.regime.label)} <span class="badge info" title="${esc((s.cycle || {}).desc || "")}">博弈周期：${esc((s.cycle || {}).stage || "--")}</span></div>
          <div class="rb-desc">${esc(s.regime.desc)}</div>
        </div>
        <div class="rb-conclusion">${esc(s.conclusion || "")}</div>
      </div>

      <div class="card" id="intradayCard">
        <div class="card-head"><h2>日内分时走势 <span class="muted small">1 分钟线 · 黄线=均价 · 虚线=昨结</span></h2><span class="muted small" id="intradayTime"></span></div>
        <canvas id="intradayChart" class="mini-chart" style="height:200px"></canvas>
      </div>

      <div class="psych-grid">
        ${partyCard("industry", "🏭 产业（套保盘）", s.parties.industry)}
        ${partyCard("institution", "🏦 主力（机构资金）", s.parties.institution)}
        ${partyCard("speculator", "⚡ 投机（短线热钱）", s.parties.speculator)}
        ${partyCard("retail", "🐑 散户（群体心理）", r, true)}
      </div>

      <div class="warning-box trap-box">
        <h3>🪤 陷阱检测（结构 · 价位 · 时间）</h3>
        ${trapsHtml}
      </div>

      <div class="warning-box">
        <h3>⚠ 此刻对散户最危险的行为</h3>
        <ul>${warns || "<li>暂无特定警告</li>"}</ul>
      </div>

      <div class="follow-box">
        <h3>🧭 反幻想 · 顺应结论</h3>
        <div class="fantasy">💎 要拆穿的幻想：${esc(s.playbook.fantasy)}</div>
        <div class="fantasy">🎭 主力动机：${esc(s.playbook.force_motive || s.playbook.main_force)}</div>
        ${s.playbook.harvest_chain ? '<div class="fantasy">⛓️ 收割链：' + esc(s.playbook.harvest_chain) + "</div>" : ""}
        <div class="follow">→ ${esc(s.follow)}</div>
      </div>

      <div class="psych-cols">
        <div class="card">
          <div class="card-head"><h2>价格位置（大势）</h2></div>
          <canvas id="psychChart" class="mini-chart"></canvas>
          <div class="kv-list">
            <div class="kv"><span class="k">60日区间</span><span class="v">${fmtNum(t.lo60)} ~ ${fmtNum(t.hi60)}（${t.pct60 == null ? "--" : t.pct60 + "% 分位"}）</span></div>
            <div class="kv"><span class="k">20日中枢（大势分界）</span><span class="v">${fmtNum(t.ma20)}，${t.above_ma20 ? "价格在上方" : t.above_ma20 === false ? "价格在下方" : "--"}${t.ma20_rising == null ? "" : "，中枢" + (t.ma20_rising ? "抬升" : "下移")}</span></div>
            <div class="kv"><span class="k">动量</span><span class="v">5日 ${fmtPct(t.chg5)} / 20日 ${fmtPct(t.chg20)}</span></div>
            <div class="kv"><span class="k">大势偏向</span><span class="v">${t.bias === "up" ? "上行" : t.bias === "down" ? "下行" : "震荡"}</span></div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h2>资金博弈证据（价 × 量 × 持仓）</h2></div>
          <div class="kv-list">
            <div class="kv"><span class="k">日线八状态</span><span class="v">${esc(cap.state5 || "数据不足")}</span></div>
            <div class="kv"><span class="k">5日价/持仓</span><span class="v">${fmtPct(cap.price_chg5)} / ${fmtPct(cap.oi_chg5)}</span></div>
            <div class="kv"><span class="k">20日持仓趋势</span><span class="v">${fmtPct(cap.oi_trend20)}${cap.oi_pct != null ? "（拥挤度 " + cap.oi_pct + "% 分位" + (cap.oi_pct >= 80 ? "，拥挤" : "") + "）" : ""}</span></div>
            <div class="kv"><span class="k">量能（vs 60日均量）</span><span class="v">${cap.vol_ratio == null ? "--" : cap.vol_ratio + "×"}（资金评分 ${cap.score > 0 ? "+" : ""}${cap.score}，${esc(cap.bias)}）</span></div>
            <div class="kv"><span class="k">日内八状态</span><span class="v">${esc(intra.state || "数据不足")}${intra.pos_chg15 != null ? "（15分持仓 " + (intra.pos_chg15 > 0 ? "+" : "") + fmtNum(intra.pos_chg15, 0) + "）" : ""}</span></div>
            <div class="kv"><span class="k">日内区间分位</span><span class="v">${intra.pos_pct == null ? "--" : intra.pos_pct + "%"}（${fmtNum(intra.day_low)} ~ ${fmtNum(intra.day_high)}）</span></div>
            <div class="kv"><span class="k">日内动能</span><span class="v">5分 ${fmtPct(intra.chg5m)} / 15分 ${fmtPct(intra.chg15m)}${intra.streak ? "，连续 " + Math.abs(intra.streak) + " 根" + (intra.streak > 0 ? "阳" : "阴") + "线" : ""}</span></div>
            ${factors}
          </div>
        </div>
      </div>

      <div class="card" id="psychAiCard" style="display:none">
        <div class="card-head"><h2>🤖 AI 深度解读</h2></div>
        <div class="md-block" id="psychAiBody"></div>
      </div>`;
    $("#psychBody").innerHTML = html;
  }

  // 迷你收盘价折线（纯价格位置，无指标）
  async function loadMiniChart(sym) {
    try {
      const d = await api("/api/daily/" + encodeURIComponent(sym) + "?limit=90");
      const closes = (d.items || []).map((x) => x.close).filter((v) => v != null);
      const cv = $("#psychChart");
      if (!cv || closes.length < 5) return;
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 600, h = 170;
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext("2d");
      ctx.scale(dpr, dpr);
      const cs = getComputedStyle(document.body);
      const up = cs.getPropertyValue("--up").trim() || "#f34e4e";
      const grid = cs.getPropertyValue("--chart-grid").trim() || "#232b3b";
      const mut = cs.getPropertyValue("--muted").trim() || "#8a93a6";
      const lo = Math.min(...closes), hi = Math.max(...closes);
      const pad = (hi - lo) * 0.08 || 1;
      const y = (v) => h - 18 - ((v - lo + pad) / (hi - lo + pad * 2)) * (h - 30);
      const x = (i) => 8 + (i / (closes.length - 1)) * (w - 16);
      // 网格 + 标签
      ctx.strokeStyle = grid; ctx.fillStyle = mut; ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach((f) => {
        const yy = 12 + f * (h - 30);
        ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(w, yy); ctx.stroke();
        const val = hi + pad - f * (hi - lo + pad * 2);
        ctx.fillText(val.toFixed(0), 4, yy - 3);
      });
      // 折线（涨红跌绿按整体趋势）
      const rising = closes[closes.length - 1] >= closes[0];
      ctx.strokeStyle = rising ? up : cs.getPropertyValue("--down").trim() || "#22c55e";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      closes.forEach((c, i) => (i ? ctx.lineTo(x(i), y(c)) : ctx.moveTo(x(i), y(c))));
      ctx.stroke();
      // 最新点
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(x(closes.length - 1), y(closes[closes.length - 1]), 3, 0, 7); ctx.fill();
      ctx.fillStyle = mut;
      ctx.fillText("近 " + closes.length + " 日收盘（仅示位置，非买卖依据）", 8, h - 4);
    } catch (e) { /* 图表失败不影响页面 */ }
  }

  // 日内分时走势（1 分钟线 + 均价线 + 昨结基准 + 持仓止损/入场线；品种博弈页停留时每分钟自动刷新）
  let intradayTimer = null;
  async function loadIntradayChart(sym) {
    try {
      const d = await api("/api/intraday/" + encodeURIComponent(sym));
      const cv = $("#intradayChart");
      if (!cv) return;
      const items = d.items || [];
      if (items.length < 5) return;
      // 该品种当前持仓 → 画入场线与止损线（看得见的盾）
      let hold = null;
      try {
        const tr = (await api("/api/trades")).items.find((x) => x.status === "open" && x.symbol === sym);
        if (tr) {
          const sg = tr.direction === "long" ? 1 : -1;
          hold = { entry: tr.entry, stop: tr.stop_points ? tr.entry - sg * tr.stop_points : null };
        }
      } catch (e) { /* ignore */ }
      const timeEl = $("#intradayTime");
      if (timeEl) timeEl.textContent = d.count + " 根 · " + (d.time || "") + (hold ? " · 🛡️ 已叠加持仓线" : "");
      const dpr = window.devicePixelRatio || 1;
      const w = cv.clientWidth || 640, h = 200;
      cv.width = w * dpr; cv.height = h * dpr;
      const ctx = cv.getContext("2d");
      ctx.scale(dpr, dpr);
      const cs = getComputedStyle(document.body);
      const up = cs.getPropertyValue("--up").trim() || "#f34e4e";
      const down = cs.getPropertyValue("--down").trim() || "#22c55e";
      const grid = cs.getPropertyValue("--chart-grid").trim() || "#232b3b";
      const mut = cs.getPropertyValue("--muted").trim() || "#8a93a6";
      const danger = cs.getPropertyValue("--danger").trim() || "#ef4444";
      const prices = items.map((x) => x.p);
      const vals = prices.concat(items.map((x) => x.a));
      if (d.prev_settle) vals.push(d.prev_settle);
      if (d.last != null) vals.push(d.last);  // 实时价可能超出分钟线范围，纳入刻度防圆点出界
      if (hold) { vals.push(hold.entry); if (hold.stop != null) vals.push(hold.stop); }
      let lo = Math.min(...vals), hi = Math.max(...vals);
      const pad = (hi - lo) * 0.1 || hi * 0.002;
      lo -= pad; hi += pad;
      const top = 10, bottom = 22;
      const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom);
      const x = (i) => 44 + (i / (items.length - 1)) * (w - 56);
      // 网格与价格刻度
      ctx.strokeStyle = grid; ctx.fillStyle = mut; ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
      [0, 0.5, 1].forEach((f) => {
        const yy = top + f * (h - top - bottom);
        ctx.beginPath(); ctx.moveTo(40, yy); ctx.lineTo(w - 8, yy); ctx.stroke();
        const val = hi - f * (hi - lo);
        ctx.fillText(val.toFixed(0), 2, yy + 3);
      });
      // 昨结基准（虚线）
      if (d.prev_settle) {
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = mut;
        ctx.beginPath(); ctx.moveTo(40, y(d.prev_settle)); ctx.lineTo(w - 8, y(d.prev_settle)); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = mut;
        ctx.fillText("昨结 " + Number(d.prev_settle).toFixed(0), w - 78, y(d.prev_settle) - 4);
      }
      // 持仓线：入场（灰点线）与止损（红虚线）——危险线看得见
      if (hold) {
        ctx.save();
        ctx.setLineDash([2, 3]);
        ctx.strokeStyle = cs.getPropertyValue("--text").trim() || "#d6dce5";
        ctx.beginPath(); ctx.moveTo(40, y(hold.entry)); ctx.lineTo(w - 8, y(hold.entry)); ctx.stroke();
        ctx.fillStyle = mut;
        ctx.fillText("入场 " + Number(hold.entry).toFixed(0), 44, y(hold.entry) - 4);
        if (hold.stop != null) {
          ctx.setLineDash([7, 4]);
          ctx.strokeStyle = danger; ctx.lineWidth = 1.6;
          ctx.beginPath(); ctx.moveTo(40, y(hold.stop)); ctx.lineTo(w - 8, y(hold.stop)); ctx.stroke();
          ctx.fillStyle = danger;
          ctx.fillText("止损 " + Number(hold.stop).toFixed(0), 44, y(hold.stop) - 4);
        }
        ctx.restore();
      }
      // 价格线（红涨绿跌 vs 昨结）
      const last = d.last != null ? d.last : prices[prices.length - 1];
      const lineColor = d.prev_settle ? (last >= d.prev_settle ? up : down) : mut;
      ctx.strokeStyle = lineColor; ctx.lineWidth = 1.5;
      ctx.beginPath();
      items.forEach((it, i) => (i ? ctx.lineTo(x(i), y(it.p)) : ctx.moveTo(x(i), y(it.p))));
      ctx.stroke();
      // 均价线（黄）
      ctx.strokeStyle = "#e6b422"; ctx.lineWidth = 1;
      ctx.beginPath();
      items.forEach((it, i) => (i ? ctx.lineTo(x(i), y(it.a)) : ctx.moveTo(x(i), y(it.a))));
      ctx.stroke();
      // 最新点与标签
      const lx = x(items.length - 1), ly = y(last);
      ctx.fillStyle = lineColor;
      ctx.beginPath(); ctx.arc(lx, ly, 3, 0, 7); ctx.fill();
      const tag = Number(last).toFixed(1);
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(tag).width + 8;
      ctx.fillStyle = lineColor;
      ctx.fillRect(Math.min(lx + 4, w - tw - 2), ly - 8, tw, 15);
      ctx.fillStyle = "#fff";
      ctx.fillText(tag, Math.min(lx + 8, w - tw + 2), ly + 3);
      // 时间轴（首/中/尾）
      ctx.fillStyle = mut; ctx.font = "10px sans-serif";
      [0, Math.floor(items.length / 2), items.length - 1].forEach((i) => {
        ctx.fillText(items[i].t, Math.max(2, Math.min(x(i) - 12, w - 30)), h - 6);
      });
    } catch (e) { /* 分时图失败不影响页面 */ }
    clearInterval(intradayTimer);
    intradayTimer = setInterval(() => {
      if (FA.state.currentView === "psych" && FA.state.psychSymbol === sym) loadIntradayChart(sym);
      else clearInterval(intradayTimer);
    }, 60000);
  }

  // AI 深度解读 / 盘中快评
  $("#btnPsychAI").addEventListener("click", async () => {
    const sym = FA.state.psychSymbol;
    if (!sym) return;
    const card = $("#psychAiCard"), body = $("#psychAiBody");
    card.style.display = ""; body.innerHTML = '<span class="typing">AI 推演中（约 10-40 秒）…</span>';
    try {
      const d = await api("/api/psych/" + encodeURIComponent(sym) + "/ai", { method: "POST" });
      body.innerHTML = md(d.advice);
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">解读失败：' + esc(e.message) + "</span>";
    }
  });

  $("#btnRealtime").addEventListener("click", async () => {
    const sym = FA.state.psychSymbol;
    if (!sym) return;
    const card = $("#psychAiCard"), body = $("#psychAiBody");
    card.style.display = ""; body.innerHTML = '<span class="typing">快评生成中…</span>';
    try {
      const d = await api("/api/ai/realtime?symbol=" + encodeURIComponent(sym));
      body.innerHTML = md(d.analysis);
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">快评失败：' + esc(e.message) + "</span>";
    }
  });

  // ================================================================ 交易诊断视图

  async function loadDiagnosis() {
    const el = $("#diagBody");
    try {
      const d = await api("/api/diagnosis");
      if (!(d.issues || []).length) {
        el.innerHTML = '<div class="empty">✅ 当前无未决问题——继续保持：有止损、不逆势、不超频</div>';
        return;
      }
      el.innerHTML = d.issues.map((i) =>
        '<div class="diag-item sev-' + i.sev + '">' +
        '<div class="d-title"><span class="badge ' + (i.sev === "fatal" ? "fatal" : i.sev === "warn" ? "warn" : "info") + '">' +
        (i.sev === "fatal" ? "致命" : i.sev === "warn" ? "警告" : "提示") + "</span><b>" + esc(i.title) + "</b></div>" +
        '<div class="d-evi">' + esc(i.evidence) + "</div>" +
        '<div class="d-adv">→ ' + esc(i.advice) + "</div></div>").join("");
    } catch (e) {
      el.innerHTML = '<div class="empty">诊断失败：' + esc(e.message) + "</div>";
    }
  }
  $("#btnDiagRefresh").addEventListener("click", () => { $("#diagBody").innerHTML = '<div class="empty">重新诊断中…</div>'; setTimeout(loadDiagnosis, 500); });

  async function loadStats() {
    const el = $("#statsBody");
    try {
      const d = await api("/api/trades/stats");
      const o = d.overview || {}, b = d.behavior || {};
      el.innerHTML =
        '<div class="stat-grid">' +
        '<div class="stat-cell"><div class="sc-v">' + (o.count || 0) + '</div><div class="sc-k">已了结</div></div>' +
        '<div class="stat-cell"><div class="sc-v">' + (o.win_rate == null ? "--" : o.win_rate + "%") + '</div><div class="sc-k">胜率</div></div>' +
        '<div class="stat-cell"><div class="sc-v ' + pctCls(o.total_pts) + '">' + (o.total_pts == null ? "--" : (o.total_pts > 0 ? "+" : "") + o.total_pts) + '</div><div class="sc-k">累计点数</div></div>' +
        '<div class="stat-cell"><div class="sc-v">' + (d.open_count || 0) + '</div><div class="sc-k">持仓中</div></div>' +
        "</div>" +
        '<div class="kv-list">' +
        '<div class="kv"><span class="k">平均盈利 / 平均亏损</span><span class="v">' + fmtNum(o.avg_win, 1) + " / " + fmtNum(o.avg_loss, 1) + " 点</span></div>" +
        '<div class="kv"><span class="k">散户病计数</span><span class="v">无止损 ' + (b.no_stop || 0) + " · 扛单 " + (b.held_thru_stop || 0) + " · 报复交易 " + (b.revenge || 0) +
        " · 强行开仓 " + (b.forced || 0) + ' <span style="color:var(--up)">· 闸门拦下 ' + (b.blocked || 0) + "</span></span></div>" +
        "</div>";
    } catch (e) {
      el.innerHTML = '<div class="empty">统计失败：' + esc(e.message) + "</div>";
    }
    loadFlaws();
  }

  async function loadFlaws() {
    const el = $("#flawBody");
    if (!el) return;
    try {
      const d = await api("/api/flaw-profile");
      const flaws = d.flaws || [];
      const saved = d.blocked_count || 0;
      const savedLine = saved
        ? '<div class="mini-note" style="margin-bottom:6px;color:var(--up)">🛡️ 闸门已拦下 ' + saved +
          ' 次开仓尝试（每次都是统计上最亏钱的模式——防线在干活）</div>'
        : "";
      el.innerHTML = savedLine + (flaws.length
        ? flaws.map((f) => {
            const cls = f.severity >= 70 ? "high" : f.severity >= 45 ? "mid" : "low";
            return '<div class="flaw-item">' +
              '<div class="f-head"><b>' + esc(f.name) + "</b>" +
              '<span class="trap ' + cls + '"><span class="trap-bar"><i style="width:' + Math.min(100, f.severity) + '%"></i></span><span class="trap-num">' + f.severity + "</span></span></div>" +
              '<div class="f-evi">' + esc(f.evidence) + "</div>" +
              '<div class="f-anti">💡 ' + esc(f.antidote) + "</div>" +
              "</div>";
          }).join("")
        : (saved ? "" : '<div class="empty">暂无交易数据（至少 3 笔）——导入交割单或记几笔后，这里会画出你的缺陷画像</div>'));
    } catch (e) {
      el.innerHTML = '<div class="empty">画像加载失败：' + esc(e.message) + "</div>";
    }
  }

  async function loadTrades() {
    const body = $("#tradesBody");
    try {
      const d = await api("/api/trades");
      if (!(d.items || []).length) { body.innerHTML = '<tr><td colspan="8" class="empty">暂无记录：用上方表单记第一笔</td></tr>'; return; }
      body.innerHTML = d.items.map((t) => {
        const isLong = t.direction === "long";
        let pnlHtml, actions;
        if (t.status === "open" && t.live) {
          const p = t.live.pnl_pts;
          pnlHtml = '<span class="' + pctCls(p) + '">' + (p > 0 ? "+" : "") + p + '点</span><br><span class="muted small">@' + fmtNum(t.live.price) + "</span>";
        } else if (t.result_pts != null) {
          pnlHtml = '<span class="' + pctCls(t.result_pts) + '">' + (t.result_pts > 0 ? "+" : "") + t.result_pts + "点</span>";
        } else {
          pnlHtml = '<span class="muted">--</span>';
        }
        if (t.status === "open") {
          actions =
            '<button class="link-btn" data-act="care" data-id="' + t.id + '" title="AI 持仓体检">🩺</button>' +
            '<button class="link-btn" data-act="close" data-id="' + t.id + '">了结</button>' +
            '<button class="link-btn danger" data-act="del" data-id="' + t.id + '">删</button>';
        } else {
          actions = '<button class="link-btn danger" data-act="del" data-id="' + t.id + '">删</button>';
        }
        const note = t.note ? '<br><span class="muted small" title="' + esc(t.note) + '">' + esc(t.note.slice(0, 14)) + (t.note.length > 14 ? "…" : "") + "</span>" : "";
        const viol = (t.violation || []).length
          ? '<span title="强行开仓：' + esc(t.violation.join("；")) + '" style="color:var(--danger)">🚫</span> ' : "";
        return "<tr>" +
          "<td>" + esc(t.date) + "</td>" +
          "<td><b>" + esc(t.symbol) + "</b>" + note + "</td>" +
          "<td>" + viol + '<span class="badge ' + (isLong ? "bull" : "bear") + '">' + (isLong ? "多" : "空") + "</span> " + (t.lots || 1) + "手</td>" +
          '<td class="r">' + fmtNum(t.entry) + "</td>" +
          '<td class="r">' + (t.stop_points || '<span style="color:var(--danger)">无</span>') + "</td>" +
          '<td class="r">' + (t.target_points || "--") + "</td>" +
          '<td class="r">' + pnlHtml + "</td>" +
          "<td>" + actions + "</td></tr>";
      }).join("");
      $$("#tradesBody .link-btn").forEach((b) => {
        b.addEventListener("click", async () => {
          const id = b.getAttribute("data-id"), act = b.getAttribute("data-act");
          if (act === "care") {
            $("#tradeCareModal").classList.remove("hidden");
            $("#careTitle").textContent = id;
            $("#careBody").innerHTML = '<span class="typing">AI 体检中（约 10-30 秒）…</span>';
            try {
              const r = await api("/api/trades/" + id + "/review", { method: "POST" });
              const vTxt = r.verdict === "exit" ? "🚫 建议离场" : r.verdict === "reduce" ? "⚠ 建议减仓" : "✅ 可继续持有";
              const pnlTxt = r.pnl_pts == null ? "" : "（浮动 " + (r.pnl_pts > 0 ? "+" : "") + r.pnl_pts + " 点 @ " + fmtNum(r.price) + "）";
              const mLife = (r.advice || "").match(/(?:生死价位|生死线)[^\d\-]{0,14}(\d+(?:\.\d+)?)/);
              const lifeBtn = mLife
                ? '<button class="btn" id="btnCareAlert" style="margin-top:8px">🔔 对 ' + mLife[1] +
                  ' 设预警（触发即事件流+飞书）</button>'
                : "";
              $("#careBody").innerHTML = '<div class="mini-note" style="margin-bottom:8px">判定：<b>' + vTxt + "</b>" + esc(pnlTxt) + "</div>"
                + md(r.advice) + lifeBtn;
              if (mLife) {
                $("#btnCareAlert").addEventListener("click", async () => {
                  const dirBelow = (r.direction || "long") === "long";
                  try {
                    await api("/api/alerts", { method: "POST", body: JSON.stringify({
                      symbol: r.symbol, price: parseFloat(mLife[1]),
                      dir: dirBelow ? "below" : "above", note: "体检生死线",
                    }) });
                    alert("已设预警：" + r.symbol + (dirBelow ? " 跌破 " : " 升破 ") + mLife[1] + "\n触发时会进事件流并推飞书");
                    FA.pollShield && FA.pollShield();
                  } catch (err) { alert("设置失败：" + err.message); }
                });
              }
            } catch (err) {
              $("#careBody").innerHTML = '<span style="color:var(--danger)">体检失败：' + esc(err.message) + "</span>";
            }
            return;
          }
          if (act === "del") {
            if (!confirm("删除这条记录？")) return;
            await api("/api/trades/" + id, { method: "DELETE" });
          } else {
            const exitStr = prompt("了结价（留空=仅标记为了结，不填盈亏）\n提示：填了结价可自动计算盈亏点数", "");
            if (exitStr === null) return;
            const body = {};
            if (exitStr.trim() !== "" && !isNaN(parseFloat(exitStr))) body.exit = parseFloat(exitStr);
            else body.status = "closed";
            await api("/api/trades/" + id, { method: "PATCH", body: JSON.stringify(body) });
          }
          loadTrades(); loadStats(); loadDiagnosis();
        });
      });
    } catch (e) {
      body.innerHTML = '<tr><td colspan="8" class="empty">加载失败：' + esc(e.message) + "</td></tr>";
    }
  }

  function submitTrade(payload) {
    return api("/api/trades", { method: "POST", body: JSON.stringify(payload) });
  }

  $("#tradeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const warnBox = $("#tradeWarnings");
    warnBox.classList.add("hidden");
    const payload = {
      symbol: $("#tfSymbol").value,
      direction: $("#tfDir").value,
      entry: parseFloat($("#tfEntry").value),
      stop_points: parseFloat($("#tfStop").value) || 0,
      target_points: parseFloat($("#tfTarget").value) || 0,
      lots: parseFloat($("#tfLots").value) || 1,
      note: $("#tfNote").value,
    };
    if (!payload.symbol) { alert("请选择品种"); return; }
    try {
      let d = await submitTrade(payload);
      // 开仓闸门：致命模式拦截 → 红色风险确认（强行通过会留违规标记并计入缺陷画像）
      if (d.blocked && (d.blockers || []).length) {
        warnBox.classList.remove("hidden");
        warnBox.innerHTML =
          '<div class="tw-item fatal"><b>🚫 开仓闸门拦截（高发亏钱模式）</b></div>' +
          d.blockers.map((b) =>
            '<div class="tw-item fatal"><b>' + esc(b.name) + "</b>" + esc(b.evidence) +
            "<br><span class=\"muted\">→ " + esc(b.antidote) + "</span></div>").join("") +
          '<div style="display:flex;gap:8px;margin-top:8px">' +
          '<button class="btn" id="btnGateCancel">🧘 放弃，再想想</button>' +
          '<button class="btn danger" id="btnGateForce">⚠ 我知道风险，仍要开仓（记录违规）</button></div>';
        $("#btnGateCancel").addEventListener("click", () => warnBox.classList.add("hidden"));
        $("#btnGateForce").addEventListener("click", async () => {
          try {
            d = await submitTrade(Object.assign({}, payload, { force: 1 }));
            renderTradeResult(d, warnBox);
            $("#tfEntry").value = ""; $("#tfNote").value = "";
            loadTrades(); loadStats(); loadDiagnosis();
          } catch (err) { alert("保存失败：" + err.message); }
        });
        return;
      }
      renderTradeResult(d, warnBox);
      $("#tfEntry").value = ""; $("#tfNote").value = "";
      loadTrades(); loadStats(); loadDiagnosis();
    } catch (err) {
      alert("保存失败：" + err.message);
    }
  });

  function renderTradeResult(d, warnBox) {
    if (d.forced) {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = '<div class="tw-item fatal"><b>🚫 已强行开仓（违规标记：</b>' +
        (d.blockers || []).map((b) => esc(b.name)).join("、") + '<b>）</b>——这笔的后续将由缺陷画像跟踪。</div>';
      return;
    }
    if ((d.warnings || []).length) {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = d.warnings.map((w) =>
        '<div class="tw-item ' + w.sev + '"><b>' + (w.sev === "fatal" ? "🚫" : w.sev === "warn" ? "⚠" : "ℹ") + " " + esc(w.title) + "</b>" +
        esc(w.evidence) + "<br><span class=\"muted\">→ " + esc(w.advice) + "</span></div>").join("");
    } else {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = '<div class="tw-item info"><b>✅ 开仓检查通过</b>有止损、不逆势、不超频——保持住。</div>';
    }
  }

  // ================================================================ 心得视图

  async function loadNotes() {
    const el = $("#notesList");
    try {
      const d = await api("/api/notes");
      if (!(d.items || []).length) { el.innerHTML = '<div class="empty">暂无心得</div>'; return; }
      el.innerHTML = d.items.map((n) =>
        '<div class="note-item"><div class="n-head"><span class="n-title">' + esc(n.title) + "</span>" +
        '<span class="n-meta">' + esc(n.date) + (n.symbol ? " · " + esc(n.symbol) : "") + (n.tags ? " · #" + esc(n.tags) : "") + (n.synced ? " · 已同步" : "") + "</span>" +
        '<button class="link-btn danger" style="margin-left:auto" data-id="' + n.id + '">删</button></div>' +
        '<div class="n-content">' + esc(n.content) + "</div></div>").join("");
      $$(".note-item .link-btn", el).forEach((b) => {
        b.addEventListener("click", async () => {
          await api("/api/notes/" + b.getAttribute("data-id"), { method: "DELETE" });
          loadNotes();
        });
      });
    } catch (e) {
      el.innerHTML = '<div class="empty">加载失败：' + esc(e.message) + "</div>";
    }
  }

  $("#noteForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          title: $("#nfTitle").value, content: $("#nfContent").value,
          symbol: $("#nfSymbol").value || null, tags: $("#nfTags").value,
        }),
      });
      $("#nfTitle").value = ""; $("#nfContent").value = ""; $("#nfTags").value = "";
      loadNotes();
    } catch (err) { alert("保存失败：" + err.message); }
  });

  $("#btnNoteSync").addEventListener("click", async () => {
    try {
      const d = await api("/api/notes/feishu-sync", { method: "POST" });
      alert("已同步 " + (d.synced || 0) + " 条到飞书");
      loadNotes();
    } catch (e) { alert("同步失败：" + e.message); }
  });

  $("#btnAiReview").addEventListener("click", async () => {
    const card = $("#reviewCard"), body = $("#reviewBody");
    card.style.display = ""; body.innerHTML = '<span class="typing">AI 复盘生成中（约 30-60 秒）…</span>';
    $("#btnReviewSave").style.display = "";
    try {
      const chats = FA.loadChatArchive ? FA.loadChatArchive() : [];
      const notes = await api("/api/notes");
      const d = await api("/api/ai/review", {
        method: "POST",
        body: JSON.stringify({ chats: chats.slice(-40), notes: notes.items || [] }),
      });
      body.innerHTML = md(d.report);
      FA._lastReview = d;
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">复盘失败：' + esc(e.message) + "</span>";
    }
  });

  $("#btnReviewSave").addEventListener("click", async () => {
    if (!FA._lastReview) { alert("还没有生成复盘报告"); return; }
    try {
      await api("/api/ai/review-save", { method: "POST", body: JSON.stringify({ report: FA._lastReview.report, stats: FA._lastReview.stats }) });
      alert("已存入飞书《AI 复盘报告》");
    } catch (e) { alert("保存失败：" + e.message); }
  });

  // ================================================================ 弹窗：简报 / 自检 / 画像

  $("#btnReport").addEventListener("click", async () => {
    $("#reportModal").classList.remove("hidden");
    $("#reportBody").textContent = "生成中…";
    try {
      let d = await api("/api/report");
      for (let i = 0; i < 30 && d.status === "generating"; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        d = await api("/api/report");
      }
      $("#reportBody").innerHTML = d.status === "ready" ? md(d.report) : "生成超时，请稍后再试。";
    } catch (e) {
      $("#reportBody").textContent = "获取失败：" + e.message;
    }
  });

  $("#btnSelfcheck").addEventListener("click", async () => {
    $("#selfcheckModal").classList.remove("hidden");
    $("#selfcheckBody").textContent = "检查中…";
    try {
      await api("/api/health/run", { method: "POST" });
      let d;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        d = await api("/api/health");
        if (!d.running && (d.results || []).length) break;
      }
      $("#selfcheckBody").innerHTML = (d.results || []).map((r) =>
        '<div class="h-row"><span>' + (r.ok ? "✅" : "❌") + " " + esc(r.name) + '</span><span class="muted">' + esc(r.detail) + "（" + r.ms + "ms）</span></div>").join("");
    } catch (e) {
      $("#selfcheckBody").textContent = "自检失败：" + e.message;
    }
  });

  // 画像
  async function loadProfileModal() {
    $("#profileModal").classList.remove("hidden");
    try {
      const d = await api("/api/profile");
      const p = d.profile || {};
      $("#pfStyle").value = p.style || "";
      $("#pfRisk").value = p.risk_preference || "";
      renderLessons(p.lessons || []);
    } catch (e) { /* ignore */ }
  }
  function renderLessons(lessons) {
    $("#pfLessons").innerHTML = lessons.map((l, i) =>
      '<div class="lesson-item"><span>' + esc(l) + '</span><button class="link-btn danger" data-i="' + i + '">删</button></div>').join("") || '<div class="muted small">暂无教训记录</div>';
    $$("#pfLessons .link-btn").forEach((b) => {
      b.addEventListener("click", async () => {
        await api("/api/profile", { method: "POST", body: JSON.stringify({ remove_lesson: parseInt(b.getAttribute("data-i")) }) });
        const d = await api("/api/profile");
        renderLessons((d.profile || {}).lessons || []);
      });
    });
  }
  $("#btnProfile").addEventListener("click", loadProfileModal);
  $("#btnPfAddLesson").addEventListener("click", async () => {
    const v = $("#pfLesson").value.trim();
    if (!v) return;
    const body = { add_lesson: v };
    if ($("#pfStyle").value.trim()) body.style = $("#pfStyle").value.trim();
    if ($("#pfRisk").value.trim()) body.risk_preference = $("#pfRisk").value.trim();
    await api("/api/profile", { method: "POST", body: JSON.stringify(body) });
    $("#pfLesson").value = "";
    const d = await api("/api/profile");
    renderLessons((d.profile || {}).lessons || []);
  });

  // 盯盘设置 / 测试
  $("#btnMonitorTest").addEventListener("click", async () => {
    try { await api("/api/monitor/test", { method: "POST" }); FA.pollEvents(); } catch (e) { alert(e.message); }
  });
  $("#btnMonitorCfg").addEventListener("click", async () => {
    const sens = prompt("灵敏度（0.5 灵敏 / 1 标准 / 2 迟钝）：", "1");
    if (sens === null) return;
    try {
      await api("/api/monitor/config", { method: "POST", body: JSON.stringify({ enabled: true, sensitivity: parseFloat(sens) || 1 }) });
      alert("已保存");
    } catch (e) { alert(e.message); }
  });

  // ================================================================ 交割单导入 + 历史交易复盘

  $("#btnImport").addEventListener("click", () => {
    $("#importModal").classList.remove("hidden");
    const p = $("#importPreview");
    p.classList.add("hidden"); p.innerHTML = "";
    $("#btnImportCommit").disabled = true;
  });
  function importApiFile(dryRun) {
    const f = $("#importFile").files[0];
    if (!f) return Promise.reject(new Error("未选择文件"));
    // 本地解码（UTF-8 严格失败则按 GBK，浏览器原生支持）→ 走 JSON 文本接口，免去 multipart 依赖
    return f.arrayBuffer().then((buf) => {
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
      catch (e) { text = new TextDecoder("gbk").decode(buf); }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      return api("/api/trades/import", { method: "POST", body: JSON.stringify({ text, dry_run: dryRun }) });
    });
  }
  function renderImportPreview(d) {
    const p = $("#importPreview");
    p.classList.remove("hidden");
    const rows = (d.closed_preview || []).map((t) =>
      "<tr><td>" + esc(t.date) + "</td><td>" + esc(t.symbol) +
      '<span class="muted small">(' + esc(t.contract) + ")</span></td><td>" + (t.direction === "long" ? "多" : "空") +
      '</td><td class="r">' + t.lots + '</td><td class="r">' + t.entry + "→" + t.exit +
      '</td><td class="r ' + (t.result_pts > 0 ? "num-up" : t.result_pts < 0 ? "num-down" : "") + '">' +
      (t.result_pts > 0 ? "+" : "") + t.result_pts + "</td></tr>").join("");
    const openRows = (d.open_preview || []).map((t) =>
      "<div class='mini-note'>未平仓：[" + esc(t.date) + "] " + esc(t.symbol) + "(" + esc(t.contract) + ") " +
      (t.direction === "long" ? "多" : "空") + " " + t.lots + "手 @ " + t.entry + "</div>").join("");
    p.innerHTML =
      "<div class='mini-note'>识别成交 " + d.fills_count + " 条 → 闭环 " + d.closed_count + " 笔 / 未平仓 " + d.open_count + " 笔" +
      (d.unmatched_close ? " · <span style='color:var(--danger)'>" + d.unmatched_close + " 条平仓无对应开仓（流水可能不完整）</span>" : "") + "</div>" +
      (rows ? "<table class='table'><thead><tr><th>日期</th><th>品种</th><th>向</th><th class='r'>手</th><th class='r'>开→平</th><th class='r'>点数</th></tr></thead><tbody>" + rows + "</tbody></table>" : "") +
      openRows +
      ((d.errors || []).length ? "<div class='mini-note' style='color:var(--danger)'>部分行未识别：" + esc(d.errors.join("；")) + "</div>" : "");
    $("#btnImportCommit").disabled = !((d.closed_count || 0) + (d.open_count || 0));
  }
  $("#importFile").addEventListener("change", async () => {
    try { renderImportPreview(await importApiFile(1)); }
    catch (e) { alert("解析失败：" + e.message); }
  });
  $("#btnImportCheck").addEventListener("click", async () => {
    const text = $("#importText").value.trim();
    if (!text) { alert("请先粘贴成交流水，或选择 CSV 文件"); return; }
    try {
      renderImportPreview(await api("/api/trades/import", { method: "POST", body: JSON.stringify({ text, dry_run: 1 }) }));
    } catch (e) { alert("解析失败：" + e.message); }
  });
  $("#btnImportCommit").addEventListener("click", async () => {
    const btn = $("#btnImportCommit");
    btn.disabled = true; btn.textContent = "导入中…";
    try {
      const useFile = $("#importFile").files[0] && !$("#importText").value.trim();
      const d = useFile
        ? await importApiFile(0)
        : await api("/api/trades/import", { method: "POST", body: JSON.stringify({ text: $("#importText").value.trim(), dry_run: 0 }) });
      alert("导入完成：新增 " + (d.added || 0) + " 笔（重复跳过 " + (d.skipped_dup || 0) + " 笔）");
      $("#importModal").classList.add("hidden");
      $("#importText").value = ""; $("#importFile").value = "";
      loadTrades(); loadStats();
    } catch (e) { alert("导入失败：" + e.message); }
    btn.textContent = "确认导入";
  });

  $("#btnTradeReview").addEventListener("click", () => { $("#tradeReviewModal").classList.remove("hidden"); });
  $("#btnTradeReviewGo").addEventListener("click", async () => {
    const body = $("#tradeReviewBody");
    body.innerHTML = '<span class="typing">AI 复盘生成中（约 30-60 秒）…</span>';
    FA._lastTradeReview = null;
    const days = parseInt($("#trDays").value, 10) || 0;
    const symbols = ($("#trSymbols").value || "").split(/[,，\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
    try {
      const d = await api("/api/ai/trade-review", { method: "POST", body: JSON.stringify({ days, symbols }) });
      body.innerHTML = md(d.report);
      FA._lastTradeReview = d;
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">生成失败：' + esc(e.message) + "</span>";
    }
  });
  $("#btnTradeReviewSave").addEventListener("click", async () => {
    if (!FA._lastTradeReview) { alert("还没有生成复盘报告"); return; }
    try {
      await api("/api/ai/review-save", { method: "POST", body: JSON.stringify({ report: FA._lastTradeReview.report, stats: FA._lastTradeReview.stats }) });
      alert("已存入飞书《AI 复盘报告》");
    } catch (e) { alert("保存失败：" + e.message); }
  });

  // 暴露给 tab 切换用
  FA.loadTrades = loadTrades;
  FA.loadDiagnosis = loadDiagnosis;
})();
