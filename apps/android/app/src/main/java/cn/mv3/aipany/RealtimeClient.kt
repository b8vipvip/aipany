package cn.mv3.aipany

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class RealtimeClient(
    private val onState: (String) -> Unit,
    private val onEvent: (JSONObject) -> Unit,
    private val onAudio: (ByteArray) -> Unit,
) {
    private val httpClient = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .build()

    @Volatile private var socket: WebSocket? = null
    @Volatile private var connected = false

    fun connect(
        serverUrl: String,
        token: String,
        tenantId: String,
        userId: String,
        deviceId: String,
    ) {
        close()
        val url = normalizeWebSocketUrl(serverUrl)
        val requestBuilder = Request.Builder().url(url)
        if (token.isNotBlank()) {
            requestBuilder.header("Authorization", "Bearer ${token.trim()}")
        }

        onState("正在连接 $url")
        socket = httpClient.newWebSocket(requestBuilder.build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                onState("WebSocket 已连接，正在创建会话")
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
                                .put("assistantAliases", JSONArray(listOf("Aipany", "小派")))
                                .put("interactionMode", "auto")
                                .put("socialProactivity", 0.45)
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
                                        .put("appVersion", "0.1.0"),
                                ),
                        )
                        .toString(),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    onEvent(JSONObject(text))
                } catch (error: Exception) {
                    onState("收到无法解析的服务端消息：${error.message}")
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                onAudio(bytes.toByteArray())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                connected = false
                onState("连接正在关闭：$code $reason")
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                connected = false
                onState("连接已关闭：$code $reason")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected = false
                val detail = response?.let { " HTTP ${it.code}" }.orEmpty()
                onState("连接失败：${t.message ?: t.javaClass.simpleName}$detail")
            }
        })
    }

    fun sendPcm(audio: ByteArray): Boolean {
        if (!connected || audio.isEmpty()) return false
        return socket?.send(ByteString.of(*audio)) == true
    }

    fun commitAudio(): Boolean = sendControl("input_audio_buffer.commit")

    fun cancelResponse(): Boolean = sendControl("response.cancel")

    fun finishSession(): Boolean = sendControl("session.finish")

    fun close() {
        connected = false
        socket?.let { current ->
            try {
                current.send(JSONObject().put("type", "session.finish").toString())
            } catch (_: Exception) {
            }
            current.close(1000, "client close")
        }
        socket = null
    }

    fun release() {
        close()
        httpClient.dispatcher.executorService.shutdown()
        httpClient.connectionPool.evictAll()
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
