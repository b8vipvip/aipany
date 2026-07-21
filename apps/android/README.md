# Aipany Android v0.1

第一版 Android 客户端用于验证真实公网实时语音链路：

```text
Android microphone
→ local adaptive endpoint detection
→ input_audio_buffer.commit
→ Aipany WebSocket realtime gateway
→ ASR → LLM Provider Pool → TTS
→ 24 kHz PCM playback
```

## 当前能力

- 16 kHz / mono / PCM16 麦克风实时上行；
- 自适应环境噪声底；
- 20 ms 帧级本地 Endpoint Detection；
- 长语音约 280 ms、普通语音约 320 ms、短语音约 360 ms 静音后自动 commit；
- AI 播放期间提高本地起说阈值，减少扬声器回声误触发；
- 本地检测到用户重新开口时发送 `response.cancel` 并立即清空本地播放缓冲；
- 接收 24 kHz / mono / PCM16 服务端音频并流式播放；
- 显示 ASR、LLM 文本与端到端首响分段时间。

## 第一版鉴权

测试包不会内置任何密钥。启动后手工输入：

- Gateway：默认 `wss://aipany.mv3.cn/v1/realtime`；
- Gateway Token：使用部署服务器现有的 Realtime Gateway Token；
- Tenant ID；
- User ID。

Token 只保留在当前页面内存中，不写入 SharedPreferences，也不会提交到 GitHub。

正式版将改为 App 登录后由服务端签发短期 JWT。

## 本地构建

需要 JDK 17、Android SDK 35 和 Gradle 8.9：

```bash
gradle -p apps/android testDebugUnitTest assembleDebug
```

APK 输出：

```text
apps/android/app/build/outputs/apk/debug/app-debug.apk
```
