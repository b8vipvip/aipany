import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultVoiceForModel,
  getClientVoiceOptions,
  resolveRequestedVoice,
} from "../src/mobile/client-capabilities.js";

test("qwen audio tts plus exposes only compatible flagship voices", () => {
  const model = "qwen-audio-3.0-tts-plus";
  const voices = getClientVoiceOptions(model, "longanlingxin");
  assert.deepEqual(voices.map((voice) => voice.id), ["longanlingxin", "longanlufeng"]);
  assert.equal(defaultVoiceForModel(model), "longanlingxin");
  assert.equal(resolveRequestedVoice(model, "longanlingxin", "Cherry"), "longanlingxin");
  assert.equal(resolveRequestedVoice(model, "longanlingxin", "longanlufeng"), "longanlufeng");
});

test("qwen audio tts flash uses its own voice family", () => {
  const model = "qwen-audio-3.0-tts-flash";
  const voices = getClientVoiceOptions(model, "longanhuan_v3.6");
  assert.ok(voices.some((voice) => voice.id === "longanhuan_v3.6"));
  assert.ok(!voices.some((voice) => voice.id === "longanlingxin"));
});
