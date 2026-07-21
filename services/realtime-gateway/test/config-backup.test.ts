import assert from "node:assert/strict";
import test from "node:test";
import { decryptConfigBackup, encryptConfigBackup } from "../src/admin/config-backup.js";

test("runtime config backup encrypts and restores secret values", () => {
  const document = {
    DASHSCOPE_API_KEY: "dash-secret",
    llmProviderPool: {
      providers: [{ id: "relay", apiKey: "relay-secret" }],
    },
  };
  const backup = encryptConfigBackup(document, "strong-passphrase");
  const serialized = JSON.stringify(backup);
  assert.equal(serialized.includes("dash-secret"), false);
  assert.equal(serialized.includes("relay-secret"), false);
  assert.deepEqual(decryptConfigBackup(backup, "strong-passphrase"), document);
  assert.throws(() => decryptConfigBackup(backup, "wrong-password"), /备份解密失败/);
});
