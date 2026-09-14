/* chat.js：AI 对话 / 设置 / 启动 */
(function () {
  "use strict";
  const { $, $$, esc, api, md } = FA;

  // ---------- 对话历史存储 ----------
  const chatKey = () => "fa_chat_" + ($("#chatSymbol").value || "_");
  FA.loadChat = () => FA.ls.get(chatKey(), []);
  FA.saveChat = (msgs) => FA.ls.set(chatKey(), msgs.slice(-60));
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

  function renderChatLog() {
    const log = $("#chatLog");
    const msgs = FA.loadChat();
    const welcome = log.querySelector(".chat-welcome");
    log.innerHTML = "";
    if (!msgs.length) {
      log.innerHTML = '<div class="chat-welcome"><p>我是反幻想教练。别问我"支撑位在哪"——我只回答：</p>' +
        "<p>· 四方资金（产业/主力/投机/散户）此刻在做什么<br>· 散户在想什么、会怎么送钱<br>· 主力的收割剧本是什么<br>· 你该顺应什么、避开什么</p></div>";
      return;
    }
    msgs.forEach((m) => appendBubble(m.role, m.content, m.ts));
    log.scrollTop = log.scrollHeight;
  }

  function appendBubble(role, text, ts) {
    const log = $("#chatLog");
    const div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "ai");
    const who = role === "user" ? "我" : "反幻想教练" + (ts ? " · " + new Date(ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "");
    div.innerHTML = '<div class="who">' + esc(who) + '</div><div class="bubble">' + (role === "user" ? esc(text) : md(text)) + "</div>";
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    return div.querySelector(".bubble");
  }

  async function sendChat(text) {
    text = (text || "").trim();
    if (!text) return;
    const log = $("#chatLog");
    const msgs = FA.loadChat();
    msgs.push({ role: "user", content: text, ts: Date.now() });
    renderChatLog();
    appendBubble("assistant", "");
    const bubbles = log.querySelectorAll(".msg.ai .bubble");
    const bubble = bubbles[bubbles.length - 1];
    bubble.innerHTML = '<span class="typing">推演中（四方博弈分析，约 10-40 秒）…</span>';
    $("#chatInput").value = "";
    try {
      const d = await api("/api/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: msgs.slice(-20).map((m) => ({ role: m.role, content: m.content })),
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
