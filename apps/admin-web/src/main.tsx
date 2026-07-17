import type { ProviderCategory, ProviderConfigDto, ProviderPolicyDto } from "@aipany/provider-types";
import { Brain, KeyRound, LogOut, Plus, Server, ShieldCheck, TestTube2, Trash2 } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  AdminApiError,
  api,
  clearAdminToken,
  getAdminToken,
  setAdminToken,
  type ProviderInput,
} from "./lib/api";
import "./styles.css";

const categories: ProviderCategory[] = ["realtime", "text", "asr", "tts"];
type ProviderTab = ProviderCategory | "all";

const categoryLabels: Record<ProviderCategory, string> = {
  realtime: "实时语音",
  text: "文本模型",
  asr: "语音识别",
  tts: "语音合成",
};

const protocolLabels: Record<string, string> = {
  openai: "OpenAI",
  "openai-compatible": "OpenAI 兼容接口",
  gemini: "Gemini",
  custom: "自定义接口",
};

function App() {
  const [providers, setProviders] = useState<ProviderConfigDto[]>([]);
  const [policy, setPolicy] = useState<ProviderPolicyDto>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<ProviderTab>("all");
  const [editing, setEditing] = useState<ProviderConfigDto | null | undefined>(undefined);
  const [toast, setToast] = useState("");
  const [authenticated, setAuthenticated] = useState(Boolean(getAdminToken()));

  async function load() {
    setLoading(true);
    try {
      const [providerList, providerPolicy] = await Promise.all([api.listProviders(), api.getPolicy()]);
      setProviders(providerList);
      setPolicy(providerPolicy);
      setError("");
    } catch (err) {
      if (err instanceof AdminApiError && err.status === 401) {
        clearAdminToken();
        setAuthenticated(false);
        setError("");
        setToast("管理凭证已失效，请重新验证。 ");
        return;
      }
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (authenticated) {
      void load();
    }
  }, [authenticated]);

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
      setEditing(undefined);
      setToast("配置保存成功");
      await load();
    } catch (err) {
      handleApiError(err, "保存失败");
    }
  }

  async function testProvider(provider: ProviderConfigDto) {
    setToast(`正在测试“${provider.name}”...`);
    try {
      const result = await api.testProvider(provider.id);
      setToast(`${result.success ? "测试成功" : "测试失败"}：${result.message}（${result.latencyMs} 毫秒）`);
    } catch (err) {
      handleApiError(err, "测试失败");
    }
  }

  function handleApiError(err: unknown, fallback: string) {
    if (err instanceof AdminApiError && err.status === 401) {
      clearAdminToken();
      setAuthenticated(false);
      setToast("管理凭证已失效，请重新验证。");
      return;
    }
    setToast(err instanceof Error ? err.message : fallback);
  }

  function logout() {
    clearAdminToken();
    setAuthenticated(false);
    setProviders([]);
    setPolicy({});
    setError("");
  }

  if (!authenticated) {
    return (
      <AdminLogin
        onSuccess={(providerList, providerPolicy) => {
          setProviders(providerList);
          setPolicy(providerPolicy);
          setAuthenticated(true);
          setToast("管理员身份验证成功");
        }}
      />
    );
  }

  return (
    <div className="shell">
      <aside>
        <div className="logo">
          <Brain />
          Aipany
        </div>
        {[
          ["概览", false],
          ["AI 服务商", true],
          ["智能体", false],
          ["设备", false],
          ["用量统计", false],
          ["系统设置", false],
        ].map(([item, active]) => (
          <div className={active ? "nav active" : "nav"} key={String(item)}>
            {item}
            {!active ? <small>即将推出</small> : null}
          </div>
        ))}
      </aside>

      <main>
        <header>
          <div>
            <h1>AI 服务商配置中心</h1>
            <p>统一管理实时语音、文本模型、语音识别与语音合成服务。</p>
          </div>
          <div className="header-actions">
            <div className="status">
              <Server /> 系统在线 · {import.meta.env.MODE === "production" ? "生产环境" : "开发环境"}
            </div>
            <button className="secondary" onClick={logout} type="button">
              <LogOut size={16} /> 退出管理
            </button>
          </div>
        </header>

        {toast ? (
          <button className="toast" onClick={() => setToast("")} type="button">
            {toast}
          </button>
        ) : null}

        <section className="toolbar">
          <button onClick={() => setEditing(null)} type="button">
            <Plus /> 添加服务商
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
                  <b>{categoryLabels[stat.category]}</b>
                  <strong>{stat.total}</strong>
                  <span>已启用 {stat.enabled} 个</span>
                </div>
              ))}
            </div>

            <div className="tabs">
              {(["all", ...categories] as ProviderTab[]).map((category) => (
                <button className={tab === category ? "on" : ""} onClick={() => setTab(category)} key={category} type="button">
                  {category === "all" ? "全部" : categoryLabels[category]}
                </button>
              ))}
            </div>

            {visibleProviders.length === 0 ? (
              <div className="empty">暂无服务商配置，请点击“添加服务商”开始配置。</div>
            ) : (
              <div className="grid">
                {visibleProviders.map((provider) => (
                  <div className="card provider" key={provider.id}>
                    <div className="row">
                      <h3>{provider.name}</h3>
                      {provider.isDefault ? <em>默认</em> : null}
                    </div>
                    <p>
                      {categoryLabels[provider.category]} · {protocolLabels[provider.protocol] ?? provider.protocol} · {provider.enabled ? "已启用" : "已禁用"}
                    </p>
                    <p>
                      接口地址：{safeHost(provider.baseUrl)}
                      <br />
                      模型：{provider.model}
                      {provider.voice ? ` · 音色：${provider.voice}` : ""}
                    </p>
                    <p>
                      API 密钥：{provider.apiKeyConfigured ? `已配置 ${provider.apiKeyMasked ?? ""}` : "未配置"} · 优先级 {provider.priority}
                    </p>
                    <small>最后更新：{new Date(provider.updatedAt).toLocaleString("zh-CN")}</small>
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
                          if (confirm(`确认删除“${provider.name}”吗？`)) {
                            void api
                              .deleteProvider(provider.id)
                              .then(load)
                              .catch((err: unknown) => handleApiError(err, "删除失败"));
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

        {editing !== undefined ? (
          <ProviderDrawer provider={editing} close={() => setEditing(undefined)} save={saveProvider} />
        ) : null}
      </main>
    </div>
  );

  async function savePolicy(nextPolicy: ProviderPolicyDto) {
    try {
      await api.setPolicy(nextPolicy);
      setToast("默认模型策略已保存");
      await load();
    } catch (err) {
      handleApiError(err, "默认策略保存失败");
    }
  }
}

function AdminLogin({
  onSuccess,
}: {
  onSuccess: (providers: ProviderConfigDto[], policy: ProviderPolicyDto) => void;
}) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextToken = token.trim();
    if (!nextToken) {
      setMessage("请输入管理员访问令牌。");
      return;
    }

    setSubmitting(true);
    setMessage("");
    setAdminToken(nextToken);

    try {
      const [providers, policy] = await Promise.all([api.listProviders(), api.getPolicy()]);
      onSuccess(providers, policy);
    } catch (err) {
      clearAdminToken();
      if (err instanceof AdminApiError && err.status === 401) {
        setMessage("管理员访问令牌错误，请检查服务器 .env 中的 ADMIN_API_TOKEN。");
      } else {
        setMessage(err instanceof Error ? err.message : "验证失败，请稍后重试。");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-glow login-glow-one" />
      <div className="login-glow login-glow-two" />
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <div className="login-brand">
          <span className="login-icon">
            <Brain />
          </span>
          <div>
            <strong>Aipany</strong>
            <small>AI 语音设备云平台</small>
          </div>
        </div>

        <div className="login-title">
          <ShieldCheck />
          <div>
            <h1>管理后台验证</h1>
            <p>请输入服务器配置的管理员访问令牌以进入控制台。</p>
          </div>
        </div>

        <label>
          管理员访问令牌
          <div className="token-input">
            <KeyRound size={18} />
            <input
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setToken(event.target.value)}
              placeholder="请输入 ADMIN_API_TOKEN"
              type="password"
              value={token}
            />
          </div>
        </label>

        {message ? <div className="login-error">{message}</div> : null}

        <button className="login-submit" disabled={submitting} type="submit">
          {submitting ? "正在验证..." : "进入管理后台"}
        </button>

        <p className="login-tip">令牌仅保存在当前浏览器会话中，关闭会话后会自动清除。</p>
      </form>
    </div>
  );
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
      <p>为不同能力指定系统默认使用的服务商。</p>
      {categories.map((category) => {
        const key = `${category}ProviderId` as keyof ProviderPolicyDto;
        return (
          <label key={category}>
            默认{categoryLabels[category]}
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
        保存默认策略
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

  const textFields: Array<{ key: "name" | "baseUrl" | "apiKey" | "model" | "voice"; label: string; placeholder?: string }> = [
    { key: "name", label: "名称", placeholder: "例如：OpenAI Realtime" },
    { key: "baseUrl", label: "接口地址", placeholder: "https://api.openai.com/v1" },
    { key: "apiKey", label: "API 密钥" },
    { key: "model", label: "模型名称" },
    { key: "voice", label: "音色名称" },
  ];

  return (
    <div className="drawer">
      <div>
        <div className="drawer-title">
          <div>
            <h2>{provider ? "编辑服务商" : "添加服务商"}</h2>
            <p>配置模型接口及运行参数。</p>
          </div>
          <button className="secondary" onClick={close} type="button">
            关闭
          </button>
        </div>

        {textFields.map(({ key, label, placeholder }) => (
          <label key={key}>
            {label}
            <input
              placeholder={key === "apiKey" && provider?.apiKeyConfigured ? "已配置密钥，留空表示保持原密钥" : placeholder ?? ""}
              type={key === "apiKey" ? "password" : "text"}
              value={String(draft[key] ?? "")}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            />
          </label>
        ))}

        <label>
          服务类别
          <select value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value as ProviderCategory })}>
            {categories.map((category) => (
              <option key={category} value={category}>
                {categoryLabels[category]}
              </option>
            ))}
          </select>
        </label>

        <label>
          接口协议
          <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderInput["protocol"] })}>
            {["openai", "openai-compatible", "gemini", "custom"].map((protocol) => (
              <option key={protocol} value={protocol}>
                {protocolLabels[protocol] ?? protocol}
              </option>
            ))}
          </select>
        </label>

        <label>
          优先级
          <input type="number" value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) })} />
        </label>

        <label className="checkbox-label">
          <input checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} type="checkbox" />
          启用此服务商
        </label>

        {draft.category === "realtime" ? (
          <fieldset>
            <legend>实时语音高级配置</legend>
            <label>
              轮次检测方式
              <input
                value={String(draft.settings.turnDetection ?? "semantic_vad")}
                onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, turnDetection: event.target.value } })}
              />
            </label>
            <label>
              响应积极度
              <input
                value={String(draft.settings.eagerness ?? "low")}
                onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, eagerness: event.target.value } })}
              />
            </label>
            <label className="checkbox-label">
              <input
                checked={Boolean(draft.settings.interruptResponse ?? true)}
                onChange={(event) => setDraft({ ...draft, settings: { ...draft.settings, interruptResponse: event.target.checked } })}
                type="checkbox"
              />
              允许用户打断 AI 回复
            </label>
          </fieldset>
        ) : null}

        <div className="actions drawer-actions">
          <button onClick={() => void save(draft, provider?.id)} type="button">
            保存配置
          </button>
          <button className="secondary" onClick={close} type="button">
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
