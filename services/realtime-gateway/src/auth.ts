import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export interface GatewayAuthConfig {
  legacyToken?: string;
  jwtSecret?: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  allowAnonymous?: boolean;
}

export interface AuthContext {
  authenticated: boolean;
  legacy: boolean;
  subject?: string;
  tenantId?: string;
  userId?: string;
  scopes: Set<string>;
}

interface JwtClaims {
  sub?: unknown;
  tenant_id?: unknown;
  tenantId?: unknown;
  user_id?: unknown;
  scope?: unknown;
  scopes?: unknown;
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
}

export function authenticateRequest(
  request: IncomingMessage,
  url: URL,
  config: GatewayAuthConfig,
): AuthContext | undefined {
  const token = readBearerToken(request) ?? url.searchParams.get("token") ?? undefined;

  if (token && config.jwtSecret && token.split(".").length === 3) {
    try {
      return verifyHs256Jwt(token, config);
    } catch {
      return undefined;
    }
  }

  if (token && config.legacyToken && safeEqual(token, config.legacyToken)) {
    return {
      authenticated: true,
      legacy: true,
      scopes: new Set(["*"]),
    };
  }

  const noAuthConfigured = !config.jwtSecret && !config.legacyToken;
  if (config.allowAnonymous || noAuthConfigured) {
    return {
      authenticated: false,
      legacy: false,
      scopes: new Set(["*"]),
    };
  }

  return undefined;
}

export function requireScope(context: AuthContext, scope: string): void {
  if (context.scopes.has("*") || context.scopes.has(scope)) return;
  throw new Error(`当前凭证缺少权限：${scope}`);
}

export function assertSessionIdentity(
  context: AuthContext,
  requested: { tenantId: string; userId: string },
): void {
  if (context.tenantId && context.tenantId !== requested.tenantId) {
    throw new Error("session.tenantId 与认证凭证不一致");
  }
  if (context.userId && context.userId !== requested.userId) {
    throw new Error("session.userId 与认证凭证不一致");
  }
}

function verifyHs256Jwt(token: string, config: GatewayAuthConfig): AuthContext {
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature || !config.jwtSecret) {
    throw new Error("invalid jwt");
  }

  const header = JSON.parse(decodeBase64Url(encodedHeader)) as Record<string, unknown>;
  if (header.alg !== "HS256") throw new Error("unsupported jwt algorithm");

  const expected = createHmac("sha256", config.jwtSecret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const actual = Buffer.from(encodedSignature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("invalid jwt signature");

  const claims = JSON.parse(decodeBase64Url(encodedPayload)) as JwtClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === "number" && now >= claims.exp) throw new Error("jwt expired");
  if (typeof claims.nbf === "number" && now < claims.nbf) throw new Error("jwt not active");
  if (config.jwtIssuer && claims.iss !== config.jwtIssuer) throw new Error("jwt issuer mismatch");
  if (config.jwtAudience && !audienceMatches(claims.aud, config.jwtAudience)) throw new Error("jwt audience mismatch");

  const tenantId = stringClaim(claims.tenant_id) ?? stringClaim(claims.tenantId);
  const subject = stringClaim(claims.sub);
  const userId = stringClaim(claims.user_id) ?? subject;
  if (!tenantId || !userId) throw new Error("jwt missing tenant/user claims");

  return {
    authenticated: true,
    legacy: false,
    subject,
    tenantId,
    userId,
    scopes: parseScopes(claims.scope, claims.scopes),
  };
}

function readBearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  const value = header.slice("Bearer ".length).trim();
  return value || undefined;
}

function parseScopes(scope: unknown, scopes: unknown): Set<string> {
  const output = new Set<string>();
  if (typeof scope === "string") {
    for (const value of scope.split(/\s+/)) if (value) output.add(value);
  }
  if (Array.isArray(scopes)) {
    for (const value of scopes) if (typeof value === "string" && value) output.add(value);
  }
  if (output.size === 0) output.add("realtime");
  return output;
}

function audienceMatches(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  return Array.isArray(value) && value.some((entry) => entry === expected);
}

function stringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
