/* chat.js：AI 对话 / 设置 / 启动 */
(function () {
  "use strict";
  const { $, $$, esc, api, md } = FA;

  // ---------- 对话历史存储 ----------
  const chatKey = () => "fa_chat_" + ($("#chatSymbol").value || "_");
  FA.loadChat = () => FA.ls.get(chatKey(), []);
  // 图片不落 localStorage（配额 5MB，base64 轻易爆）——历史只留［图片×N］文字标记
  FA.saveChat = (msgs) => FA.ls.set(chatKey(), msgs.slice(-60).map((m) => {
    if (!m.images) return m;
    const { images, ...rest } = m;
    return rest;
  }));
  FA.loadChatArchive = () => {
    // 复盘用：全部品种的对话合并
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("fa_chat_")) {
        const sym = k.slice(8) === "_" ? "" : k.slice(8);
        const msgs = FA.ls.get(k, []);
        msgs.forEach((m) => out.push({ ...m, sym }));
      }
    }
    return out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  };

  function chatSymbolChanged() {
    renderChatLog();
  }
  $("#chatSymbol").addEventListener("change", chatSymbolChanged);

  function renderChatLog(override) {
    const log = $("#chatLog");
    const msgs = override || FA.loadChat();
    const welcome = log.querySelector(".chat-welcome");
    log.innerHTML = "";
    if (!msgs.length) {
      log.innerHTML = '<div class="chat-welcome"><p>我是反幻想教练。别问我"支撑位在哪"——我只回答：</p>' +
        "<p>· 四方资金（产业/主力/投机/散户）此刻在做什么<br>· 散户在想什么、会怎么送钱<br>· 主力的收割剧本是什么<br>· 你该顺应什么、避开什么</p></div>";
      return;
    }
    msgs.forEach((m) => appendBubble(m.role, m.content, m.ts, m.images));
    log.scrollTop = log.scrollHeight;
  }

  function appendBubble(role, text, ts, images) {
    const log = $("#chatLog");
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "ai");
    const who = role === "user" ? "我" : "反幻想教练" + (ts ? " · " + new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");
    const imgHtml = (images && images.length)
      ? '<div class="msg-imgs">' + images.map((src) => '<img class="msg-img" src="' + src + '">').join("") + "</div>" : "";
    div.innerHTML = '<div class="who">' + esc(who) + '</div><div class="bubble">' +
      imgHtml + (role === "user" ? esc(text) : md(text)) + "</div>";
    // AI 回复后追加上下文行动按钮（把教练建议变成可执行动作）
    if (role === "assistant" && text) {
      const act = document.createElement("div");
      act.className = "chat-actions";
      const sym = $("#chatSymbol").value || "";
      act.innerHTML =
        '<button class="btn ghost sm" data-ca="save" title="存为心得（复盘素材）">📝 存心得</button>' +
        (sym ? '<button class="btn ghost sm" data-ca="alert" title="对该品种设价格预警">🔔 预警</button>' +
               '<button class="btn ghost sm" data-ca="sim" title="跳到模拟开仓（带入当前品种）">⚡ 模拟</button>' : "");
      div.appendChild(act);
      $$("button", act).forEach((b) => {
        b.addEventListener("click", async () => {
          const ca = b.getAttribute("data-ca");
          if (ca === "save") {
            const title = text.slice(0, 30).replace(/\n/g, " ");
            try {
              await api("/api/notes", { method: "POST", body: JSON.stringify({
                title: "教练：" + title, content: text.slice(0, 500), symbol: sym || null, tags: "AI 对话",
              }) });
              b.textContent = "✅ 已存";
            } catch (e) { alert("保存失败：" + e.message); }
          } else if (ca === "alert" && sym) {
            const q = FA.state.quotes[sym];
            const px = q ? q.last : null;
            const p = prompt("预警价位（升破/跌破自动按当前方向判断）：", px || "");
            if (p === null) return;
            const price = parseFloat(p);
            if (isNaN(price)) return;
            const dir = q && q.change_pct > 0 ? "above" : "below";
            try {
              await api("/api/alerts", { method: "POST", body: JSON.stringify({
                symbol: sym, price: price, dir: dir, note: "教练对话后设置",
              }) });
              alert("已设预警：" + sym + (dir === "above" ? " 升破 " : " 跌破 ") + price);
              FA.pollShield && FA.pollShield();
            } catch (e) { alert("设置失败：" + e.message); }
          } else if (ca === "sim" && sym) {
            const tab = document.querySelector('.tab[data-view="trades"]');
            if (tab) tab.click();
            const sel = $("#tfSymbol");
            if (sel) { sel.value = sym; sel.dispatchEvent(new Event("change")); }
          }
        });
      });
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div.querySelector(".bubble");
  }

  // ---------- 🖼 图片输入 + 📺 期货通画面 ----------
  let _pendingImgs = [];
  function renderAttachRow() {
    const row = $("#chatAttachRow");
    if (!row) return;
    row.classList.toggle("hidden", !_pendingImgs.length);
    row.innerHTML = _pendingImgs.map((src, i) =>
      '<span class="att-chip"><img src="' + src + '"><a class="att-rm" data-rm="' + i + '">✕</a></span>').join("");
    $$("#chatAttachRow [data-rm]").forEach((a) => a.addEventListener("click", () => {
      _pendingImgs.splice(+a.getAttribute("data-rm"), 1);
      renderAttachRow();
    }));
  }

  function addChatImages(files) {
    for (const f of files) {
      if (!f.type || !f.type.startsWith("image/")) continue;
      const rd = new FileReader();
      rd.onload = () => {
        const img = new Image();
        img.onload = () => {
          // 压到最长边 1600px（截图足够清晰，base64 体积可控）
          const maxSide = 1600;
          let w = img.width, h = img.height;
          if (Math.max(w, h) > maxSide) {
            const k = maxSide / Math.max(w, h);
            w = Math.round(w * k); h = Math.round(h * k);
          }
          const cv = document.createElement("canvas");
          cv.width = w; cv.height = h;
          cv.getContext("2d").drawImage(img, 0, 0, w, h);
          _pendingImgs.push(cv.toDataURL("image/jpeg", 0.85));
          renderAttachRow();
        };
        img.src = rd.result;
      };
      rd.readAsDataURL(f);
    }
  }

  async function sendChat(text, imgs) {
    text = (text || "").trim();
    imgs = imgs || [];
    if (!text && !imgs.length) return;
    const log = $("#chatLog");
    const msgs = FA.loadChat();
    const sendText = text + (imgs.length ? (text ? " " : "") + "［图片×" + imgs.length + "］" : "");
    msgs.push({ role: "user", content: sendText, ts: Date.now(), images: imgs.length ? imgs : undefined });
    _pendingImgs = [];
    renderAttachRow();
    FA.saveChat(msgs);          // ★ 先落库：用户消息立即显示，不等 AI 回复
    renderChatLog(msgs);        // 内存版含图，缩略图立即可见
    appendBubble("assistant", "");
    const bubbles = log.querySelectorAll(".msg.ai .bubble");
    const bubble = bubbles[bubbles.length - 1];
    bubble.innerHTML = '<span class="typing">' + (imgs.length ? "识图推演中（视觉模型，约 15-45 秒）…" : "推演中（四方博弈分析，约 10-40 秒）…") + "</span>";
    $("#chatInput").value = "";
    try {
      const d = await api("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: msgs.slice(-20).map((m) => ({ role: m.role, content: m.content, images: m.images })),
          symbol: $("#chatSymbol").value || null,
        }),
      });
      msgs.push({ role: "assistant", content: d.reply, ts: Date.now() });
      FA.saveChat(msgs);
      renderChatLog();
    } catch (e) {
      bubble.className = "bubble err";
      bubble.textContent = "❌ " + e.message;
    }
  }

  $("#btnChatImg").addEventListener("click", () => $("#chatImgFile").click());
  $("#chatImgFile").addEventListener("change", (e) => {
    addChatImages(e.target.files || []);
    e.target.value = "";
  });
  // Ctrl+V 直接粘贴截图
  $("#chatInput").addEventListener("paste", (e) => {
    const items = (e.clipboardData && e.clipboardData.items) || [];
    const imgs = [];
    for (const it of items) {
      if (it.type && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault();
      addChatImages(imgs);
    }
  });
  // 📺 让 AI 看期货通实时画面：扫描 → 摘要 → 作为消息发送
  $("#btnChatThs").addEventListener("click", async () => {
    const btn = $("#btnChatThs");
    btn.disabled = true;
    btn.textContent = "⏳";
    try {
      const r = await api("/api/ths-sync/scan", { method: "POST" });
      if (!r || !r.ok) throw new Error((r && r.err) || "读取失败");
      const lines = [];
      const nowStr = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      const nm = (q) => {
        const m = THS_NAME_MAP[q.code] || {};
        return m.ths_name || q.name || q.code;
      };
      const THS_NAME_MAP = (await api("/api/ths-sync")).symbol_map || {};
      const poss = r.positions || [];
      if (poss.length) {
        lines.push("【持仓】");
        poss.forEach((p) => {
          const d = p.direction === "long" ? "多" : "空";
          lines.push("- " + (nm({ code: p.symbol }) || p.symbol) + " " + d + " " + (p.lots || 1) +
            "手 均价" + (p.avg_entry ?? "--") + " 浮动" + (p.float_pnl != null ? (p.float_pnl > 0 ? "+" : "") + p.float_pnl : "--") + "点");
        });
      } else {
        lines.push("【持仓】当前无持仓");
      }
      const ac = r.account || {};
      if (ac.equity != null) {
        lines.push("【账户】权益 " + Number(ac.equity).toLocaleString() +
          " 可用 " + (ac.available != null ? Number(ac.available).toLocaleString() : "--") +
          (ac.usage_pct != null ? " 占用 " + ac.usage_pct.toFixed(0) + "%" : ""));
      }
      const qs = r.quotes || [];
      if (qs.length) {
        lines.push("【行情】" + qs.slice(0, 12).map((q) =>
          nm(q) + " " + (q.last ?? "--") + " " + (q.change_pct != null ? (q.change_pct > 0 ? "+" : "") + q.change_pct.toFixed(2) + "%" : "")).join("；"));
      }
      const digest = "📺 [期货通实时画面 " + nowStr + "]\n" + lines.join("\n");
      const q = $("#chatInput").value.trim();
      $("#chatInput").value = "";
      sendChat(digest + "\n\n" + (q || "看一眼期货通现在的画面：持仓健康吗？有什么风险要注意？"));
    } catch (e) {
      alert("期货通读取失败：" + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "📺";
    }
  });

  $("#btnChatSend").addEventListener("click", () => sendChat($("#chatInput").value));
  $("#chatInput").addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") sendChat($("#chatInput").value);
  });
  $$(".qk").forEach((b) => {
    b.addEventListener("click", () => sendChat(b.getAttribute("data-q")));
  });

  // ---------- 设置 ----------
  const PROVIDER_LABELS = { zhipu: "智谱 GLM", deepseek: "DeepSeek", custom: "自定义 / Coding Plan" };

  $("#btnSettings").addEventListener("click", async () => {
    $("#settingsModal").classList.remove("hidden");
    try {
      const d = await api("/api/ai/config");
      const sel = $("#setProvider");
      sel.innerHTML = Object.keys(PROVIDER_LABELS).map((p) =>
        '<option value="' + p + '">' + PROVIDER_LABELS[p] + "</option>").join("");
      sel.value = d.provider;
      $("#setModel").value = d.model || "";
      $("#setKey").value = "";
      $("#setKey").placeholder = d.has_key ? "已配置（留空保持不变）" : "API Key";
      $("#customUrlRow").style.display = d.provider === "custom" ? "" : "none";
      $("#setCustomUrl").value = d.custom_base_url || "";
      // 风控参数
      const dg = await api("/api/discipline/config");
      const dis = dg.discipline || {};
      $("#setAccount").value = dis.account_size || "";
      $("#setRisk").value = dis.risk_per_trade ?? "";
      $("#setDailyStop").value = dis.daily_stop ?? "";
      $("#setDailyMax").value = dis.daily_max_trades ?? "";
      $("#setCooling").value = dis.cooling_min ?? "";
      // 飞书
      $("#setFsAppId").value = "";
      $("#setFsSecret").value = "";
      $("#setFsWebhook").value = "";
    } catch (e) { /* ignore */ }
  });
  $("#setProvider").addEventListener("change", (e) => {
    $("#customUrlRow").style.display = e.target.value === "custom" ? "" : "none";
  });

  $("#btnSaveSettings").addEventListener("click", async () => {
    try {
      await api("/api/ai/config", {
        method: "POST",
        body: JSON.stringify({
          provider: $("#setProvider").value,
          model: $("#setModel").value,
          api_key: $("#setKey").value,
          custom_base_url: $("#setCustomUrl").value,
        }),
      });
      const dis = {};
      const num = (id) => { const v = parseFloat($(id).value); return isNaN(v) ? undefined : v; };
      if ($("#setAccount").value.trim() !== "") dis.account_size = num("#setAccount");
      if ($("#setRisk").value.trim() !== "") dis.risk_per_trade = num("#setRisk");
      if ($("#setDailyStop").value.trim() !== "") dis.daily_stop = num("#setDailyStop");
      if ($("#setDailyMax").value.trim() !== "") dis.daily_max_trades = num("#setDailyMax");
      if ($("#setCooling").value.trim() !== "") dis.cooling_min = num("#setCooling");
      await api("/api/discipline/config", { method: "POST", body: JSON.stringify(dis) });
      $("#settingsModal").classList.add("hidden");
      alert("已保存");
    } catch (e) { alert("保存失败：" + e.message); }
  });

  $("#btnAiHealth").addEventListener("click", async () => {
    const note = $("#aiHealthResult"), detail = $("#aiHealthDetail");
    note.textContent = "体检中…"; detail.classList.add("hidden");
    try {
      const d = await api("/api/ai/health");
      const okN = (d.items || []).filter((x) => x.ok).length;
      note.textContent = okN + "/" + (d.items || []).length + " 可用";
      detail.classList.remove("hidden");
      detail.innerHTML = (d.items || []).map((x) =>
        '<div class="h-row"><span>' + (x.ok ? "✅" : "❌") + " " + esc(x.provider) + " / " + esc(x.model) +
        (x.active ? ' <span class="badge info">当前</span>' : "") + '</span><span class="muted">' + esc(x.detail) + "（" + x.ms + "ms）</span></div>").join("");
    } catch (e) { note.textContent = "体检失败：" + e.message; }
  });

  $("#btnFsSave").addEventListener("click", async () => {
    try {
      await api("/api/feishu/config", {
        method: "POST",
        body: JSON.stringify({
          app_id: $("#setFsAppId").value,
          app_secret: $("#setFsSecret").value,
          webhook_url: $("#setFsWebhook").value,
        }),
      });
      alert("飞书配置已保存");
    } catch (e) { alert("保存失败：" + e.message); }
  });
  $("#btnFsTest").addEventListener("click", async () => {
    try { await api("/api/feishu/push-test", { method: "POST" }); alert("测试消息已发送"); }
    catch (e) { alert("推送失败：" + e.message); }
  });

  // ---------- 启动 ----------
  renderChatLog();
  FA.bindSearch();
  FA.startPolling();
})();
