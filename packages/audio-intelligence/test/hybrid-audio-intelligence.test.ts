import assert from "node:assert/strict";
import test from "node:test";
import type {
  AudioFormatDescriptor,
  SpeakerIntelligenceCapabilities,
  TargetSpeakerExtractionProvider,
  UtteranceAudioAnalysis,
  UtteranceAudioAnalysisOptions,
  UtteranceAudioAnalysisProvider,
} from "../src/types.js";
import {
  HybridAudioIntelligenceProvider,
  type CloudAudioAnalysisProvider,
} from "../src/providers/hybrid-audio-intelligence-provider.js";
import { QwenOmniCloudAudioProvider } from "../src/providers/qwen-omni-cloud-audio-provider.js";

const format: AudioFormatDescriptor = { encoding: "pcm_s16le", sampleRate: 16000, channels: 1 };
const audio = Buffer.alloc(32000);

class LocalProvider implements UtteranceAudioAnalysisProvider {
  readonly name = "local-test";
  lastOptions?: UtteranceAudioAnalysisOptions;

  async extractEmbedding() {
    return { embedding: [1, 0], quality: 0.9, durationMs: 1000 };
  }

  async getCapabilities(): Promise<SpeakerIntelligenceCapabilities> {
    return {
      embeddings: true,
      verification: true,
      diarization: true,
      streamingDiarization: true,
      overlapDetection: false,
      speechSeparation: false,
      targetSpeakerExtraction: false,
      environmentAnalysis: false,
      segmentTranscription: false,
    };
  }

  async analyzeUtterance(_audio: Buffer, _format: AudioFormatDescriptor, options: UtteranceAudioAnalysisOptions = {}): Promise<UtteranceAudioAnalysis> {
    this.lastOptions = options;
    return {
      embedding: [1, 0],
      quality: 0.9,
      durationMs: 2000,
      diarization: [
        { speakerId: "local_a", startMs: 0, endMs: 900, confidence: 0.8, embedding: [1, 0] },
        { speakerId: "local_b", startMs: 900, endMs: 2000, confidence: 0.8, embedding: [0, 1] },
      ],
      overlapDetected: false,
    };
  }
}

test("hybrid provider keeps local identity data and enriches with cloud/remote results", async () => {
  const local = new LocalProvider();
  let remoteCalls = 0;
  const cloud: CloudAudioAnalysisProvider = {
    name: "cloud-test",
    async analyzeCloudAudio() {
      return {
        diarization: [
          { speakerId: "speaker_1", startMs: 0, endMs: 1000, confidence: 0.95, transcript: "你好" },
          { speakerId: "speaker_2", startMs: 1000, endMs: 2000, confidence: 0.96, transcript: "你好呀" },
        ],
        environment: { scene: "room", noiseLevel: "low", events: [], capturedAt: 1 },
      };
    },
  };
  const remote: TargetSpeakerExtractionProvider = {
    name: "remote-test",
    async extractTargetSpeaker() {
      remoteCalls += 1;
      return { matched: true, similarity: 0.91, confidence: 0.88, transcript: "只保留主人" };
    },
  };
  const provider = new HybridAudioIntelligenceProvider({ local, cloud, remoteTargetSpeaker: remote });
  const result = await provider.analyzeUtterance(audio, format, {
    mode: "owner_focus",
    ownerEmbedding: [1, 0],
    includeTranscript: true,
    enableEnvironment: true,
    enableSeparation: true,
  });

  assert.equal(local.lastOptions?.includeTranscript, false);
  assert.equal(local.lastOptions?.enableEnvironment, false);
  assert.equal(local.lastOptions?.enableSeparation, false);
  assert.equal(result.diarization[0]?.speakerId, "local_a");
  assert.equal(result.diarization[0]?.transcript, "你好");
  assert.deepEqual(result.diarization[0]?.embedding, [1, 0]);
  assert.equal(result.environment?.scene, "room");
  assert.equal(result.targetSpeaker?.matched, true);
  assert.equal(result.overlapDetected, true);
  assert.equal(remoteCalls, 1);
});

test("cloud enhancement failure fails open to local analysis", async () => {
  const local = new LocalProvider();
  const cloud: CloudAudioAnalysisProvider = {
    name: "broken-cloud",
    async analyzeCloudAudio() { throw new Error("cloud unavailable"); },
  };
  const provider = new HybridAudioIntelligenceProvider({ local, cloud });
  const result = await provider.analyzeUtterance(audio, format, { includeTranscript: true, enableEnvironment: true });
  assert.equal(result.embedding[0], 1);
  assert.equal(result.diarization.length, 2);
  assert.equal(result.environment, undefined);
});

test("Qwen Omni provider parses streamed JSON and sends WAV audio", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody = "";
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? "");
    const payload = JSON.stringify({ choices: [{ delta: { content: '{"environment":{"scene":"street","sceneConfidence":0.9,"noiseLevel":"medium","events":[]},"segments":[{"speakerId":"speaker_1","startMs":0,"endMs":1000,"confidence":0.9,"transcript":"测试"}]}' } }] });
    return new Response(`data: ${payload}\n\ndata: [DONE]\n`, { status: 200 });
  }) as typeof fetch;

  try {
    const provider = new QwenOmniCloudAudioProvider({ baseUrl: "https://example.invalid/v1", apiKey: "test-key" });
    const result = await provider.analyzeCloudAudio(audio, format, { includeDiarization: true, includeEnvironment: true });
    assert.match(requestBody, /input_audio/);
    assert.match(requestBody, /data:;base64/);
    assert.equal(result.environment?.scene, "street");
    assert.equal(result.diarization[0]?.transcript, "测试");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
