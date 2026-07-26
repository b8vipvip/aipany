package cn.mv3.aipany

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AudioStartupGuardTest {
    @Test
    fun staleCompletionCannotReplaceNewStartup() {
        val guard = AudioStartupGuard(timeoutMs = 8_000)
        val first = guard.begin(1_000)
        val second = guard.begin(1_500)

        assertFalse(guard.markReady(first))
        assertTrue(guard.isCurrent(second))
        assertTrue(guard.markReady(second))
        assertTrue(guard.isReady())
    }

    @Test
    fun timeoutAppliesOnlyToCurrentGeneration() {
        val guard = AudioStartupGuard(timeoutMs = 8_000)
        val first = guard.begin(1_000)
        assertFalse(guard.isTimedOut(first, 8_999))
        assertTrue(guard.isTimedOut(first, 9_000))

        val second = guard.begin(9_100)
        assertFalse(guard.isTimedOut(first, 20_000))
        assertFalse(guard.isTimedOut(second, 12_000))
    }

    @Test
    fun invalidationRejectsLateDriverCompletion() {
        val guard = AudioStartupGuard()
        val token = guard.begin(2_000)
        guard.invalidate()

        assertFalse(guard.isCurrent(token))
        assertFalse(guard.markReady(token))
        assertFalse(guard.isReady())
    }
}
