import assert from "node:assert/strict";
import test from "node:test";
import { EncryptedEmbeddingCodec } from "../src/postgres-speaker-identity-store.js";
import { cosineSimilarity } from "../src/speaker-identity-store.js";

const key = Buffer.alloc(32, 7).toString("base64");

test("AES-GCM 声纹密文可以在相同 AAD 下正确解密", () => {
  const codec = new EncryptedEmbeddingCodec(key);
  const embedding = [0.12, -0.4, 0.91, 0.03];
  const encrypted = codec.encrypt(embedding, "tenant:user:profile");
  assert.notEqual(encrypted.toString("utf8"), JSON.stringify(embedding));
  assert.deepEqual(codec.decrypt(encrypted, "tenant:user:profile"), embedding);
});

test("不同作用域使用不同搜索投影，避免跨租户直接关联", () => {
  const codec = new EncryptedEmbeddingCodec(key);
  const embedding = [0.8, 0.1, -0.2, 0.5];
  assert.notDeepEqual(
    codec.projectForSearch(embedding, "tenant-a:user-a"),
    codec.projectForSearch(embedding, "tenant-b:user-a"),
  );
});

test("AAD 不一致时无法解密其它租户作用域的声纹", () => {
  const codec = new EncryptedEmbeddingCodec(key);
  const encrypted = codec.encrypt([1, 0, 0], "tenant-a:user-a");
  assert.throws(() => codec.decrypt(encrypted, "tenant-b:user-a"));
});

test("pgvector 搜索投影保持 cosine similarity", () => {
  const codec = new EncryptedEmbeddingCodec(key);
  const a = [0.8, 0.1, -0.2, 0.5];
  const b = [0.75, 0.05, -0.1, 0.45];
  const before = cosineSimilarity(a, b);
  const after = cosineSimilarity(
    codec.projectForSearch(a, "tenant-a:user-a"),
    codec.projectForSearch(b, "tenant-a:user-a"),
  );
  assert.ok(Math.abs(before - after) < 1e-12);
});
