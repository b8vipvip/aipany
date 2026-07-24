import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTtsInstructionStyle,
  isQwenAudioTtsModel,
  resolveTtsProtocol,
  resolveTtsWebSocketUrl,
} from "../src/providers/qwen-tts.js";

test("qwen audio tts uses dashscope inference websocket protocol", () => {
  const model = "qwen-audio-3.0-tts-plus";
  assert.equal(isQwenAudioTtsModel(model), true);
  assert.equal(resolveTtsProtocol(model), "dashscope_inference");
  assert.equal(
    resolveTtsWebSocketUrl(
      "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime",
      model,
    ),
    "wss://workspace.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference/",
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
