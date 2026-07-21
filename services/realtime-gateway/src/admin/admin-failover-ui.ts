export const ADMIN_FAILOVER_UI = String.raw`(() => {
  const tokenValue = () => sessionStorage.getItem("aipanyAdminToken") || "";
  const headers = () => ({ Authorization: "Bearer " + tokenValue(), "Content-Type": "application/json" });
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  const protocolName = (value) => value === "chat_completions" ? "Chat Completions" : "Responses";
  const dateText = (value) => value ? new Date(value).toLocaleString() : "-";
  const ms = (value) => value === undefined || value === null ? "-" : Math.round(value) + " ms";

  function ensurePanels() {
    const llmPage = document.querySelector('[data-page="llm"]');
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
      document.getElementById("refreshLlmRoutingBtn")?.addEventListener("click", () => refreshRouting(true));
    }

    const diagnosticsPage = document.querySelector('[data-page="diagnostics"]');
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
      document.getElementById("refreshLlmTraceBtn")?.addEventListener("click", () => refreshRouting(true));
    }
  }

  function renderMetrics(data) {
    const target = document.getElementById("llmRoutingMetrics");
    if (!target) return;
    const preferred = data.preferredRoute;
    const routes = Array.isArray(data.routes) ? data.routes : [];
    const cooling = routes.filter((route) => Number(route.cooldownRemainingMs) > 0).length;
    const last = Array.isArray(data.recentRequests) ? data.recentRequests[0] : undefined;
    const selected = last?.attempts?.find((attempt) => attempt.routeKey === last.selectedRouteKey);
    target.innerHTML = `
      <div class="metric"><small>当前首选路由</small><strong>${preferred ? esc(preferred.key) : "按测速优先级"}</strong><div class="hint">${preferred ? "TTL 剩余 " + ms(preferred.remainingMs) : "没有粘连路由"}</div></div>
      <div class="metric"><small>可用路由组合</small><strong>${routes.length}</strong><div class="hint">冷却中 ${cooling} 条</div></div>
      <div class="metric"><small>最近命中</small><strong>${selected ? esc(selected.model) : "-"}</strong><div class="hint">${selected ? esc(selected.providerName) + " / " + protocolName(selected.protocol) : "暂无请求"}</div></div>
      <div class="metric"><small>最近 LLM 首 Token</small><strong>${selected ? ms(selected.firstTokenMs) : "-"}</strong><div class="hint">${last ? "总路由耗时 " + ms(last.totalMs) : "暂无请求"}</div></div>
    `;
  }

  function renderRoutes(data) {
    const target = document.getElementById("llmRoutingRows");
    if (!target) return;
    const routes = Array.isArray(data.routes) ? data.routes : [];
    target.innerHTML = routes.map((route) => {
      const cooling = Number(route.cooldownRemainingMs) > 0;
      const status = route.preferred ? "★ 首选" : cooling ? "冷却中" : "可用";
      return `<tr>
        <td>${esc(route.providerName)}</td>
        <td>${esc(route.model)}</td>
        <td>${esc(protocolName(route.protocol))}</td>
        <td><span class="badge ${cooling ? "bad" : route.preferred ? "good" : ""}">${status}</span></td>
        <td>${ms(route.firstTokenTimeoutMs)}${route.firstTokenTimeoutMs !== route.configuredFirstTokenTimeoutMs ? `<div class="hint">全局/站点 ${ms(route.configuredFirstTokenTimeoutMs)}</div>` : ""}</td>
        <td>${ms(route.benchmarkFirstTokenMs)}</td>
        <td>${ms(route.lastFirstTokenMs)}</td>
        <td>${route.failures || 0}</td>
        <td title="${esc(route.lastError || "")}">${esc(route.lastError ? String(route.lastError).slice(0, 70) : "-")}</td>
      </tr>`;
    }).join("") || `<tr><td colspan="9">暂无可用路由</td></tr>`;
  }

  function renderTraces(data) {
    const target = document.getElementById("llmTraceList");
    if (!target) return;
    const traces = Array.isArray(data.recentRequests) ? data.recentRequests.slice(0, 12) : [];
    if (!traces.length) {
      target.innerHTML = `<div class="status">暂无路由请求记录。运行一次 E2E 测试后会在这里显示完整链路。</div>`;
      return;
    }
    target.innerHTML = traces.map((trace) => {
      const attempts = Array.isArray(trace.attempts) ? trace.attempts : [];
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

  async function refreshRouting(showStatus) {
    if (!tokenValue()) return;
    try {
      const response = await fetch("/admin/api/config/llm-routing", { headers: headers() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || JSON.stringify(data));
      renderMetrics(data);
      renderRoutes(data);
      renderTraces(data);
      if (showStatus && typeof setStatus === "function") setStatus("LLM Failover 路由状态已刷新。", true);
    } catch (error) {
      if (showStatus && typeof setStatus === "function") setStatus("读取 LLM Failover 状态失败：" + error.message, false);
    }
  }

  ensurePanels();
  const e2eButton = document.getElementById("runE2eBtn");
  if (e2eButton && e2eButton.onclick) {
    const original = e2eButton.onclick;
    e2eButton.onclick = async function(event) {
      const result = original.call(this, event);
      if (result && typeof result.then === "function") await result;
      await refreshRouting(false);
    };
  }

  document.querySelectorAll('[data-route="llm"],[data-route="diagnostics"]').forEach((link) => {
    link.addEventListener("click", () => setTimeout(() => refreshRouting(false), 50));
  });
  document.getElementById("mobileNav")?.addEventListener("change", (event) => {
    if (event.target.value === "llm" || event.target.value === "diagnostics") setTimeout(() => refreshRouting(false), 50);
  });

  refreshRouting(false);
  setInterval(() => {
    const active = document.querySelector('.page.active')?.dataset.page;
    if (active === "llm" || active === "diagnostics") refreshRouting(false);
  }, 5000);
})();`;
