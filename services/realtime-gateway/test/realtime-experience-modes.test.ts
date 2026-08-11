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
  getRealtimeExperienceDefinitions,
  isNativeExperienceAvailable,
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

test("realtime experience modes include ChatGPT Live without subscription semantics", () => {
  const config = loadConfig();
  const modes = getClientExperienceModeOptions(config);

  assert.deepEqual(modes.map((item) => item.id), ["economy_live", "chat2api_live", "native_flash", "native_plus"]);
  assert.equal(modes.find((item) => item.id === "economy_live")?.engine, "cascaded");
  assert.equal(modes.find((item) => item.id === "chat2api_live")?.model, "gpt-live");
  assert.equal(modes.find((item) => item.id === "native_flash")?.model, QWEN_AUDIO_REALTIME_FLASH);
  assert.equal(modes.find((item) => item.id === "native_plus")?.model, QWEN_AUDIO_REALTIME_PLUS);
  assert.equal(resolveExperienceDefinition(config, "native_plus")?.recommendedTurnDetection, "smart_turn");
});

test("disabled Qwen Native Live is clearly labelled while voice preview remains discoverable", () => {
  const current = loadConfig();
  const config = {
    ...current,
    qwenOmniRealtime: {
      ...current.qwenOmniRealtime,
      enabled: false,
      qwenEnabled: false,
      apiKey: "configured-for-preview",
    },
  };
  const modes = getRealtimeExperienceDefinitions(config);
  const flash = modes.find((item) => item.id === "native_flash");

  assert.equal(isNativeExperienceAvailable(config), false);
  assert.match(flash?.title ?? "", /未启用/u);
  assert.match(flash?.subtitle ?? "", /音色仍可试听/u);
  assert.match(flash?.subtitle ?? "", /回退到 Economy Live/u);
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

test("ChatGPT Live uses the browser-selected ChatGPT voice and is not previewed as Qwen", () => {
  const voices = getClientVoiceOptions("gpt-live", "chatgpt-current");
  assert.deepEqual(voices.map((voice) => voice.id), ["chatgpt-current"]);
  assert.equal(voices[0]?.previewable, false);
  assert.equal(defaultVoiceForModel("gpt-live"), "chatgpt-current");
});

test("legacy Qwen3.5 Omni realtime voice catalog remains available", () => {
  const voices = getClientVoiceOptions("qwen3.5-omni-plus-realtime", "Tina");
  assert.ok(voices.length >= 50);
  assert.ok(voices.some((voice) => voice.id === "Tina"));
  assert.ok(voices.some((voice) => voice.id === "Chloe"));
  assert.equal(voices.every((voice) => voice.previewable === true), true);
});

test("Qwen native model dropdown stays provider-specific", () => {
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
