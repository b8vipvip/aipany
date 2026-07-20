import assert from "node:assert/strict";
import test from "node:test";
import { createCipheriv, randomBytes } from "node:crypto";
import { KeyringEncryptedEmbeddingCodec } from "../src/keyring-postgres-speaker-identity-store.js";

const oldKey = Buffer.alloc(32, 7).toString("base64");
const newKey = Buffer.alloc(32, 9).toString("base64");
const searchKey = Buffer.alloc(32, 11).toString("base64");

function spec(active: string): string {
  return JSON.stringify({
    active,
    search: searchKey,
    keys: { old: oldKey, next: newKey },
  });
}

test("keyring 新密文携带 active key id 且可解密", () => {
  const codec = new KeyringEncryptedEmbeddingCodec(spec("next"));
  const encrypted = codec.encrypt([1, 0.2, -0.1], "scope-a");
  assert.equal(encrypted[0], 2);
  assert.deepEqual(codec.decrypt(encrypted, "scope-a"), [1, 0.2, -0.1]);
  assert.equal(codec.getActiveKeyId(), "next");
});

test("轮换 active key 不改变独立 search key 的 cosine 投影", () => {
  const before = new KeyringEncryptedEmbeddingCodec(spec("old"));
  const after = new KeyringEncryptedEmbeddingCodec(spec("next"));
  assert.deepEqual(
    before.projectForSearch([0.1, 0.2, 0.3, 0.4], "tenant-a"),
    after.projectForSearch([0.1, 0.2, 0.3, 0.4], "tenant-a"),
  );
});

test("keyring 可以读取 v0.2 legacy v1 密文", () => {
  const aad = "legacy-aad";
  const embedding = [0.4, -0.2, 0.8];
  const key = Buffer.from(oldKey, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(embedding), "utf8"), cipher.final()]);
  const legacy = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);

  const codec = new KeyringEncryptedEmbeddingCodec(spec("next"));
  assert.deepEqual(codec.decrypt(legacy, aad), embedding);
});

test("AAD 不匹配时 keyring 不会错误解密", () => {
  const codec = new KeyringEncryptedEmbeddingCodec(spec("next"));
  const encrypted = codec.encrypt([1, 0, 0], "tenant-a");
  assert.throws(() => codec.decrypt(encrypted, "tenant-b"));
});
