from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel
from speechbrain.inference.speaker import EncoderClassifier


MODEL_SOURCE = os.getenv("SPEAKER_MODEL_SOURCE", "speechbrain/spkrec-ecapa-voxceleb")
MODEL_CACHE_DIR = os.getenv("SPEAKER_MODEL_CACHE_DIR", "/models/speechbrain/spkrec-ecapa-voxceleb")
SERVICE_TOKEN = os.getenv("SPEAKER_SERVICE_TOKEN", "")
DEVICE = os.getenv("SPEAKER_DEVICE", "cpu")
MIN_AUDIO_MS = int(os.getenv("SPEAKER_SERVICE_MIN_AUDIO_MS", "500"))
EXPECTED_SAMPLE_RATE = 16000


class EmbeddingResponse(BaseModel):
    embedding: list[float]
    quality: float
    duration_ms: float
    model: str
    dimensions: int


class SpeakerEngine:
    def __init__(self) -> None:
        self.classifier: EncoderClassifier | None = None

    def load(self) -> None:
        self.classifier = EncoderClassifier.from_hparams(
            source=MODEL_SOURCE,
            savedir=MODEL_CACHE_DIR,
            run_opts={"device": DEVICE},
        )

    def embed_pcm_s16le(self, raw: bytes, sample_rate: int, channels: int) -> EmbeddingResponse:
        if self.classifier is None:
            raise RuntimeError("speaker model is not loaded")
        if sample_rate != EXPECTED_SAMPLE_RATE:
            raise ValueError(f"v0.2 provider currently requires {EXPECTED_SAMPLE_RATE} Hz PCM")
        if channels < 1:
            raise ValueError("channels must be >= 1")
        if len(raw) % (2 * channels) != 0:
            raise ValueError("invalid pcm_s16le byte length")

        pcm = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        if channels > 1:
            pcm = pcm.reshape(-1, channels).mean(axis=1)

        duration_ms = float(len(pcm) / sample_rate * 1000)
        if duration_ms < MIN_AUDIO_MS:
            raise ValueError(f"audio too short: {duration_ms:.0f} ms, need >= {MIN_AUDIO_MS} ms")

        waveform = torch.from_numpy(pcm).unsqueeze(0).to(DEVICE)
        with torch.inference_mode():
            embedding = self.classifier.encode_batch(waveform).squeeze().detach().cpu().numpy().astype(np.float32)

        norm = float(np.linalg.norm(embedding))
        if norm > 0:
            embedding = embedding / norm

        return EmbeddingResponse(
            embedding=embedding.tolist(),
            quality=estimate_quality(pcm, duration_ms),
            duration_ms=duration_ms,
            model=MODEL_SOURCE,
            dimensions=int(embedding.size),
        )


engine = SpeakerEngine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    engine.load()
    yield


app = FastAPI(
    title="Aipany Speaker Intelligence",
    version="0.2.1",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": engine.classifier is not None,
        "service": "aipany-speaker-intelligence",
        "model": MODEL_SOURCE,
        "device": DEVICE,
    }


@app.get("/v1/capabilities")
def capabilities(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    authorize(authorization)
    return {
        "embeddings": True,
        "verification": True,
        "diarization": False,
        "streamingDiarization": False,
        "targetSpeakerExtraction": False,
    }


@app.post("/v1/embedding", response_model=EmbeddingResponse)
async def embedding(
    request: Request,
    encoding: str = Query(default="pcm_s16le"),
    sample_rate: int = Query(default=16000, ge=8000, le=192000),
    channels: int = Query(default=1, ge=1, le=8),
    authorization: str | None = Header(default=None),
) -> EmbeddingResponse:
    authorize(authorization)
    if encoding != "pcm_s16le":
        raise HTTPException(status_code=400, detail="only pcm_s16le is supported in v0.2.1")

    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio body")

    try:
        return engine.embed_pcm_s16le(raw, sample_rate, channels)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"speaker embedding failed: {exc}") from exc


def authorize(authorization: str | None) -> None:
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def estimate_quality(pcm: np.ndarray, duration_ms: float) -> float:
    """轻量样本质量评分，不替代独立 SNR/噪声模型。"""
    if pcm.size == 0:
        return 0.0

    rms = float(np.sqrt(np.mean(np.square(pcm), dtype=np.float64) + 1e-12))
    dbfs = 20.0 * np.log10(max(rms, 1e-8))
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
