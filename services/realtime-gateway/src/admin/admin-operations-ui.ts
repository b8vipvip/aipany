export const ADMIN_OPERATIONS_UI = String.raw`(() => {
  const STORAGE_KEY = "aipanyAdminToken";
  const $ = (id) => document.getElementById(id);
  let operationsLoaded = false;
  let realtimeLoaded = false;
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

  function installUnifiedNavigation() {
    const nav = $("nav");
    const realtimeLink = nav && nav.querySelector('[data-route="dashscope"]');
    const audioLink = nav && nav.querySelector('[data-route="omni"]');
    const remoteLink = nav && nav.querySelector('[data-route="remote"]');
    if (realtimeLink) realtimeLink.textContent = "实时语音";
    if (audioLink) audioLink.textContent = "音频智能";
    if (remoteLink) remoteLink.style.display = "none";

    const mobile = $("mobileNav");
    if (mobile) {
      const dashOption = mobile.querySelector('option[value="dashscope"]');
      const omniOption = mobile.querySelector('option[value="omni"]');
      const remoteOption = mobile.querySelector('option[value="remote"]');
      if (dashOption) dashOption.textContent = "实时语音";
      if (omniOption) omniOption.textContent = "音频智能";
      if (remoteOption) remoteOption.remove();
    }

    const realtimePage = document.querySelector('[data-page="dashscope"]');
    if (realtimePage) {
      const head = realtimePage.querySelector(".page-head");
      if (head) head.innerHTML = '<h2>实时语音</h2><p>只在这里选择和配置实时对话链路：ChatGPT Live、Qwen Native Live 或 Economy Live。</p>';
    }

    const audioPage = document.querySelector('[data-page="omni"]');
    if (audioPage) {
      const head = audioPage.querySelector(".page-head");
      if (head) head.innerHTML = '<h2>音频智能</h2><p>环境理解、多人转写、声纹与远程语音分离等增强能力；它们不是实时语音引擎。</p>';
      const cloudCard = audioPage.querySelector(".card");
      if (cloudCard && !cloudCard.querySelector("[data-audio-card-title]")) {
        const title = document.createElement("div");
        title.setAttribute("data-audio-card-title", "true");
        title.innerHTML = '<h3 style="margin:0 0 5px">Qwen Omni Cloud Audio</h3><div class="hint" style="margin-bottom:16px">用于环境理解、音频事件和云端多人转写，不决定 App 使用哪种实时语音模式。</div>';
        cloudCard.insertBefore(title, cloudCard.firstChild);
      }
      const remotePage = document.querySelector('[data-page="remote"]');
      const remoteCard = remotePage && remotePage.querySelector(".card");
      if (remoteCard && !$("audioRemoteTitle")) {
        const title = document.createElement("div");
        title.id = "audioRemoteTitle";
        title.innerHTML = '<h3 style="margin:0 0 5px">Remote GPU / SepFormer</h3><div class="hint" style="margin-bottom:16px">可选的远程语音分离与目标说话人提取 Worker。</div>';
        remoteCard.insertBefore(title, remoteCard.firstChild);
        audioPage.appendChild(remoteCard);
      }
      const remotePageNow = document.querySelector('[data-page="remote"]');
      if (remotePageNow && !remotePageNow.querySelector(".section-note")) {
        remotePageNow.innerHTML = '<div class="page-head"><h2>Remote GPU</h2></div><div class="section-note">Remote GPU 配置已经合并到“音频智能”页面。</div>';
      }
    }

    const quickRealtime = document.querySelector('[data-go="dashscope"]');
    if (quickRealtime) quickRealtime.textContent = "配置实时语音模式";

    const overview = document.querySelector('[data-page="overview"] .overview-grid');
    if (overview) {
      const cards = overview.querySelectorAll(".metric");
      if (cards[0] && cards[0].querySelector("small")) cards[0].querySelector("small").textContent = "实时语音";
      if (cards[1] && cards[1].querySelector("small")) cards[1].querySelector("small").textContent = "音频智能";
      if (cards[3] && cards[3].querySelector("small")) cards[3].querySelector("small").textContent = "ChatGPT Live";
    }
  }

  function installRealtimeConsole() {
    if ($("chat2apiLiveCard")) return;
    installUnifiedNavigation();
    const page = document.querySelector('[data-page="dashscope"]');
    if (!page) return;
    const oldEconomyCard = page.querySelector(".card");

    const style = document.createElement("style");
    style.id = "aipanyRealtimeConsoleStyle";
    style.textContent = '.realtime-mode-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px}.realtime-mode{border:1px solid #e4e7ec;border-radius:14px;padding:16px;background:#fff}.realtime-mode strong{display:block;margin-bottom:5px}.realtime-mode .mode-state{margin-top:10px}.realtime-recommended{border-color:#aeb8ff;background:#f8f9ff}.advanced-box{margin-top:14px;padding-top:14px;border-top:1px solid #eaecf0}@media(max-width:800px){.realtime-mode-grid{grid-template-columns:1fr}}';
    document.head.appendChild(style);

    const summary = document.createElement("div");
    summary.className = "realtime-mode-grid";
    summary.id = "realtimeModeSummary";
    summary.innerHTML = '<div class="realtime-mode realtime-recommended"><strong>ChatGPT Live <span class="badge good">推荐</span></strong><div class="hint">Chat2API → ChatGPT Voice，原生实时语音。新安装 App 在可用时优先选择。</div><div id="summaryChat2Api" class="mode-state status">检查中…</div></div><div class="realtime-mode"><strong>Qwen Native Live</strong><div class="hint">Qwen Audio / Omni 端到端实时语音，作为原生实时备选。</div><div id="summaryNative" class="mode-state status">检查中…</div></div><div class="realtime-mode"><strong>Economy Live</strong><div class="hint">ASR → 文本 LLM → TTS，成本最低，也作为不可用时的兜底。</div><div id="summaryEconomy" class="mode-state status ok">始终可用</div></div>';
    if (oldEconomyCard) page.insertBefore(summary, oldEconomyCard);
    else page.appendChild(summary);

    const chat = document.createElement("div");
    chat.id = "chat2apiLiveCard";
    chat.className = "card";
    chat.innerHTML = '<div class="toolbar"><div><h3 style="margin:0 0 5px">ChatGPT Live</h3><div class="hint">通过 Chat2API 连接已登录的 ChatGPT Voice。保存后新会话立即生效，无需重建 Docker。</div></div><div class="actions"><button class="btn secondary" id="checkChat2ApiLiveBtn" type="button">检查可用性</button><button class="btn primary" id="saveChat2ApiLiveBtn" type="button">保存 ChatGPT Live</button></div></div><div class="grid"><div class="field"><label>ChatGPT Live</label><select id="CHAT2API_LIVE_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div><div class="field"><label>模型</label><select id="CHAT2API_LIVE_MODEL"><option value="gpt-live">gpt-live</option><option value="gpt-live-mini">gpt-live-mini</option></select></div><div class="field full"><label>Chat2API Base URL</label><input id="CHAT2API_LIVE_BASE_URL" placeholder="https://chat2api.mv3.cn" /><div class="hint">填写 Chat2API 服务根地址，不要填写 /v1/audio/realtime。</div></div><div class="field full"><label>API Key <span id="CHAT2API_LIVE_KEY_STATE" class="badge">未配置</span></label><input id="CHAT2API_LIVE_API_KEY" type="password" placeholder="留空保留已保存的 Key" /><div class="hint">Key 只保存在服务器运行时配置文件中；读取接口不会回显明文。</div></div><div class="field full"><label>Client ID（可选）</label><input id="CHAT2API_LIVE_CLIENT_ID" placeholder="只有多个 Chat2API Chrome 扩展同时在线时才需要固定" /></div></div><div id="chat2apiLiveStatus" class="status" style="margin-top:14px">等待读取配置</div>';
    if (oldEconomyCard) page.insertBefore(chat, oldEconomyCard);
    else page.appendChild(chat);

    const native = document.createElement("div");
    native.id = "nativeLiveUnifiedCard";
    native.className = "card";
    native.innerHTML = '<div class="toolbar"><div><h3 style="margin:0 0 5px">Qwen Native Live</h3><div class="hint">Qwen Audio / Qwen3.5 Omni 的端到端实时语音。与 ChatGPT Live 是并列 Provider，不再混在 Cloud Audio 页面。</div></div><button class="btn primary" id="saveNativeUnifiedBtn" type="button">保存 Native Live</button></div><div class="grid"><div class="field"><label>Native Live</label><select id="QWEN_OMNI_REALTIME_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select></div><div class="field"><label>默认模型</label><select id="QWEN_OMNI_REALTIME_MODEL"><option value="qwen-audio-3.0-realtime-plus">qwen-audio-3.0-realtime-plus</option><option value="qwen-audio-3.0-realtime-flash">qwen-audio-3.0-realtime-flash</option><option value="qwen3.5-omni-plus-realtime">qwen3.5-omni-plus-realtime</option><option value="qwen3.5-omni-flash-realtime">qwen3.5-omni-flash-realtime</option></select></div><div class="field full"><label>Realtime WebSocket Base URL</label><input id="QWEN_OMNI_REALTIME_BASE_URL" placeholder="留空复用 DashScope 默认实时地址" /></div><div class="field"><label>服务器默认音色</label><input id="QWEN_OMNI_REALTIME_VOICE" placeholder="longanqian" /></div><div class="field"><label>Turn Detection</label><select id="QWEN_OMNI_REALTIME_TURN_DETECTION"><option value="smart_turn">Smart Turn</option><option value="server_vad">Server VAD</option><option value="semantic_vad">Semantic VAD</option></select></div><div class="field"><label>VAD Threshold</label><input id="QWEN_OMNI_REALTIME_VAD_THRESHOLD" type="number" min="-1" max="1" step="0.05" /></div><div class="field"><label>静音结束窗口(ms)</label><input id="QWEN_OMNI_REALTIME_SILENCE_MS" type="number" min="200" max="6000" step="50" /></div></div><div id="nativeLiveUnifiedStatus" class="status" style="margin-top:14px">等待读取配置</div>';
    if (oldEconomyCard) page.insertBefore(native, oldEconomyCard);
    else page.appendChild(native);

    if (oldEconomyCard && !$("economyUnifiedTitle")) {
      const title = document.createElement("div");
      title.id = "economyUnifiedTitle";
      title.innerHTML = '<div class="toolbar"><div><h3 style="margin:0 0 5px">Economy Live</h3><div class="hint">流式 ASR → 文本 LLM Provider Pool → TTS。文本模型和故障切换仍在“文本 LLM”页面统一管理。</div></div></div>';
      oldEconomyCard.insertBefore(title, oldEconomyCard.firstChild);
    }

    $("saveChat2ApiLiveBtn").onclick = saveChat2ApiLive;
    $("checkChat2ApiLiveBtn").onclick = checkRealtimeAvailability;
    $("saveNativeUnifiedBtn").onclick = saveNativeLive;
  }

  function setValue(id, value) {
    const el = $(id);
    if (el) el.value = String(value == null ? "" : value);
  }

  function setLiveStatus(id, text, ok) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = "status" + (ok === true ? " ok" : ok === false ? " bad" : "");
  }

  async function loadRealtimeConfig() {
    installRealtimeConsole();
    const data = await jsonRequest("/admin/api/config", { headers: authHeaders() });
    const values = data.values || {};
    const secrets = data.secrets || {};
    setValue("CHAT2API_LIVE_ENABLED", values.CHAT2API_LIVE_ENABLED || "false");
    setValue("CHAT2API_LIVE_BASE_URL", values.CHAT2API_LIVE_BASE_URL || "https://chat2api.mv3.cn");
    setValue("CHAT2API_LIVE_MODEL", values.CHAT2API_LIVE_MODEL || "gpt-live");
    setValue("CHAT2API_LIVE_CLIENT_ID", values.CHAT2API_LIVE_CLIENT_ID || "");
    const chatKeyConfigured = Boolean(secrets.CHAT2API_LIVE_API_KEY && secrets.CHAT2API_LIVE_API_KEY.configured);
    if ($("CHAT2API_LIVE_KEY_STATE")) {
      $("CHAT2API_LIVE_KEY_STATE").textContent = chatKeyConfigured ? "已配置" : "未配置";
      $("CHAT2API_LIVE_KEY_STATE").className = "badge " + (chatKeyConfigured ? "good" : "");
    }
    const chatEnabled = values.CHAT2API_LIVE_ENABLED === "true";
    setLiveStatus("chat2apiLiveStatus", chatEnabled
      ? (chatKeyConfigured ? "配置已启用。正在检查 App 能力接口…" : "已开启，但 API Key 尚未配置。")
      : "当前关闭。开启并保存后，新安装 App 会优先选择 ChatGPT Live。", chatEnabled && chatKeyConfigured ? undefined : !chatEnabled ? undefined : false);

    setValue("QWEN_OMNI_REALTIME_ENABLED", values.QWEN_OMNI_REALTIME_ENABLED || "false");
    setValue("QWEN_OMNI_REALTIME_BASE_URL", values.QWEN_OMNI_REALTIME_BASE_URL || "");
    setValue("QWEN_OMNI_REALTIME_MODEL", values.QWEN_OMNI_REALTIME_MODEL || "qwen-audio-3.0-realtime-plus");
    setValue("QWEN_OMNI_REALTIME_VOICE", values.QWEN_OMNI_REALTIME_VOICE || "longanqian");
    setValue("QWEN_OMNI_REALTIME_TURN_DETECTION", values.QWEN_OMNI_REALTIME_TURN_DETECTION || "smart_turn");
    setValue("QWEN_OMNI_REALTIME_VAD_THRESHOLD", values.QWEN_OMNI_REALTIME_VAD_THRESHOLD || "0.2");
    setValue("QWEN_OMNI_REALTIME_SILENCE_MS", values.QWEN_OMNI_REALTIME_SILENCE_MS || "500");
    setLiveStatus("nativeLiveUnifiedStatus", values.QWEN_OMNI_REALTIME_ENABLED === "true" ? "Native Live 已开启。" : "Native Live 已关闭。", values.QWEN_OMNI_REALTIME_ENABLED === "true" ? true : undefined);
    realtimeLoaded = true;
    await checkRealtimeAvailability(false);
  }

  async function saveChat2ApiLive() {
    setLiveStatus("chat2apiLiveStatus", "正在保存 ChatGPT Live 配置…");
    try {
      const body = {
        CHAT2API_LIVE_ENABLED: $("CHAT2API_LIVE_ENABLED").value,
        CHAT2API_LIVE_BASE_URL: $("CHAT2API_LIVE_BASE_URL").value.trim() || "https://chat2api.mv3.cn",
        CHAT2API_LIVE_MODEL: $("CHAT2API_LIVE_MODEL").value,
        CHAT2API_LIVE_CLIENT_ID: $("CHAT2API_LIVE_CLIENT_ID").value.trim() || null,
      };
      const key = $("CHAT2API_LIVE_API_KEY").value.trim();
      if (key) body.CHAT2API_LIVE_API_KEY = key;
      await jsonRequest("/admin/api/config", { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
      $("CHAT2API_LIVE_API_KEY").value = "";
      await loadRealtimeConfig();
      setLiveStatus("chat2apiLiveStatus", "保存成功。新建立的会话会立即读取最新 Chat2API Live 配置。", true);
    } catch (error) {
      setLiveStatus("chat2apiLiveStatus", "保存失败：" + error.message, false);
    }
  }

  async function saveNativeLive() {
    setLiveStatus("nativeLiveUnifiedStatus", "正在保存 Native Live 配置…");
    try {
      const body = {
        QWEN_OMNI_REALTIME_ENABLED: $("QWEN_OMNI_REALTIME_ENABLED").value,
        QWEN_OMNI_REALTIME_BASE_URL: $("QWEN_OMNI_REALTIME_BASE_URL").value.trim() || null,
        QWEN_OMNI_REALTIME_MODEL: $("QWEN_OMNI_REALTIME_MODEL").value,
        QWEN_OMNI_REALTIME_VOICE: $("QWEN_OMNI_REALTIME_VOICE").value.trim(),
        QWEN_OMNI_REALTIME_TURN_DETECTION: $("QWEN_OMNI_REALTIME_TURN_DETECTION").value,
        QWEN_OMNI_REALTIME_VAD_THRESHOLD: $("QWEN_OMNI_REALTIME_VAD_THRESHOLD").value,
        QWEN_OMNI_REALTIME_SILENCE_MS: $("QWEN_OMNI_REALTIME_SILENCE_MS").value,
      };
      await jsonRequest("/admin/api/config", { method: "PUT", headers: authHeaders(), body: JSON.stringify(body) });
      await loadRealtimeConfig();
      setLiveStatus("nativeLiveUnifiedStatus", "保存成功。新建立的 Native Live 会话会使用最新设置。", true);
    } catch (error) {
      setLiveStatus("nativeLiveUnifiedStatus", "保存失败：" + error.message, false);
    }
  }

  async function checkRealtimeAvailability(showWorking = true) {
    if (showWorking) setLiveStatus("chat2apiLiveStatus", "正在检查 Gateway 与 ChatGPT Live 可用性…");
    try {
      const response = await fetch("/v1/mobile/capabilities", { cache: "no-store" });
      if (!response.ok) throw new Error("Capabilities HTTP " + response.status);
      const data = await response.json();
      const modes = Array.isArray(data.experienceModes) ? data.experienceModes : [];
      const chat = modes.find((item) => item && item.id === "chat2api_live");
      const native = modes.find((item) => item && (item.id === "native_plus" || item.id === "native_flash") && item.engine === "omni_realtime");
      const chatAvailable = Boolean(chat && chat.engine === "omni_realtime" && !String(chat.title || "").includes("未启用"));
      setLiveStatus("summaryChat2Api", chatAvailable ? "可用 · App 可选择 ChatGPT Live" : "未就绪", chatAvailable);
      setLiveStatus("summaryNative", native ? "可用" : "未启用 / 未配置", native ? true : undefined);
      if ($("overviewRemote")) $("overviewRemote").textContent = chatAvailable ? "已就绪" : "未就绪";
      if (chatAvailable) setLiveStatus("chat2apiLiveStatus", "可用：Gateway 已把 ChatGPT Live 暴露为实时体验。真正的 ChatGPT Voice ready 状态请在会话诊断中确认。", true);
      else setLiveStatus("chat2apiLiveStatus", "当前未就绪：请确认已开启 ChatGPT Live、API Key 已保存，并且 Chat2API 服务可用。", false);
    } catch (error) {
      setLiveStatus("summaryChat2Api", "检查失败", false);
      setLiveStatus("chat2apiLiveStatus", "可用性检查失败：" + error.message, false);
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
        if (!realtimeLoaded) loadRealtimeConfig().catch(() => undefined);
      }
    });
    observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  }

  async function bootstrap() {
    installUnifiedNavigation();
    installRealtimeConsole();
    installCards();
    watchForSuccessfulLogin();
    $("reloadBtn") && $("reloadBtn").addEventListener("click", () => setTimeout(() => { loadRealtimeConfig().catch(() => undefined); }, 100));
    document.querySelector('[data-route="dashscope"]') && document.querySelector('[data-route="dashscope"]').addEventListener("click", () => setTimeout(() => { loadRealtimeConfig().catch(() => undefined); }, 50));
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
      loadRealtimeConfig().catch(() => undefined);
    }
  }

  bootstrap();
})();`;
