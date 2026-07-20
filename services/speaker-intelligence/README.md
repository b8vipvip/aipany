# Aipany Speaker Intelligence

这是 Aipany 的第一版真实声纹 Provider 服务。

当前能力：

- 基于 SpeechBrain ECAPA-TDNN 提取 speaker embedding；
- 输入 `PCM S16LE / 16kHz`；
- 返回归一化声纹向量、样本时长和轻量质量评分；
- 可被 Realtime Gateway 通过内部 HTTP 调用；
- 模型服务与业务层解耦，后续可替换成 NeMo、云 API 或自研模型。

当前暂未提供：

- 多人重叠语音分离；
- Streaming Diarization；
- Target Speaker Extraction；
- 环境声音分类。

这些能力会通过同一个 Speaker Intelligence Provider 边界继续扩展，不会改变上层会话协议。

## API

### `GET /health`

服务和模型健康状态。

### `GET /v1/capabilities`

返回当前 Provider 能力。

### `POST /v1/embedding`

Query：

```text
encoding=pcm_s16le
sample_rate=16000
channels=1
```

Body 为原始 PCM 二进制数据。

响应示例：

```json
{
  "embedding": [0.01, -0.02],
  "quality": 0.91,
  "duration_ms": 2100,
  "model": "speechbrain/spkrec-ecapa-voxceleb",
  "dimensions": 192
}
```

## 模型

默认使用 `speechbrain/spkrec-ecapa-voxceleb`。该模型用于 speaker embedding / verification，Gateway 侧通过余弦相似度完成长期人物 Voice Profile 匹配和会话级未知说话人聚类。

模型第一次启动时会下载到 `/models`，Docker Compose 使用持久卷缓存模型。

## 生产建议

第一版 CPU 可运行，但并发提升后建议将该服务独立部署，并使用 GPU 推理实例。声纹向量属于敏感生物特征数据，生产环境应限制服务网络访问，并对长期 Voice Profile 做加密存储、用户授权和删除机制。
