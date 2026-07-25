import assert from "node:assert/strict";
import test from "node:test";
import {
  buildInferenceTtsParameters,
  classifyTtsInstructionStyle,
  isQwenAudioTtsModel,
  resolveTtsProsody,
  resolveTtsProtocol,
  resolveTtsWebSocketUrl,
} from "../src/providers/qwen-tts.js";

test("qwen audio tts uses the exact dashscope inference websocket endpoint", () => {
  const model = "qwen-audio-3.0-tts-plus";
  assert.equal(isQwenAudioTtsModel(model), true);
  assert.equal(resolveTtsProtocol(model), "dashscope_inference");
  assert.equal(
    resolveTtsWebSocketUrl(
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      model,
    ),
    "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
  );
  assert.equal(
    resolveTtsWebSocketUrl(
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
      model,
    ),
    "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
  );
  assert.equal(
    resolveTtsWebSocketUrl(
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/",
      model,
    ),
    "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
  );
});

test("legacy qwen realtime tts keeps model query protocol", () => {
  const model = "qwen3-tts-instruct-flash-realtime";
  assert.equal(resolveTtsProtocol(model), "qwen_realtime");
  assert.equal(
    resolveTtsWebSocketUrl("wss://dashscope.aliyuncs.com/api-ws/v1/realtime", model),
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-instruct-flash-realtime",
  );
});

test("tts observability classifies style without storing instruction text", () => {
  assert.equal(
    classifyTtsInstructionStyle("用温暖、轻柔、真诚、有陪伴感的方式说话。"),
    "warm_support",
  );
  assert.equal(
    classifyTtsInstructionStyle("自然开心、轻快、带一点真实笑意。"),
    "bright_playful",
  );
  assert.equal(classifyTtsInstructionStyle(""), "none");
});

test("humanizer style maps to bounded numeric Qwen-Audio prosody", () => {
  const warm = resolveTtsProsody("用温暖、轻柔、真诚、有陪伴感的方式说话，语速稍慢。");
  const bright = resolveTtsProsody("自然开心、轻快、带一点真实笑意，短回应要轻、快。");

  assert.equal(warm.style, "warm_support");
  assert.ok(warm.rate < 1);
  assert.ok(warm.pitch <= 1);
  assert.equal(bright.style, "bright_playful");
  assert.ok(bright.rate > 1);
  assert.ok(bright.pitch >= 1);
  for (const item of [warm, bright]) {
    assert.ok(item.rate >= 0.5 && item.rate <= 2);
    assert.ok(item.pitch >= 0.5 && item.pitch <= 2);
    assert.ok(item.volume >= 0 && item.volume <= 100);
  }
});

test("workspace-safe Qwen Audio payload omits seed and excessive precision", () => {
  const parameters = buildInferenceTtsParameters(
    { voice: "longanlingxin", sampleRate: 24_000, language: "Chinese" },
    "用温暖、轻柔、真诚、有陪伴感的方式说话，语速稍慢。",
  );

  assert.equal(parameters.voice, "longanlingxin");
  assert.equal(parameters.sample_rate, 24_000);
  assert.deepEqual(parameters.language_hints, ["zh"]);
  assert.equal("seed" in parameters, false);
  assert.equal(Number.isInteger(parameters.rate * 10), true);
  assert.equal(Number.isInteger(parameters.pitch * 10), true);
  assert.ok(parameters.instruction.length > 0);
});
