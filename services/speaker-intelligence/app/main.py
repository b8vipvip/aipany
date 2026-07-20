from __future__ import annotations

import base64
import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Query, Request
from pydantic import BaseModel

from .audio_engine import (
    DEVICE,
    MODEL_SOURCE,
    AudioIntelligenceEngine,
)


SERVICE_TOKEN = os.getenv("SPEAKER_SERVICE_TOKEN", "")
ENABLE_DIARIZATION = env_bool("DIARIZATION_ENABLED", True)
ENABLE_SEPARATION = env_bool("SPEECH_SEPARATION_ENABLED", True)
ENABLE_TARGET_SPEAKER = env_bool("TARGET_SPEAKER_EXTRACTION_ENABLED", True)
ENABLE_ENVIRONMENT = env_bool("ENVIRONMENT_INTELLIGENCE_ENABLED", True)
ENABLE_TRANSCRIPTION = env_bool("SEGMENT_TRANSCRIPTION_ENABLED", True)


class EmbeddingResponse(BaseModel):
    embedding: list[float]
    quality: float
    duration_ms: float
    model: str
    dimensions: int


engine = AudioIntelligenceEngine()


@asynccontextmanager
async def lifespan(_: FastAPI):
    engine.load()
    yield


app = FastAPI(
    title="Aipany Audio Intelligence",
    version="0.3.0",
    lifespan=lifespan,
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": engine.classifier is not None,
        "service": "aipany-audio-intelligence",
        "model": MODEL_SOURCE,
        "device": DEVICE,
        "components": {
            "speaker_embedding": engine.classifier is not None,
            "separation_loaded": engine.separator is not None,
            "transcription_loaded": engine.whisper is not None,
            "environment_loaded": engine.environment_model is not None,
        },
        "component_errors": engine.component_errors,
    }


@app.get("/v1/capabilities")
def capabilities(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    authorize(authorization)
    return {
        "embeddings": True,
        "verification": True,
        "diarization": ENABLE_DIARIZATION,
        "streamingDiarization": ENABLE_DIARIZATION,
        "overlapDetection": ENABLE_SEPARATION,
        "speechSeparation": ENABLE_SEPARATION,
        "targetSpeakerExtraction": ENABLE_TARGET_SPEAKER and ENABLE_SEPARATION,
        "environmentAnalysis": ENABLE_ENVIRONMENT,
        "segmentTranscription": ENABLE_TRANSCRIPTION,
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
    ensure_pcm_encoding(encoding)
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio body")
    try:
        return EmbeddingResponse(**engine.embed_pcm_s16le(raw, sample_rate, channels))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"speaker embedding failed: {exc}") from exc


@app.post("/v1/analyze")
async def analyze(
    request: Request,
    encoding: str = Query(default="pcm_s16le"),
    sample_rate: int = Query(default=16000, ge=8000, le=192000),
    channels: int = Query(default=1, ge=1, le=8),
    authorization: str | None = Header(default=None),
    x_aipany_session_id: str | None = Header(default=None),
    x_aipany_mode: str | None = Header(default=None),
    x_aipany_language: str | None = Header(default=None),
    x_aipany_include_transcript: str | None = Header(default=None),
    x_aipany_enable_separation: str | None = Header(default=None),
    x_aipany_enable_environment: str | None = Header(default=None),
    x_aipany_owner_embedding: str | None = Header(default=None),
) -> dict[str, Any]:
    authorize(authorization)
    ensure_pcm_encoding(encoding)
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio body")

    owner_embedding = decode_owner_embedding(x_aipany_owner_embedding)
    include_transcript = ENABLE_TRANSCRIPTION and parse_bool(x_aipany_include_transcript, True)
    enable_separation = ENABLE_SEPARATION and parse_bool(x_aipany_enable_separation, True)
    enable_environment = ENABLE_ENVIRONMENT and parse_bool(x_aipany_enable_environment, True)
    if x_aipany_mode == "owner_focus" and owner_embedding and ENABLE_TARGET_SPEAKER:
        enable_separation = ENABLE_SEPARATION

    try:
        result = engine.analyze_pcm_s16le(
            raw,
            sample_rate,
            channels,
            owner_embedding=owner_embedding if ENABLE_TARGET_SPEAKER else None,
            include_transcript=include_transcript,
            enable_separation=enable_separation,
            enable_environment=enable_environment,
            language=x_aipany_language,
            session_id=x_aipany_session_id,
        )
        if not ENABLE_DIARIZATION:
            result["diarization"] = []
        return result
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"audio analysis failed: {exc}") from exc


def authorize(authorization: str | None) -> None:
    if not SERVICE_TOKEN:
        return
    if authorization != f"Bearer {SERVICE_TOKEN}":
        raise HTTPException(status_code=401, detail="unauthorized")


def ensure_pcm_encoding(encoding: str) -> None:
    if encoding != "pcm_s16le":
        raise HTTPException(status_code=400, detail="only pcm_s16le is currently supported")


def parse_bool(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def decode_owner_embedding(value: str | None) -> list[float] | None:
    if not value:
        return None
    try:
        padding = "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(value + padding).decode("utf-8")
        payload = json.loads(decoded)
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError("invalid owner embedding")
        embedding = [float(item) for item in payload]
        if not all(item == item and abs(item) != float("inf") for item in embedding):
            raise ValueError("owner embedding contains non-finite values")
        return embedding
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"invalid X-Aipany-Owner-Embedding: {exc}") from exc


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}
