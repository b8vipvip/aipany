import type { ProviderCategory, ProviderConfigDto, ProviderPolicyDto } from "@aipany/provider-types";
import { Brain, Plus, Server, TestTube2, Trash2 } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { api, type ProviderInput } from "./lib/api";
import "./styles.css";

const categories: ProviderCategory[] = ["realtime", "text", "asr", "tts"];

type ProviderTab = ProviderCategory | "all";

function App() {
  const [providers, setProviders] = useState<ProviderConfigDto[]>([]);
  const [policy, setPolicy] = useState<ProviderPolicyDto>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<ProviderTab>("all");
  const [editing, setEditing] = useState<ProviderConfigDto | null>(null);
  const [toast, setToast] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [providerList, providerPolicy] = await Promise.all([api.listProviders(), api.getPolicy()]);
      setProviders(providerList);
      setPolicy(providerPolicy);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const visibleProviders = providers.filter((provider) => tab === "all" || provider.category === tab);
  const stats = useMemo(
    () =>
      categories.map((category) => ({
        category,
        total: providers.filter((provider) => provider.category === category).length,
        enabled: providers.filter((provider) => provider.category === category && provider.enabled).length,
      })),
    [providers],
  );

  async function saveProvider(input: ProviderInput, id?: string) {
    try {
      if (id) {
        await api.updateProvider(id, input);
      } else {
        await api.createProvider(input);
      }
      setEditing(null);
      setToast("保存成功");
      await load();
    } catch (err) {
      setToast(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function testProvider(provider: ProviderConfigDto) {
    setToast(`正在测试 ${provider.name}...`);
    try {
      const result = await api.testProvider(provider.id);
      setToast(`${result.success ? "测试成功" : "测试失败"}：${result.message}（${result.latencyMs}ms）`);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "测试失败");
    }
  }

  return (
    <div className="shell">
      <aside>
        <div className="logo">
          <Brain />
          Aipany
        </div>
        {["Overview", "AI Providers", "Agents", "Devices", "Usage", "System"].map((item) => (
          <div className={item === "AI Providers" ? "nav active" : "nav"} key={item}>
            {item}
          </div>
        ))}
      </aside>

      <main>
        <header>
          <div>
            <h1>AI Provider 配置中心</h1>
            <p>统一管理实时语音、文本模型、ASR 与 TTS 服务。</p>
          </div>
          <div className="status">
            <Server /> 系统在线 · {import.meta.env.MODE}
          </div>
        </header>

        {toast ? (
          <button className="toast" onClick={() => setToast("")} type="button">
            {toast}
          </button>
        ) : null}

        <section className="toolbar">
          <button onClick={() => setEditing({} as ProviderConfigDto)} type="button">
            <Plus /> 添加 Provider
          </button>
          <button onClick={() => providers.forEach((provider) => void testProvider(provider))} type="button">
            <TestTube2 /> 测试全部
          </button>
        </section>

        {loading ? (
          <div className="grid">
            {[1, 2, 3, 4].map((item) => (
              <div className="card skeleton" key={item} />
            ))}
          </div>
        ) : null}

        {error ? <div className="empty error">{error}</div> : null}

        {!loading && !error ? (
          <>
            <div className="stats">
              {stats.map((stat) => (
                <div className="card" key={stat.category}>
                  <b>{stat.category.toUpperCase()}</b>
                  <strong>{stat.total}</strong>
                  <span>启用 {stat.enabled}</span>
                </div>
              ))}
            </div>

            <div className="tabs">
              {(["all", ...categories] as ProviderTab[]).map((category) => (
                <button className={tab === category ? "on" : ""} onClick={() => setTab(category)} key={category} type="button">
                  {category}
                </button>
              ))}
            </div>

            {visibleProviders.length === 0 ? (
              <div className="empty">暂无 Provider，请点击“添加 Provider”。</div>
            ) : (
              <div className="grid">
                {visibleProviders.map((provider) => (
                  <div className="card provider" key={provider.id}>
                    <div className="row">
                      <h3>{provider.name}</h3>
                      {provider.isDefault ? <em>DEFAULT</em> : null}
                    </div>
                    <p>
                      {provider.category} · {provider.protocol} · {provider.enabled ? "启用" : "禁用"}
                    </p>
                    <p>
                      Host: {safeHost(provider.baseUrl)}
                      <br />
                      Model: {provider.model}
                      {provider.voice ? ` · Voice: ${provider.voice}` : ""}
                    </p>
                    <p>
                      API Key: {provider.apiKeyConfigured ? `已配置 ${provider.apiKeyMasked ?? ""}` : "未配置"} · Priority{" "}
                      {provider.priority}
                    </p>
                    <small>更新：{new Date(provider.updatedAt).toLocaleString()}</small>
                    <div className="actions">
                      <button onClick={() => void testProvider(provider)} type="button">
                        测试连接
                      </button>
                      <button onClick={() => setEditing(provider)} type="button">
                        编辑
                      </button>
                      <button onClick={() => void saveProvider({ ...provider, enabled: !provider.enabled }, provider.id)} type="button">
                        {provider.enabled ? "禁用" : "启用"}
                      </button>
                      <button
                        className="danger"
                        onClick={() => {
                          if (confirm("确认删除？")) {
                            void api.deleteProvider(provider.id).then(load);
                          }
                        }}
                        type="button"
                      >
                        <Trash2 size={14} /> 删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <ProviderPolicy providers={providers} policy={policy} save={savePolicy} />
          </>
        ) : null}

        {editing ? <ProviderDrawer provider={editing.id ? editing : null} close={() => setEditing(null)} save={saveProvider} /> : null}
      </main>
    </div>
  );

  async function savePolicy(nextPolicy: ProviderPolicyDto) {
    await api.setPolicy(nextPolicy);
    setToast("默认策略已保存");
    await load();
  }
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ProviderPolicy({
  providers,
  policy,
  save,
}: {
  providers: ProviderConfigDto[];
  policy: ProviderPolicyDto;
  save: (policy: ProviderPolicyDto) => Promise<void>;
}) {
  const [draft, setDraft] = useState(policy);

  useEffect(() => setDraft(policy), [policy]);

  return (
    <section className="policy card">
      <h2>默认模型策略</h2>
      {categories.map((category) => {
        const key = `${category}ProviderId` as keyof ProviderPolicyDto;
        return (
          <label key={category}>
            {category}
            <select value={draft[key] ?? ""} onChange={(event) => setDraft({ ...draft, [key]: event.target.value || null })}>
              <option value="">未设置</option>
              {providers
                .filter((provider) => provider.enabled && provider.category === category)
                .map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
      <button onClick={() => void save(draft)} type="button">
        保存策略
      </button>
    </section>
  );
}

function ProviderDrawer({
  provider,
  close,
  save,
}: {
  provider: ProviderConfigDto | null;
  close: () => void;
  save: (provider: ProviderInput, id?: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProviderInput>(
    provider ?? {
      category: "realtime",
      protocol: "openai",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-realtime-2.1",
      voice: "marin",
      priority: 100,
      settings: {},
      name: "",
    },
  );

  return (
    <div className="drawer">
      <div>
        <h2>{provider ? "编辑" : "新增"} Provider</h2>
        {(["name", "baseUrl", "apiKey", "model", "voice"] as const).map((key) => (
          <label key={key}>
            {key}
            <input
              placeholder={key === "apiKey" && provider?.apiKeyConfigured ? "已配置密钥，留空表示保持原密钥" : ""}
              value={String(draft[key] ?? "")}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            />
          </label>
        ))}
        <label>
          Category
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ProviderCategory })}>
            {categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
        </label>
        <label>
          Protocol
          <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderInput["protocol"] })}>
            {["openai", "openai-compatible", "gemini", "custom"].map((protocol) => (
              <option key={protocol}>{protocol}</option>
            ))}
          </select>
        </label>
        <label>
          Priority
          <input type="number" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} />
        </label>
        <label>
          <input checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} type="checkbox" /> Enabled
        </label>
        <fieldset>
          <legend>Realtime 高级配置</legend>
          <label>
            Turn Detection
            <input
              value={String(draft.settings.turnDetection ?? "semantic_vad")}
              onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, turnDetection: event.target.value } })}
            />
          </label>
          <label>
            Eagerness
            <input
              value={String(draft.settings.eagerness ?? "low")}
              onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, eagerness: event.target.value } })}
            />
          </label>
          <label>
            <input
              checked={Boolean(draft.settings.interruptResponse ?? true)}
              onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, interruptResponse: event.target.checked } })}
              type="checkbox"
            />{" "}
            Interrupt Response
          </label>
        </fieldset>
        <div className="actions">
          <button onClick={() => void save(draft, provider?.id)} type="button">
            保存
          </button>
          <button onClick={close} type="button">
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
