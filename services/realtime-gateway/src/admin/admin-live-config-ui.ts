function adminLiveConfigUiClient(): void {
  const tokenValue = () => sessionStorage.getItem("aipanyAdminToken") || "";
  const headers = () => ({ Authorization: "Bearer " + tokenValue(), "Content-Type": "application/json" });

  function ensurePanel(): void {
    const page = document.querySelector<HTMLElement>('[data-page="omni"]');
    if (!page || document.getElementById("nativeLiveConfigCard")) return;
    const card = document.createElement("div");
    card.className = "card";
    card.id = "nativeLiveConfigCard";
    card.innerHTML = `
      <div class="toolbar">
        <div><h3 style="margin:0 0 5px">Native Live 实时语音</h3><div class="hint">支持 Qwen-Audio 3.0 Realtime 与 Qwen3.5 Omni Realtime。移动端用户会按“体验模式”选择实际模型和音色；这里配置服务器默认值与旧客户端兜底。</div></div>
        <button id="saveNativeLiveBtn" class="btn primary" type="button">保存 Live 设置</button>
      </div>
      <div class="grid">
        <div class="field"><label>实时引擎</label><select id="AIPANY_REALTIME_ENGINE"><option value="auto">Auto（推荐）</option><option value="omni_realtime">强制 Native Live</option><option value="cascaded">强制 Cascaded</option></select><div class="hint">生产推荐 Auto：Native Live 可用时优先使用，启动失败自动回退。</div></div>
        <div class="field"><label>Native Live</label><select id="QWEN_OMNI_REALTIME_ENABLED"><option value="true">开启</option><option value="false">关闭</option></select><div class="hint">关闭后 Native Plus / Native Flash 体验模式会回退 Economy Live。</div></div>
        <div class="field full"><label>Realtime WebSocket Base URL</label><input id="QWEN_OMNI_REALTIME_BASE_URL" placeholder="留空复用 DashScope Workspace 默认实时地址" /></div>
        <div class="field"><label>默认 Realtime Model</label><select id="QWEN_OMNI_REALTIME_MODEL"><option value="qwen-audio-3.0-realtime-plus">qwen-audio-3.0-realtime-plus（默认）</option><option value="qwen-audio-3.0-realtime-flash">qwen-audio-3.0-realtime-flash</option><option value="qwen3.5-omni-plus-realtime">qwen3.5-omni-plus-realtime</option><option value="qwen3.5-omni-flash-realtime">qwen3.5-omni-flash-realtime</option></select><div class="hint">新客户端会按体验模式覆盖这里的默认模型；该值用于 Auto/旧客户端。</div></div>
        <div class="field"><label>服务器默认音色（兜底）</label><input id="QWEN_OMNI_REALTIME_VOICE" placeholder="longanqian" /><div class="hint">新客户端音色由用户选择。Qwen-Audio 默认 longanqian；Qwen3.5 Omni 默认 Tina。</div></div>
        <div class="field"><label>Turn Detection</label><select id="QWEN_OMNI_REALTIME_TURN_DETECTION"><option value="smart_turn">Smart Turn（Qwen-Audio 推荐）</option><option value="server_vad">Server VAD</option><option value="semantic_vad">Semantic VAD（Qwen3.5 Omni）</option></select><div class="hint">Qwen-Audio 的 Smart Turn 会结合语义判断用户是否真的说完；体验模式会自动使用模型推荐策略。</div></div>
        <div class="field"><label>VAD Threshold</label><input id="QWEN_OMNI_REALTIME_VAD_THRESHOLD" type="number" min="-1" max="1" step="0.05" /></div>
        <div class="field"><label>静音结束窗口(ms)</label><input id="QWEN_OMNI_REALTIME_SILENCE_MS" type="number" min="200" max="6000" step="50" /></div>
      </div>
      <div id="nativeLiveConfigStatus" class="status" style="margin-top:14px">等待读取配置</div>
    `;
    const firstCard = page.querySelector(".card");
    if (firstCard) page.insertBefore(card, firstCard);
    else page.appendChild(card);
    document.getElementById("saveNativeLiveBtn")?.addEventListener("click", () => { void save(); });
    document.getElementById("QWEN_OMNI_REALTIME_MODEL")?.addEventListener("change", () => syncModelDefaults(false));
  }

  async function load(): Promise<void> {
    if (!tokenValue()) return;
    ensurePanel();
    const response = await fetch("/admin/api/config", { headers: headers() });
    if (!response.ok) return;
    const data = await response.json();
    const values = data.values || {};
    setValue("AIPANY_REALTIME_ENGINE", values.AIPANY_REALTIME_ENGINE || "auto");
    setValue("QWEN_OMNI_REALTIME_ENABLED", values.QWEN_OMNI_REALTIME_ENABLED || "false");
    setValue("QWEN_OMNI_REALTIME_BASE_URL", values.QWEN_OMNI_REALTIME_BASE_URL || "");
    setValue("QWEN_OMNI_REALTIME_MODEL", values.QWEN_OMNI_REALTIME_MODEL || "qwen-audio-3.0-realtime-plus");
    setValue("QWEN_OMNI_REALTIME_VOICE", values.QWEN_OMNI_REALTIME_VOICE || "longanqian");
    setValue("QWEN_OMNI_REALTIME_TURN_DETECTION", values.QWEN_OMNI_REALTIME_TURN_DETECTION || "smart_turn");
    setValue("QWEN_OMNI_REALTIME_VAD_THRESHOLD", values.QWEN_OMNI_REALTIME_VAD_THRESHOLD || "0.2");
    setValue("QWEN_OMNI_REALTIME_SILENCE_MS", values.QWEN_OMNI_REALTIME_SILENCE_MS || "500");
    const status = document.getElementById("nativeLiveConfigStatus");
    if (status) {
      status.className = "status ok";
      status.textContent = `当前：${engineName(values.AIPANY_REALTIME_ENGINE || "auto")} · Native Live ${values.QWEN_OMNI_REALTIME_ENABLED === "true" ? "已开启" : "未开启"} · ${values.QWEN_OMNI_REALTIME_MODEL || "qwen-audio-3.0-realtime-plus"}`;
    }
  }

  async function save(): Promise<void> {
    if (!tokenValue()) return;
    const status = document.getElementById("nativeLiveConfigStatus");
    if (status) {
      status.className = "status";
      status.textContent = "正在保存 Native Live 配置…";
    }
    const body = {
      AIPANY_REALTIME_ENGINE: value("AIPANY_REALTIME_ENGINE"),
      QWEN_OMNI_REALTIME_ENABLED: value("QWEN_OMNI_REALTIME_ENABLED"),
      QWEN_OMNI_REALTIME_BASE_URL: value("QWEN_OMNI_REALTIME_BASE_URL") || null,
      QWEN_OMNI_REALTIME_MODEL: value("QWEN_OMNI_REALTIME_MODEL"),
      QWEN_OMNI_REALTIME_VOICE: value("QWEN_OMNI_REALTIME_VOICE"),
      QWEN_OMNI_REALTIME_TURN_DETECTION: value("QWEN_OMNI_REALTIME_TURN_DETECTION"),
      QWEN_OMNI_REALTIME_VAD_THRESHOLD: value("QWEN_OMNI_REALTIME_VAD_THRESHOLD"),
      QWEN_OMNI_REALTIME_SILENCE_MS: value("QWEN_OMNI_REALTIME_SILENCE_MS"),
    };
    try {
      const response = await fetch("/admin/api/config", { method: "PUT", headers: headers(), body: JSON.stringify(body) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || JSON.stringify(data));
      if (status) {
        status.className = "status ok";
        status.textContent = "保存成功。新建立的 App 会话会使用新的服务器默认值；新客户端的体验模式会按所选模式覆盖模型和音色。";
      }
      await load();
    } catch (error) {
      if (status) {
        status.className = "status bad";
        status.textContent = "保存失败：" + (error instanceof Error ? error.message : String(error));
      }
    }
  }

  function syncModelDefaults(force: boolean): void {
    const model = value("QWEN_OMNI_REALTIME_MODEL");
    const voice = document.getElementById("QWEN_OMNI_REALTIME_VOICE") as HTMLInputElement | null;
    const turn = document.getElementById("QWEN_OMNI_REALTIME_TURN_DETECTION") as HTMLSelectElement | null;
    if (model.startsWith("qwen-audio-3.0")) {
      if (voice && (force || !voice.value.trim() || voice.value === "Tina")) voice.value = "longanqian";
      if (turn && (force || turn.value === "semantic_vad")) turn.value = "smart_turn";
    } else if (model.includes("qwen3.5") && model.includes("omni")) {
      if (voice && (force || !voice.value.trim() || voice.value === "longanqian")) voice.value = "Tina";
      if (turn && turn.value === "smart_turn") turn.value = "server_vad";
    }
  }

  function setValue(id: string, value: string): void {
    const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (element) element.value = value;
  }

  function value(id: string): string {
    const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    return element?.value.trim() || "";
  }

  function engineName(value: string): string {
    if (value === "omni_realtime") return "强制 Native Live";
    if (value === "cascaded") return "强制 Cascaded";
    return "Auto";
  }

  ensurePanel();
  document.getElementById("loginBtn")?.addEventListener("click", () => setTimeout(() => { void load(); }, 300));
  document.getElementById("reloadBtn")?.addEventListener("click", () => setTimeout(() => { void load(); }, 100));
  document.querySelector('[data-route="omni"]')?.addEventListener("click", () => setTimeout(() => { void load(); }, 50));
  void load();
}

export const ADMIN_LIVE_CONFIG_UI = `(${adminLiveConfigUiClient.toString()})();`;
