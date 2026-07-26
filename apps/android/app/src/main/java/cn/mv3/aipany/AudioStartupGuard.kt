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

    @Synchronized
    fun begin(nowMs: Long): Token {
        generation += 1
        return Token(generation, nowMs).also {
            active = it
            readyGeneration = null
        }
    }

    @Synchronized
    fun markReady(token: Token): Boolean {
        if (active?.generation != token.generation) return false
        readyGeneration = token.generation
        active = null
        return true
    }

    @Synchronized
    fun markFailed(token: Token): Boolean {
        if (active?.generation != token.generation) return false
        active = null
        readyGeneration = null
        return true
    }

    @Synchronized
    fun isTimedOut(token: Token, nowMs: Long): Boolean {
        return active?.generation == token.generation && nowMs - token.startedAtMs >= timeoutMs
    }

    @Synchronized
    fun invalidate() {
        generation += 1
        active = null
        readyGeneration = null
    }

    @Synchronized
    fun isReady(): Boolean = readyGeneration != null

    @Synchronized
    fun isCurrent(token: Token): Boolean = active?.generation == token.generation
}
