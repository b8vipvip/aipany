package cn.mv3.aipany

/**
 * Process-local diagnostics-only timing tracker. It observes the same control
 * milestones already used by the realtime client and never affects whether a
 * frame/event is accepted or sent.
 */
object LiveLatencyTracker {
    private val lock = Any()
    private var endpointAtMs = 0L
    private var transcriptAtMs = 0L
    private var responseAtMs = 0L

    fun endpoint(nowMs: Long = System.currentTimeMillis()) = synchronized(lock) {
        endpointAtMs = nowMs
        transcriptAtMs = 0L
        responseAtMs = 0L
    }

    fun transcript(nowMs: Long = System.currentTimeMillis()) = synchronized(lock) {
        if (endpointAtMs <= 0L || nowMs < endpointAtMs) return@synchronized
        if (transcriptAtMs <= 0L) transcriptAtMs = nowMs
    }

    fun responseCreated(nowMs: Long = System.currentTimeMillis()) = synchronized(lock) {
        if (endpointAtMs <= 0L || nowMs < endpointAtMs) return@synchronized
        if (responseAtMs <= 0L) responseAtMs = nowMs
    }

    fun audioStarted(nowMs: Long = System.currentTimeMillis()) = synchronized(lock) {
        val endpoint = endpointAtMs
        if (endpoint <= 0L || nowMs < endpoint) return@synchronized
        val transcript = transcriptAtMs
        val response = responseAtMs
        LiveDiagnosticsStore.recordLatency(
            endpointToAsrMs = delta(endpoint, transcript),
            asrToLlmMs = delta(transcript, response),
            llmToAudioMs = delta(response, nowMs),
            totalFirstResponseMs = nowMs - endpoint,
            nowMs = nowMs,
        )
    }

    fun reset() = synchronized(lock) {
        endpointAtMs = 0L
        transcriptAtMs = 0L
        responseAtMs = 0L
    }

    private fun delta(from: Long, to: Long): Long = if (from > 0L && to >= from) to - from else -1L
}
