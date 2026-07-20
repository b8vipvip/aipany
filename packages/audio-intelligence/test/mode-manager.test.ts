import assert from "node:assert/strict";
import test from "node:test";
import { ModeManager } from "../src/mode-manager.js";

test("可以从自然中文语音命令识别交互模式", () => {
  const manager = new ModeManager();
  assert.equal(manager.detectVoiceCommand("Aipany，大家一起聊吧"), "group");
  assert.equal(manager.detectVoiceCommand("接下来只听我说话"), "owner_focus");
  assert.equal(manager.detectVoiceCommand("以后你自动判断就行"), "auto");
});

test("检测到两个稳定说话人后建议切换多人模式", () => {
  const manager = new ModeManager({
    initialMode: "owner_focus",
    minimumSpeechMs: 1000,
    suggestionCooldownMs: 0,
  });
  const now = Date.now();

  manager.observeSpeaker({
    sessionSpeakerId: "speaker-a",
    observedAt: now,
    speechDurationMs: 1200,
    confidence: 0.9,
  });
  const suggestion = manager.observeSpeaker({
    sessionSpeakerId: "speaker-b",
    observedAt: now + 1000,
    speechDurationMs: 1300,
    confidence: 0.91,
  });

  assert.equal(suggestion?.to, "group");
  assert.equal(suggestion?.reason, "multiple_stable_speakers");
});
