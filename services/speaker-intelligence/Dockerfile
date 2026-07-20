FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/models/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends libsndfile1 libgomp1 ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY services/speaker-intelligence/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY services/speaker-intelligence/app ./app

EXPOSE 3200

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "3200"]
