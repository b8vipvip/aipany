import assert from "node:assert/strict";
import test from "node:test";
import { validatePreviewSelection } from "../src/mobile/native-voice-preview.js";

test("allows the configured Economy Live Qwen Audio TTS voice", () => {
  assert.equal(
    validatePreviewSelection(
      "qwen-audio-3.0-tts-plus",
      "longanlingxin",
      "qwen-audio-3.0-tts-plus",
      "longanlingxin",
    ),
    "economy",
  );
});

test("rejects an Economy preview model that differs from runtime configuration", () => {
  assert.throws(
    () => validatePreviewSelection(
      "qwen-audio-3.0-tts-flash",
      "longanhuan_v3.6",
      "qwen-audio-3.0-tts-plus",
      "longanlingxin",
    ),
    /模型与服务器配置不一致/u,
  );
});

test("keeps Native Live preview validation", () => {
  assert.equal(
    validatePreviewSelection("qwen-audio-3.0-realtime-plus", "longanlingxin"),
    "native",
  );
});
