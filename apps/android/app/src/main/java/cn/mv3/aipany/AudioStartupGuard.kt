package cn.mv3.aipany

/**
 * Guards asynchronous microphone/audio-device initialization across reconnects,
 * activity lifecycle changes and slow vendor audio drivers.
 */
class AudioStartupGuard(
    private val timeoutMs: Long = 8_000L,
) {
    data class Token(
        val generation: Long,
        val startedAtMs: Long,
    )

    private var generation = 0L
    private var active: Token? = null
    private var readyGeneration: Long? = null
    private var timedOutGeneration: Long? = null

    @Synchronized
    fun begin(nowMs: Long): Token {
        generation += 1
        return Token(generation, nowMs).also {
            active = it
            readyGeneration = null
            timedOutGeneration = null
            LiveDiagnosticsStore.recordAndroidAudio("audio_start_requested", "Android audio startup requested")
        }
    }

    @Synchronized
    fun markReady(token: Token): Boolean {
        if (active?.generation != token.generation) return false
        readyGeneration = token.generation
        active = null
        timedOutGeneration = null
        LiveDiagnosticsStore.recordAndroidAudio("audio_ready", "Android audio ready")
        return true
    }

    @Synchronized
    fun markFailed(token: Token): Boolean {
        if (active?.generation != token.generation) return false
        active = null
        readyGeneration = null
        if (timedOutGeneration != token.generation) {
            LiveDiagnosticsStore.recordAndroidAudio("audio_failed", "Android audio startup failed")
        }
        return true
    }

    @Synchronized
    fun isTimedOut(token: Token, nowMs: Long): Boolean {
        val timedOut = active?.generation == token.generation && nowMs - token.startedAtMs >= timeoutMs
        if (timedOut && timedOutGeneration != token.generation) {
            timedOutGeneration = token.generation
            LiveDiagnosticsStore.recordAndroidAudio("audio_timeout", "Android audio startup exceeded ${timeoutMs} ms")
        }
        return timedOut
    }

    @Synchronized
    fun invalidate() {
        generation += 1
        active = null
        readyGeneration = null
        timedOutGeneration = null
    }

    @Synchronized
    fun isReady(): Boolean = readyGeneration != null

    @Synchronized
    fun isCurrent(token: Token): Boolean = active?.generation == token.generation
}
