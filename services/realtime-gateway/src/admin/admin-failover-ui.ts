function adminFailoverUiClient(): void {
  type RoutingData = {
    preferredRoute?: { key: string; remainingMs: number };
    routes?: Array<Record<string, unknown>>;
    recentRequests?: Array<Record<string, unknown>>;
  };
  type LooseObject = Record<string, any>;

  const expandedProviders = new Set<string>();
  let relayTestState: {
    running: boolean;
    total: number;
    completed: number;
    currentProviderId?: string;
    currentProviderName?: string;
    startedAt: number;
    message: string;
  } = { running: false, total: 0, completed: 0, startedAt: 0, message: "尚未开始测试" };

  const tokenValue = () => sessionStorage.getItem("aipanyAdminToken") || "";
  const headers = () => ({ Authorization: "Bearer " + tokenValue(), "Content-Type": "application/json" });
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
  const protocolName = (value: unknown) => value === "chat_completions" ? "Chat Completions" : "Responses";
  const dateText = (value: unknown) => typeof value === "number" && value > 0 ? new Date(value).toLocaleString() : "-";
  const ms = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) + " ms" : "-";
  const seconds = (value: number) => (value / 1000).toFixed(1) + "s";
  const pageEval = <T>(source: string): T => (0, eval)(source) as T;
  const getPool = (): LooseObject => pageEval<LooseObject>("llmPool");
  const getRelayResults = (): LooseObject => pageEval<LooseObject>("relayResults");
  const setPageStatus = (text: string, ok?: boolean) => {
    const fn = pageEval<((message: string, success?: boolean) => void) | undefined>("typeof setStatus === 'function' ? setStatus : undefined");
    fn?.(text, ok);
  };
  const renderOverview = (data: LooseObject) => {
    const fn = pageEval<((value: LooseObject) => void) | undefined>("typeof renderOverview === 'function' ? renderOverview : undefined");
    fn?.(data);
  };
  const normalizePoolIntoPage = (raw: unknown) => {
    (globalThis as LooseObject).__aipanyNextPool = raw;
    pageEval<void>("llmPool = normalizePool(globalThis.__aipanyNextPool)");
    delete (globalThis as LooseObject).__aipanyNextPool;
  };

  function injectStyles(): void {
    if (document.getElementById("aipanyCompactLlmStyles")) return;
    const style = document.createElement("style");
    style.id = "aipanyCompactLlmStyles";
    style.textContent = `
      .llm-provider-list{display:flex;flex-direction:column;gap:8px}
      .llm-provider-item{border:1px solid #e1e5ec;border-radius:12px;background:#fff;overflow:hidden}
      .llm-provider-row{display:grid;grid-template-columns:28px minmax(135px,.85fr) minmax(210px,1.35fr) minmax(240px,1.7fr) 72px 54px 190px;gap:10px;align-items:center;padding:9px 10px;min-height:58px}
      .llm-provider-row.testing{background:#f8f9ff;border-left:3px solid var(--primary)}
      .llm-provider-row input{min-width:0;padding:8px 9px;border-radius:8px;font-size:13px}
      .llm-provider-row .provider-select{width:auto;margin:auto}
      .llm-provider-cell{min-width:0}
      .llm-provider-cell .mini-label{display:block;color:#667085;font-size:10px;margin-bottom:3px}
      .llm-provider-actions{display:flex;gap:5px;justify-content:flex-end;white-space:nowrap}
      .llm-provider-actions .btn{padding:7px 9px;font-size:12px}
      .llm-provider-detail{display:none;border-top:1px solid #eaecf0;background:#fafbfc;padding:14px 16px}
      .llm-provider-detail.open{display:block}
      .llm-provider-detail-grid{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px}
      .llm-provider-meta{display:flex;gap:6px;align-items:center;margin-top:4px;min-height:18px}
      .model-inline{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .switch{position:relative;display:inline-flex;width:42px;height:24px;align-items:center}
      .switch input{position:absolute;opacity:0;pointer-events:none}
      .switch-track{width:42px;height:24px;border-radius:999px;background:#d0d5dd;position:relative;transition:.18s ease;cursor:pointer}
      .switch-track:after{content:"";position:absolute;width:18px;height:18px;border-radius:50%;background:#fff;top:3px;left:3px;box-shadow:0 1px 3px rgba(16,24,40,.25);transition:.18s ease}
      .switch input:checked + .switch-track{background:var(--primary)}
      .switch input:checked + .switch-track:after{transform:translateX(18px)}
      .relay-progress{display:none;margin:12px 0 14px;padding:12px 14px;border:1px solid #dfe3eb;border-radius:12px;background:#f8f9fc}
      .relay-progress.show{display:block}
      .relay-progress-head{display:flex;justify-content:space-between;gap:12px;margin-bottom:8px;font-size:13px}
      .relay-progress-track{height:8px;border-radius:999px;background:#e4e7ec;overflow:hidden}
      .relay-progress-bar{height:100%;width:0;background:var(--primary);transition:width .25s ease}
      .latency-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin-top:16px}
      .latency-card{border:1px solid #e4e7ec;border-radius:12px;padding:12px;background:#fff}
      .latency-card small{display:block;color:#667085;margin-bottom:5px}.latency-card strong{font-size:18px}
      .latency-card.primary{background:#f4f5ff;color:#172033}
      .latency-timeline{margin-top:12px;border:1px solid #e4e7ec;border-radius:12px;overflow:hidden}
      .latency-line{display:grid;grid-template-columns:minmax(180px,1fr) auto;gap:12px;padding:9px 12px;border-bottom:1px solid #eaecf0;font-size:13px}.latency-line:last-child{border-bottom:0}
      @media(max-width:1100px){.llm-provider-row{grid-template-columns:28px 150px minmax(220px,1fr) minmax(240px,1fr) 70px 50px}.llm-provider-actions{grid-column:2/-1;justify-content:flex-start}.latency-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}
      @media(max-width:760px){.llm-provider-row{grid-template-columns:28px 1fr 54px}.llm-provider-cell.url,.llm-provider-cell.models,.llm-provider-cell.priority{grid-column:2/-1}.llm-provider-actions{grid-column:2/-1}.llm-provider-detail-grid,.latency-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function ensureCompactLlmLayout(): void {
    const providers = document.getElementById("llmProviders");
    if (!providers) return;
    const parent = providers.parentElement;
    if (parent && !document.getElementById("relayTestProgress")) {
      const progress = document.createElement("div");
      progress.id = "relayTestProgress";
      progress.className = "relay-progress";
      progress.innerHTML = `<div class="relay-progress-head"><strong id="relayProgressText">尚未开始测试</strong><span id="relayProgressTime">0.0s</span></div><div class="relay-progress-track"><div id="relayProgressBar" class="relay-progress-bar"></div></div><div id="relayProgressHint" class="hint" style="margin-top:8px">测试会自动发现模型，并逐个验证 Responses API 与 Chat Completions。</div>`;
      parent.insertBefore(progress, providers);
    }
  }

  function renderRelayProgress(): void {
    const wrap = document.getElementById("relayTestProgress");
    const text = document.getElementById("relayProgressText");
    const time = document.getElementById("relayProgressTime");
    const bar = document.getElementById("relayProgressBar") as HTMLElement | null;
    if (!wrap || !text || !time || !bar) return;
    wrap.classList.toggle("show", relayTestState.running || relayTestState.completed > 0);
    const elapsed = relayTestState.startedAt ? Date.now() - relayTestState.startedAt : 0;
    const percent = relayTestState.total > 0 ? Math.round(relayTestState.completed / relayTestState.total * 100) : 0;
    text.textContent = relayTestState.running
      ? `正在测试 ${Math.min(relayTestState.completed + 1, relayTestState.total)} / ${relayTestState.total}：${relayTestState.currentProviderName || "中转站"}`
      : relayTestState.message;
    time.textContent = seconds(elapsed);
    bar.style.width = (relayTestState.running ? Math.max(percent, 4) : percent) + "%";
  }

  function modelCsv(provider: LooseObject): string {
    return (Array.isArray(provider.models) ? provider.models : [])
      .filter((model: LooseObject) => model && model.id && model.id !== "__aipany_auto_discover__")
      .sort((a: LooseObject, b: LooseObject) => Number(a.priority) - Number(b.priority))
      .map((model: LooseObject) => model.id)
      .join(", ");
  }

  function updateModels(provider: LooseObject, text: string): void {
    const ids = [...new Set(text.split(/[，,\n]+/).map((value) => value.trim()).filter(Boolean))];
    const previous = new Map((Array.isArray(provider.models) ? provider.models : []).map((model: LooseObject) => [model.id, model]));
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
      ? `测试完成：发现 ${result.discoveredModels || 0} 个模型，${Array.isArray(result.eligibleModels) ? result.eligibleModels.length : 0} 个双协议可用，总耗时 ${result.elapsedMs || 0} ms`
      : `测试失败：${result.error || "没有符合条件的模型"}`;
    wrap.appendChild(summary);
    if (!Array.isArray(result.results) || !result.results.length) return wrap;
    const tableWrap = document.createElement("div");
    tableWrap.className = "table-wrap";
    const rows = result.results.map((item: LooseObject) => {
      const map: LooseObject = {};
      for (const protocol of item.protocols || []) map[protocol.protocol] = protocol;
      const responses = map.responses;
      const chat = map.chat_completions;
      return `<tr><td>${esc(item.model)}</td><td>${item.eligible ? "可用" : "未通过"}</td><td>${ms(item.scoreMs)}</td><td>${responses?.success ? ms(responses.firstTokenMs) : "失败"}</td><td>${chat?.success ? ms(chat.firstTokenMs) : "失败"}</td></tr>`;
    }).join("");
    tableWrap.innerHTML = `<table><thead><tr><th>模型</th><th>状态</th><th>综合首 Token</th><th>Responses</th><th>Chat Completions</th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.appendChild(tableWrap);
    return wrap;
  }

  function renderCompactLlmPool(): void {
    ensureCompactLlmLayout();
    const pool = getPool();
    const setInput = (id: string, value: unknown) => {
      const input = document.getElementById(id) as HTMLInputElement | null;
      if (input) input.value = String(value ?? "");
    };
    setInput("LLM_POOL_FIRST_TOKEN_TIMEOUT_MS", pool.firstTokenTimeoutMs);
    setInput("LLM_POOL_TOTAL_TIMEOUT_MS", pool.totalTimeoutMs);
    setInput("LLM_POOL_COOLDOWN_MS", pool.cooldownMs);
    setInput("LLM_POOL_MAX_ATTEMPTS", pool.maxAttempts);
    const container = document.getElementById("llmProviders");
    if (!container) return;
    container.innerHTML = "";
    const providers = Array.isArray(pool.providers) ? pool.providers : [];
    if (!providers.length) {
      container.innerHTML = `<div class="section-note">尚未配置中转站。点击“添加中转站”后填写 Base URL 和 API Key，再运行自动测试。</div>`;
      return;
    }
    const results = getRelayResults();
    const list = document.createElement("div");
    list.className = "llm-provider-list";

    providers.forEach((provider: LooseObject, index: number) => {
      const item = document.createElement("div");
      item.className = "llm-provider-item";
      item.dataset.providerId = provider.id;
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
      const result = results[provider.id];
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
      models.placeholder = "模型用逗号分隔；测试后自动按速度排序";
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
      switchLabel.title = provider.enabled === false ? "当前停用" : "当前启用";
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
        renderCompactLlmPool();
      });
      const removeButton = document.createElement("button");
      removeButton.type = "button";
      removeButton.className = "btn danger";
      removeButton.textContent = "删除";
      removeButton.addEventListener("click", () => {
        if (!confirm("确定删除这个中转站吗？")) return;
        providers.splice(index, 1);
        expandedProviders.delete(provider.id);
        renderCompactLlmPool();
      });
      actions.append(testButton, editButton, removeButton);
      row.appendChild(actions);
      item.appendChild(row);

      const detail = document.createElement("div");
      detail.className = "llm-provider-detail" + (expandedProviders.has(provider.id) ? " open" : "");
      const detailGrid = document.createElement("div");
      detailGrid.className = "llm-provider-detail-grid";
      const keyBox = document.createElement("div");
      keyBox.className = "field";
      keyBox.innerHTML = `<label>API Key</label>`;
      const key = document.createElement("input");
      key.type = "password";
      key.placeholder = provider.apiKeyConfigured ? "留空保留已保存的 Key" : "请输入 API Key";
      key.addEventListener("input", () => { provider.apiKey = key.value; });
      keyBox.appendChild(key);
      const firstBox = document.createElement("div");
      firstBox.className = "field";
      firstBox.innerHTML = `<label>首 Token 超时(ms)</label>`;
      const first = document.createElement("input");
      first.type = "number";
      first.placeholder = "继承全局";
      first.value = provider.firstTokenTimeoutMs === undefined ? "" : String(provider.firstTokenTimeoutMs);
      first.addEventListener("input", () => { provider.firstTokenTimeoutMs = first.value ? Number(first.value) : undefined; });
      firstBox.appendChild(first);
      const totalBox = document.createElement("div");
      totalBox.className = "field";
      totalBox.innerHTML = `<label>总超时(ms)</label>`;
      const total = document.createElement("input");
      total.type = "number";
      total.placeholder = "继承全局";
      total.value = provider.totalTimeoutMs === undefined ? "" : String(provider.totalTimeoutMs);
      total.addEventListener("input", () => { provider.totalTimeoutMs = total.value ? Number(total.value) : undefined; });
      totalBox.appendChild(total);
      detailGrid.append(keyBox, firstBox, totalBox);
      detail.appendChild(detailGrid);
      if (result) detail.appendChild(renderBenchmarkCompact(result));
      item.appendChild(detail);
      list.appendChild(item);
    });
    container.appendChild(list);
    renderRelayProgress();
  }

  async function runRelayTestsWithProgress(providerIds?: string[]): Promise<void> {
    const pool = getPool();
    const ids = providerIds?.length ? providerIds : (pool.providers || []).filter((provider: LooseObject) => provider.selected).map((provider: LooseObject) => provider.id);
    if (!ids.length) {
      setPageStatus("请先勾选至少一个中转站。", false);
      return;
    }
    if (relayTestState.running) return;
    const selected = new Set((pool.providers || []).filter((provider: LooseObject) => provider.selected).map((provider: LooseObject) => provider.id));
    const allButtons = [document.getElementById("testSelectedProvidersBtn"), ...Array.from(document.querySelectorAll<HTMLButtonElement>(".llm-provider-actions button"))];
    allButtons.forEach((button) => { if (button instanceof HTMLButtonElement) button.disabled = true; });
    relayTestState = { running: true, total: ids.length, completed: 0, startedAt: Date.now(), message: "正在测试" };
    renderRelayProgress();
    const timer = window.setInterval(renderRelayProgress, 250);
    let passed = 0;
    let lastConfig: LooseObject | undefined;
    try {
      setPageStatus("正在保存配置并启动中转站深度测试…");
      const saveFn = pageEval<((silent: boolean) => Promise<unknown>)>("save");
      await saveFn(true);
      getPool().providers?.forEach((provider: LooseObject) => { provider.selected = selected.has(provider.id); });

      for (let index = 0; index < ids.length; index += 1) {
        const id = ids[index]!;
        const provider = (getPool().providers || []).find((item: LooseObject) => item.id === id);
        relayTestState.currentProviderId = id;
        relayTestState.currentProviderName = provider?.name || provider?.baseUrl || id;
        relayTestState.completed = index;
        renderCompactLlmPool();
        renderRelayProgress();
        setPageStatus(`正在测试 ${index + 1} / ${ids.length}：${relayTestState.currentProviderName}。正在发现模型并执行双协议流式测速…`);

        const response = await fetch("/admin/api/config/relay-test", {
          method: "POST",
          headers: headers(),
          body: JSON.stringify({ providerIds: [id] }),
        });
        const data = await response.json() as LooseObject;
        if (!response.ok) throw new Error(data.message || JSON.stringify(data));
        lastConfig = data.config;
        for (const result of data.results || []) {
          getRelayResults()[result.providerId] = result;
          if (result.ok) passed += 1;
        }
        normalizePoolIntoPage(data.config.llmProviderPool);
        getPool().providers?.forEach((item: LooseObject) => { item.selected = selected.has(item.id); });
        relayTestState.completed = index + 1;
        renderCompactLlmPool();
        renderRelayProgress();
      }

      if (lastConfig) renderOverview(lastConfig);
      relayTestState.running = false;
      relayTestState.message = `测试完成：${passed} / ${ids.length} 个中转站生成了可用双协议模型池`;
      relayTestState.completed = ids.length;
      renderCompactLlmPool();
      setPageStatus(relayTestState.message + "。", passed > 0);
    } catch (error) {
      relayTestState.running = false;
      relayTestState.message = "测试失败：" + (error instanceof Error ? error.message : String(error));
      renderCompactLlmPool();
      setPageStatus(relayTestState.message, false);
    } finally {
      clearInterval(timer);
      renderRelayProgress();
      const mainButton = document.getElementById("testSelectedProvidersBtn") as HTMLButtonElement | null;
      if (mainButton) mainButton.disabled = false;
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
    setPageStatus("正在测试 ASR → LLM Provider Pool → TTS 首响延迟…");
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
      setPageStatus("E2E 完整链路测试通过。核心首响：Speech End → First Audio = " + ms(t.speechEndToFirstAudioMs), true);
      await refreshRouting(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.textContent = "FAIL：" + message;
      setPageStatus("E2E 测试失败：" + message, false);
    } finally {
      button.disabled = false;
    }
  }

  function ensurePanels(): void {
    const llmPage = document.querySelector<HTMLElement>('[data-page="llm"]');
    if (llmPage && !document.getElementById("llmRoutingObservability")) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = "llmRoutingObservability";
      card.innerHTML = `
        <div class="toolbar">
          <div><h3 style="margin:0 0 5px">LLM Failover 实时状态</h3><div class="hint">查看实际首选路由、自适应首 Token 超时、失败冷却和最近请求链。配置保存或重新测速后，旧首选路由会立即失效。</div></div>
          <div class="actions"><button class="btn secondary" id="refreshLlmRoutingBtn" type="button">刷新路由状态</button></div>
        </div>
        <div id="llmRoutingMetrics" class="overview-grid"></div>
        <div class="table-wrap"><table><thead><tr><th>中转站</th><th>模型</th><th>协议</th><th>状态</th><th>实际超时</th><th>测速</th><th>最近首 Token</th><th>失败</th><th>最近错误</th></tr></thead><tbody id="llmRoutingRows"></tbody></table></div>
      `;
      llmPage.appendChild(card);
      document.getElementById("refreshLlmRoutingBtn")?.addEventListener("click", () => { void refreshRouting(true); });
    }

    const diagnosticsPage = document.querySelector<HTMLElement>('[data-page="diagnostics"]');
    if (diagnosticsPage && !document.getElementById("llmFailoverTracePanel")) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = "llmFailoverTracePanel";
      card.innerHTML = `
        <div class="toolbar">
          <div><h3 style="margin:0 0 5px">LLM Failover 请求链</h3><div class="hint">每一条记录对应一次真实 LLM 请求，按实际尝试顺序显示路由、耗时、超时和切换原因。</div></div>
          <div class="actions"><button class="btn secondary" id="refreshLlmTraceBtn" type="button">刷新请求链</button></div>
        </div>
        <div id="llmTraceList"><div class="status">暂无路由请求记录</div></div>
      `;
      diagnosticsPage.appendChild(card);
      document.getElementById("refreshLlmTraceBtn")?.addEventListener("click", () => { void refreshRouting(true); });
    }
  }

  function renderMetrics(data: RoutingData): void {
    const target = document.getElementById("llmRoutingMetrics");
    if (!target) return;
    const routes = Array.isArray(data.routes) ? data.routes : [];
    const cooling = routes.filter((route) => Number(route.cooldownRemainingMs) > 0).length;
    const recent = Array.isArray(data.recentRequests) ? data.recentRequests : [];
    const last = recent[0] as LooseObject | undefined;
    const attempts = last && Array.isArray(last.attempts) ? last.attempts as Array<LooseObject> : [];
    const selectedRouteKey = last?.selectedRouteKey;
    const selected = attempts.find((attempt) => attempt.routeKey === selectedRouteKey);
    target.innerHTML = `
      <div class="metric"><small>当前首选路由</small><strong>${data.preferredRoute ? esc(data.preferredRoute.key) : "按测速优先级"}</strong><div class="hint">${data.preferredRoute ? "TTL 剩余 " + ms(data.preferredRoute.remainingMs) : "没有粘连路由"}</div></div>
      <div class="metric"><small>可用路由组合</small><strong>${routes.length}</strong><div class="hint">冷却中 ${cooling} 条</div></div>
      <div class="metric"><small>最近命中</small><strong>${selected ? esc(selected.model) : "-"}</strong><div class="hint">${selected ? esc(selected.providerName) + " / " + protocolName(selected.protocol) : "暂无请求"}</div></div>
      <div class="metric"><small>最近 LLM 首 Token</small><strong>${selected ? ms(selected.firstTokenMs) : "-"}</strong><div class="hint">${last ? "总路由耗时 " + ms(last.totalMs) : "暂无请求"}</div></div>
    `;
  }

  function renderRoutes(data: RoutingData): void {
    const target = document.getElementById("llmRoutingRows");
    if (!target) return;
    const routes = Array.isArray(data.routes) ? data.routes : [];
    target.innerHTML = routes.map((route) => {
      const cooling = Number(route.cooldownRemainingMs) > 0;
      const preferred = route.preferred === true;
      const status = preferred ? "★ 首选" : cooling ? "冷却中" : "可用";
      const actualTimeout = Number(route.firstTokenTimeoutMs);
      const configuredTimeout = Number(route.configuredFirstTokenTimeoutMs);
      return `<tr>
        <td>${esc(route.providerName)}</td>
        <td>${esc(route.model)}</td>
        <td>${esc(protocolName(route.protocol))}</td>
        <td><span class="badge ${cooling ? "bad" : preferred ? "good" : ""}">${status}</span></td>
        <td>${ms(actualTimeout)}${actualTimeout !== configuredTimeout ? `<div class="hint">配置值 ${ms(configuredTimeout)}</div>` : ""}</td>
        <td>${ms(route.benchmarkFirstTokenMs)}</td>
        <td>${ms(route.lastFirstTokenMs)}</td>
        <td>${Number(route.failures) || 0}</td>
        <td title="${esc(route.lastError || "")}">${esc(route.lastError ? String(route.lastError).slice(0, 70) : "-")}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="9">暂无可用路由</td></tr>`;
  }

  function renderTraces(data: RoutingData): void {
    const target = document.getElementById("llmTraceList");
    if (!target) return;
    const traces = Array.isArray(data.recentRequests) ? data.recentRequests.slice(0, 12) as Array<LooseObject> : [];
    if (!traces.length) {
      target.innerHTML = `<div class="status">暂无路由请求记录。运行一次 E2E 测试后会在这里显示完整链路。</div>`;
      return;
    }
    target.innerHTML = traces.map((trace) => {
      const attempts = Array.isArray(trace.attempts) ? trace.attempts as Array<LooseObject> : [];
      const chain = attempts.map((attempt, index) => {
        const ok = attempt.status === "success";
        const cancelled = attempt.status === "cancelled";
        const badgeClass = ok ? "good" : "bad";
        const label = ok ? "成功" : cancelled ? "取消" : "失败";
        return `<div style="display:grid;grid-template-columns:40px minmax(0,1fr) auto;gap:12px;align-items:start;padding:12px 0;border-bottom:1px solid #eaecf0">
          <div class="badge ${badgeClass}">${index + 1}</div>
          <div>
            <strong>${esc(attempt.providerName)} / ${esc(attempt.model)} / ${esc(protocolName(attempt.protocol))}</strong>
            <div class="hint" style="margin-top:5px">首 Token ${ms(attempt.firstTokenMs)} · 本路由耗时 ${ms(attempt.elapsedMs)} · 超时阈值 ${ms(attempt.firstTokenTimeoutMs)}${attempt.preferredAtStart ? " · 启动时为首选路由" : ""}</div>
            ${attempt.error ? `<div class="hint" style="color:#b42318;margin-top:5px">${esc(attempt.error)}</div>` : ""}
          </div>
          <span class="badge ${badgeClass}">${label}</span>
        </div>`;
      }).join("");
      return `<div class="provider-card" style="margin-top:12px">
        <div class="provider-head"><div><strong>${esc(trace.id)}</strong><div class="hint">${dateText(trace.startedAt)} · 总路由耗时 ${ms(trace.totalMs)} · 尝试 ${attempts.length} 条</div></div><span class="badge ${trace.status === "success" ? "good" : "bad"}">${esc(trace.status)}</span></div>
        ${chain || `<div class="hint">没有路由尝试记录</div>`}
      </div>`;
    }).join("");
  }

  async function refreshRouting(showStatus: boolean): Promise<void> {
    if (!tokenValue()) return;
    try {
      const response = await fetch("/admin/api/config/llm-routing", { headers: headers() });
      const data = await response.json() as RoutingData & { message?: string };
      if (!response.ok) throw new Error(data.message || JSON.stringify(data));
      renderMetrics(data);
      renderRoutes(data);
      renderTraces(data);
      if (showStatus) setPageStatus("LLM Failover 路由状态已刷新。", true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (showStatus) setPageStatus("读取 LLM Failover 状态失败：" + message, false);
    }
  }

  injectStyles();
  ensureCompactLlmLayout();
  ensureLatencyPanel();
  ensurePanels();

  (globalThis as LooseObject).renderLlmPool = renderCompactLlmPool;
  (globalThis as LooseObject).runRelayTests = runRelayTestsWithProgress;
  (globalThis as LooseObject).runE2e = runE2eWithLatency;

  const testSelectedButton = document.getElementById("testSelectedProvidersBtn") as HTMLButtonElement | null;
  if (testSelectedButton) testSelectedButton.onclick = () => { void runRelayTestsWithProgress(); };
  const e2eButton = document.getElementById("runE2eBtn") as HTMLButtonElement | null;
  if (e2eButton) e2eButton.onclick = () => { void runE2eWithLatency(); };

  try { renderCompactLlmPool(); } catch { /* 登录前可能尚未初始化配置 */ }

  document.querySelectorAll('[data-route="llm"],[data-route="diagnostics"]').forEach((link) => {
    link.addEventListener("click", () => setTimeout(() => { void refreshRouting(false); }, 50));
  });
  document.getElementById("mobileNav")?.addEventListener("change", (event) => {
    const value = (event.target as HTMLSelectElement).value;
    if (value === "llm" || value === "diagnostics") setTimeout(() => { void refreshRouting(false); }, 50);
  });

  void refreshRouting(false);
  setInterval(() => {
    const active = document.querySelector<HTMLElement>(".page.active")?.dataset.page;
    if (active === "llm" || active === "diagnostics") void refreshRouting(false);
  }, 5000);
}

export const ADMIN_FAILOVER_UI = `(${adminFailoverUiClient.toString()})();`;
