export const ADMIN_OPERATIONS_UI = String.raw`(() => {
  const STORAGE_KEY = "aipanyAdminToken";
  const $ = (id) => document.getElementById(id);
  let operationsLoaded = false;
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
      if (!app.classList.contains("hidden") && !operationsLoaded) {
        loadOperations().catch(() => undefined);
      }
    });
    observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  }

  async function bootstrap() {
    installCards();
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
    }
  }

  bootstrap();
})();`;
