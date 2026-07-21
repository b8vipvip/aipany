package cn.mv3.aipany

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

class RealtimeClient(
    private val onState: (String) -> Unit,
    private val onEvent: (JSONObject) -> Unit,
    private val onAudio: (ByteArray) -> Unit,
    private val onDisconnected: (DisconnectInfo) -> Unit = {},
) {
    data class DisconnectInfo(
        val code: Int?,
        val reason: String,
        val failure: String?,
        val wasConnected: Boolean,
    )

    private val httpClient = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private val heartbeatExecutor = Executors.newSingleThreadScheduledExecutor()
    private val connectionGeneration = AtomicLong(0)

    @Volatile private var socket: WebSocket? = null
    @Volatile private var connected = false
    @Volatile private var lastPongAt = 0L
    @Volatile private var lastPingTimestamp = 0L

    init {
        heartbeatExecutor.scheduleAtFixedRate({ heartbeatTick() }, 8, 8, TimeUnit.SECONDS)
    }

    fun connect(
        serverUrl: String,
        token: String,
        tenantId: String,
        userId: String,
        deviceId: String,
        settings: AppSettings,
    ) {
        closeSilently()
        val generation = connectionGeneration.incrementAndGet()
        val url = normalizeWebSocketUrl(serverUrl)
        val requestBuilder = Request.Builder().url(url)
        if (token.isNotBlank()) requestBuilder.header("Authorization", "Bearer ${token.trim()}")

        onState("正在连接 Aipany")
        socket = httpClient.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (generation != connectionGeneration.get()) {
                    webSocket.close(1000, "stale connection")
                    return
                }
                connected = true
                lastPongAt = System.currentTimeMillis()
                onState("安全连接已建立，正在启动实时语音")
                webSocket.send(
                    JSONObject()
                        .put("type", "session.start")
                        .put(
                            "session",
                            JSONObject()
                                .put("tenantId", tenantId)
                                .put("userId", userId)
                                .put("agentId", "default-agent")
                                .put("locale", "zh-CN")
                                .put("assistantAliases", JSONArray(settings.aliases()))
                                .put("interactionMode", settings.interactionMode)
                                .put("socialProactivity", settings.socialProactivity.toDouble())
                                .put("outputVoice", settings.voiceId)
                                .put(
                                    "inputAudio",
                                    JSONObject()
                                        .put("encoding", "pcm_s16le")
                                        .put("sampleRate", AudioEngine.INPUT_SAMPLE_RATE)
                                        .put("channels", 1),
                                )
                                .put(
                                    "device",
                                    JSONObject()
                                        .put("deviceId", deviceId)
                                        .put("productId", "aipany-android-v1")
                                        .put("deviceType", "mobile")
                                        .put("platform", "android")
                                        .put("appVersion", BuildConfig.VERSION_NAME),
                                ),
                        )
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != connectionGeneration.get()) return
                try {
                    val event = JSONObject(text)
                    if (event.optString("type") == "pong") {
                        val timestamp = event.optLong("timestamp", 0L)
                        val now = System.currentTimeMillis()
                        lastPongAt = now
                        if (timestamp > 0L && timestamp <= now) {
                            val rtt = (now - timestamp).coerceAtMost(600_000)
                            sendTelemetry("heartbeat_rtt", rtt.toDouble())
                        }
                    }
                    onEvent(event)
                } catch (error: Exception) {
                    onState("收到无法解析的服务端消息：${error.message}")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (generation != connectionGeneration.get()) return
                onAudio(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                if (generation != connectionGeneration.get()) return
                connected = false
                onState("连接正在关闭：$code ${reason.ifBlank { "无原因" }}")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (generation != connectionGeneration.get()) return
                val wasConnected = connected
                connected = false
                socket = null
                onState("连接已断开：$code ${reason.ifBlank { "无原因" }}")
                onDisconnected(DisconnectInfo(code, reason, null, wasConnected))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (generation != connectionGeneration.get()) return
                val wasConnected = connected
                connected = false
                socket = null
                val detail = response?.let { " HTTP ${it.code}" }.orEmpty()
                val message = "${t.message ?: t.javaClass.simpleName}$detail"
                onState("连接失败：$message")
                onDisconnected(DisconnectInfo(response?.code, response?.message.orEmpty(), message, wasConnected))
            }
        })
    }

    fun sendPcm(audio: ByteArray): Boolean {
        if (!connected || audio.isEmpty()) return false
        return socket?.send(ByteString.of(*audio)) == true
    }

    fun commitAudio(): Boolean = sendControl("input_audio_buffer.commit")

    fun cancelResponse(): Boolean = sendControl("response.cancel")

    fun setInteractionMode(mode: String): Boolean {
        if (!connected) return false
        return socket?.send(JSONObject().put("type", "mode.set").put("mode", mode).toString()) == true
    }

    fun sendTelemetry(
        name: String,
        valueMs: Double? = null,
        details: Map<String, Any> = emptyMap(),
    ): Boolean {
        if (!connected) return false
        val payload = JSONObject().put("type", "client.telemetry").put("name", name)
        if (valueMs != null) payload.put("valueMs", valueMs)
        if (details.isNotEmpty()) payload.put("details", JSONObject(details))
        return socket?.send(payload.toString()) == true
    }

    fun finishSession(): Boolean = sendControl("session.finish")

    fun close() {
        closeSilently(sendFinish = true)
    }

    fun release() {
        closeSilently(sendFinish = true)
        heartbeatExecutor.shutdownNow()
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()
    }

    private fun heartbeatTick() {
        if (!connected) return
        val now = System.currentTimeMillis()
        if (lastPongAt > 0L && now - lastPongAt > 45_000L) {
            // OkHttp's protocol ping and the application heartbeat have both gone
            // stale. Cancel the socket so MainActivity can enter its reconnect loop.
            socket?.cancel()
            return
        }
        lastPingTimestamp = now
        socket?.send(JSONObject().put("type", "ping").put("timestamp", now).toString())
    }

    private fun closeSilently(sendFinish: Boolean = false) {
        connectionGeneration.incrementAndGet()
        connected = false
        val current = socket
        socket = null
        current?.let {
            if (sendFinish) runCatching { it.send(JSONObject().put("type", "session.finish").toString()) }
            runCatching { it.close(1000, "client close") }
        }
    }

    private fun sendControl(type: String): Boolean {
        if (!connected) return false
        return socket?.send(JSONObject().put("type", type).toString()) == true
    }

    companion object {
        fun normalizeWebSocketUrl(input: String): String {
            var value = input.trim().trimEnd('/')
            value = when {
                value.startsWith("https://", ignoreCase = true) -> "wss://${value.substring(8)}"
                value.startsWith("http://", ignoreCase = true) -> "ws://${value.substring(7)}"
                value.startsWith("wss://", ignoreCase = true) || value.startsWith("ws://", ignoreCase = true) -> value
                else -> "wss://$value"
            }
            if (!value.endsWith("/v1/realtime")) value += "/v1/realtime"
            return value
        }
    }
}
