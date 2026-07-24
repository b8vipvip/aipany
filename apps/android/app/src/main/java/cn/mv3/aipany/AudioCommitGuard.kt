package cn.mv3.aipany

/**
 * Prevents duplicate local endpoint commits while the previous utterance is
 * still waiting for an ASR result. A stale pending commit is released after a
 * bounded timeout so a transient upstream failure cannot block the microphone.
 */
class AudioCommitGuard(
    private val minimumCommitIntervalMs: Long = 500L,
    private val transcriptTimeoutMs: Long = 4_000L,
) {
    enum class SuppressionReason(val wireValue: String) {
        AWAITING_TRANSCRIPT("awaiting_transcript"),
        COMMIT_COOLDOWN("commit_cooldown"),
    }

    data class Decision(
        val allowed: Boolean,
        val reason: SuppressionReason? = null,
    )

    private var awaitingTranscript = false
    private var awaitingSinceMs = 0L
    private var lastCommitAtMs = Long.MIN_VALUE

    @Synchronized
    fun tryCommit(nowMs: Long): Decision {
        if (awaitingTranscript) {
            val ageMs = nowMs - awaitingSinceMs
            if (ageMs in 0 until transcriptTimeoutMs) {
                return Decision(false, SuppressionReason.AWAITING_TRANSCRIPT)
            }
            awaitingTranscript = false
            awaitingSinceMs = 0L
        }

        if (lastCommitAtMs != Long.MIN_VALUE && nowMs - lastCommitAtMs < minimumCommitIntervalMs) {
            return Decision(false, SuppressionReason.COMMIT_COOLDOWN)
        }

        lastCommitAtMs = nowMs
        awaitingTranscript = true
        awaitingSinceMs = nowMs
        return Decision(true)
    }

    @Synchronized
    fun resolveTranscript() {
        awaitingTranscript = false
        awaitingSinceMs = 0L
    }

    @Synchronized
    fun reset() {
        awaitingTranscript = false
        awaitingSinceMs = 0L
        lastCommitAtMs = Long.MIN_VALUE
    }
}
