import { createHash, createHmac } from "node:crypto";

export interface MobilePreviewTokenConfig {
  jwtSecret: string;
  jwtIssuer?: string;
  jwtAudience?: string;
  ttlSeconds: number;
  tenantId: string;
}

export interface MobilePreviewIdentity {
  tenantId: string;
  userId: string;
  subject: string;
}

export function createMobilePreviewIdentity(deviceId: string, tenantId: string): MobilePreviewIdentity {
  const digest = createHash("sha256").update(deviceId.trim()).digest("hex").slice(0, 24);
  const userId = `preview-${digest}`;
  return { tenantId, userId, subject: userId };
}

export function issueMobilePreviewJwt(
  identity: MobilePreviewIdentity,
  config: MobilePreviewTokenConfig,
  nowSeconds = Math.floor(Date.now() / 1000),
): { token: string; expiresAt: number } {
  const expiresAt = nowSeconds + config.ttlSeconds;
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    sub: identity.subject,
    tenant_id: identity.tenantId,
    user_id: identity.userId,
    scope: "realtime",
    iat: nowSeconds,
    nbf: nowSeconds - 5,
    exp: expiresAt,
    ...(config.jwtIssuer ? { iss: config.jwtIssuer } : {}),
    ...(config.jwtAudience ? { aud: config.jwtAudience } : {}),
  });
  const signature = createHmac("sha256", config.jwtSecret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return { token: `${header}.${payload}.${signature}`, expiresAt };
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
