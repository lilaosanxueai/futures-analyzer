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
      if (v === "real") { loadTrades(); loadStats(); loadDiagnosis(); }
      if (v === "sim") { loadSimTrades(); loadSimStats(); }
      if (v === "persona") { loadFlaws(); loadMineRules(); loadProfileSummary(); }
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
${(s.variety_profile || "").split("｜").filter(Boolean).length > 1 ? `
      <div class="card" id="vpCard">
        <div class="card-head"><h2>📋 品种档案 <span class="muted small">核心矛盾 · 季节性 · 散户死法 · 该盯什么</span></h2></div>
        <div class="kv-list" style="padding:8px 14px">
          ${(s.variety_profile || "").split("｜").filter(Boolean).map((seg) =>
            '<div class="kv"><span class="v" style="text-align:left">' + esc(seg) + "</span></div>").join("")}
        </div>
      </div>` : ""}

      ${(() => {
        const intra = s.intraday || {};
        const items = [
          { label: "5 分钟", v: intra.chg5m },
          { label: "15 分钟", v: intra.chg15m },
          { label: "30 分钟", v: intra.chg30m },
        ].filter((x) => x.v != null);
        if (items.length < 2) return "";
        const allUp = items.every((x) => x.v > 0);
        const allDown = items.every((x) => x.v < 0);
        const mixed = !allUp && !allDown;
        const verdict = allUp ? "🔴 多周期共振向上" : allDown ? "🟢 多周期共振向下" : "🟡 多周期分歧（观望）";
        const bars = items.map((x) => {
          const w = Math.min(100, Math.abs(x.v) * 120);   // 0.83% → 100px
          const left = x.v > 0 ? 50 : 50 - w;
          return '<div style="display:flex;align-items:center;gap:8px;font-size:12px">' +
            '<span style="flex:0 0 55px;color:var(--muted)">' + x.label + "</span>" +
            '<div style="flex:1;height:14px;background:var(--panel-2);border-radius:7px;position:relative;overflow:hidden">' +
            '<div style="position:absolute;left:' + left + "%;width:" + w + "%;height:100%;border-radius:7px;background:" +
            (x.v > 0 ? "var(--up)" : "var(--down)") + '"></div>' +
            '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:var(--border)"></div>' +
            "</div>" +
            '<span style="flex:0 0 55px;text-align:right" class="' + (x.v > 0 ? "num-up" : "num-down") + '">' +
            (x.v > 0 ? "+" : "") + x.v.toFixed(2) + "%</span></div>";
        }).join("");
        return '<div class="card" id="mtfCard"><div class="card-head"><h2>📐 多周期共振 <span class="muted small">5 / 15 / 30 分钟动能</span></h2></div>' +
          '<div style="padding:8px 14px;display:flex;flex-direction:column;gap:6px">' + bars +
          '<div style="margin-top:6px;font-weight:600;color:var(--text-strong)">' + verdict + "</div>" +
          (mixed ? '<div class="mini-note">多周期不一致=动能未形成共识，突破方向待确认——超短宜观望等共振</div>' :
                   '<div class="mini-note">三周期同向=动能共识已形成，顺势方向操作盈亏比更优；逆共振方向=送钱</div>') +
          "</div></div>";
      })()}
      <div class="card" id="intradayCard">
        <div class="card-head"><h2>日内分时走势 <span class="muted small">1 分钟线 · 黄线=均价 · 虚线=昨结</span></h2><span class="muted small" id="intradayTime"></span></div>
        <canvas id="intradayChart" class="mini-chart" style="height:200px"></canvas>
      </div>
${(() => {
        const st = s.seats || {};
        if (st.long_total == null) return "";
        const rows = [];
        const net = st.net_chg || 0;
        rows.push('<div class="kv"><span class="k">前20席位净变化</span><span class="v"><b class="' +
          (net > 0 ? "num-up" : net < 0 ? "num-down" : "") + '">' + (net > 0 ? "+" : "") + net.toLocaleString("zh-CN") +
          "</b> · " + esc(st.bias || "") + ' <span class="muted small">' + esc(st.contract || "") + " " + esc((st.date || "").slice(4, 6) + "-" + (st.date || "").slice(6)) + "盘后</span></span></div>");
        rows.push('<div class="kv"><span class="k">多单合计</span><span class="v">' + fmtNum(st.long_total, 0) +
          "（" + (st.long_chg > 0 ? "+" : "") + fmtNum(st.long_chg, 0) + "）</span></div>");
        rows.push('<div class="kv"><span class="k">空单合计</span><span class="v">' + fmtNum(st.short_total, 0) +
          "（" + (st.short_chg > 0 ? "+" : "") + fmtNum(st.short_chg, 0) + "）</span></div>");
        const seatLine = (arr, label) =>
          '<div class="kv"><span class="k">' + label + '</span><span class="v" style="text-align:left;font-size:12px">' +
          (arr || []).map((r) => esc(r.name) + " " + fmtNum(r.pos, 0) +
            (r.chg ? ' <span class="' + (r.chg > 0 ? "num-up" : "num-down") + '">' + (r.chg > 0 ? "+" : "") + fmtNum(r.chg, 0) + "</span>" : "")
          ).join(" · ") + "</span></div>";
        rows.push(seatLine(st.top_long, "多头榜 Top5"));
        rows.push(seatLine(st.top_short, "空头榜 Top5"));
        // 价仓背离
        const chg = s.change_pct;
        if (chg != null && Math.abs(chg) >= 0.3) {
          if (chg > 0 && net < 0) {
            rows.push('<div class="kv"><span class="k">⚠ 价仓背离</span><span class="v" style="color:var(--danger)">今日涨 ' + fmtPct(chg) + ' 但席位净变化为负——上涨缺乏席位支持，警惕诱多</span></div>');
          } else if (chg < 0 && net > 0) {
            rows.push('<div class="kv"><span class="k">⚠ 价仓背离</span><span class="v" style="color:var(--up)">今日跌 ' + fmtPct(chg) + ' 但席位净变化为正——或为散户踩踏，警惕诱空洗盘</span></div>');
          }
        }
        return '<div class="card" id="seatCard"><div class="card-head"><h2>🏛 主力席位 <span class="muted small">前 20 会员持仓 · 主力账户的脚印</span></h2></div>' +
          '<div class="kv-list" style="padding:8px 14px">' + rows.join("") + "</div></div>";
      })()}
