package cn.mv3.aipany

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioCommitGuardTest {
    @Test
    fun suppressesDuplicateCommitUntilTranscriptResolves() {
        val guard = AudioCommitGuard(minimumCommitIntervalMs = 500, transcriptTimeoutMs = 4_000)

        assertTrue(guard.tryCommit(1_000).allowed)
        val duplicate = guard.tryCommit(1_400)
        assertFalse(duplicate.allowed)
        assertEquals(AudioCommitGuard.SuppressionReason.AWAITING_TRANSCRIPT, duplicate.reason)

        guard.resolveTranscript()
        assertTrue(guard.tryCommit(1_600).allowed)
    }

    @Test
    fun releasesStalePendingCommitAfterTimeout() {
        val guard = AudioCommitGuard(minimumCommitIntervalMs = 500, transcriptTimeoutMs = 4_000)

        assertTrue(guard.tryCommit(1_000).allowed)
        assertTrue(guard.tryCommit(5_100).allowed)
    }

    @Test
    fun resetClearsCooldownAndPendingState() {
        val guard = AudioCommitGuard(minimumCommitIntervalMs = 500, transcriptTimeoutMs = 4_000)

        assertTrue(guard.tryCommit(1_000).allowed)
        guard.reset()
        assertTrue(guard.tryCommit(1_100).allowed)
    }
}
