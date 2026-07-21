import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface EncryptedConfigBackup {
  format: "aipany-runtime-config";
  version: 1;
  createdAt: string;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export function encryptConfigBackup(document: Record<string, unknown>, passphrase: string): EncryptedConfigBackup {
  validatePassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(document), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: "aipany-runtime-config",
    version: 1,
    createdAt: new Date().toISOString(),
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

export function decryptConfigBackup(input: unknown, passphrase: string): Record<string, unknown> {
  validatePassphrase(passphrase);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("备份文件格式无效");
  const backup = input as Partial<EncryptedConfigBackup>;
  if (backup.format !== "aipany-runtime-config" || backup.version !== 1) throw new Error("不支持的 Aipany 配置备份格式");
  if (backup.kdf !== "scrypt" || backup.cipher !== "aes-256-gcm") throw new Error("不支持的备份加密算法");
  for (const key of ["salt", "iv", "tag", "ciphertext"] as const) {
    if (typeof backup[key] !== "string" || !backup[key]) throw new Error(`备份文件缺少 ${key}`);
  }

  try {
    const salt = Buffer.from(backup.salt!, "base64");
    const iv = Buffer.from(backup.iv!, "base64");
    const tag = Buffer.from(backup.tag!, "base64");
    const ciphertext = Buffer.from(backup.ciphertext!, "base64");
    const key = scryptSync(passphrase, salt, 32);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    const parsed = JSON.parse(plaintext) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("解密后的配置不是 JSON 对象");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`备份解密失败，请检查密码或文件完整性：${error instanceof Error ? error.message : String(error)}`);
  }
}

function validatePassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < 8) throw new Error("备份密码至少需要 8 个字符");
}
