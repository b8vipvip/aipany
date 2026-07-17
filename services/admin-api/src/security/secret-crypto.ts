import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}

function keyBytes(key: string): Buffer {
  const base64Key = Buffer.from(key, "base64");
  if (base64Key.length === 32) {
    return base64Key;
  }

  if (Buffer.byteLength(key) === 32) {
    return Buffer.from(key);
  }

  return createHash("sha256").update(key).digest();
}

export class SecretCrypto {
  constructor(private readonly key: string) {}

  encrypt(plainText: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", keyBytes(this.key), iv);
    const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);

    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    };
  }

  decrypt(secret: EncryptedSecret): string {
    const decipher = createDecipheriv("aes-256-gcm", keyBytes(this.key), Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));

    return Buffer.concat([decipher.update(Buffer.from(secret.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
}

export function maskSecret(secret?: string | null): string | null {
  if (!secret) {
    return null;
  }

  const head = secret.startsWith("sk-") ? "sk-" : "";
  return `${head}****${secret.slice(-4)}`;
}
