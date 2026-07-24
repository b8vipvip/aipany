package cn.mv3.aipany

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Lightweight client-side endpoint detector for 16 kHz / mono / PCM16 audio.
 * The active profile changes only the silence window; speech detection continues
 * to adapt to the local noise floor. During assistant playback it uses a stricter
 * echo-resistant start threshold, while platform AEC removes most speaker leakage.
 *
 * A short energy spike may be loud enough to trigger speech-start, but it is not
 * allowed to produce a commit until at least 260 ms of voiced frames have been
 * observed. This prevents coughs, speaker echo tails and tap noise from creating
 * empty ASR commits.
 */
class EndpointDetector(
    private val onSpeechStarted: () -> Unit,
    private val onEndpointDetected: () -> Unit,
    private val onLevel: (dbfs: Float, noiseFloorDbfs: Float, speaking: Boolean) -> Unit,
) {
    companion object {
        private const val MIN_VOICED_SPEECH_FRAMES = 13 // 260 ms at 20 ms/frame
        private const val POST_ENDPOINT_COOLDOWN_FRAMES = 25 // 500 ms
    }

    @Volatile private var profile: EndpointProfile = EndpointProfile.BALANCED
    private var noiseFloorDbfs = -52f
    private var speaking = false
    private var consecutiveSpeechFrames = 0
    private var silenceFrames = 0
    private var speechFrames = 0
    private var voicedSpeechFrames = 0
    private var cooldownFrames = 0
    private var levelFrames = 0

    fun setProfile(value: EndpointProfile) {
        profile = value
    }

    fun process(samples: ShortArray, count: Int, assistantSpeaking: Boolean) {
        if (count <= 0) return

        var energy = 0.0
        for (index in 0 until count) {
            val value = samples[index].toDouble()
            energy += value * value
        }
        val rms = sqrt(energy / count)
        val dbfs = if (rms < 1.0) -96f else (20.0 * log10(rms / 32768.0)).toFloat()

        if (!speaking) {
            if (cooldownFrames > 0) cooldownFrames--

            val startMargin = if (assistantSpeaking) 10f else 7f
            val absoluteFloor = if (assistantSpeaking) -34f else -50f
            val startThreshold = max(absoluteFloor, noiseFloorDbfs + startMargin)
            val likelySpeech = dbfs > startThreshold

            if (!likelySpeech && dbfs < -24f) {
                val bounded = dbfs.coerceIn(-80f, -24f)
                noiseFloorDbfs = noiseFloorDbfs * 0.97f + bounded * 0.03f
            }

            consecutiveSpeechFrames = when {
                cooldownFrames > 0 -> 0
                likelySpeech -> consecutiveSpeechFrames + 1
                else -> (consecutiveSpeechFrames - 1).coerceAtLeast(0)
            }

            val requiredStartFrames = if (assistantSpeaking) 4 else 3
            if (consecutiveSpeechFrames >= requiredStartFrames) {
                speaking = true
                speechFrames = consecutiveSpeechFrames
                voicedSpeechFrames = consecutiveSpeechFrames
                silenceFrames = 0
                onSpeechStarted()
            }
        } else {
            speechFrames++
            val endThreshold = max(-52f, noiseFloorDbfs + 5f)
            if (dbfs < endThreshold) {
                silenceFrames++
            } else {
                silenceFrames = 0
                voicedSpeechFrames++
            }

            val activeProfile = profile
            val requiredSilenceFrames = when {
                speechFrames >= 100 -> activeProfile.longSpeechSilenceFrames
                speechFrames >= 50 -> activeProfile.mediumSpeechSilenceFrames
                else -> activeProfile.shortSpeechSilenceFrames
            }

            if (silenceFrames >= requiredSilenceFrames) {
                val validUtterance = voicedSpeechFrames >= MIN_VOICED_SPEECH_FRAMES
                speaking = false
                consecutiveSpeechFrames = 0
                silenceFrames = 0
                speechFrames = 0
                voicedSpeechFrames = 0
                cooldownFrames = POST_ENDPOINT_COOLDOWN_FRAMES
                if (validUtterance) onEndpointDetected()
            }
        }

        levelFrames++
        if (levelFrames >= 5) {
            levelFrames = 0
            onLevel(dbfs, noiseFloorDbfs, speaking)
        }
    }

    fun reset() {
        speaking = false
        consecutiveSpeechFrames = 0
        silenceFrames = 0
        speechFrames = 0
        voicedSpeechFrames = 0
        cooldownFrames = 0
    }
}
