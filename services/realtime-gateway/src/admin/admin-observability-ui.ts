function adminObservabilityUiClient(): void {
  type Overview = {
    generatedAt?: number;
    processUptimeMs?: number;
    activeSessions?: number;
    sessions?: number;
    completedSessions?: number;
    abnormalDisconnects?: number;
    reconnects?: number;
    errors?: number;
    interruptions?: number;
    turns?: number;
    engines?: Record<string, number>;
    latency?: Record<string, { count?: number; averageMs?: number; p50Ms?: number; p95Ms?: number; maxMs?: number }>;
    process?: Record<string, number>;
  };

  const tokenValue = () => sessionStorage.getItem("aipanyAdminToken") || "";
  const headers = () => ({ Authorization: "Bearer " + tokenValue(), "Content-Type": "application/json" });
  const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char] ?? char));
  const ms = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.round(value) + " ms" : "-";
  const dateText = (value: unknown) => typeof value === "number" && value > 0 ? new Date(value).toLocaleString() : "-";
  const duration = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    if (value < 1000) return Math.round(value) + " ms";
    if (value < 60000) return (value / 1000).toFixed(1) + " s";
    return (value / 60000).toFixed(1) + " min";
  };
  const bytes = (value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return "-";
    if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KB";
    return (value / 1024 / 1024).toFixed(1) + " MB";
  };

  function ensureConsolePages(): void {
    const nav = document.getElementById("nav");
    const pageWrap = document.querySelector<HTMLElement>(".page-wrap");
    const mobileNav = document.getElementById("mobileNav") as HTMLSelectElement | null;
    if (!nav || !pageWrap) return;

    const firstExisting = nav.querySelector("a");
    const items = [
      ["quality", "/admin/config/quality", "实时质量"],
      ["sessions", "/admin/config/sessions", "会话"],
      ["logs", "/admin/config/logs", "日志"],
    ] as const;
    for (const [route, href, label] of items.slice().reverse()) {
      if (!nav.querySelector(`[data-route="${route}"]`)) {
        const link = document.createElement("a");
        link.href = href;
        link.dataset.route = route;
        link.textContent = label;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          activate(route, true);
        });
        nav.insertBefore(link, firstExisting);
      }
    }
    if (mobileNav) {
      for (const [route, , label] of items) {
        if (![...mobileNav.options].some((option) => option.value === route)) {
          const option = document.createElement("option");
          option.value = route;
          option.textContent = label;
          mobileNav.insertBefore(option, mobileNav.firstChild);
        }
      }
      mobileNav.addEventListener("change", () => {
        const value = mobileNav.value;
        if (value === "quality" || value === "sessions" || value === "logs") activate(value, true);
      });
    }

    if (!document.querySelector('[data-page="quality"]')) {
      const quality = document.createElement("section");
      quality.className = "page";
      quality.dataset.page = "quality";
      quality.innerHTML = `
        <div class="page-head"><h2>实时质量</h2><p>以最近 24 小时真实会话为依据，判断连接稳定性、首响延迟、打断体验和当前实时引擎状态。</p></div>
        <div id="qualityAlert" class="status">正在读取服务质量…</div>
        <div id="qualityMetrics" class="overview-grid" style="margin-top:16px"></div>
        <div class="card" style="margin-top:18px">
          <div class="toolbar"><div><h3 style="margin:0 0 5px">实时语音首响</h3><div class="hint">P50 代表典型体验，P95 用来发现偶发慢请求。核心指标是“用户说完 → AI 首音频”。</div></div><button id="refreshQualityBtn" class="btn secondary" type="button">立即刷新</button></div>
          <div class="table-wrap"><table><thead><tr><th>阶段</th><th>样本</th><th>平均</th><th>P50</th><th>P95</th><th>最慢</th></tr></thead><tbody id="qualityLatencyRows"></tbody></table></div>
        </div>
        <div class="card"><h3>运行进程</h3><div id="qualityProcess" class="overview-grid"></div></div>
      `;
      pageWrap.insertBefore(quality, pageWrap.firstChild);
      document.getElementById("refreshQualityBtn")?.addEventListener("click", () => { void refreshOverview(true); });
    }

    if (!document.querySelector('[data-page="sessions"]')) {
      const sessions = document.createElement("section");
      sessions.className = "page";
      sessions.dataset.page = "sessions";
      sessions.innerHTML = `
        <div class="page-head"><h2>实时会话</h2><p>查看每台设备的会话时长、断线原因、自动重连迹象、对话轮数、打断次数和首响样本。</p></div>
        <div class="card">
          <div class="toolbar"><div><h3 style="margin:0">最近会话</h3></div><button id="refreshSessionsBtn" class="btn secondary" type="button">刷新</button></div>
          <div class="table-wrap"><table><thead><tr><th>开始时间</th><th>状态</th><th>引擎</th><th>客户端</th><th>时长</th><th>轮次</th><th>打断</th><th>错误</th><th>首响</th><th>关闭原因</th></tr></thead><tbody id="sessionRows"></tbody></table></div>
        </div>
      `;
      pageWrap.insertBefore(sessions, pageWrap.firstChild);
      document.getElementById("refreshSessionsBtn")?.addEventListener("click", () => { void refreshSessions(true); });
    }

    if (!document.querySelector('[data-page="logs"]')) {
      const logs = document.createElement("section");
      logs.className = "page";
      logs.dataset.page = "logs";
      logs.innerHTML = `
        <div class="page-head"><h2>结构化日志</h2><p>日志默认不保存用户对话正文，只记录连接、引擎、耗时、错误代码和技术指标，便于定位网络/API/实时链路问题。</p></div>
        <div class="card">
          <div class="grid4">
            <div class="field"><label>级别</label><select id="logLevel"><option value="">全部</option><option value="error">错误</option><option value="warn">警告</option><option value="info">信息</option></select></div>
            <div class="field"><label>分类</label><select id="logCategory"><option value="">全部</option><option value="connection">连接</option><option value="engine">引擎</option><option value="asr">ASR</option><option value="llm">LLM</option><option value="tts">TTS</option><option value="omni">Omni Live</option><option value="audio">音频</option><option value="client">客户端</option><option value="auth">鉴权</option></select></div>
            <div class="field"><label>关键词</label><input id="logQuery" placeholder="错误代码、事件名…" /></div>
            <div class="field"><label>&nbsp;</label><button id="refreshLogsBtn" class="btn primary" type="button">查询日志</button></div>
          </div>
          <div class="table-wrap"><table><thead><tr><th>时间</th><th>级别</th><th>分类</th><th>事件</th><th>引擎</th><th>Session</th><th>详情</th></tr></thead><tbody id="logRows"></tbody></table></div>
        </div>
      `;
      pageWrap.insertBefore(logs, pageWrap.firstChild);
      document.getElementById("refreshLogsBtn")?.addEventListener("click", () => { void refreshLogs(true); });
    }

    const overview = document.querySelector<HTMLElement>('[data-page="overview"]');
    if (overview && !document.getElementById("opsOverviewCard")) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = "opsOverviewCard";
      card.innerHTML = `<h3>运行与质量</h3><div class="grid"><button class="btn secondary" data-ops-go="quality">查看实时质量与首响</button><button class="btn secondary" data-ops-go="sessions">查看设备会话与断线</button><button class="btn secondary" data-ops-go="logs">查询结构化日志</button><button class="btn secondary" data-ops-go="diagnostics">运行完整链路诊断</button></div>`;
      overview.appendChild(card);
      card.querySelectorAll<HTMLElement>("[data-ops-go]").forEach((button) => {
        button.addEventListener("click", () => {
          const route = button.dataset.opsGo || "quality";
          if (route === "diagnostics") {
            const link = document.querySelector<HTMLAnchorElement>('[data-route="diagnostics"]');
            link?.click();
          } else activate(route, true);
        });
      });
    }
  }

  function activate(route: string, push: boolean): void {
    const pathMap: Record<string, string> = {
      quality: "/admin/config/quality",
      sessions: "/admin/config/sessions",
      logs: "/admin/config/logs",
    };
    const titleMap: Record<string, string> = { quality: "实时质量", sessions: "实时会话", logs: "结构化日志" };
    const path = pathMap[route];
    if (!path) return;
    if (push && location.pathname !== path) history.pushState({}, "", path);
    document.querySelectorAll<HTMLElement>(".page").forEach((page) => page.classList.toggle("active", page.dataset.page === route));
    document.querySelectorAll<HTMLElement>("#nav a").forEach((link) => link.classList.toggle("active", link.dataset.route === route));
    const title = document.getElementById("pageTitle");
    if (title) title.textContent = titleMap[route] ?? route;
    const mobileNav = document.getElementById("mobileNav") as HTMLSelectElement | null;
    if (mobileNav) mobileNav.value = route;
    document.querySelectorAll<HTMLElement>(".save-action").forEach((element) => element.classList.add("hidden"));
    if (route === "quality") void refreshOverview(false);
    if (route === "sessions") void refreshSessions(false);
    if (route === "logs") void refreshLogs(false);
  }

  async function requestJson(path: string): Promise<any> {
    const response = await fetch(path, { headers: headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || data.error || JSON.stringify(data));
    return data;
  }

  async function refreshOverview(showStatus: boolean): Promise<void> {
    if (!tokenValue()) return;
    try {
      const [data, health] = await Promise.all([
        requestJson("/admin/api/observability/overview") as Promise<Overview>,
        fetch("/health").then((response) => response.json()),
      ]);
      renderOverview(data, health);
      if (showStatus) setGlobalStatus("实时质量数据已刷新。", true);
    } catch (error) {
      if (showStatus) setGlobalStatus("读取实时质量失败：" + errorText(error), false);
    }
  }

  function renderOverview(data: Overview, health: Record<string, unknown>): void {
    const target = document.getElementById("qualityMetrics");
    if (!target) return;
    const completed = Number(data.completedSessions) || 0;
    const disconnects = Number(data.abnormalDisconnects) || 0;
    const disconnectRate = completed ? disconnects / completed : 0;
    const totalFirstAudio = data.latency?.speechEndToFirstAudio;
    const p95 = totalFirstAudio?.p95Ms;
    const selectedEngine = String(health.realtimeEngine || "-");
    target.innerHTML = `
      <div class="metric"><small>当前实时引擎</small><strong>${selectedEngine === "omni_realtime" ? "Native Live" : "Cascaded"}</strong><div class="hint">Native 可用：${health.nativeLiveAvailable ? "是" : "否"}</div></div>
      <div class="metric"><small>当前在线会话</small><strong>${Number(data.activeSessions) || 0}</strong><div class="hint">24h 会话 ${Number(data.sessions) || 0}</div></div>
      <div class="metric"><small>异常断线率</small><strong>${(disconnectRate * 100).toFixed(1)}%</strong><div class="hint">异常 ${disconnects} · 疑似自动重连 ${Number(data.reconnects) || 0}</div></div>
      <div class="metric"><small>说完 → 首音频 P95</small><strong>${ms(p95)}</strong><div class="hint">P50 ${ms(totalFirstAudio?.p50Ms)} · 样本 ${Number(totalFirstAudio?.count) || 0}</div></div>
      <div class="metric"><small>24h 错误</small><strong>${Number(data.errors) || 0}</strong><div class="hint">用于判断网络/API/Provider 稳定性</div></div>
      <div class="metric"><small>用户打断</small><strong>${Number(data.interruptions) || 0}</strong><div class="hint">总对话轮次 ${Number(data.turns) || 0}</div></div>
      <div class="metric"><small>Native Live 会话</small><strong>${Number(data.engines?.omni_realtime) || 0}</strong><div class="hint">Cascaded ${Number(data.engines?.cascaded) || 0}</div></div>
      <div class="metric"><small>Gateway 运行时间</small><strong>${duration(data.processUptimeMs)}</strong><div class="hint">数据时间 ${dateText(data.generatedAt)}</div></div>
    `;

    const rows = document.getElementById("qualityLatencyRows");
    if (rows) {
      const metrics = [
        ["用户说完 → AI 首音频", data.latency?.speechEndToFirstAudio],
        ["用户说完 → ASR Final", data.latency?.speechEndToTranscriptFinal],
        ["ASR Final → 首文字 Token", data.latency?.transcriptFinalToFirstText],
        ["首文字 Token → 首音频", data.latency?.firstTextToFirstAudio],
      ] as const;
      rows.innerHTML = metrics.map(([label, value]) => `<tr><td>${label}</td><td>${Number(value?.count) || 0}</td><td>${ms(value?.averageMs)}</td><td>${ms(value?.p50Ms)}</td><td>${ms(value?.p95Ms)}</td><td>${ms(value?.maxMs)}</td></tr>`).join("");
    }

    const processTarget = document.getElementById("qualityProcess");
    if (processTarget) {
      processTarget.innerHTML = `
        <div class="metric"><small>RSS 内存</small><strong>${bytes(data.process?.rssBytes)}</strong></div>
        <div class="metric"><small>Heap Used</small><strong>${bytes(data.process?.heapUsedBytes)}</strong></div>
        <div class="metric"><small>Heap Total</small><strong>${bytes(data.process?.heapTotalBytes)}</strong></div>
        <div class="metric"><small>External</small><strong>${bytes(data.process?.externalBytes)}</strong></div>
      `;
    }

    const alert = document.getElementById("qualityAlert");
    if (alert) {
      const issues: string[] = [];
      if (disconnectRate > 0.05 && completed >= 5) issues.push(`异常断线率 ${(disconnectRate * 100).toFixed(1)}%，建议先检查网络/代理和关闭码`);
      if (typeof p95 === "number" && p95 > 3000) issues.push(`首响 P95 ${Math.round(p95)}ms，仍有明显慢请求`);
      if ((Number(data.errors) || 0) > 10) issues.push(`24h 内记录 ${Number(data.errors)} 个错误，需要查看日志分类`);
      alert.className = "status " + (issues.length ? "bad" : "ok");
      alert.textContent = issues.length ? issues.join("\n") : "当前没有检测到明显的实时质量异常。继续积累真机样本后，P50/P95 会更有代表性。";
    }
  }

  async function refreshSessions(showStatus: boolean): Promise<void> {
    if (!tokenValue()) return;
    try {
      const data = await requestJson("/admin/api/observability/sessions?limit=150");
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      const rows = document.getElementById("sessionRows");
      if (rows) {
        rows.innerHTML = sessions.map((session: Record<string, any>) => {
          const samples = Array.isArray(session.latency) ? session.latency : [];
          const last = samples.at(-1);
          const active = !session.endedAt;
          const state = active ? "在线" : session.abnormalDisconnect ? "异常断开" : "已结束";
          const statusClass = active ? "good" : session.abnormalDisconnect ? "bad" : "";
          const client = [session.platform, session.appVersion].filter(Boolean).join(" ") || session.deviceType || "-";
          const close = active ? "-" : `${session.closeCode ?? "-"} ${session.closeReason || ""}`.trim();
          return `<tr>
            <td>${dateText(session.startedAt)}</td><td><span class="badge ${statusClass}">${state}</span>${session.reconnectLikely ? '<div class="hint">疑似重连</div>' : ""}</td>
            <td>${session.engine === "omni_realtime" ? "Native Live" : "Cascaded"}</td><td>${esc(client)}</td><td>${duration(session.durationMs)}</td>
            <td>${Number(session.turns) || 0}</td><td>${Number(session.interruptions) || 0}</td><td>${Number(session.errors) || 0}</td><td>${ms(last?.speechEndToFirstAudioMs)}</td><td title="${esc(close)}">${esc(close.slice(0, 80))}</td>
          </tr>`;
        }).join("") || '<tr><td colspan="10">暂无会话记录</td></tr>';
      }
      if (showStatus) setGlobalStatus("会话列表已刷新。", true);
    } catch (error) {
      if (showStatus) setGlobalStatus("读取会话失败：" + errorText(error), false);
    }
  }

  async function refreshLogs(showStatus: boolean): Promise<void> {
    if (!tokenValue()) return;
    try {
      const level = (document.getElementById("logLevel") as HTMLSelectElement | null)?.value || "";
      const category = (document.getElementById("logCategory") as HTMLSelectElement | null)?.value || "";
      const query = (document.getElementById("logQuery") as HTMLInputElement | null)?.value || "";
      const params = new URLSearchParams({ limit: "300" });
      if (level) params.set("level", level);
      if (category) params.set("category", category);
      if (query) params.set("q", query);
      const data = await requestJson("/admin/api/observability/events?" + params.toString());
      const events = Array.isArray(data.events) ? data.events : [];
      const rows = document.getElementById("logRows");
      if (rows) {
        rows.innerHTML = events.map((event: Record<string, any>) => {
          const levelClass = event.level === "error" ? "bad" : event.level === "warn" ? "" : "good";
          const details = JSON.stringify(event.data || {});
          return `<tr><td>${dateText(event.timestamp)}</td><td><span class="badge ${levelClass}">${esc(event.level)}</span></td><td>${esc(event.category)}</td><td>${esc(event.event)}</td><td>${event.engine === "omni_realtime" ? "Native Live" : event.engine === "cascaded" ? "Cascaded" : "-"}</td><td>${esc(String(event.sessionId || "").slice(0, 12))}</td><td title="${esc(details)}">${esc(details.slice(0, 160))}</td></tr>`;
        }).join("") || '<tr><td colspan="7">没有符合条件的日志</td></tr>';
      }
      if (showStatus) setGlobalStatus("日志已刷新。", true);
    } catch (error) {
      if (showStatus) setGlobalStatus("读取日志失败：" + errorText(error), false);
    }
  }

  function setGlobalStatus(text: string, ok: boolean): void {
    const target = document.getElementById("globalStatus");
    if (!target) return;
    target.textContent = text;
    target.className = "status global-status " + (ok ? "ok" : "bad");
  }

  function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  ensureConsolePages();

  const initialPath = location.pathname.replace(/\/$/, "");
  if (initialPath.endsWith("/quality")) activate("quality", false);
  if (initialPath.endsWith("/sessions")) activate("sessions", false);
  if (initialPath.endsWith("/logs")) activate("logs", false);

  window.addEventListener("popstate", () => {
    const path = location.pathname.replace(/\/$/, "");
    if (path.endsWith("/quality")) activate("quality", false);
    if (path.endsWith("/sessions")) activate("sessions", false);
    if (path.endsWith("/logs")) activate("logs", false);
  });

  void refreshOverview(false);
  setInterval(() => {
    const active = document.querySelector<HTMLElement>(".page.active")?.dataset.page;
    if (active === "quality") void refreshOverview(false);
    if (active === "sessions") void refreshSessions(false);
  }, 5000);
}

export const ADMIN_OBSERVABILITY_UI = `(${adminObservabilityUiClient.toString()})();`;
