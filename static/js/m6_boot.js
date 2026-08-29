/* m6_boot —— 启动：存储层实现/AI设置/分隔条/init */

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
  store.set("fa_split", {
    list: cs.getPropertyValue("--w-list").trim(),
    chat: cs.getPropertyValue("--w-chat").trim(),
    mon: ws.getPropertyValue("--h-monitor").trim(),
  });
}

function restoreSplitterState() {
  try {
    const s = store.get("fa_split", {});
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
  applySkin(skinParam || store.get("fa_skin", "dark"));
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
  pruneOldAnnotations();
  pollHealth();
  setInterval(pollHealth, 5 * 60000);
  // 顶级视图路由：?view=compare|news|notes（兼容旧 ?tab= 参数）；?report=1 直开晨报
  const params = new URLSearchParams(location.search);
  const legacyTab = params.get("tab");
  const view = params.get("view") || (legacyTab === "compare" ? "compare" : legacyTab === "notes" ? "notes" : null);
  if (view) switchView(view);
  if (params.get("report") === "1") $("btnReport").click();
  await doRefresh();
  state.polling = setInterval(doRefresh, 5000);
  setInterval(tickPoll, 2000);
  loadSparklines(true);
  setInterval(() => loadSparklines(true), 5 * 60000);

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
