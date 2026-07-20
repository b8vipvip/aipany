from __future__ import annotations

import base64
import os
import threading
import time
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch
from speechbrain.inference.speaker import EncoderClassifier


MODEL_SOURCE = os.getenv("SPEAKER_MODEL_SOURCE", "speechbrain/spkrec-ecapa-voxceleb")
MODEL_CACHE_DIR = os.getenv("SPEAKER_MODEL_CACHE_DIR", "/models/speechbrain/spkrec-ecapa-voxceleb")
DEVICE = os.getenv("SPEAKER_DEVICE", "cpu")
MIN_AUDIO_MS = int(os.getenv("SPEAKER_SERVICE_MIN_AUDIO_MS", "500"))
EXPECTED_SAMPLE_RATE = 16000

DIARIZATION_WINDOW_MS = int(os.getenv("DIARIZATION_WINDOW_MS", "1400"))
DIARIZATION_HOP_MS = int(os.getenv("DIARIZATION_HOP_MS", "700"))
DIARIZATION_MATCH_THRESHOLD = float(os.getenv("DIARIZATION_MATCH_THRESHOLD", "0.72"))
DIARIZATION_MIN_REGION_MS = int(os.getenv("DIARIZATION_MIN_REGION_MS", "320"))
DIARIZATION_MAX_SPEAKERS = int(os.getenv("DIARIZATION_MAX_SPEAKERS", "8"))

SEPARATION_MODEL_SOURCE = os.getenv("SEPARATION_MODEL_SOURCE", "speechbrain/sepformer-wsj02mix")
SEPARATION_MODEL_CACHE_DIR = os.getenv("SEPARATION_MODEL_CACHE_DIR", "/models/speechbrain/sepformer-wsj02mix")
SEPARATION_SECOND_SOURCE_RATIO = float(os.getenv("SEPARATION_SECOND_SOURCE_RATIO", "0.12"))
SEPARATION_DISTINCT_SPEAKER_THRESHOLD = float(os.getenv("SEPARATION_DISTINCT_SPEAKER_THRESHOLD", "0.78"))
TARGET_SPEAKER_THRESHOLD = float(os.getenv("TARGET_SPEAKER_THRESHOLD", "0.72"))

WHISPER_MODEL = os.getenv("WHISPER_MODEL", "base")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", DEVICE)
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8" if DEVICE == "cpu" else "float16")
WHISPER_MODEL_CACHE_DIR = os.getenv("WHISPER_MODEL_CACHE_DIR", "/models/faster-whisper")

ENVIRONMENT_MODEL_SOURCE = os.getenv(
    "ENVIRONMENT_MODEL_SOURCE",
    "MIT/ast-finetuned-audioset-10-10-0.4593",
)
ENVIRONMENT_MODEL_CACHE_DIR = os.getenv("ENVIRONMENT_MODEL_CACHE_DIR", "/models/huggingface")


@dataclass
class Cluster:
    speaker_id: str
    centroid: np.ndarray
    count: int


