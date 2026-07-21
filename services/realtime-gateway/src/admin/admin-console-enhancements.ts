declare let llmPool: any;
declare let relayResults: Record<string, any>;
declare function normalizePool(value: unknown): any;
declare function save(silent: boolean): Promise<unknown>;
declare function setStatus(text: string, ok?: boolean): void;
declare function renderOverview(data: any): void;
declare let renderLlmPool: () => void;
declare let runRelayTests: (providerIds?: string[]) => Promise<void>;
declare let runE2e: () => Promise<void>;

function adminConsoleEnhancementsClient(): void {
  type LooseObject = Record<string, any>;

  const expandedProviders = new Set<string>();
  let relayTestState = {
    running: false,
    total: 0,
    completed: 0,
    currentProviderId: "",
    currentProviderName: "",
    startedAt: 0,
    message: "尚未开始测试",
  };

  const tokenValue = () => sessionStorage.getItem("aipanyAdminToken") || "";
  const headers = () => ({ Authorization: "Bearer " + tokenValue(), "Content-Type": "application/json" });
  const ms = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) + " ms" : "-";
  const seconds = (value: number) => (value / 1000).toFixed(1) + "s";
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));

  function injectStyles(): void {
    if (document.getElementById("aipanyCompactLlmStyles")) return;
    const style = document.createElement("style");
    style.id = "aipanyCompactLlmStyles";
    style.textContent = `
      .llm-provider-list{display:flex;flex-direction:column;gap:8px}
      .llm-provider-item{border:1px solid #e1e5ec;border-radius:12px;background:#fff;overflow:hidden}
      .llm-provider-row{display:grid;grid-template-columns:28px minmax(140px,.9fr) minmax(220px,1.35fr) minmax(260px,1.7fr) 72px 54px 188px;gap:10px;align-items:center;padding:9px 10px;min-height:58px}
      .llm-provider-row.testing{background:#f8f9ff;border-left:3px solid var(--primary)}
      .llm-provider-row input{min-width:0;padding:8px 9px;border-radius:8px;font-size:13px}
      .llm-provider-row .provider-select{width:auto;margin:auto}
      .llm-provider-cell{min-width:0}.llm-provider-meta{display:flex;gap:5px;align-items:center;margin-top:4px;min-height:18px}
      .llm-provider-actions{display:flex;gap:5px;justify-content:flex-end;white-space:nowrap}.llm-provider-actions .btn{padding:7px 9px;font-size:12px}
      .llm-provider-detail{display:none;border-top:1px solid #eaecf0;background:#fafbfc;padding:14px 16px}.llm-provider-detail.open{display:block}
      .llm-provider-detail-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}
      .switch{position:relative;display:inline-flex;width:42px;height:24px;align-items:center}.switch input{position:absolute;opacity:0;pointer-events:none}
      .switch-track{width:42px;height:24px;border-radius:999px;background:#d0d5dd;position:relative;transition:.18s ease;cursor:pointer}
      .switch-track:after{content:"";position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;top:3px;left:3px;box-shadow:0 1px 3px rgba(16,24,40,.25);transition:.18s ease}
      .switch input:checked + .switch-track{background:var(--primary)}.switch input:checked + .switch-track:after{transform:translateX(18px)}
      .relay-progress{display:none;margin:12px 0 14px;padding:12px 14px;border:1px solid #dfe3eb;border-radius:12px;background:#f8f9fc}
      .relay-progress.show{display:block}.relay-progress-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:13px}
      .relay-progress-track{height:8px;border-radius:999px;background:#e4e7ec;overflow:hidden}.relay-progress-bar{height:100%;width:0;background:var(--primary);transition:width .25s ease}
      .latency-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:16px}
      .latency-card{border:1px solid #e4e7ec;border-radius:12px;padding:12px;background:#fff}.latency-card small{display:block;color:#667085;margin-bottom:5px}.latency-card strong{font-size:18px}
      .latency-card.primary{background:#f4f5ff}.latency-timeline{margin-top:12px;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden}
      .latency-line{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:12px;padding:9px 12px;border-bottom:1px solid #eaecf0;font-size:13px}.latency-line:last-child{border-bottom:0}
      @media(max-width:1100px){.llm-provider-row{grid-template-columns:28px 150px minmax(220px,1fr) minmax(240px,1fr) 70px 50px}.llm-provider-actions{grid-column:2/-1;justify-content:flex-start}.latency-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:760px){.llm-provider-row{grid-template-columns:28px 1fr 54px}.llm-provider-cell.url,.llm-provider-cell.models,.llm-provider-cell.priority{grid-column:2/-1}.llm-provider-actions{grid-column:2/-1}.llm-provider-detail-grid,.latency-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureProgressPanel(): void {
    const providers = document.getElementById("llmProviders");
    if (!providers || document.getElementById("relayTestProgress")) return;
    const progress = document.createElement("div");
    progress.id = "relayTestProgress";
    progress.className = "relay-progress";
    progress.innerHTML = `<div class="relay-progress-head"><strong id="relayProgressText">尚未开始测试</strong><span id="relayProgressTime">0.0s</span></div><div class="relay-progress-track"><div id="relayProgressBar" class="relay-progress-bar"></div></div><div class="hint" style="margin-top:8px">当前阶段：模型发现 → Responses API 流式测试 → Chat Completions 流式测试 → 自动排序。</div>`;
    providers.parentElement?.insertBefore(progress, providers);
  }

  function renderProgress(): void {
    const wrap = document.getElementById("relayTestProgress");
    const text = document.getElementById("relayProgressText");
    const time = document.getElementById("relayProgressTime");
    const bar = document.getElementById("relayProgressBar") as HTMLElement | null;
    if (!wrap || !text || !time || !bar) return;
    wrap.classList.toggle("show", relayTestState.running || relayTestState.completed > 0);
    const elapsed = relayTestState.startedAt ? Date.now() - relayTestState.startedAt : 0;
    const percent = relayTestState.total ? Math.round(relayTestState.completed / relayTestState.total * 100) : 0;
    text.textContent = relayTestState.running
      ? `正在测试 ${Math.min(relayTestState.completed + 1, relayTestState.total)} / ${relayTestState.total}：${relayTestState.currentProviderName || "中转站"}`
      : relayTestState.message;
    time.textContent = seconds(elapsed);
    bar.style.width = (relayTestState.running ? Math.max(4, percent) : percent) + "%";
  }

  function modelCsv(provider: LooseObject): string {
    return (Array.isArray(provider.models) ? provider.models : [])
      .filter((model: LooseObject) => model?.id && model.id !== "__aipany_auto_discover__")
      .sort((a: LooseObject, b: LooseObject) => Number(a.priority) - Number(b.priority))
      .map((model: LooseObject) => model.id)
      .join(", ");
  }

  function updateModels(provider: LooseObject, text: string): void {
    const ids = [...new Set(text.split(/[，,\n]+/).map((value) => value.trim()).filter(Boolean))];
    const previous = new Map((provider.models || []).map((model: LooseObject) => [model.id, model]));
    provider.models = ids.map((id, index) => {
      const old = previous.get(id) as LooseObject | undefined;
      return old ? { ...old, id, enabled: true, priority: (index + 1) * 10 } : {
        id,
        enabled: true,
        priority: (index + 1) * 10,
        protocols: ["responses", "chat_completions"],
      };
    });
  }

  function renderBenchmarkCompact(result: LooseObject): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.marginTop = "14px";
    const summary = document.createElement("div");
    summary.className = "status " + (result.ok ? "ok" : "bad");
    summary.textContent = result.ok
      ? `测试完成：发现 ${result.discoveredModels || 0} 个模型，${result.eligibleModels?.length || 0} 个双协议可用，总耗时 ${result.elapsedMs || 0} ms`
      : `测试失败：${result.error || "没有符合条件的模型"}`;
    wrap.appendChild(summary);
    if (!Array.isArray(result.results) || !result.results.length) return wrap;
    const table = document.createElement("div");
    table.className = "table-wrap";
    table.innerHTML = `<table><thead><tr><th>模型</th><th>状态</th><th>综合首 Token</th><th>Responses</th><th>Chat Completions</th></tr></thead><tbody>${result.results.map((item: LooseObject) => {
      const protocols: LooseObject = {};
      for (const protocol of item.protocols || []) protocols[protocol.protocol] = protocol;
      return `<tr><td>${esc(item.model)}</td><td>${item.eligible ? "可用" : "未通过"}</td><td>${ms(item.scoreMs)}</td><td>${protocols.responses?.success ? ms(protocols.responses.firstTokenMs) : "失败"}</td><td>${protocols.chat_completions?.success ? ms(protocols.chat_completions.firstTokenMs) : "失败"}</td></tr>`;
    }).join("")}</tbody></table>`;
    wrap.appendChild(table);
    return wrap;
  }

  function renderCompactPool(): void {
    ensureProgressPanel();
    const inputValue = (id: string, value: unknown) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) input.value = String(value ?? "");
    };
    inputValue("LLM_POOL_FIRST_TOKEN_TIMEOUT_MS", llmPool.firstTokenTimeoutMs);
    inputValue("LLM_POOL_TOTAL_TIMEOUT_MS", llmPool.totalTimeoutMs);
    inputValue("LLM_POOL_COOLDOWN_MS", llmPool.cooldownMs);
    inputValue("LLM_POOL_MAX_ATTEMPTS", llmPool.maxAttempts);

    const container = document.getElementById("llmProviders");
    if (!container) return;
    container.innerHTML = "";
    if (!Array.isArray(llmPool.providers) || !llmPool.providers.length) {
      container.innerHTML = `<div class="section-note">尚未配置中转站。点击“添加中转站”后填写 Base URL 和 API Key，再运行自动测试。</div>`;
      return;
    }
    const list = document.createElement("div");
    list.className = "llm-provider-list";

    llmPool.providers.forEach((provider: LooseObject, index: number) => {
      const item = document.createElement("div");
      item.className = "llm-provider-item";
      const row = document.createElement("div");
      row.className = "llm-provider-row" + (relayTestState.running && relayTestState.currentProviderId === provider.id ? " testing" : "");

      const selected = document.createElement("input");
      selected.type = "checkbox";
      selected.className = "provider-select";
      selected.checked = Boolean(provider.selected);
      selected.addEventListener("change", () => { provider.selected = selected.checked; });
      row.appendChild(selected);

      const nameCell = document.createElement("div");
      nameCell.className = "llm-provider-cell";
      const name = document.createElement("input");
      name.value = provider.name || `中转站 ${index + 1}`;
      name.title = "中转站名称";
      name.addEventListener("input", () => { provider.name = name.value; });
      nameCell.appendChild(name);
      const meta = document.createElement("div");
      meta.className = "llm-provider-meta";
      meta.innerHTML = `<span class="badge ${provider.apiKeyConfigured ? "good" : ""}">${provider.apiKeyConfigured ? "Key 已保存" : "Key 未保存"}</span>`;
      const result = relayResults[provider.id];
      if (result) meta.innerHTML += `<span class="badge ${result.ok ? "good" : "bad"}">${result.ok ? (result.eligibleModels?.length || 0) + " 模型可用" : "测试失败"}</span>`;
      nameCell.appendChild(meta);
      row.appendChild(nameCell);

      const urlCell = document.createElement("div");
      urlCell.className = "llm-provider-cell url";
      const url = document.createElement("input");
      url.type = "url";
      url.value = provider.baseUrl || "";
      url.placeholder = "https://example.com/v1";
      url.title = "Base URL";
      url.addEventListener("input", () => { provider.baseUrl = url.value; });
      urlCell.appendChild(url);
      row.appendChild(urlCell);

      const modelsCell = document.createElement("div");
      modelsCell.className = "llm-provider-cell models";
      const models = document.createElement("input");
      models.value = modelCsv(provider);
      models.placeholder = "模型用逗号分隔；测速后自动排序";
      models.title = models.value || "尚未发现模型";
      models.addEventListener("input", () => updateModels(provider, models.value));
      modelsCell.appendChild(models);
      row.appendChild(modelsCell);

      const priorityCell = document.createElement("div");
      priorityCell.className = "llm-provider-cell priority";
      const priority = document.createElement("input");
      priority.type = "number";
      priority.min = "0";
      priority.max = "10000";
      priority.value = String(provider.priority ?? 100);
      priority.title = "中转站优先级，数字越小越优先";
      priority.addEventListener("input", () => { provider.priority = Number(priority.value) || 0; });
      priorityCell.appendChild(priority);
      row.appendChild(priorityCell);

      const switchLabel = document.createElement("label");
      switchLabel.className = "switch";
      const enabled = document.createElement("input");
      enabled.type = "checkbox";
      enabled.checked = provider.enabled !== false;
      enabled.addEventListener("change", () => { provider.enabled = enabled.checked; });
      const track = document.createElement("span");
      track.className = "switch-track";
      switchLabel.append(enabled, track);
      row.appendChild(switchLabel);

      const actions = document.createElement("div");
      actions.className = "llm-provider-actions";
      const testButton = document.createElement("button");
      testButton.type = "button";
      testButton.className = "btn secondary";
      testButton.textContent = "测试";
      testButton.disabled = relayTestState.running;
      testButton.addEventListener("click", () => { void runRelayTestsWithProgress([provider.id]); });
      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "btn ghost";
      editButton.textContent = expandedProviders.has(provider.id) ? "收起" : "编辑";
      editButton.addEventListener("click", () => {
        if (expandedProviders.has(provider.id)) expandedProviders.delete(provider.id); else expandedProviders.add(provider.id);
        renderCompactPool();
      });
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "btn danger";
      removeButton.textContent = "删除";
      removeButton.addEventListener("click", () => {
        if (!confirm("确定删除这个中转站吗？")) return;
        llmPool.providers.splice(index, 1);
        expandedProviders.delete(provider.id);
        renderCompactPool();
      });
      actions.append(testButton, editButton, removeButton);
      row.appendChild(actions);
      item.appendChild(row);

      const detail = document.createElement("div");
      detail.className = "llm-provider-detail" + (expandedProviders.has(provider.id) ? " open" : "");
      const detailGrid = document.createElement("div");
      detailGrid.className = "llm-provider-detail-grid";
      const buildField = (labelText: string, input: HTMLInputElement) => {
        const box = document.createElement("div");
        box.className = "field";
        const label = document.createElement("label");
        label.textContent = labelText;
        box.append(label, input);
        return box;
      };
      const key = document.createElement("input");
      key.type = "password";
      key.placeholder = provider.apiKeyConfigured ? "留空保留已保存的 Key" : "请输入 API Key";
      key.addEventListener("input", () => { provider.apiKey = key.value; });
      const first = document.createElement("input");
      first.type = "number";
      first.placeholder = "继承全局";
      first.value = provider.firstTokenTimeoutMs === undefined ? "" : String(provider.firstTokenTimeoutMs);
      first.addEventListener("input", () => { provider.firstTokenTimeoutMs = first.value ? Number(first.value) : undefined; });
      const total = document.createElement("input");
      total.type = "number";
      total.placeholder = "继承全局";
      total.value = provider.totalTimeoutMs === undefined ? "" : String(provider.totalTimeoutMs);
      total.addEventListener("input", () => { provider.totalTimeoutMs = total.value ? Number(total.value) : undefined; });
      detailGrid.append(buildField("API Key", key), buildField("首 Token 超时(ms)", first), buildField("总超时(ms)", total));
      detail.appendChild(detailGrid);
      if (result) detail.appendChild(renderBenchmarkCompact(result));
      item.appendChild(detail);
      list.appendChild(item);
    });

    container.appendChild(list);
    renderProgress();
  }

  async function runRelayTestsWithProgress(providerIds?: string[]): Promise<void> {
    const ids = providerIds?.length ? providerIds : (llmPool.providers || []).filter((provider: LooseObject) => provider.selected).map((provider: LooseObject) => provider.id);
    if (!ids.length) {
      setStatus("请先勾选至少一个中转站。", false);
      return;
    }
    if (relayTestState.running) return;
    const selected = new Set((llmPool.providers || []).filter((provider: LooseObject) => provider.selected).map((provider: LooseObject) => provider.id));
    relayTestState = { running: true, total: ids.length, completed: 0, currentProviderId: "", currentProviderName: "", startedAt: Date.now(), message: "正在测试" };
    renderProgress();
    const timer = window.setInterval(renderProgress, 250);
    let passed = 0;
    let lastConfig: LooseObject | undefined;
    try {
      setStatus("正在保存配置并启动中转站深度测试…");
      await save(true);
      for (const provider of llmPool.providers || []) provider.selected = selected.has(provider.id);

      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]!;
        const provider = (llmPool.providers || []).find((item: LooseObject) => item.id === id);
        relayTestState.currentProviderId = id;
        relayTestState.currentProviderName = provider?.name || provider?.baseUrl || id;
        relayTestState.completed = index;
        renderCompactPool();
        setStatus(`正在测试 ${index + 1} / ${ids.length}：${relayTestState.currentProviderName}。正在发现模型并执行双协议流式测速…`);

        const response = await fetch("/admin/api/config/relay-test", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ providerIds: [id] }),
        });
        const data = await response.json() as LooseObject;
        if (!response.ok) throw new Error(data.message || JSON.stringify(data));
        lastConfig = data.config;
        for (const result of data.results || []) {
          relayResults[result.providerId] = result;
          if (result.ok) passed += 1;
        }
        llmPool = normalizePool(data.config.llmProviderPool);
        for (const item of llmPool.providers || []) item.selected = selected.has(item.id);
        relayTestState.completed = index + 1;
        renderCompactPool();
      }

      if (lastConfig) renderOverview(lastConfig);
      relayTestState.running = false;
      relayTestState.completed = ids.length;
      relayTestState.message = `测试完成：${passed} / ${ids.length} 个中转站生成了可用双协议模型池`;
      renderCompactPool();
      setStatus(relayTestState.message + "。", passed > 0);
    } catch (error) {
      relayTestState.running = false;
      relayTestState.message = "测试失败：" + (error instanceof Error ? error.message : String(error));
      renderCompactPool();
      setStatus(relayTestState.message, false);
    } finally {
      clearInterval(timer);
      renderProgress();
    }
  }

  function ensureLatencyPanel(): void {
    const result = document.getElementById("e2eResult");
    if (!result || document.getElementById("e2eLatencyMetrics")) return;
    const metrics = document.createElement("div");
    metrics.id = "e2eLatencyMetrics";
    metrics.className = "latency-grid";
    metrics.innerHTML = `<div class="latency-card"><small>说完 → AI 开口</small><strong>-</strong></div>`;
    const timeline = document.createElement("div");
    timeline.id = "e2eLatencyTimeline";
    timeline.className = "latency-timeline";
    timeline.innerHTML = `<div class="latency-line"><span>等待测试</span><strong>-</strong></div>`;
    result.parentElement?.insertBefore(metrics, result);
    result.parentElement?.insertBefore(timeline, result);
  }

  function renderLatency(data: LooseObject): void {
    ensureLatencyPanel();
    const timings = data.timings || {};
    const cards = document.getElementById("e2eLatencyMetrics");
    const timeline = document.getElementById("e2eLatencyTimeline");
    if (cards) cards.innerHTML = `
      <div class="latency-card primary"><small>说完 → AI 首音频</small><strong>${ms(timings.speechEndToFirstAudioMs)}</strong></div>
      <div class="latency-card"><small>VAD 端点检测</small><strong>${ms(timings.vadEndpointMs)}</strong></div>
      <div class="latency-card"><small>VAD → ASR Final</small><strong>${ms(timings.asrAfterVadStoppedMs)}</strong></div>
      <div class="latency-card"><small>ASR → LLM 首 Token</small><strong>${ms(timings.llmFirstTokenMs)}</strong></div>
      <div class="latency-card"><small>LLM Token → TTS 首音频</small><strong>${ms(timings.ttsFirstAudioAfterLlmTokenMs)}</strong></div>`;
    if (timeline) timeline.innerHTML = `
      <div class="latency-line"><span>测试语音长度</span><strong>${ms(timings.inputSpeechDurationMs)}</strong></div>
      <div class="latency-line"><span>客户端 Speech End → Server VAD Speech Stopped</span><strong>${ms(timings.vadEndpointMs)}</strong></div>
      <div class="latency-line"><span>Server VAD Speech Stopped → ASR Final</span><strong>${ms(timings.asrAfterVadStoppedMs)}</strong></div>
      <div class="latency-line"><span>ASR Final → LLM First Token</span><strong>${ms(timings.llmFirstTokenMs)}</strong></div>
      <div class="latency-line"><span>LLM First Token → First PCM Audio</span><strong>${ms(timings.ttsFirstAudioAfterLlmTokenMs)}</strong></div>
      <div class="latency-line"><span><strong>用户说完 → AI 真正开口</strong></span><strong>${ms(timings.speechEndToFirstAudioMs)}</strong></div>`;
  }

  async function runE2eWithLatency(): Promise<void> {
    const button = document.getElementById("runE2eBtn") as HTMLButtonElement | null;
    const output = document.getElementById("e2eResult");
    if (!button || !output) return;
    button.disabled = true;
    output.textContent = "正在执行完整 E2E 测试，并采集 Speech End → First Audio 全链路时间轴…";
    setStatus("正在测试 ASR → LLM Provider Pool → TTS 首响延迟…");
    try {
      const response = await fetch("/admin/api/config/e2e-test", { method: "POST", headers: headers(), body: "{}" });
      const data = await response.json() as LooseObject;
      if (!response.ok) throw new Error(data.message || JSON.stringify(data));
      renderLatency(data);
      const t = data.timings || {};
      output.textContent = [
        "PASS：完整实时语音链路测试通过",
        "",
        "测试输入 TTS：" + data.inputTtsBytes + " bytes",
        "ASR：" + data.transcript,
        "LLM：" + data.answerText,
        "返回 TTS：" + data.responseAudioBytes + " bytes",
        "",
        "输入 TTS 耗时：" + ms(t.inputTtsMs),
        "测试语音长度：" + ms(t.inputSpeechDurationMs),
        "会话 Ready：" + ms(t.sessionReadyMs),
        "Speech End：" + ms(t.speechEndMs),
        "Server VAD Stopped：" + ms(t.serverVadStoppedMs),
        "VAD 端点耗时：" + ms(t.vadEndpointMs),
        "ASR Final：" + ms(t.asrFinalMs),
        "Speech End → ASR Final：" + ms(t.asrAfterSpeechEndMs),
        "ASR Final → LLM 首 Token：" + ms(t.llmFirstTokenMs),
        "LLM 首 Token → TTS 首音频：" + ms(t.ttsFirstAudioAfterLlmTokenMs),
        "Speech End → AI 首音频：" + ms(t.speechEndToFirstAudioMs),
        "完整耗时：" + ms(t.totalMs),
      ].join("\n");
      setStatus("E2E 完整链路测试通过。核心首响：Speech End → First Audio = " + ms(t.speechEndToFirstAudioMs), true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.textContent = "FAIL：" + message;
      setStatus("E2E 测试失败：" + message, false);
    } finally {
      button.disabled = false;
    }
  }

  injectStyles();
  ensureProgressPanel();
  ensureLatencyPanel();

  renderLlmPool = renderCompactPool;
  runRelayTests = runRelayTestsWithProgress;
  runE2e = runE2eWithLatency;

  const testSelectedButton = document.getElementById("testSelectedProvidersBtn") as HTMLButtonElement | null;
  if (testSelectedButton) testSelectedButton.onclick = () => { void runRelayTestsWithProgress(); };
  const e2eButton = document.getElementById("runE2eBtn") as HTMLButtonElement | null;
  if (e2eButton) e2eButton.onclick = () => { void runE2eWithLatency(); };

  try { renderCompactPool(); } catch { /* 登录前配置尚未初始化 */ }
}

export const ADMIN_CONSOLE_ENHANCEMENTS = `(${adminConsoleEnhancementsClient.toString()})();`;