${(() => {
        const f = s.fundamentals || {};
        if (!f.inventory && f.basis == null) return "";
        const rows = [];
        if (f.inventory != null) {
          const chg = f.inv_chg2w_pct;
          const chgCls = chg == null ? "" : chg > 1 ? "num-down" : chg < -1 ? "num-up" : "";
          const tone = chg == null ? "" : chg > 1 ? "累库 · 需求弱于供给" : chg < -1 ? "去库 · 需求消化快" : "平稳";
          rows.push('<div class="kv"><span class="k">交易所库存</span><span class="v">' +
            fmtNum(f.inventory, 0) + (chg != null ? '（两周 <span class="' + chgCls + '">' + (chg > 0 ? "+" : "") + chg + '%</span>）' : "") +
            (tone ? " · " + tone : "") + ' <span class="muted small">' + esc(f.inv_date || "") + "</span></span></div>");
        }
        if (f.basis != null) {
          const tone = f.basis < 0 ? "现货升水 · 产业惜售/现货紧" : "期货升水 · 现货充裕";
          rows.push('<div class="kv"><span class="k">现货 / 基差</span><span class="v">' +
            (f.spot != null ? fmtNum(f.spot) : "--") + ' / <b class="' + (f.basis < 0 ? "num-up" : "") + '">' + (f.basis > 0 ? "+" : "") + f.basis + "</b> · " + tone +
            ' <span class="muted small">' + esc((f.spot_date || "").slice(4, 6) + "-" + (f.spot_date || "").slice(6)) + "</span></span></div>");
        }
        return '<div class="card" id="fundCard"><div class="card-head"><h2>⚖ 供需温度计 <span class="muted small">需求侧实时读数 · 库存与基差</span></h2></div>' +
          '<div class="kv-list" style="padding:8px 14px">' + rows.join("") + "</div></div>";
      })()}

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
      el.innerHTML = d.issues.map((i) => {
        let action = "";
        if (i.id === "D02" && i.trade_id) {
          action = '<button class="btn danger sm" data-fix="mktclose" data-tid="' + i.trade_id + '">💰 立即平仓</button>';
        } else if (i.id === "D01" && i.trade_id) {
          action = '<button class="btn sm" data-fix="setstop" data-tid="' + i.trade_id + '">🔧 补设止损</button>';
        }
        return '<div class="diag-item sev-' + i.sev + '">' +
        '<div class="d-title"><span class="badge ' + (i.sev === "fatal" ? "fatal" : i.sev === "warn" ? "warn" : "info") + '">' +
        (i.sev === "fatal" ? "致命" : i.sev === "warn" ? "警告" : "提示") + "</span><b>" + esc(i.title) + "</b></div>" +
        '<div class="d-evi">' + esc(i.evidence) + "</div>" +
        '<div class="d-adv">→ ' + esc(i.advice) + "</div>" +
        (action ? '<div style="margin-top:6px">' + action + "</div>" : "") +
        "</div>";
      }).join("");
      $$("#diagBody [data-fix]").forEach((b) => {
        b.addEventListener("click", async () => {
          const tid = b.getAttribute("data-tid");
          const fix = b.getAttribute("data-fix");
          if (fix === "mktclose") {
            const trades = await api("/api/trades");
            const t = (trades.items || []).find((x) => x.id === tid);
            if (!t || !t.live) { alert("实时价未就绪"); return; }
            if (!confirm("按 " + t.live.price + " 市价平仓？（浮动 " + (t.live.pnl_pts > 0 ? "+" : "") + t.live.pnl_pts + " 点）")) return;
            await api("/api/trades/" + tid, { method: "PATCH", body: JSON.stringify({ exit: t.live.price }) });
            loadDiagnosis(); loadTrades(); loadStats();
          } else if (fix === "setstop") {
            const p = prompt("补设止损点数：", "20");
            if (p === null || isNaN(parseFloat(p))) return;
            await api("/api/trades/" + tid, { method: "PATCH", body: JSON.stringify({ note: "止损计划 " + p + " 点（待手动执行）" }) });
            alert("已记录止损计划——请在实际交易软件中设置硬止损");
            loadDiagnosis();
          }
        });
      });
    } catch (e) {
      el.innerHTML = '<div class="empty">诊断失败：' + esc(e.message) + "</div>";
    }
  }
  $("#btnDiagRefresh").addEventListener("click", () => { $("#diagBody").innerHTML = '<div class="empty">重新诊断中…</div>'; setTimeout(loadDiagnosis, 500); });

  async function loadStats() {
    const el = $("#statsBody");
    try {
      const d = await api("/api/trades/stats?source=real");
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

  // 累计点数权益曲线（已平仓单按时间累积——盈亏轨迹一眼看清）
  function drawEquity(items) {
    const cv = $("#equityChart");
    if (!cv) return;
    const closed = items
      .filter((t) => t.status === "closed" && t.result_pts != null && t.closed_ts)
      .sort((a, b) => a.closed_ts - b.closed_ts);
    if (closed.length < 2) { cv.style.display = "none"; return; }
    cv.style.display = "";
    let cum = 0;
    const cums = closed.map((t) => (cum += t.result_pts));
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth || 400, h = 120;
    cv.width = w * dpr; cv.height = h * dpr;
    const ctx = cv.getContext("2d");
    ctx.scale(dpr, dpr);
    const cs = getComputedStyle(document.body);
    const grid = cs.getPropertyValue("--chart-grid").trim() || "#232b3b";
    const mut = cs.getPropertyValue("--muted").trim() || "#8a93a6";
    const up = cs.getPropertyValue("--up").trim() || "#f34e4e";
    const down = cs.getPropertyValue("--down").trim() || "#22c55e";
    const lo = Math.min(0, ...cums), hi = Math.max(0, ...cums);
    const pad = (hi - lo) * 0.1 || 1;
    const top = 8, bottom = 16;
    const y = (v) => top + (1 - (v - lo + pad) / (hi - lo + pad * 2)) * (h - top - bottom);
    const x = (i) => 8 + (i / (cums.length - 1)) * (w - 16);
    ctx.strokeStyle = grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke();
    ctx.fillStyle = mut; ctx.font = "10px sans-serif";
    ctx.fillText("0", 2, y(0) - 3);
    ctx.fillText(String(Math.round(cums[cums.length - 1])), 2, 10);
    ctx.strokeStyle = cums[cums.length - 1] >= 0 ? up : down;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    cums.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.arc(x(cums.length - 1), y(cums[cums.length - 1]), 3, 0, 7); ctx.fill();
    ctx.fillStyle = mut;
    ctx.fillText("累计点数（" + closed.length + " 笔已平）", 34, h - 4);
  }

  // 真实/模拟交易拆分：各自独立加载
  async function loadTrades() {
    const body = $("#tradesBody");
    try {
      const d = await api("/api/trades?source=real");
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
            '<button class="link-btn" data-act="mktclose" data-id="' + t.id + '" title="按当前市价一键平仓">💰</button>' +
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
      drawEquity(d.items || []);
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
          if (act === "mktclose") {
            // 💰 一键市价平仓：取当前实时价自动填入
            if (!confirm("按当前市价一键平仓？")) return;
            const lv = t.live || {};
            if (lv.price == null) { alert("实时价未就绪，稍后再试"); return; }
            const sign = t.direction === "long" ? 1 : -1;
            const pnl = sign * (lv.price - t.entry);
            if (!confirm(`平仓价 ${lv.price}，浮动 ${pnl > 0 ? "+" : ""}${pnl.toFixed(1)} 点。确认？`)) return;
            try {
              await api("/api/trades/" + id, { method: "PATCH", body: JSON.stringify({ exit: lv.price }) });
              loadTrades(); loadStats(); loadDiagnosis();
            } catch (err) { alert("平仓失败：" + err.message); }
            return;
          }
          if (act === "del") {
            if (!confirm("删除这条记录？")) return;
            await api("/api/trades/" + id, { method: "DELETE" });
          } else {
            const lv = t.live || {};
            let hint = "";
            if (lv.pnl_pts != null) {
              hint = lv.pnl_pts > 0 ? `当前浮动 +${lv.pnl_pts} 点` : `当前浮动 ${lv.pnl_pts} 点`;
              if (t.target_points && lv.pnl_pts > 0 && lv.pnl_pts < t.target_points * 0.5)
                hint += "\n⚠ 浮盈未及目标一半——确认不是怕回吐的早兑现？（处置效应）";
              if (lv.pnl_pts < 0 && t.stop_points && lv.pnl_pts > -t.stop_points)
                hint += "\n未到止损离场：若是主动认错可以；若是恐慌，请再看一眼计划。";
              if (t.stop_points && lv.pnl_pts <= -t.stop_points)
                hint += "\n止损已破——现在离场是执行纪律，不是认输。";
            }
            const exitStr = prompt("了结价（留空=仅标记了结，不填盈亏）\n" + hint, "");
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

  // 开仓表单实时风险金额：点数 → 真金白银的痛感前置
  let _mults = null, _acctSize = 0, _feeRef = {};
  async function ensureMults() {
    if (_mults) return;
    try {
      const d = await api("/api/multipliers");
      _mults = d.multipliers || {};
      _acctSize = d.account_size || 0;
      _feeRef = d.fee_ref || {};
    } catch (e) { /* ignore */ }
  }
  function updateRiskPreview() {
    const el = $("#riskPreview");
    if (!el || !_mults) return;
    const sym = $("#tfSymbol").value || "";
    const pfx = sym.replace(/0$/, "").toUpperCase();
    const m = _mults[pfx];
    const stop = parseFloat($("#tfStop").value) || 0;
    const lots = parseFloat($("#tfLots").value) || 0;
    const target = parseFloat($("#tfTarget").value) || 0;
    if (!sym || !m || stop <= 0 || lots <= 0) { el.textContent = ""; return; }
    const risk = stop * m * lots;
    const fee = (_feeRef[pfx] || m * 0.4) * lots;
    let txt = "💸 本笔满打亏损：¥" + risk.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) +
      "（止损 " + stop + " 点 × " + m + " 元/点 × " + lots + " 手）" +
      " + 手续费约 ¥" + fee.toFixed(0) + " = ¥" + (risk + fee).toLocaleString("zh-CN", { maximumFractionDigits: 0 });
    if (target > 0) {
      const rr = (target / stop).toFixed(1);
      const rrCls = rr >= 2 ? "num-up" : rr < 1 ? "num-down" : "";
      txt += "｜盈亏比 <b class='" + rrCls + "'>" + target + ":" + stop + "（" + rr + "R）</b>" +
        (rr < 1.5 ? " ⚠ 目标过近，低于 1.5R 的单不值得开" : rr >= 2 ? " ✅ ≥2R 达标" : "");
    }
    if (_acctSize > 0) {
      const pct = risk / _acctSize * 100;
      txt += "｜占账户 " + pct.toFixed(2) + "%" + (pct > 1 ? " ⚠ 超单笔风险预算" : "");
    } else {
      txt += "（设置里填账户权益后显示占比）";
    }
    el.innerHTML = txt;
    el.style.color = "";
  }
  // ⚡ 一键模拟：现价入场 + ATR 建议止损 + 2:1 目标 + 建议手数（基于账户风险预算）
  $("#btnSimSetup").addEventListener("click", async () => {
    const sym = $("#tfSymbol").value;
    if (!sym) { alert("先选品种"); return; }
    const btn = $("#btnSimSetup");
    btn.disabled = true; btn.textContent = "⏳";
    try {
      const [wd, md] = await Promise.all([
        api("/api/watchlist?symbols=" + encodeURIComponent(sym)),
        api("/api/multipliers"),
      ]);
      const q = (wd.quotes || [])[0];
      if (!q || q.last == null) { alert("行情未就绪"); return; }
      $("#tfEntry").value = q.last;
      // ATR 建议止损：从博弈快照取日内波幅的 30%（近似 ATR），兜底用现价的 1%
      const ps = FA.state.psych[sym];
      const dayRange = ps && ps.intraday ? (ps.intraday.day_high - ps.intraday.day_low) : q.last * 0.01;
      const atrProxy = Math.max(dayRange * 0.3, q.last * 0.004);
      const stop = Math.round(atrProxy * 10) / 10;
      $("#tfStop").value = stop;
      $("#tfTarget").value = Math.round(stop * 2 * 10) / 10;
      // 建议手数：风险预算 ÷ 单手风险
      const acct = md.account_size || 0;
      const mult = (md.multipliers || {})[sym.replace(/0$/, "")] || 0;
      if (acct > 0 && mult > 0 && stop > 0) {
        const budget = acct * 0.01;
        const perLot = stop * mult;
        $("#tfLots").value = Math.max(1, Math.floor(budget / perLot));
      }
      // 理由模板（待用户补充）
      if (!$("#tfNote").value.trim()) {
        $("#tfNote").value = "现价入场，止损" + stop + "点（日内波幅30%），目标" + (stop * 2).toFixed(1) + "点（2:1）——理由：";
      }
      ensureMults().then(updateRiskPreview);
      btn.textContent = "✅ 已填入";
      setTimeout(() => { btn.textContent = "⚡ 一键模拟"; btn.disabled = false; }, 2000);
    } catch (e) {
      alert("失败：" + e.message);
      btn.textContent = "⚡ 一键模拟"; btn.disabled = false;
    }
  });

  async function autoFillPrice() {
    const sym = $("#tfSymbol").value;
    if (!sym) return;
    try {
      const d = await api("/api/watchlist?symbols=" + encodeURIComponent(sym));
      const q = (d.quotes || [])[0];
      if (q && q.last != null) {
        $("#tfEntry").value = q.last;
        $("#tfEntry").title = "已自动填入最新价 " + q.last + "（" + (q.time || "") + "）";
      }
    } catch (e) { /* ignore */ }
  }
  $("#tfSymbol").addEventListener("change", autoFillPrice);
  ["tfStop", "tfLots", "tfTarget"].forEach((id) => {
    const el = $("#" + id);
    if (el) {
      el.addEventListener("change", () => { ensureMults().then(updateRiskPreview); });
      el.addEventListener("input", () => { ensureMults().then(updateRiskPreview); });
    }
  });
  ensureMults().then(updateRiskPreview);

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
    // 开仓理由必须充分（前端先拦，后端同样校验）
    const note = (payload.note || "").trim();
    const lazy = ["看涨", "看跌", "感觉", "抄底", "追涨", "杀跌", "赌", "试试", "蒙", "直觉", "朋友说", "听说", "群里"];
    if (!note) { alert("开仓理由必须填写：写清这笔靠什么赚钱（供需/资金/位置）"); return; }
    if (note.length < 10) { alert("开仓理由太短（" + note.length + " 字）——至少 10 字，写清逻辑"); return; }
    const hitLazy = lazy.find((k) => k in note || note.includes(k));
    if (hitLazy && note.length < 20) { alert("理由含空话「" + hitLazy + "」且无具体逻辑——供需/资金/位置至少说清一样"); return; }
    try {
      let d = await submitTrade(payload);
      // 开仓闸门：致命模式拦截 → 红色风险确认（强行通过会留违规标记并计入缺陷画像）
      if (d.blocked && (d.blockers || []).length) {
        const sugTxt = d.suggested_lots != null
          ? '<div class="mini-note">📏 风险预算建议手数：≤ ' + d.suggested_lots + " 手（账户单笔风险 ÷ 止损额）</div>" : "";
        warnBox.classList.remove("hidden");
        warnBox.innerHTML =
          '<div class="tw-item fatal"><b>🚫 开仓闸门拦截</b>（主导情绪判定：' + esc(d.mood || "--") + "）</div>" +
          d.blockers.map((b) =>
            '<div class="tw-item fatal"><b>' + esc(b.name) + "</b>" + esc(b.evidence) +
            "<br><span class=\"muted\">→ " + esc(b.antidote) + "</span>" +
            (b.backtest ? '<br><span style="color:var(--up)">📊 ' + esc(b.backtest) + "</span>" : "") + "</div>").join("") +
          sugTxt +
          '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
          '<button class="btn" id="btnGateCancel">🧘 放弃，再想想</button>' +
          '<button class="btn ghost" id="btnGateAsk">🧠 问教练：为什么拦我</button>' +
          '<button class="btn danger" id="btnGateForce">⚠ 我知道风险，仍要开仓（记录违规）</button></div>';
        $("#btnGateCancel").addEventListener("click", () => warnBox.classList.add("hidden"));
        $("#btnGateAsk").addEventListener("click", () => {
          const q = "我刚想开仓被闸门拦下了。情形：" +
            d.blockers.map((b) => b.name + "（" + b.evidence + "）").join("；") +
            "。请拆穿我此刻的幻想（主导情绪判定：" + (d.mood || "") + "），并告诉我什么条件下这个方向才值得做。";
          const chatSel = $("#chatSymbol");
          if (chatSel) chatSel.value = payload.symbol || "";
          $("#chatInput").value = q;
          const tab = document.querySelector('.tab[data-view="work"]');
          if (tab) tab.click();
          warnBox.classList.add("hidden");
          setTimeout(() => $("#btnChatSend").click(), 350);
        });
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
    const sug = d.suggested_lots != null
      ? '<div class="mini-note">📏 风险预算建议手数：≤ ' + d.suggested_lots + " 手</div>" : "";
    if (d.forced) {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = '<div class="tw-item fatal"><b>🚫 已强行开仓（违规标记：</b>' +
        (d.blockers || []).map((b) => esc(b.name)).join("、") + '<b>）</b>——主导情绪：' + esc(d.mood || "--") +
        "，这笔的后续将由缺陷画像与违规成绩单跟踪。</div>" + sug;
      return;
    }
    if ((d.warnings || []).length) {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = d.warnings.map((w) =>
        '<div class="tw-item ' + w.sev + '"><b>' + (w.sev === "fatal" ? "🚫" : w.sev === "warn" ? "⚠" : "ℹ") + " " + esc(w.title) + "</b>" +
        esc(w.evidence) + "<br><span class=\"muted\">→ " + esc(w.advice) + "</span></div>").join("") + sug;
    } else {
      warnBox.classList.remove("hidden");
      warnBox.innerHTML = '<div class="tw-item info"><b>✅ 开仓检查通过</b>有止损、不逆势、不超频——保持住。</div>' + sug;
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
      renderProfile(d.profile || {});
    } catch (e) { /* ignore */ }
  }
  function renderProfile(p) {
    $("#pfStyle").value = p.style || "";
    $("#pfRisk").value = p.risk_preference || "";
    const aiEl = $("#pfAiSummary");
    if (aiEl) {
      aiEl.innerHTML = p.ai_summary ? md(p.ai_summary) : "";
      const tsEl = $("#pfSynTs");
      if (tsEl) {
        tsEl.textContent = p.ai_summary_ts
          ? "上次综合：" + new Date(p.ai_summary_ts).toLocaleString("zh-CN", { hour12: false }) : "";
      }
    }
    renderLessons(p.lessons || []);
  }
  $("#btnPfSynthesize").addEventListener("click", async () => {
    const btn = $("#btnPfSynthesize");
    btn.disabled = true; btn.textContent = "🧠 综合分析中（约 20-40 秒）…";
    try {
      const d = await api("/api/profile/synthesize", { method: "POST" });
      renderProfile(d.profile || {});
    } catch (err) {
      alert("综合画像失败：" + err.message);
    }
    btn.disabled = false; btn.textContent = "🧠 由真实记录综合画像";
  });
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

  // 模拟交易页
  async function loadSimTrades() {
    const body = $("#simTradesBody");
    if (!body) return;
    try {
      const d = await api("/api/trades?source=auto");
      if (!(d.items || []).length) { body.innerHTML = '<tr><td colspan="8" class="empty">暂无模拟交易——自动引擎在跑，信号触发后自动记录；或用左侧表单手动模拟</td></tr>'; return; }
      body.innerHTML = d.items.map((t) => {
        const isLong = t.direction === "long";
        let pnlHtml;
        if (t.status === "open" && t.live) {
          const p = t.live.pnl_pts;
          pnlHtml = '<span class="' + pctCls(p) + '">' + (p > 0 ? "+" : "") + p + '点</span><br><span class="muted small">@' + fmtNum(t.live.price) + "</span>";
        } else if (t.result_pts != null) {
          pnlHtml = '<span class="' + pctCls(t.result_pts) + '">' + (t.result_pts > 0 ? "+" : "") + t.result_pts + "点</span>";
        } else {
          pnlHtml = '<span class="muted">--</span>';
        }
        const note = t.note ? '<br><span class="muted small" title="' + esc(t.note) + '">' + esc(t.note.slice(0, 14)) + "</span>" : "";
        return "<tr><td>" + esc(t.date) + "</td><td><b>" + esc(t.symbol) + "</b>" + note + "</td>" +
          '<td><span class="badge ' + (isLong ? "bull" : "bear") + '">' + (isLong ? "多" : "空") + "</span> " + (t.lots || 1) + "手</td>" +
          '<td class="r">' + fmtNum(t.entry) + '</td><td class="r">' + (t.stop_points || "--") + '</td><td class="r">' + (t.target_points || "--") + '</td>' +
          '<td class="r">' + pnlHtml + '</td><td><button class="link-btn danger" data-del="' + t.id + '">删</button></td></tr>';
      }).join("");
      $$("#simTradesBody [data-del]").forEach((b) => {
        b.addEventListener("click", async () => {
          if (!confirm("删除？")) return;
          await api("/api/trades/" + b.getAttribute("data-del"), { method: "DELETE" });
          loadSimTrades();
        });
      });
    } catch (e) {
      body.innerHTML = '<tr><td colspan="8" class="empty">加载失败：' + esc(e.message) + "</td></tr>";
    }
  }
  async function loadSimStats() {
    const el = $("#simStatsBody");
    if (!el) return;
    try {
      const d = await api("/api/auto-sim");
      const st = d.stats || {};
      const t = st.today || {};
      const fn = st.funnel || {};
      el.innerHTML = '<div class="kv-list">' +
        '<div class="kv"><span class="k">今日战绩</span><span class="v">' + (t.count ? t.count + ' 笔 · 胜率 ' + t.win_rate + '% · <b class="' + (t.total_pts > 0 ? "num-up" : "num-down") + '">' + (t.total_pts > 0 ? "+" : "") + t.total_pts + '点</b>' : "暂无平仓") + "</span></div>" +
        '<div class="kv"><span class="k">持仓中</span><span class="v">' + (st.open_count || 0) + " 笔</span></div>" +
        (fn.scans ? '<div class="kv"><span class="k">信号漏斗</span><span class="v">' + fn.scans + "扫→" + (fn.resonance || 0) + "共振→" + (fn.opened || 0) + "开</span></div>" : "") +
        '<div class="kv"><span class="k">引擎状态</span><span class="v">' + (d.enabled ? "✅ 运行中" : "⛔ 未启用") + '</span></div></div>';
    } catch (e) { /* ignore */ }
  }

  // 交易人格分析页
  async function loadMineRules() {
    const el = $("#mineBody");
    if (!el) return;
    try {
      const d = await api("/api/mine-rules");
      const rules = d.rules || [];
      el.innerHTML = rules.length
        ? rules.map((r) =>
          '<div class="flaw-item"><div class="f-head"><b>' + esc(r.rule.slice(0, 50)) + "</b></div>" +
          '<div class="f-evi">' + esc(r.evidence) + '</div>' +
          '<div class="f-anti">💡 ' + esc(r.action) + "</div></div>").join("")
        : '<div class="empty">记录不足 5 笔——导入交割单后自动挖掘</div>';
    } catch (e) { el.innerHTML = '<div class="empty">加载失败</div>'; }
    const eq = $("#exitQBody");
    if (eq) {
      try {
        const d = await api("/api/mine-rules");
        const items = d.exit_quality || [];
        const qc = {};
        items.forEach((q) => { qc[q.quality] = (qc[q.quality] || 0) + 1; });
        eq.innerHTML = Object.entries(qc).map(([k, v]) =>
          '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v"><b>' + v + "</b> 笔</span></div>").join("") || '<div class="empty">暂无平仓记录</div>';
      } catch (e) { /* ignore */ }
    }
  }
  async function loadProfileSummary() {
    const el = $("#pfSummaryBody");
    if (!el) return;
    try {
      const d = await api("/api/profile");
      const p = d.profile || {};
      el.innerHTML = (p.ai_summary ? md(p.ai_summary) : '<div class="empty">点击「🧠 AI 综合画像」从真实记录推导你的交易风格</div>') +
        (p.style ? '<div class="kv"><span class="k">风格</span><span class="v">' + esc(p.style) + "</span></div>" : "") +
        (p.risk_preference ? '<div class="kv"><span class="k">风险偏好</span><span class="v">' + esc(p.risk_preference) + "</span></div>" : "");
    } catch (e) { /* ignore */ }
  }

  // AI 综合画像按钮（人格页）
  const btnPf2 = $("#btnPfSynthesize2");
  if (btnPf2) {
    btnPf2.addEventListener("click", async () => {
      btnPf2.disabled = true; btnPf2.textContent = "🧠 分析中…";
      try { await api("/api/profile/synthesize", { method: "POST" }); loadProfileSummary(); }
      catch (e) { alert("失败：" + e.message); }
      btnPf2.disabled = false; btnPf2.textContent = "🧠 AI 综合画像";
    });
  }

  // 导入功能（真实交易页顶部的导入卡）：支持多文件，csv/txt 走文本路径，xlsx/xls 走 base64 Excel 端点
  async function importOneFile(f, dryRun) {
    const name = f.name.toLowerCase();
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      const buf = await f.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      const r = await fetch("/api/trades/import/xlsx?dry_run=" + dryRun, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: btoa(binary) }),
      });
      const d = await r.json();
      if (!r.ok || d.ok === false) throw new Error(f.name + ": " + (d.detail || ("HTTP " + r.status)));
      return d;
    }
    const buf = await f.arrayBuffer();
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch (e) { text = new TextDecoder("gbk").decode(buf); }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return api("/api/trades/import", { method: "POST", body: JSON.stringify({ text, dry_run: dryRun }) });
  }
  async function importFiles(dryRun) {
    const files = Array.from($("#importFile").files || []);
    if (!files.length) throw new Error("未选择文件");
    const results = [];
    for (const f of files) {
      try {
        const d = await importOneFile(f, dryRun);
        results.push({ file: f.name, ok: true, d });
      } catch (e) {
        results.push({ file: f.name, ok: false, error: e.message });
      }
    }
    return { results,
      totals: results.reduce((a, r) => r.ok ? {
        fills: a.fills + (r.d.fills_count || 0),
        closed: a.closed + (r.d.closed_count || 0),
        open: a.open + (r.d.open_count || 0),
        added: a.added + (r.d.added || 0),
        dup: a.dup + (r.d.skipped_dup || 0),
        errors: a.errors + (r.d.errors || []).length,
      } : a, { fills: 0, closed: 0, open: 0, added: 0, dup: 0, errors: 0 }),
    };
  }
  function renderMultiImportPreview(data) {
    const p = $("#importPreview");
    p.classList.remove("hidden");
    let html = "";
    data.results.forEach((r) => {
      if (!r.ok) {
        html += '<div class="mini-note" style="color:var(--danger)">❌ ' + esc(r.file) + "：" + esc(r.error) + "</div>";
      } else {
        const d = r.d;
        html += '<div class="mini-note">📄 ' + esc(r.file) + "：成交 " + d.fills_count + " 条 → 闭环 " + d.closed_count + " 笔 / 未平仓 " + d.open_count + " 笔" +
          ((d.errors || []).length ? " <span style='color:var(--danger)'>（" + d.errors.length + " 行未识别）</span>" : "") + "</div>";
      }
    });
    const t = data.totals;
    html += '<div style="margin:8px 0;font-weight:600;color:var(--text-strong)">合计：闭环 ' + t.closed + " 笔 / 未平仓 " + t.open + " 笔（新增 " + (t.added != null ? t.added : "—") + "）</div>";
    const rows = [];
    data.results.forEach((r) => {
      if (r.ok) (r.d.closed_preview || []).forEach((x) => rows.push(x));
    });
    if (rows.length) {
      html += "<table class='table'><thead><tr><th>日期</th><th>品种</th><th>向</th><th class='r'>手</th><th class='r'>开→平</th><th class='r'>点数</th></tr></thead><tbody>" +
        rows.slice(0, 15).map((x) =>
          "<tr><td>" + esc(x.date) + "</td><td>" + esc(x.symbol) + "</td><td>" + (x.direction === "long" ? "多" : "空") +
          '</td><td class="r">' + x.lots + '</td><td class="r">' + x.entry + "→" + x.exit +
          '</td><td class="r ' + (x.result_pts > 0 ? "num-up" : "num-down") + '">' + (x.result_pts > 0 ? "+" : "") + x.result_pts + "</td></tr>").join("") + "</tbody></table>" +
        (rows.length > 15 ? '<div class="mini-note">（仅显示前 15 笔，共 ' + rows.length + " 笔）</div>" : "");
    }
    p.innerHTML = html;
    $("#btnImportCommit").disabled = !(t.closed + t.open);
  }
  function renderImportPreview(d) {
    const p = $("#importPreview");
    p.classList.remove("hidden");
    const rows = (d.closed_preview || []).map((t) =>
      "<tr><td>" + esc(t.date) + "</td><td>" + esc(t.symbol) + "</td><td>" + (t.direction === "long" ? "多" : "空") +
      '</td><td class="r">' + t.lots + '</td><td class="r">' + t.entry + "→" + t.exit + '</td><td class="r ' + (t.result_pts > 0 ? "num-up" : "num-down") + '">' + (t.result_pts > 0 ? "+" : "") + t.result_pts + "</td></tr>").join("");
    const openRows = (d.open_preview || []).map((t) =>
      '<div class="mini-note">未平仓：[' + esc(t.date) + "] " + esc(t.symbol) + " " + (t.direction === "long" ? "多" : "空") + " " + t.lots + "手 @ " + t.entry + "</div>").join("");
    p.innerHTML = "<div class='mini-note'>识别成交 " + d.fills_count + " 条 → 闭环 " + d.closed_count + " 笔 / 未平仓 " + d.open_count + " 笔</div>" +
      (rows ? "<table class='table'><tbody>" + rows + "</tbody></table>" : "") + openRows +
      ((d.errors || []).length ? "<div class='mini-note' style='color:var(--danger)'>" + esc(d.errors.join("；")) + "</div>" : "");
    $("#btnImportCommit").disabled = !((d.closed_count || 0) + (d.open_count || 0));
  }
  const impFile = $("#importFile");
  if (impFile) {
    impFile.addEventListener("change", async () => {
      const btn = $("#btnImportCheck");
      const n = impFile.files.length;
      btn.disabled = true; btn.textContent = "⏳ 解析中(" + n + " 文件)…";
      try { renderMultiImportPreview(await importFiles(1)); }
      catch (e) { alert("解析失败：" + e.message); }
      btn.disabled = false; btn.textContent = "解析预览";
    });
  }
  const impCheck = $("#btnImportCheck");
  if (impCheck) {
    impCheck.addEventListener("click", async () => {
      const text = $("#importText").value.trim();
      if (!text && !impFile.files.length) { alert("请粘贴流水或选择文件"); return; }
      impCheck.disabled = true; impCheck.textContent = "⏳ 解析中…";
      try { renderMultiImportPreview(await importFiles(1)); }
      catch (e) { alert("解析失败：" + e.message); }
      impCheck.disabled = false; impCheck.textContent = "解析预览";
    });
  }
  const impCommit = $("#btnImportCommit");
  if (impCommit) {
    impCommit.addEventListener("click", async () => {
      impCommit.disabled = true; impCommit.textContent = "⏳ 导入中…";
      try {
        const useFiles = impFile.files.length > 0;
        const d = useFiles
          ? await importFiles(0)
          : await api("/api/trades/import", { method: "POST", body: JSON.stringify({ text: $("#importText").value.trim(), dry_run: 0 }) });
        if (useFiles) {
          renderMultiImportPreview(d);
          const t = d.totals;
          const fails = d.results.filter((r) => !r.ok).length;
          alert("多文件导入完成：新增 " + (t.added || 0) + " 笔（重复跳过 " + (t.dup || 0) + " 笔）" +
            (fails ? "\n⚠ " + fails + " 个文件解析失败（见预览区红色提示）" : ""));
        } else {
          alert("导入完成：新增 " + (d.added || 0) + " 笔（重复跳过 " + (d.skipped_dup || 0) + " 笔）");
        }
        $("#importText").value = ""; impFile.value = "";
        loadTrades(); loadStats(); loadDiagnosis(); loadFlaws();
      } catch (e) {
        alert("导入失败：" + e.message);
      }
      impCommit.disabled = false; impCommit.textContent = "确认导入";
    });
  }

  // CSV 导出
  $("#btnExportCsv").addEventListener("click", () => {
    window.open("/api/trades/export", "_blank");
  });

  // 闸门回测报告
  $("#btnGateBt").addEventListener("click", async () => {
    $("#gateBtModal").classList.remove("hidden");
    const el = $("#gateBtBody");
    try {
      const d = await api("/api/gate-backtest");
      const stats = d.stats || {};
      const rows = Object.entries(stats).map(([code, s]) => {
        const good = s.exp5 < 0;  // 期望为负=拦得对（绿色）
        const cls = good ? "num-up" : "num-down";
        return "<tr>" +
          "<td><b>" + esc(code) + "</b></td><td>" + esc(s.name) + "</td>" +
          '<td class="r">' + s.n + '（约' + s.years + '年）</td>' +
          '<td class="r ' + cls + '">' + (s.exp5 > 0 ? "+" : "") + s.exp5 + "%</td>" +
          '<td class="r">' + s.win5 + "%</td>" +
          '<td class="r ' + cls + '">' + (s.exp3 > 0 ? "+" : "") + s.exp3 + "%</td>" +
          '<td class="r">' + s.worst + "%</td>" +
          '<td class="r">' + s.p95_mae + "%</td></tr>";
      }).join("");
      const unb = (d.unbacktestable || []).map((u) =>
        '<div class="mini-note">' + esc(u.code) + "：" + esc(u.note) + "</div>").join("");
      el.innerHTML = (rows
        ? '<table class="table"><thead><tr><th>规则</th><th>模式</th><th class="r">样本</th><th class="r">5日期望</th><th class="r">胜率</th><th class="r">3日期望</th><th class="r">最差</th><th class="r">5日95%逆行</th></tr></thead><tbody>' + rows + "</tbody></table>"
        : '<div class="empty">样本不足（自选品种历史太短）</div>') + unb +
        '<div class="hint">口径：日级近似条件触发后按被拦方向模拟开仓的前向收盘收益；期望为负=闸门拦得值。品种范围为当前自选。</div>';
    } catch (e) {
      el.innerHTML = '<span style="color:var(--danger)">回测失败：' + esc(e.message) + "</span>";
    }
  });

  // 盾周报
  $("#btnShieldWeekly").addEventListener("click", async () => {
    $("#shieldWeeklyModal").classList.remove("hidden");
    const body = $("#weeklyBody");
    FA._lastWeekly = null;
    body.innerHTML = '<span class="typing">盾周报生成中（约 30-60 秒）…</span>';
    try {
      const d = await api("/api/ai/shield-weekly", { method: "POST" });
      body.innerHTML = md(d.report);
      FA._lastWeekly = d;
    } catch (e) {
      body.innerHTML = '<span style="color:var(--danger)">' + esc(e.message) + "</span>";
    }
  });
  $("#btnWeeklySave").addEventListener("click", async () => {
    if (!FA._lastWeekly) { alert("还没有生成周报"); return; }
    try {
      await api("/api/ai/review-save", { method: "POST", body: JSON.stringify({ report: FA._lastWeekly.report, stats: FA._lastWeekly.stats }) });
      alert("已存入飞书《AI 复盘报告》");
    } catch (e) { alert("保存失败：" + e.message); }
  });

  // 暴露给 tab 切换用
  FA.loadTrades = loadTrades;
  FA.loadDiagnosis = loadDiagnosis;
})();
