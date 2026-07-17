import type { ProviderConfigDto, ProviderPolicyDto } from "@aipany/provider-types";

const baseUrl = (import.meta.env.VITE_ADMIN_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api/admin";
const adminToken = import.meta.env.VITE_ADMIN_API_TOKEN as string | undefined;

export type ProviderInput = Omit<
  ProviderConfigDto,
  "id" | "apiKeyConfigured" | "apiKeyMasked" | "createdAt" | "updatedAt" | "isDefault"
> & {
  apiKey?: string | null;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}),
        ...init.headers,
      },
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({ error: { message: response.statusText } }))) as {
        error?: { message?: string };
      };
      throw new Error(payload.error?.message ?? response.statusText);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export const api = {
  listProviders: () => request<ProviderConfigDto[]>("/v1/admin/providers"),
  createProvider: (provider: ProviderInput) =>
    request<ProviderConfigDto>("/v1/admin/providers", {
      method: "POST",
      body: JSON.stringify(provider),
    }),
  updateProvider: (id: string, provider: Partial<ProviderInput>) =>
    request<ProviderConfigDto>(`/v1/admin/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(provider),
    }),
  deleteProvider: (id: string) => request<void>(`/v1/admin/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    request<{ success: boolean; latencyMs: number; message: string }>(`/v1/admin/providers/${id}/test`, {
      method: "POST",
    }),
  getPolicy: () => request<ProviderPolicyDto>("/v1/admin/provider-policy"),
  setPolicy: (policy: ProviderPolicyDto) =>
    request<ProviderPolicyDto>("/v1/admin/provider-policy", {
      method: "PUT",
      body: JSON.stringify(policy),
    }),
};
