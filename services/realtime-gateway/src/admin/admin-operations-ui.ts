export const ADMIN_OPERATIONS_UI = String.raw`(() => {
  const STORAGE_KEY = "aipanyAdminToken";
  const $ = (id) => document.getElementById(id);
  let operationsLoaded = false;
  let realtimeVoiceLoaded = false;
  let chat2apiKeyConfigured = false;
  const authHeaders = () => ({
    Authorization: "Bearer " + (sessionStorage.getItem(STORAGE_KEY) || ""),
    "Content-Type": "application/json",
  });

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, options);
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
    if (!response.ok) throw new Error(data.message || data.error || ("HTTP " + response.status));
    return data;
  }

  function updateLoginCopy(passwordEnabled) {
    const label = $("adminToken") && $("adminToken").parentElement && $("adminToken").parentElement.querySelector("label");
    const description = document.querySelector("#login .login-card p");
    if (label) label.textContent = passwordEnabled ? "控制面板密码" : "控制面板访问";
    if (description) {
      description.textContent = passwordEnabled
        ? "输入控制面板密码。密码仅保存在当前浏览器会话中。"
        : "当前未开启应用层密码保护，将自动进入控制面板。";
    }
  }

  function installCards() {
    if ($("operationsSecurityCard")) return;
    const overview = document.querySelector('[data-page="overview"]');
    if (!overview) return;

    const security = document.createElement("div");
    security.id = "operationsSecurityCard";
    security.className = "card";
    security.style.marginTop = "18px";
    security.innerHTML = '<h3>控制面板访问保护</h3><div class="section-note">默认关闭。关闭时控制面板和管理 API 可直接访问，因此生产环境应至少使用反向代理鉴权、IP 白名单或开启此密码保护。开启后，浏览器需要输入这里设置的密码。</div><div class="grid"><div class="field"><label>密码保护</label><select id="OPS_PASSWORD_ENABLED"><option value="false">关闭（直接访问）</option><option value="true">开启（需要密码）</option></select></div><div class="field"><label>新密码</label><input id="OPS_NEW_PASSWORD" type="password" autocomplete="new-password" placeholder="留空表示不修改；首次开启必须填写" /></div></div><div class="actions" style="margin-top:14px"><button class="btn primary" id="saveOperationsSecurityBtn">保存访问设置</button></div><div id="operationsSecurityStatus" class="status" style="margin-top:14px">读取中…</div>';
    overview.appendChild(security);

    const sync = document.createElement("div");
    sync.id = "operationsGitHubCard";
    sync.className = "card";
    sync.innerHTML = '<h3>Observability GitHub 自动同步</h3><div class="section-note">同步的是强脱敏诊断事件，不包含对话正文、原始 Session ID、用户/租户/设备标识、IP、User-Agent、Token 或 API Key。事件按批次上传，避免每轮对话都产生一次 Git commit。当前主仓库 b8vipvip/aipany 是公开仓库，默认禁止上传到公开仓库，建议填写一个私有日志仓库。</div><div class="grid"><div class="field"><label>自动同步</label><select id="OPS_GITHUB_ENABLED"><option value="false">关闭</option><option value="true">开启</option></select></div><div class="field"><label>批次间隔（秒）</label><input id="OPS_GITHUB_BATCH_SECONDS" type="number" min="30" max="3600" /></div><div class="field full"><label>目标仓库（owner/repo）</label><input id="OPS_GITHUB_REPOSITORY" placeholder="例如：b8vipvip/aipany-observability-private" /></div><div class="field"><label>分支</label><input id="OPS_GITHUB_BRANCH" placeholder="main" /></div><div class="field"><label>仓库目录</label><input id="OPS_GITHUB_PATH" placeholder="ops/observability" /></div><div class="field full"><label>GitHub Fine-grained Token <span id="OPS_GITHUB_TOKEN_STATE" class="badge">未配置</span></label><input id="OPS_GITHUB_TOKEN" type="password" placeholder="留空保留服务器已保存的 Token" /><div class="hint">Token 只保存在服务器 /data 的权限文件中，不会写入同步日志，也不会在 API 中回显。</div></div><div class="field full"><label><input id="OPS_GITHUB_ALLOW_PUBLIC" type="checkbox" style="width:auto;margin-right:8px" />我明确允许把强脱敏诊断事件同步到公开仓库</label><div class="hint">不勾选时，服务器会先检查仓库可见性；如果目标仓库是 Public，会拒绝上传。</div></div></div><div class="actions" style="margin-top:14px"><button class="btn primary" id="saveOperationsGitHubBtn">保存同步设置</button><button class="btn secondary" id="testOperationsGitHubBtn">测试 GitHub 连接</button></div><div id="operationsGitHubStatus" class="status" style="margin-top:14px">读取中…</div>';
    overview.appendChild(sync);

    $("saveOperationsSecurityBtn").onclick = saveSecurity;
    $("saveOperationsGitHubBtn").onclick = saveGitHub;
    $("testOperationsGitHubBtn").onclick = testGitHub;
  }

  function installRealtimeVoiceConsole() {
    const navRealtime = document.querySelector('#nav [data-route="dashscope"]');
    if (navRealtime) navRealtime.textContent = "实时语音";
    const navAudio = document.querySelector('#nav [data-route="omni"]');
    if (navAudio) navAudio.textContent = "音频智能";
    const mobileRealtime = document.querySelector('#mobileNav option[value="dashscope"]');
    if (mobileRealtime) mobileRealtime.textContent = "实时语音";
    const mobileAudio = document.querySelector('#mobileNav option[value="omni"]');
    if (mobileAudio) mobileAudio.textContent = "音频智能";

    const audioPage = document.querySelector('[data-page="omni"]');
    if (audioPage) {
      const head = audioPage.querySelector(".page-head");
      if (head) head.innerHTML = '<h2>音频智能</h2><p>管理 Qwen Omni Cloud Audio、环境理解、多人转写等增强能力；这些能力独立于实时语音模式。</p>';
      const economyCard = $("economyLiveConfigCard");
      const nativeCard = $("nativeLiveConfigCard");
      if (economyCard) economyCard.remove();
      if (nativeCard) nativeCard.remove();
    }

    const page = document.querySelector('[data-page="dashscope"]');
    if (!page || $("realtimeVoiceConsole")) {
      refreshConsoleLabels();
      return;
    }

    const style = document.createElement("style");
    style.id = "realtimeVoiceConsoleStyles";
    style.textContent = '.voice-mode-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}.voice-mode{border:1px solid #dfe3eb;border-radius:14px;padding:15px;background:#fcfcfd}.voice-mode strong{display:block;margin-bottom:5px}.voice-mode .badge{margin-top:8px}.voice-card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:14px}.voice-card-head h3{margin:0 0 5px}.voice-card-head .hint{max-width:760px}.voice-advanced{margin-top:14px;border-top:1px solid #eaecf0;padding-top:12px}.voice-advanced summary{cursor:pointer;font-weight:700;color:#3448d8}.voice-advanced .grid{margin-top:14px}@media(max-width:760px){.voice-mode-grid{grid-template-columns:1fr}.voice-card-head{display:block}.voice-card-head .badge{margin-top:8px}}';
    document.head.appendChild(style);

    page.innerHTML = '<div id="realtimeVoiceConsole">' +
      '<div class="page-head"><h2>实时语音</h2><p>只在这里选择和配置“怎么跟 AI 实时说话”。ChatGPT Live、Qwen Native 和 Economy Live 不再分散到多个接口页面。</p></div>' +
      '<div class="card"><h3>三种实时语音体验</h3><div class="voice-mode-grid">' +
        '<div class="voice-mode"><strong>ChatGPT Live</strong><div class="hint">Chat2API → ChatGPT Voice，端到端原生实时语音。</div><span id="RT_CHAT2API_STATUS" class="badge">读取中</span></div>' +
        '<div class="voice-mode"><strong>Qwen Native Live</strong><div class="hint">Qwen Audio / Omni Realtime，原生端到端语音。</div><span id="RT_QWEN_STATUS" class="badge">读取中</span></div>' +
        '<div class="voice-mode"><strong>Economy Live</strong><div class="hint">实时 ASR → 文本 LLM → TTS，成本更低。</div><span id="RT_ECONOMY_STATUS" class="badge">读取中</span></div>' +
      '</div><div class="section-note" style="margin-top:14px">Android 端仍通过“体验模式”选择实际链路；这里负责服务器能力和凭据。生产兼容路由保持 Auto 即可，不要把内部 engine 当成产品模式。</div></div>' +
      '<div class="card"><div class="voice-card-head"><div><h3>ChatGPT Live · Chat2API</h3><div class="hint">配置后，新会话选择 ChatGPT Live 就会使用 chat2api_live Provider。API Key 不会从服务端回显。</div></div><span id="CHAT2API_LIVE_KEY_STATE" class="badge">Key 未配置</span></div><div class="grid">' +
        '<div class="field"><label>ChatGPT Live</label><select id="CHAT2API_LIVE_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div>' +
        '<div class="field"><label>模型</label><select id="CHAT2API_LIVE_MODEL"><option value="gpt-live">gpt-live</option><option value="gpt-live-mini">gpt-live-mini</option></select></div>' +
        '<div class="field full"><label>Chat2API 地址</label><input id="CHAT2API_LIVE_BASE_URL" placeholder="https://chat2api.mv3.cn" /><div class="hint">支持 http(s) / ws(s)，服务端会自动补 /v1/audio/realtime。</div></div>' +
        '<div class="field full"><label>Chat2API API Key</label><input id="CHAT2API_LIVE_API_KEY" type="password" placeholder="留空保留服务器已经保存的 Key" /></div>' +
        '<div class="field full"><label>Client ID（可选）</label><input id="CHAT2API_LIVE_CLIENT_ID" placeholder="单个浏览器扩展在线时留空自动选择" /></div>' +
      '</div><div id="chat2apiVoiceStatus" class="status" style="margin-top:14px">读取中…</div></div>' +
      '<div class="card"><div class="voice-card-head"><div><h3>Qwen 共享凭据</h3><div class="hint">Economy Live 和 Qwen Native 共用 DashScope 账号。Native 也可以在“音频智能”页单独配置 Omni Key。</div></div><span id="dashscopeState" class="badge">未配置</span></div><div class="grid">' +
        '<div class="field full"><label>DashScope API Key</label><input id="DASHSCOPE_API_KEY" type="password" placeholder="留空保留已保存的 Key" /></div>' +
        '<div class="field"><label>Workspace ID</label><input id="DASHSCOPE_WORKSPACE_ID" /></div><div></div>' +
      '</div><details class="voice-advanced"><summary>高级连接地址</summary><div class="grid">' +
        '<div class="field full"><label>ASR WebSocket Base URL</label><input id="DASHSCOPE_ASR_WS_BASE_URL" placeholder="留空使用默认地址" /></div>' +
        '<div class="field full"><label>TTS WebSocket Base URL</label><input id="DASHSCOPE_TTS_WS_BASE_URL" placeholder="留空使用默认地址" /></div>' +
      '</div></details></div>' +
      '<div class="card"><div class="voice-card-head"><div><h3>Qwen Native Live</h3><div class="hint">适合追求 Qwen 原生端到端语音体验。新 Android 客户端会按体验模式覆盖服务器默认模型和音色。</div></div></div><div class="grid">' +
        '<div class="field"><label>Native Live</label><select id="QWEN_OMNI_REALTIME_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div>' +
        '<div class="field"><label>默认 Realtime Model</label><select id="QWEN_OMNI_REALTIME_MODEL"><option value="qwen-audio-3.0-realtime-plus">qwen-audio-3.0-realtime-plus</option><option value="qwen-audio-3.0-realtime-flash">qwen-audio-3.0-realtime-flash</option><option value="qwen3.5-omni-plus-realtime">qwen3.5-omni-plus-realtime</option><option value="qwen3.5-omni-flash-realtime">qwen3.5-omni-flash-realtime</option></select></div>' +
        '<div class="field"><label>服务器默认音色</label><input id="QWEN_OMNI_REALTIME_VOICE" placeholder="longanqian / Tina" /></div>' +
        '<div class="field"><label>Turn Detection</label><select id="QWEN_OMNI_REALTIME_TURN_DETECTION"><option value="smart_turn">Smart Turn</option><option value="server_vad">Server VAD</option><option value="semantic_vad">Semantic VAD</option></select></div>' +
      '</div><details class="voice-advanced"><summary>Native 高级设置</summary><div class="grid">' +
        '<div class="field full"><label>Realtime WebSocket Base URL</label><input id="QWEN_OMNI_REALTIME_BASE_URL" placeholder="留空复用 Workspace 默认实时地址" /></div>' +
        '<div class="field"><label>VAD Threshold</label><input id="QWEN_OMNI_REALTIME_VAD_THRESHOLD" type="number" min="-1" max="1" step="0.05" /></div>' +
        '<div class="field"><label>静音结束窗口(ms)</label><input id="QWEN_OMNI_REALTIME_SILENCE_MS" type="number" min="200" max="6000" step="50" /></div>' +
        '<div class="field"><label>兼容路由策略</label><select id="AIPANY_REALTIME_ENGINE"><option value="auto">Auto（推荐）</option><option value="omni_realtime">强制 Native</option><option value="cascaded">强制 Economy</option></select></div>' +
      '</div></details></div>' +
      '<div class="card"><div class="voice-card-head"><div><h3>Economy Live</h3><div class="hint">流式 ASR + 文本 LLM Provider Pool + 独立 TTS。文本模型仍在“文本 LLM”页面统一管理。</div></div></div><div class="grid">' +
        '<div class="field"><label>实时 ASR Model</label><input id="QWEN_ASR_MODEL" /></div>' +
        '<div class="field"><label>TTS Model</label><select id="QWEN_TTS_MODEL"><option value="qwen-audio-3.0-tts-plus">qwen-audio-3.0-tts-plus</option><option value="qwen-audio-3.0-tts-flash">qwen-audio-3.0-tts-flash</option><option value="qwen3-tts-instruct-flash-realtime">qwen3-tts-instruct-flash-realtime</option></select></div>' +
        '<div class="field"><label>TTS 音色</label><input id="QWEN_TTS_VOICE" placeholder="longanlingxin / Cherry" /></div>' +
        '<div class="field"><label>输出语言</label><select id="QWEN_TTS_LANGUAGE"><option value="Chinese">中文</option><option value="English">英文</option></select></div>' +
      '</div></div>' +
      '<div class="card"><div class="actions"><button class="btn primary" id="saveRealtimeVoiceBtn">保存实时语音配置</button><button class="btn secondary" id="reloadRealtimeVoiceBtn">重新读取</button><a class="btn ghost" href="/admin/config/quality" style="text-decoration:none">查看实时质量与 GPT-Live 诊断</a></div><div id="realtimeVoiceStatus" class="status" style="margin-top:14px">等待读取配置</div></div>' +
    '</div>';

    $("saveRealtimeVoiceBtn").onclick = saveRealtimeVoice;
    $("reloadRealtimeVoiceBtn").onclick = () => loadRealtimeVoice().catch(showRealtimeVoiceError);
    realtimeVoiceLoaded = false;
    refreshConsoleLabels();
  }

  function voiceValue(id) {
    const element = $(id);
    return element && typeof element.value === "string" ? element.value.trim() : "";
  }

  function setVoiceValue(id, value) {
    const element = $(id);
    if (element) element.value = value == null ? "" : String(value);
  }

  function setVoiceBadge(id, text, ok, bad) {
    const element = $(id);
    if (!element) return;
    element.textContent = text;
    element.className = "badge " + (ok ? "good" : bad ? "bad" : "");
  }

  function refreshConsoleLabels() {
    const path = location.pathname.replace(/\/$/, "");
    if (path === "/admin/config/dashscope") {
      if ($("pageTitle")) $("pageTitle").textContent = "实时语音";
      if ($("saveBtn")) $("saveBtn").classList.add("hidden");
    } else {
      if ($("saveBtn")) $("saveBtn").classList.remove("hidden");
      if (path === "/admin/config/omni" && $("pageTitle")) $("pageTitle").textContent = "音频智能";
    }
  }

  async function loadRealtimeVoice() {
    installRealtimeVoiceConsole();
    const data = await jsonRequest("/admin/api/config", { headers: authHeaders() });
    const values = data.values || {};
    const secrets = data.secrets || {};
    chat2apiKeyConfigured = Boolean(secrets.CHAT2API_LIVE_API_KEY && secrets.CHAT2API_LIVE_API_KEY.configured);
    const dashscopeKeyConfigured = Boolean(secrets.DASHSCOPE_API_KEY && secrets.DASHSCOPE_API_KEY.configured);
    const omniKeyConfigured = Boolean(secrets.QWEN_OMNI_API_KEY && secrets.QWEN_OMNI_API_KEY.configured);

    setVoiceValue("CHAT2API_LIVE_ENABLED", values.CHAT2API_LIVE_ENABLED || "false");
    setVoiceValue("CHAT2API_LIVE_BASE_URL", values.CHAT2API_LIVE_BASE_URL || "https://chat2api.mv3.cn");
    setVoiceValue("CHAT2API_LIVE_MODEL", values.CHAT2API_LIVE_MODEL || "gpt-live");
    setVoiceValue("CHAT2API_LIVE_CLIENT_ID", values.CHAT2API_LIVE_CLIENT_ID || "");
    setVoiceValue("CHAT2API_LIVE_API_KEY", "");

    setVoiceValue("DASHSCOPE_WORKSPACE_ID", values.DASHSCOPE_WORKSPACE_ID || "");
    setVoiceValue("DASHSCOPE_ASR_WS_BASE_URL", values.DASHSCOPE_ASR_WS_BASE_URL || "");
    setVoiceValue("DASHSCOPE_TTS_WS_BASE_URL", values.DASHSCOPE_TTS_WS_BASE_URL || "");
    setVoiceValue("DASHSCOPE_API_KEY", "");

    setVoiceValue("QWEN_OMNI_REALTIME_ENABLED", values.QWEN_OMNI_REALTIME_ENABLED || "false");
    setVoiceValue("QWEN_OMNI_REALTIME_BASE_URL", values.QWEN_OMNI_REALTIME_BASE_URL || "");
    setVoiceValue("QWEN_OMNI_REALTIME_MODEL", values.QWEN_OMNI_REALTIME_MODEL || "qwen-audio-3.0-realtime-plus");
    setVoiceValue("QWEN_OMNI_REALTIME_VOICE", values.QWEN_OMNI_REALTIME_VOICE || "longanqian");
    setVoiceValue("QWEN_OMNI_REALTIME_TURN_DETECTION", values.QWEN_OMNI_REALTIME_TURN_DETECTION || "smart_turn");
    setVoiceValue("QWEN_OMNI_REALTIME_VAD_THRESHOLD", values.QWEN_OMNI_REALTIME_VAD_THRESHOLD || "0.2");
    setVoiceValue("QWEN_OMNI_REALTIME_SILENCE_MS", values.QWEN_OMNI_REALTIME_SILENCE_MS || "500");
    setVoiceValue("AIPANY_REALTIME_ENGINE", values.AIPANY_REALTIME_ENGINE || "auto");

    setVoiceValue("QWEN_ASR_MODEL", values.QWEN_ASR_MODEL || "qwen3-asr-flash-realtime");
    setVoiceValue("QWEN_TTS_MODEL", values.QWEN_TTS_MODEL || "qwen-audio-3.0-tts-plus");
    setVoiceValue("QWEN_TTS_VOICE", values.QWEN_TTS_VOICE || "longanlingxin");
    setVoiceValue("QWEN_TTS_LANGUAGE", values.QWEN_TTS_LANGUAGE || "Chinese");

    setVoiceBadge("CHAT2API_LIVE_KEY_STATE", chat2apiKeyConfigured ? "Key 已保存" : "Key 未配置", chat2apiKeyConfigured, !chat2apiKeyConfigured);
    setVoiceBadge("dashscopeState", dashscopeKeyConfigured ? "Key 已保存" : "Key 未配置", dashscopeKeyConfigured, !dashscopeKeyConfigured);

    const chatEnabled = values.CHAT2API_LIVE_ENABLED === "true";
    const qwenEnabled = values.QWEN_OMNI_REALTIME_ENABLED === "true";
    setVoiceBadge("RT_CHAT2API_STATUS", chatEnabled && chat2apiKeyConfigured ? "配置可用" : chatEnabled ? "缺少 Key" : "未启用", chatEnabled && chat2apiKeyConfigured, chatEnabled && !chat2apiKeyConfigured);
    setVoiceBadge("RT_QWEN_STATUS", qwenEnabled && (dashscopeKeyConfigured || omniKeyConfigured) ? "配置可用" : qwenEnabled ? "缺少 Key" : "未启用", qwenEnabled && (dashscopeKeyConfigured || omniKeyConfigured), qwenEnabled && !(dashscopeKeyConfigured || omniKeyConfigured));
    setVoiceBadge("RT_ECONOMY_STATUS", dashscopeKeyConfigured ? "配置可用" : "缺少 DashScope Key", dashscopeKeyConfigured, !dashscopeKeyConfigured);

    if ($("chat2apiVoiceStatus")) {
      $("chat2apiVoiceStatus").textContent = chatEnabled
        ? (chat2apiKeyConfigured ? "ChatGPT Live 已启用。Android 选择 ChatGPT Live 后，新会话会走 chat2api_live。" : "ChatGPT Live 已开启，但还没有 Chat2API API Key。")
        : "ChatGPT Live 当前关闭；已有 Key（如果存在）会保留。";
      $("chat2apiVoiceStatus").className = "status " + (chatEnabled && chat2apiKeyConfigured ? "ok" : chatEnabled ? "bad" : "");
    }
    if ($("realtimeVoiceStatus")) {
      $("realtimeVoiceStatus").textContent = "实时语音配置已读取。保存后只影响新建立的会话，不需要重新构建 Docker 镜像。";
      $("realtimeVoiceStatus").className = "status ok";
    }
    realtimeVoiceLoaded = true;
    refreshConsoleLabels();
  }

  function nullableVoiceValue(id) {
    const value = voiceValue(id);
    return value || null;
  }

  async function saveRealtimeVoice() {
    const status = $("realtimeVoiceStatus");
    if (status) {
      status.textContent = "正在保存实时语音配置…";
      status.className = "status";
    }
    try {
      const chatEnabled = voiceValue("CHAT2API_LIVE_ENABLED") === "true";
      const newChatKey = voiceValue("CHAT2API_LIVE_API_KEY");
      if (chatEnabled && !chat2apiKeyConfigured && !newChatKey) throw new Error("开启 ChatGPT Live 前请先填写 Chat2API API Key");
      const body = {
        CHAT2API_LIVE_ENABLED: voiceValue("CHAT2API_LIVE_ENABLED"),
        CHAT2API_LIVE_BASE_URL: voiceValue("CHAT2API_LIVE_BASE_URL"),
        CHAT2API_LIVE_MODEL: voiceValue("CHAT2API_LIVE_MODEL"),
        CHAT2API_LIVE_CLIENT_ID: nullableVoiceValue("CHAT2API_LIVE_CLIENT_ID"),
        DASHSCOPE_WORKSPACE_ID: nullableVoiceValue("DASHSCOPE_WORKSPACE_ID"),
        DASHSCOPE_ASR_WS_BASE_URL: nullableVoiceValue("DASHSCOPE_ASR_WS_BASE_URL"),
        DASHSCOPE_TTS_WS_BASE_URL: nullableVoiceValue("DASHSCOPE_TTS_WS_BASE_URL"),
        QWEN_OMNI_REALTIME_ENABLED: voiceValue("QWEN_OMNI_REALTIME_ENABLED"),
        QWEN_OMNI_REALTIME_BASE_URL: nullableVoiceValue("QWEN_OMNI_REALTIME_BASE_URL"),
        QWEN_OMNI_REALTIME_MODEL: voiceValue("QWEN_OMNI_REALTIME_MODEL"),
        QWEN_OMNI_REALTIME_VOICE: voiceValue("QWEN_OMNI_REALTIME_VOICE"),
        QWEN_OMNI_REALTIME_TURN_DETECTION: voiceValue("QWEN_OMNI_REALTIME_TURN_DETECTION"),
        QWEN_OMNI_REALTIME_VAD_THRESHOLD: voiceValue("QWEN_OMNI_REALTIME_VAD_THRESHOLD"),
        QWEN_OMNI_REALTIME_SILENCE_MS: voiceValue("QWEN_OMNI_REALTIME_SILENCE_MS"),
        AIPANY_REALTIME_ENGINE: voiceValue("AIPANY_REALTIME_ENGINE"),
        QWEN_ASR_MODEL: voiceValue("QWEN_ASR_MODEL"),
        QWEN_TTS_MODEL: voiceValue("QWEN_TTS_MODEL"),
        QWEN_TTS_VOICE: voiceValue("QWEN_TTS_VOICE"),
        QWEN_TTS_LANGUAGE: voiceValue("QWEN_TTS_LANGUAGE"),
      };
      const dashKey = voiceValue("DASHSCOPE_API_KEY");
      if (newChatKey) body.CHAT2API_LIVE_API_KEY = newChatKey;
      if (dashKey) body.DASHSCOPE_API_KEY = dashKey;
      await jsonRequest("/admin/api/config", { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
      await loadRealtimeVoice();
      if (status) {
        status.textContent = "保存成功。ChatGPT Live / Qwen Native / Economy Live 的新会话会立即使用最新配置。";
        status.className = "status ok";
      }
    } catch (error) {
      showRealtimeVoiceError(error);
    }
  }

  function showRealtimeVoiceError(error) {
    const status = $("realtimeVoiceStatus");
    if (!status) return;
    status.textContent = "实时语音配置失败：" + (error && error.message ? error.message : String(error));
    status.className = "status bad";
  }

  function wireRealtimeVoiceNavigation() {
    document.querySelectorAll("#nav a").forEach((link) => link.addEventListener("click", () => setTimeout(() => {
      refreshConsoleLabels();
      if (location.pathname.replace(/\/$/, "") === "/admin/config/dashscope") loadRealtimeVoice().catch(showRealtimeVoiceError);
    }, 0)));
    if ($("mobileNav")) $("mobileNav").addEventListener("change", () => setTimeout(() => {
      refreshConsoleLabels();
      if (location.pathname.replace(/\/$/, "") === "/admin/config/dashscope") loadRealtimeVoice().catch(showRealtimeVoiceError);
    }, 0));
    window.addEventListener("popstate", () => setTimeout(() => {
      refreshConsoleLabels();
      if (location.pathname.replace(/\/$/, "") === "/admin/config/dashscope") loadRealtimeVoice().catch(showRealtimeVoiceError);
    }, 0));
    if ($("reloadBtn")) $("reloadBtn").addEventListener("click", () => setTimeout(() => {
      if (location.pathname.replace(/\/$/, "") === "/admin/config/dashscope") loadRealtimeVoice().catch(showRealtimeVoiceError);
      refreshConsoleLabels();
    }, 80));
  }

  async function loadOperations() {
    installCards();
    const data = await jsonRequest("/admin/api/operations", { headers: authHeaders() });
    const access = data.adminAccess || {};
    const github = data.observabilityGitHub || {};

    $("OPS_PASSWORD_ENABLED").value = access.passwordEnabled ? "true" : "false";
    $("operationsSecurityStatus").textContent = access.passwordEnabled
      ? "密码保护已开启" + (access.passwordConfigured ? "，密码已配置。" : "，但密码尚未配置。")
      : "密码保护已关闭，当前为直接访问模式。";
    $("operationsSecurityStatus").className = "status " + (access.passwordEnabled ? "ok" : "");

    $("OPS_GITHUB_ENABLED").value = github.enabled ? "true" : "false";
    $("OPS_GITHUB_REPOSITORY").value = github.repository || "b8vipvip/aipany";
    $("OPS_GITHUB_BRANCH").value = github.branch || "main";
    $("OPS_GITHUB_PATH").value = github.path || "ops/observability";
    $("OPS_GITHUB_BATCH_SECONDS").value = String(github.batchSeconds || 60);
    $("OPS_GITHUB_ALLOW_PUBLIC").checked = Boolean(github.allowPublicRepository);
    $("OPS_GITHUB_TOKEN_STATE").textContent = github.tokenConfigured ? "已配置" : "未配置";
    $("OPS_GITHUB_TOKEN_STATE").className = "badge " + (github.tokenConfigured ? "good" : "");
    $("operationsGitHubStatus").textContent = github.enabled
      ? "自动同步已开启。事件会按批次上传到 " + github.repository + "/" + github.path
      : "自动同步已关闭。服务器仍会继续写入本地 JSONL。";
    $("operationsGitHubStatus").className = "status " + (github.enabled ? "ok" : "");
    operationsLoaded = true;
  }

  async function saveSecurity() {
    const enabled = $("OPS_PASSWORD_ENABLED").value === "true";
    const newPassword = $("OPS_NEW_PASSWORD").value;
    $("operationsSecurityStatus").textContent = "正在保存…";
    try {
      const body = { passwordEnabled: enabled };
      if (newPassword) body.newPassword = newPassword;
      await jsonRequest("/admin/api/operations/admin-access", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      if (!enabled) sessionStorage.setItem(STORAGE_KEY, "anonymous");
      else if (newPassword) sessionStorage.setItem(STORAGE_KEY, newPassword);
      location.reload();
    } catch (error) {
      $("operationsSecurityStatus").textContent = "保存失败：" + error.message;
      $("operationsSecurityStatus").className = "status bad";
    }
  }

  async function saveGitHub() {
    $("operationsGitHubStatus").textContent = "正在保存…";
    try {
      const body = {
        enabled: $("OPS_GITHUB_ENABLED").value === "true",
        repository: $("OPS_GITHUB_REPOSITORY").value.trim(),
        branch: $("OPS_GITHUB_BRANCH").value.trim(),
        path: $("OPS_GITHUB_PATH").value.trim(),
        batchSeconds: Number($("OPS_GITHUB_BATCH_SECONDS").value),
        allowPublicRepository: $("OPS_GITHUB_ALLOW_PUBLIC").checked,
      };
      const tokenValue = $("OPS_GITHUB_TOKEN").value.trim();
      if (tokenValue) body.token = tokenValue;
      await jsonRequest("/admin/api/operations/github-sync", {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      $("OPS_GITHUB_TOKEN").value = "";
      await loadOperations();
      $("operationsGitHubStatus").textContent = "同步设置已保存。";
      $("operationsGitHubStatus").className = "status ok";
    } catch (error) {
      $("operationsGitHubStatus").textContent = "保存失败：" + error.message;
      $("operationsGitHubStatus").className = "status bad";
    }
  }

  async function testGitHub() {
    $("operationsGitHubStatus").textContent = "正在检查仓库权限和可见性…";
    try {
      const data = await jsonRequest("/admin/api/operations/github-sync/test", {
        method: "POST",
        headers: authHeaders(),
        body: "{}",
      });
      $("operationsGitHubStatus").textContent = "连接成功：" + data.repository + "（" + (data.private ? "Private" : "Public") + "），分支 " + data.branch;
      $("operationsGitHubStatus").className = "status ok";
    } catch (error) {
      $("operationsGitHubStatus").textContent = "连接测试失败：" + error.message;
      $("operationsGitHubStatus").className = "status bad";
    }
  }

  function watchForSuccessfulLogin() {
    const app = $("app");
    if (!app || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (!app.classList.contains("hidden")) {
        if (!operationsLoaded) loadOperations().catch(() => undefined);
        if (!realtimeVoiceLoaded) loadRealtimeVoice().catch(() => undefined);
        refreshConsoleLabels();
      }
    });
    observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  }

  async function bootstrap() {
    installRealtimeVoiceConsole();
    installCards();
    wireRealtimeVoiceNavigation();
    watchForSuccessfulLogin();
    let status;
    try {
      status = await jsonRequest("/admin/api/operations/auth-status");
    } catch {
      return;
    }
    const enabled = Boolean(status.passwordEnabled);
    updateLoginCopy(enabled);
    const currentToken = sessionStorage.getItem(STORAGE_KEY) || "";

    if (!enabled && !currentToken) {
      sessionStorage.setItem(STORAGE_KEY, "anonymous");
      location.reload();
      return;
    }
    if (enabled && currentToken === "anonymous") {
      sessionStorage.removeItem(STORAGE_KEY);
      location.reload();
      return;
    }

    if (currentToken) {
      loadOperations().catch(() => undefined);
      loadRealtimeVoice().catch(() => undefined);
    }
    refreshConsoleLabels();
  }

  bootstrap();
})();`;
