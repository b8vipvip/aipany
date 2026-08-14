export const ADMIN_CLIENT_DIAGNOSTICS_UI = String.raw`(() => {
  const STORAGE_KEY = "aipanyAdminToken";
  const $ = (id) => document.getElementById(id);
  const authHeaders = () => ({ Authorization: "Bearer " + (sessionStorage.getItem(STORAGE_KEY) || "") });
  let loading = false;

  function install() {
    const page = document.querySelector('[data-page="diagnostics"]');
    if (!page || $("clientDiagnosticsCard")) return;
    const card = document.createElement("div");
    card.id = "clientDiagnosticsCard";
    card.className = "card";
    card.innerHTML = '<div class="toolbar"><div><h3 style="margin:0 0 5px">客户端诊断报告</h3><div class="hint">Android 在严重实时链路异常时会自动上传脱敏报告。报告不包含 API Key、JWT、管理员凭据或设备 ID；服务器还会再次执行 Schema 校验和深度脱敏。</div></div><button id="refreshClientDiagnosticsBtn" class="btn secondary" type="button">刷新客户端报告</button></div><div id="clientDiagnosticsStatus" class="status">等待读取客户端报告</div><div class="table-wrap"><table><thead><tr><th>接收时间</th><th>App</th><th>设备环境</th><th>诊断</th><th>置信度</th><th>大小</th><th>操作</th></tr></thead><tbody id="clientDiagnosticsRows"></tbody></table></div>';
    const head = page.querySelector(".page-head");
    if (head && head.nextSibling) page.insertBefore(card, head.nextSibling);
    else page.appendChild(card);
    $("refreshClientDiagnosticsBtn").addEventListener("click", loadReports);
  }

  async function loadReports() {
    install();
    if (loading || !$("clientDiagnosticsRows") || !sessionStorage.getItem(STORAGE_KEY)) return;
    loading = true;
    setStatus("正在读取客户端诊断报告…", true);
    try {
      const response = await fetch("/admin/api/client-diagnostics?limit=50", { headers: authHeaders() });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data.message || data.error || ("HTTP " + response.status));
      const reports = Array.isArray(data.reports) ? data.reports : [];
      renderReports(reports);
      setStatus(reports.length ? "已加载最近 " + reports.length + " 份客户端诊断报告。" : "暂无客户端自动上传的诊断报告。", true);
    } catch (error) {
      setStatus("客户端诊断报告读取失败：" + (error && error.message ? error.message : String(error)), false);
    } finally {
      loading = false;
    }
  }

  function renderReports(reports) {
    const tbody = $("clientDiagnosticsRows");
    if (!tbody) return;
    tbody.replaceChildren();
    if (!reports.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 7;
      cell.textContent = "暂无报告。新版本 Android 在 GPT-Live / Gateway / Android 音频出现严重异常时会自动上传。";
      row.appendChild(cell);
      tbody.appendChild(row);
      return;
    }
    reports.forEach((report) => {
      const row = document.createElement("tr");
      row.appendChild(cell(formatTime(report.receivedAtMs)));
      row.appendChild(cell((report.appVersion || "-") + (report.versionCode ? " (" + report.versionCode + ")" : "")));
      row.appendChild(cell([report.manufacturer, report.model, report.androidSdk ? "Android " + report.androidSdk : ""].filter(Boolean).join(" · ") || "-"));
      row.appendChild(cell((report.title || report.diagnosisLayer || "-") + (report.severity ? " · " + severityName(report.severity) : "")));
      row.appendChild(cell(report.confidence ? report.confidence + "%" : "-"));
      row.appendChild(cell(formatBytes(report.sizeBytes)));
      const actions = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn small secondary";
      button.textContent = "下载 JSON";
      button.addEventListener("click", () => downloadReport(String(report.id || ""), button));
      actions.appendChild(button);
      row.appendChild(actions);
      tbody.appendChild(row);
    });
  }

  async function downloadReport(id, button) {
    if (!id) return;
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "下载中…";
    try {
      const response = await fetch("/admin/api/client-diagnostics/" + encodeURIComponent(id) + "/download", { headers: authHeaders() });
      if (!response.ok) throw new Error("HTTP " + response.status + ": " + await response.text());
      const blob = await response.blob();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = "aipany-client-diagnostics-" + id + ".json";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(href);
    } catch (error) {
      setStatus("诊断报告下载失败：" + (error && error.message ? error.message : String(error)), false);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function cell(text) {
    const element = document.createElement("td");
    element.textContent = String(text == null ? "" : text);
    return element;
  }

  function setStatus(text, ok) {
    const status = $("clientDiagnosticsStatus");
    if (!status) return;
    status.textContent = text;
    status.className = "status " + (ok ? "ok" : "bad");
  }

  function formatTime(value) {
    const number = Number(value || 0);
    return number > 0 ? new Date(number).toLocaleString() : "-";
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return "-";
    if (bytes < 1024) return Math.round(bytes) + " B";
    return (bytes / 1024).toFixed(1) + " KiB";
  }

  function severityName(value) {
    if (value === "error") return "异常";
    if (value === "warning") return "需关注";
    if (value === "ok") return "正常";
    return String(value || "");
  }

  function watchLogin() {
    const app = $("app");
    if (!app || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      if (!app.classList.contains("hidden") && sessionStorage.getItem(STORAGE_KEY)) loadReports();
    });
    observer.observe(app, { attributes: true, attributeFilter: ["class"] });
  }

  install();
  watchLogin();
  document.querySelector('[data-route="diagnostics"]')?.addEventListener("click", () => setTimeout(loadReports, 50));
  $("loginBtn")?.addEventListener("click", () => setTimeout(loadReports, 350));
  if (sessionStorage.getItem(STORAGE_KEY)) setTimeout(loadReports, 0);
})();`;
