import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import {
  defaultVoiceForModel,
  getClientExperienceModeOptions,
  getClientNativeModelOptions,
  getClientVoiceOptions,
  resolveRequestedVoice,
} from "../src/mobile/client-capabilities.js";
import {
  QWEN_AUDIO_REALTIME_FLASH,
  QWEN_AUDIO_REALTIME_PLUS,
  resolveExperienceDefinition,
} from "../src/mobile/realtime-experience.js";
import { validatePreviewSelection } from "../src/mobile/native-voice-preview.js";

const QWEN_AUDIO_VOICES = [
  "longanqian",
  "longanlingxin",
  "longanlingxi",
  "longanxiaoxin",
  "longanlufeng",
];

test("three realtime experience modes are exposed without subscription semantics", () => {
  const config = loadConfig();
  const modes = getClientExperienceModeOptions(config);

  assert.deepEqual(modes.map((item) => item.id), ["economy_live", "native_flash", "native_plus"]);
  assert.equal(modes[0]?.engine, "cascaded");
  assert.equal(modes[1]?.model, QWEN_AUDIO_REALTIME_FLASH);
  assert.equal(modes[2]?.model, QWEN_AUDIO_REALTIME_PLUS);
  assert.equal(resolveExperienceDefinition(config, "native_plus")?.recommendedTurnDetection, "smart_turn");
});

test("Qwen Audio realtime modes expose every system voice and safe defaults", () => {
  for (const model of [QWEN_AUDIO_REALTIME_PLUS, QWEN_AUDIO_REALTIME_FLASH]) {
    const voices = getClientVoiceOptions(model, "not-a-real-voice");
    assert.deepEqual(voices.map((voice) => voice.id), QWEN_AUDIO_VOICES);
    assert.equal(voices.every((voice) => voice.previewable === true), true);
    assert.equal(defaultVoiceForModel(model), "longanqian");
    assert.equal(resolveRequestedVoice(model, "bad-default", "longanlingxin"), "longanlingxin");
    assert.equal(resolveRequestedVoice(model, "bad-default", "unsupported"), "longanqian");
  }
});

test("legacy Qwen3.5 Omni realtime voice catalog remains available", () => {
  const voices = getClientVoiceOptions("qwen3.5-omni-plus-realtime", "Tina");
  assert.ok(voices.length >= 50);
  assert.ok(voices.some((voice) => voice.id === "Tina"));
  assert.ok(voices.some((voice) => voice.id === "Chloe"));
  assert.equal(voices.every((voice) => voice.previewable === true), true);
});

test("native model dropdown includes qwen audio and qwen3.5 realtime families", () => {
  assert.deepEqual(getClientNativeModelOptions().map((item) => item.id), [
    "qwen-audio-3.0-realtime-plus",
    "qwen-audio-3.0-realtime-flash",
    "qwen3.5-omni-plus-realtime",
    "qwen3.5-omni-flash-realtime",
  ]);
});

test("voice preview validation rejects cross-model voices", () => {
  assert.doesNotThrow(() => validatePreviewSelection(QWEN_AUDIO_REALTIME_PLUS, "longanlingxin"));
  assert.throws(() => validatePreviewSelection(QWEN_AUDIO_REALTIME_PLUS, "Tina"), /不支持该试听音色/);
  assert.throws(() => validatePreviewSelection("unknown-realtime-model", "Tina"), /不支持的 Native Live 模型/);
});