class AudioIntelligenceEngine:
    """Aipany 音频智能模型层。

    ECAPA 在启动时加载，是低延迟主能力；SepFormer、AST 和 Whisper 都按需懒加载，
    任一增强模型失败时均降级到已有能力而不是阻断声纹主链路。
    """

    def __init__(self) -> None:
        self.classifier: EncoderClassifier | None = None
        self.separator: Any | None = None
        self.whisper: Any | None = None
        self.environment_feature_extractor: Any | None = None
        self.environment_model: Any | None = None
        self._separator_lock = threading.Lock()
        self._whisper_lock = threading.Lock()
        self._environment_lock = threading.Lock()
        self.component_errors: dict[str, str] = {}

    def load(self) -> None:
        self.classifier = EncoderClassifier.from_hparams(
            source=MODEL_SOURCE,
            savedir=MODEL_CACHE_DIR,
            run_opts={"device": DEVICE},
        )

    def decode_pcm_s16le(self, raw: bytes, sample_rate: int, channels: int) -> np.ndarray:
        if sample_rate != EXPECTED_SAMPLE_RATE:
            raise ValueError(f"provider currently requires {EXPECTED_SAMPLE_RATE} Hz PCM")
        if channels < 1:
            raise ValueError("channels must be >= 1")
        if len(raw) % (2 * channels) != 0:
            raise ValueError("invalid pcm_s16le byte length")
        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1:
            pcm = pcm.reshape(-1, channels).mean(axis=1)
        return np.ascontiguousarray(pcm, dtype=np.float32)

    def embed_pcm_s16le(self, raw: bytes, sample_rate: int, channels: int) -> dict[str, Any]:
        pcm = self.decode_pcm_s16le(raw, sample_rate, channels)
        duration_ms = float(len(pcm) / sample_rate * 1000)
        if duration_ms < MIN_AUDIO_MS:
            raise ValueError(f"audio too short: {duration_ms:.0f} ms, need >= {MIN_AUDIO_MS} ms")
        embedding = self.embed_waveform(pcm)
        return {
            "embedding": embedding.tolist(),
            "quality": estimate_quality(pcm, duration_ms),
            "duration_ms": duration_ms,
            "model": MODEL_SOURCE,
            "dimensions": int(embedding.size),
        }

    def analyze_pcm_s16le(
        self,
        raw: bytes,
        sample_rate: int,
        channels: int,
        *,
        owner_embedding: list[float] | None = None,
        include_transcript: bool = True,
        enable_separation: bool = True,
        enable_environment: bool = True,
        language: str | None = None,
    ) -> dict[str, Any]:
        pcm = self.decode_pcm_s16le(raw, sample_rate, channels)
        duration_ms = float(len(pcm) / sample_rate * 1000)
        if duration_ms < MIN_AUDIO_MS:
            raise ValueError(f"audio too short: {duration_ms:.0f} ms, need >= {MIN_AUDIO_MS} ms")

        embedding = self.embed_waveform(pcm)
        result: dict[str, Any] = {
            "embedding": embedding.tolist(),
            "quality": estimate_quality(pcm, duration_ms),
            "duration_ms": duration_ms,
            "model": MODEL_SOURCE,
            "dimensions": int(embedding.size),
            "proximity": estimate_proximity(pcm),
            "diarization": [],
            "overlap_detected": False,
            "environment": None,
            "target_speaker": None,
        }

        if enable_environment:
            result["environment"] = self.analyze_environment(pcm, sample_rate)

        separation = None
        if enable_separation and duration_ms >= max(900, MIN_AUDIO_MS):
            separation = self.try_separate(pcm)

        if separation and separation["overlap_detected"]:
            result["overlap_detected"] = True
            result["diarization"] = self.build_overlap_segments(
                separation["sources"],
                separation["embeddings"],
                sample_rate,
                include_transcript,
                language,
            )
        else:
            result["diarization"] = self.diarize(
                pcm,
                sample_rate,
                include_transcript=include_transcript,
                language=language,
            )

        if owner_embedding:
            result["target_speaker"] = self.extract_target_speaker(
                pcm,
                np.asarray(owner_embedding, dtype=np.float32),
                separation,
                sample_rate,
                include_transcript,
                language,
            )

        return result

    def embed_waveform(self, pcm: np.ndarray) -> np.ndarray:
        if self.classifier is None:
            raise RuntimeError("speaker model is not loaded")
        if pcm.size == 0:
            raise ValueError("empty audio")
        minimum_samples = int(EXPECTED_SAMPLE_RATE * max(0.2, MIN_AUDIO_MS / 1000.0))
        if pcm.size < minimum_samples:
            padded = np.zeros(minimum_samples, dtype=np.float32)
            padded[: pcm.size] = pcm
            pcm = padded
        waveform = torch.from_numpy(np.ascontiguousarray(pcm)).unsqueeze(0).to(DEVICE)
        with torch.inference_mode():
            embedding = (
                self.classifier.encode_batch(waveform)
                .squeeze()
                .detach()
                .cpu()
                .numpy()
                .astype(np.float32)
            )
        norm = float(np.linalg.norm(embedding))
        if norm > 0:
            embedding = embedding / norm
        return embedding

    def diarize(
        self,
        pcm: np.ndarray,
        sample_rate: int,
        *,
        include_transcript: bool,
        language: str | None,
    ) -> list[dict[str, Any]]:
        regions = detect_speech_regions(pcm, sample_rate)
        if not regions:
            regions = [(0, len(pcm))]

        window_samples = max(int(sample_rate * DIARIZATION_WINDOW_MS / 1000), int(sample_rate * 0.5))
        hop_samples = max(int(sample_rate * DIARIZATION_HOP_MS / 1000), int(sample_rate * 0.25))
        clusters: list[Cluster] = []
        windows: list[tuple[int, int, str, float]] = []

        for region_start, region_end in regions:
            cursor = region_start
            while cursor < region_end:
                end = min(region_end, cursor + window_samples)
                segment = pcm[cursor:end]
                if segment.size < int(sample_rate * 0.25):
                    break
                emb = self.embed_waveform(segment)
                speaker_id, confidence = assign_cluster(emb, clusters)
                windows.append((cursor, end, speaker_id, confidence))
                if end >= region_end:
                    break
                cursor += hop_samples

        if not windows:
            emb = self.embed_waveform(pcm)
            return [self._make_segment("speaker_1", 0, len(pcm), 1.0, emb, pcm, sample_rate, include_transcript, language)]

        boundaries: list[tuple[int, int, str, float]] = []
        for index, (start, end, speaker_id, confidence) in enumerate(windows):
            next_start = windows[index + 1][0] if index + 1 < len(windows) else end
            segment_end = min(len(pcm), max(start + 1, (end + next_start) // 2))
            if boundaries and boundaries[-1][2] == speaker_id and start <= boundaries[-1][1] + hop_samples:
                prev = boundaries[-1]
                boundaries[-1] = (prev[0], segment_end, speaker_id, max(prev[3], confidence))
            else:
                boundaries.append((start, segment_end, speaker_id, confidence))

        output: list[dict[str, Any]] = []
        for start, end, speaker_id, confidence in boundaries:
            clip = pcm[start:end]
            if clip.size < int(sample_rate * DIARIZATION_MIN_REGION_MS / 1000):
                continue
            emb = self.embed_waveform(clip)
            output.append(
                self._make_segment(
                    speaker_id,
                    start,
                    end,
                    confidence,
                    emb,
                    clip,
                    sample_rate,
                    include_transcript,
                    language,
                )
            )
        return output or [
            self._make_segment(
                "speaker_1",
                0,
                len(pcm),
                1.0,
                self.embed_waveform(pcm),
                pcm,
                sample_rate,
                include_transcript,
                language,
            )
        ]

    def _make_segment(
        self,
        speaker_id: str,
        start_sample: int,
        end_sample: int,
        confidence: float,
        embedding: np.ndarray,
        clip: np.ndarray,
        sample_rate: int,
        include_transcript: bool,
        language: str | None,
        overlap: bool = False,
    ) -> dict[str, Any]:
        return {
            "speaker_id": speaker_id,
            "start_ms": float(start_sample / sample_rate * 1000),
            "end_ms": float(end_sample / sample_rate * 1000),
            "confidence": float(max(0.0, min(1.0, confidence))),
            "overlap": overlap,
            "embedding": embedding.tolist(),
            "transcript": self.transcribe(clip, language) if include_transcript else None,
        }

    def try_separate(self, pcm: np.ndarray) -> dict[str, Any] | None:
        try:
            separator = self._get_separator()
            waveform = torch.from_numpy(np.ascontiguousarray(pcm)).unsqueeze(0).to(DEVICE)
            with torch.inference_mode():
                separated = separator.separate_batch(waveform).detach().cpu().numpy()
            sources = normalize_separated_sources(separated)
            if len(sources) < 2:
                return None
            energies = np.asarray([rms(source) for source in sources], dtype=np.float32)
            order = np.argsort(energies)[::-1]
            sources = [sources[int(index)] for index in order]
            energies = energies[order]
            if energies[0] <= 1e-5:
                return None
            active = [source for source, energy in zip(sources, energies) if energy / energies[0] >= SEPARATION_SECOND_SOURCE_RATIO]
            embeddings = [self.embed_waveform(source) for source in active]
            overlap = False
            if len(active) >= 2:
                similarity = cosine_similarity(embeddings[0], embeddings[1])
                overlap = similarity < SEPARATION_DISTINCT_SPEAKER_THRESHOLD
            return {
                "sources": active,
                "embeddings": embeddings,
                "overlap_detected": overlap,
            }
        except Exception as exc:  # noqa: BLE001 - enhancement must fail open
            self.component_errors["separation"] = str(exc)
            return None

    def build_overlap_segments(
        self,
        sources: list[np.ndarray],
        embeddings: list[np.ndarray],
        sample_rate: int,
        include_transcript: bool,
        language: str | None,
    ) -> list[dict[str, Any]]:
        segments: list[dict[str, Any]] = []
        for index, (source, embedding) in enumerate(zip(sources, embeddings)):
            segments.append(
                self._make_segment(
                    f"overlap_{index + 1}",
                    0,
                    len(source),
                    estimate_quality(source, len(source) / sample_rate * 1000),
                    embedding,
                    source,
                    sample_rate,
                    include_transcript,
                    language,
                    overlap=True,
                )
            )
        return segments

    def extract_target_speaker(
        self,
        pcm: np.ndarray,
        owner_embedding: np.ndarray,
        separation: dict[str, Any] | None,
        sample_rate: int,
        include_transcript: bool,
        language: str | None,
    ) -> dict[str, Any]:
        if owner_embedding.ndim != 1 or owner_embedding.size < 2:
            return {"matched": False, "similarity": 0.0, "confidence": 0.0}
        owner_norm = float(np.linalg.norm(owner_embedding))
        if owner_norm <= 0:
            return {"matched": False, "similarity": 0.0, "confidence": 0.0}
        owner_embedding = owner_embedding / owner_norm

        candidates: list[tuple[np.ndarray, np.ndarray]] = []
        if separation:
            candidates.extend(zip(separation.get("sources", []), separation.get("embeddings", [])))
        if not candidates:
            candidates.append((pcm, self.embed_waveform(pcm)))

        scored = [(cosine_similarity(owner_embedding, embedding), source) for source, embedding in candidates]
        similarity, source = max(scored, key=lambda item: item[0])
        confidence = float(max(0.0, min(1.0, (similarity - 0.45) / 0.45)))
        matched = similarity >= TARGET_SPEAKER_THRESHOLD
        pcm16 = np.clip(source, -1.0, 1.0)
        audio_bytes = (pcm16 * 32767.0).astype("<i2").tobytes()
        return {
            "matched": bool(matched),
            "similarity": float(similarity),
            "confidence": confidence,
            "transcript": self.transcribe(source, language) if matched and include_transcript else None,
            "audio_base64": base64.b64encode(audio_bytes).decode("ascii") if matched else None,
        }

    def analyze_environment(self, pcm: np.ndarray, sample_rate: int) -> dict[str, Any]:
        fallback = heuristic_environment(pcm)
        try:
            feature_extractor, model = self._get_environment_model()
            inputs = feature_extractor(
                pcm,
                sampling_rate=sample_rate,
                return_tensors="pt",
            )
            inputs = {key: value.to(DEVICE) for key, value in inputs.items()}
            with torch.inference_mode():
                logits = model(**inputs).logits[0]
                probabilities = torch.softmax(logits, dim=-1)
                values, indices = torch.topk(probabilities, k=min(5, probabilities.numel()))
            events: list[dict[str, Any]] = []
            for score, index in zip(values.detach().cpu().tolist(), indices.detach().cpu().tolist()):
                label = str(model.config.id2label.get(int(index), f"class_{index}"))
                events.append({"type": label, "confidence": float(score)})
            scene, scene_confidence = infer_scene(events)
            return {
                "scene": scene or fallback["scene"],
                "scene_confidence": scene_confidence if scene else fallback["scene_confidence"],
                "noise_level": fallback["noise_level"],
                "events": events,
                "captured_at": int(time.time() * 1000),
            }
        except Exception as exc:  # noqa: BLE001 - environment is optional enhancement
            self.component_errors["environment"] = str(exc)
            fallback["captured_at"] = int(time.time() * 1000)
            return fallback

    def transcribe(self, pcm: np.ndarray, language: str | None) -> str | None:
        if pcm.size < int(EXPECTED_SAMPLE_RATE * 0.25):
            return None
        try:
            model = self._get_whisper()
            normalized_language = normalize_language(language)
            segments, _ = model.transcribe(
                np.ascontiguousarray(pcm, dtype=np.float32),
                language=normalized_language,
                vad_filter=True,
                beam_size=1,
                best_of=1,
                condition_on_previous_text=False,
            )
            text = "".join(segment.text for segment in segments).strip()
            return text or None
        except Exception as exc:  # noqa: BLE001 - transcript enrichment must fail open
            self.component_errors["transcription"] = str(exc)
            return None

    def _get_separator(self) -> Any:
        if self.separator is not None:
            return self.separator
        with self._separator_lock:
            if self.separator is None:
                from speechbrain.inference.separation import SepformerSeparation

                self.separator = SepformerSeparation.from_hparams(
                    source=SEPARATION_MODEL_SOURCE,
                    savedir=SEPARATION_MODEL_CACHE_DIR,
                    run_opts={"device": DEVICE},
                )
        return self.separator

    def _get_whisper(self) -> Any:
        if self.whisper is not None:
            return self.whisper
        with self._whisper_lock:
            if self.whisper is None:
                from faster_whisper import WhisperModel

                self.whisper = WhisperModel(
                    WHISPER_MODEL,
                    device=WHISPER_DEVICE,
                    compute_type=WHISPER_COMPUTE_TYPE,
                    download_root=WHISPER_MODEL_CACHE_DIR,
                )
        return self.whisper

    def _get_environment_model(self) -> tuple[Any, Any]:
        if self.environment_feature_extractor is not None and self.environment_model is not None:
            return self.environment_feature_extractor, self.environment_model
        with self._environment_lock:
            if self.environment_feature_extractor is None or self.environment_model is None:
                from transformers import AutoFeatureExtractor, ASTForAudioClassification

                self.environment_feature_extractor = AutoFeatureExtractor.from_pretrained(
                    ENVIRONMENT_MODEL_SOURCE,
                    cache_dir=ENVIRONMENT_MODEL_CACHE_DIR,
                )
                self.environment_model = ASTForAudioClassification.from_pretrained(
                    ENVIRONMENT_MODEL_SOURCE,
                    cache_dir=ENVIRONMENT_MODEL_CACHE_DIR,
                ).to(DEVICE)
                self.environment_model.eval()
        return self.environment_feature_extractor, self.environment_model


def assign_cluster(embedding: np.ndarray, clusters: list[Cluster]) -> tuple[str, float]:
    if not clusters:
        clusters.append(Cluster("speaker_1", embedding.copy(), 1))
        return "speaker_1", 1.0

    scores = [cosine_similarity(cluster.centroid, embedding) for cluster in clusters]
    best_index = int(np.argmax(scores))
    best_score = float(scores[best_index])
    if best_score >= DIARIZATION_MATCH_THRESHOLD or len(clusters) >= DIARIZATION_MAX_SPEAKERS:
        cluster = clusters[best_index]
        cluster.centroid = normalize_vector(cluster.centroid * cluster.count + embedding)
        cluster.count += 1
        return cluster.speaker_id, max(0.0, min(1.0, best_score))

    speaker_id = f"speaker_{len(clusters) + 1}"
    clusters.append(Cluster(speaker_id, embedding.copy(), 1))
    return speaker_id, 1.0


def detect_speech_regions(pcm: np.ndarray, sample_rate: int) -> list[tuple[int, int]]:
    frame = max(1, int(sample_rate * 0.03))
    if pcm.size < frame:
        return [(0, pcm.size)] if pcm.size else []
    energies = []
    for start in range(0, pcm.size, frame):
        clip = pcm[start : start + frame]
        energies.append(rms(clip))
    energy_array = np.asarray(energies, dtype=np.float32)
    noise_floor = float(np.percentile(energy_array, 20))
    threshold = max(0.004, noise_floor * 2.2)
    active = energy_array >= threshold

    hangover = 4
    for index in range(len(active)):
        if not active[index]:
            continue
        left = max(0, index - hangover)
        right = min(len(active), index + hangover + 1)
        active[left:right] = True

    regions: list[tuple[int, int]] = []
    start_index: int | None = None
    for index, is_active in enumerate(active):
        if is_active and start_index is None:
            start_index = index
        if not is_active and start_index is not None:
            regions.append((start_index * frame, min(pcm.size, index * frame)))
            start_index = None
    if start_index is not None:
        regions.append((start_index * frame, pcm.size))

    minimum = int(sample_rate * DIARIZATION_MIN_REGION_MS / 1000)
    return [(start, end) for start, end in regions if end - start >= minimum]


def normalize_separated_sources(value: np.ndarray) -> list[np.ndarray]:
    array = np.asarray(value)
    while array.ndim > 2 and array.shape[0] == 1:
        array = array[0]
    if array.ndim == 1:
        return [np.ascontiguousarray(array, dtype=np.float32)]
    if array.ndim != 2:
        return []
    if array.shape[0] > array.shape[1] and array.shape[1] <= 8:
        array = array.T
    sources: list[np.ndarray] = []
    for source in array:
        source = np.asarray(source, dtype=np.float32).reshape(-1)
        peak = float(np.max(np.abs(source))) if source.size else 0.0
        if peak > 1.0:
            source = source / peak
        sources.append(np.ascontiguousarray(source))
    return sources


def heuristic_environment(pcm: np.ndarray) -> dict[str, Any]:
    level = rms(pcm)
    dbfs = 20.0 * np.log10(max(level, 1e-8))
    if dbfs < -55:
        noise_level = "quiet"
    elif dbfs < -42:
        noise_level = "low"
    elif dbfs < -28:
        noise_level = "medium"
    elif dbfs < -16:
        noise_level = "high"
    else:
        noise_level = "very_high"
    events: list[dict[str, Any]] = []
    if dbfs > -10:
        events.append({"type": "Loud sound", "confidence": min(1.0, (dbfs + 16) / 12)})
    return {
        "scene": "quiet_indoor" if noise_level in {"quiet", "low"} else "unknown",
        "scene_confidence": 0.45 if noise_level in {"quiet", "low"} else 0.2,
        "noise_level": noise_level,
        "events": events,
    }


def infer_scene(events: list[dict[str, Any]]) -> tuple[str | None, float]:
    groups = {
        "traffic": ("Vehicle", "Traffic", "Car", "Motorcycle", "Siren", "Horn"),
        "crowd": ("Crowd", "Conversation", "Speech", "Babble"),
        "music": ("Music", "Singing", "Musical instrument"),
        "office": ("Typing", "Keyboard", "Printer", "Computer"),
        "construction": ("Drill", "Jackhammer", "Sawing", "Tools", "Construction"),
        "home": ("Domestic", "Dishes", "Vacuum", "Door", "Water"),
    }
    best_scene: str | None = None
    best_score = 0.0
    for event in events:
        label = str(event.get("type", ""))
        score = float(event.get("confidence", 0.0))
        for scene, keywords in groups.items():
            if any(keyword.lower() in label.lower() for keyword in keywords) and score > best_score:
                best_scene = scene
                best_score = score
    return best_scene, best_score


def estimate_proximity(pcm: np.ndarray) -> str:
    level = rms(pcm)
    dbfs = 20.0 * np.log10(max(level, 1e-8))
    if dbfs >= -9:
        return "very_near"
    if dbfs >= -17:
        return "near"
    if dbfs >= -27:
        return "medium"
    if dbfs >= -40:
        return "far"
    return "background"


def estimate_quality(pcm: np.ndarray, duration_ms: float) -> float:
    if pcm.size == 0:
        return 0.0
    level = rms(pcm)
    dbfs = 20.0 * np.log10(max(level, 1e-8))
    if dbfs < -55:
        energy_score = 0.15
    elif dbfs < -40:
        energy_score = 0.55
    elif dbfs <= -10:
        energy_score = 1.0
    else:
        energy_score = 0.7
    clipping_ratio = float(np.mean(np.abs(pcm) >= 0.985))
    clipping_score = max(0.0, 1.0 - clipping_ratio * 8.0)
    duration_score = min(1.0, duration_ms / 2500.0)
    quality = duration_score * 0.45 + energy_score * 0.4 + clipping_score * 0.15
    return float(max(0.0, min(1.0, quality)))


def normalize_language(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.lower().replace("_", "-")
    aliases = {
        "zh-cn": "zh",
        "zh-tw": "zh",
        "chinese": "zh",
        "en-us": "en",
        "en-gb": "en",
        "english": "en",
    }
    return aliases.get(normalized, normalized.split("-")[0])


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    if a.size == 0 or a.shape != b.shape:
        return 0.0
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 0:
        return 0.0
    return float(np.dot(a, b) / denominator)


def normalize_vector(value: np.ndarray) -> np.ndarray:
    norm = float(np.linalg.norm(value))
    return value / norm if norm > 0 else value


def rms(value: np.ndarray) -> float:
    if value.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(value), dtype=np.float64) + 1e-12))
