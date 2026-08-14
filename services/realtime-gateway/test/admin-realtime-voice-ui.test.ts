import assert from "node:assert/strict";
import test from "node:test";
import { ADMIN_OPERATIONS_UI } from "../src/admin/admin-operations-ui.js";

test("operations console exposes unified realtime voice configuration", () => {
  assert.match(ADMIN_OPERATIONS_UI, /实时语音/);
  assert.match(ADMIN_OPERATIONS_UI, /ChatGPT Live/);
  assert.match(ADMIN_OPERATIONS_UI, /Qwen Native Live/);
  assert.match(ADMIN_OPERATIONS_UI, /Economy Live/);
  assert.match(ADMIN_OPERATIONS_UI, /CHAT2API_LIVE_ENABLED/);
  assert.match(ADMIN_OPERATIONS_UI, /CHAT2API_LIVE_API_KEY/);
  assert.match(ADMIN_OPERATIONS_UI, /音频智能/);
  assert.match(ADMIN_OPERATIONS_UI, /保存实时语音配置/);
});
