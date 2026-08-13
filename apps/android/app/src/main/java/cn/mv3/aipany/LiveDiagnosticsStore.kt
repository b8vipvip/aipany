package cn.mv3.aipany

import org.json.JSONObject

data class LiveDiagnosticEvent(
    val timestampMs: Long,
    val source: String,
    val state: String,
    val detail: String,
    val attempt: Int = 0,
    val model: String = "",
)

data class LiveLatencySnapshot(
    val endpointToAsrMs: Long = -1L,
    val asrToLlmMs: Long = -1L,
    val llmToAudioMs: Long = -1L,
    val totalFirstResponseMs: Long = -1L,
    val updatedAtMs: Long = 0L,
)

data class LiveDiagnosticsSnapshot(
    val gatewayState: String,
    val upstreamState: String,
    val upstreamDetail: String,
    val model: String,
    val recoveryAttempt: Int,
    val lastReadyAtMs: Long,
    val lastError: String,
    val androidAudioState: String,
    val androidAudioDetail: String,
    val lastAudioReadyAtMs: Long,
    val lastAudioError: String,
    val latency: LiveLatencySnapshot,
    val updatedAtMs: Long,
    val events: List<LiveDiagnosticEvent>,
)

object LiveDiagnosticsStore {
    private const val MAX_EVENTS = 48
    private val lock = Any()
    private val events = ArrayDeque<LiveDiagnosticEvent>()
    private var gatewayState = "尚未连接"
    private var upstreamState = "unknown"
    private var upstreamDetail = ""
    private var model = ""
    private var recoveryAttempt = 0
    private var lastReadyAtMs = 0L
    private var lastError = ""
    private var androidAudioState = "unknown"
    private var androidAudioDetail = ""
    private var lastAudioReadyAtMs = 0L
    private var lastAudioError = ""
    private var latency = LiveLatencySnapshot()
    private var updatedAtMs = 0L

    fun recordGateway(message: String, nowMs: Long = System.currentTimeMillis()) {
        val clean = message.trim().take(240)
        if (clean.isBlank()) return
        synchronized(lock) {
            gatewayState = clean
            updatedAtMs = nowMs
            appendLocked(
                LiveDiagnosticEvent(
                    timestampMs = nowMs,
                    source = "gateway",
                    state = classifyGateway(clean),
                    detail = clean,
                ),
            )
            if (clean.startsWith("连接失败") || clean == "连接已断开" || clean.startsWith("Bootstrap 失败")) {
                lastError = clean
            }
        }
    }

    fun recordUpstream(
        state: String,
        detail: String = "",
        attempt: Int = 0,
        model: String = "",
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val cleanState = state.trim().ifBlank { "unknown" }.take(64)
        val cleanDetail = detail.trim().take(320)
        synchronized(lock) {
            upstreamState = cleanState
            upstreamDetail = cleanDetail
            if (model.isNotBlank()) this.model = model.trim().take(120)
            if (attempt > 0) recoveryAttempt = attempt
            if (cleanState == "ready") {
                lastReadyAtMs = nowMs
                recoveryAttempt = 0
            }
            if (cleanState == "degraded" || cleanState == "unavailable") {
                lastError = cleanDetail.ifBlank { cleanState }
            }
            updatedAtMs = nowMs
            appendLocked(
                LiveDiagnosticEvent(
                    timestampMs = nowMs,
                    source = "upstream",
                    state = cleanState,
                    detail = cleanDetail,
                    attempt = attempt,
                    model = this.model,
                ),
            )
        }
    }

    fun recordUpstream(event: JSONObject, nowMs: Long = System.currentTimeMillis()) {
        if (event.optString("provider") != "chat2api_live") return
        recordUpstream(
            state = event.optString("state"),
            detail = event.optString("detail"),
            attempt = event.optInt("attempt", 0),
            model = event.optString("model"),
            nowMs = nowMs,
        )
    }

    fun recordAndroidAudio(
        state: String,
        detail: String = "",
        nowMs: Long = System.currentTimeMillis(),
    ) {
        val cleanState = state.trim().ifBlank { "unknown" }.take(64)
        val cleanDetail = detail.trim().take(240)
        synchronized(lock) {
            androidAudioState = cleanState
            androidAudioDetail = cleanDetail
            if (cleanState == "audio_ready") {
                lastAudioReadyAtMs = nowMs
                lastAudioError = ""
            } else if (cleanState == "audio_timeout" || cleanState == "audio_failed") {
                lastAudioError = cleanDetail.ifBlank { cleanState }
            }
            updatedAtMs = nowMs
            appendLocked(
                LiveDiagnosticEvent(
                    timestampMs = nowMs,
                    source = "android_audio",
                    state = cleanState,
                    detail = cleanDetail,
                    model = model,
                ),
            )
        }
    }

    fun recordLatency(
        endpointToAsrMs: Long,
        asrToLlmMs: Long,
        llmToAudioMs: Long,
        totalFirstResponseMs: Long,
        nowMs: Long = System.currentTimeMillis(),
    ) {
        synchronized(lock) {
            latency = LiveLatencySnapshot(
                endpointToAsrMs = endpointToAsrMs,
                asrToLlmMs = asrToLlmMs,
                llmToAudioMs = llmToAudioMs,
                totalFirstResponseMs = totalFirstResponseMs,
                updatedAtMs = nowMs,
            )
            updatedAtMs = nowMs
        }
    }

    fun snapshot(): LiveDiagnosticsSnapshot = synchronized(lock) {
        LiveDiagnosticsSnapshot(
            gatewayState = gatewayState,
            upstreamState = upstreamState,
            upstreamDetail = upstreamDetail,
            model = model,
            recoveryAttempt = recoveryAttempt,
            lastReadyAtMs = lastReadyAtMs,
            lastError = lastError,
            androidAudioState = androidAudioState,
            androidAudioDetail = androidAudioDetail,
            lastAudioReadyAtMs = lastAudioReadyAtMs,
            lastAudioError = lastAudioError,
            latency = latency,
            updatedAtMs = updatedAtMs,
            events = events.toList(),
        )
    }

    fun clear() = synchronized(lock) {
        events.clear()
        gatewayState = "尚未连接"
        upstreamState = "unknown"
        upstreamDetail = ""
        model = ""
        recoveryAttempt = 0
        lastReadyAtMs = 0L
        lastError = ""
        androidAudioState = "unknown"
        androidAudioDetail = ""
        lastAudioReadyAtMs = 0L
        lastAudioError = ""
        latency = LiveLatencySnapshot()
        updatedAtMs = 0L
    }

    private fun appendLocked(event: LiveDiagnosticEvent) {
        val previous = events.lastOrNull()
        val duplicate = previous != null &&
            previous.source == event.source &&
            previous.state == event.state &&
            previous.detail == event.detail &&
            previous.attempt == event.attempt
        if (!duplicate) events.addLast(event)
        while (events.size > MAX_EVENTS) events.removeFirst()
    }

    private fun classifyGateway(message: String): String = when {
        message.startsWith("连接失败") || message.startsWith("Bootstrap 失败") -> "failed"
        message == "连接已断开" -> "closed"
        message.contains("安全连接") -> "connected"
        message.contains("自动重连") -> "reconnecting"
        message.contains("正在连接") -> "connecting"
        else -> "state"
    }
}
