package cn.mv3.aipany

import kotlin.math.log10
import kotlin.math.max
import kotlin.math.sqrt

/**
 * Lightweight client-side endpoint detector for 16 kHz / mono / PCM16 audio.
 *
 * The detector continuously adapts to the local noise floor, uses a stricter
 * speech-start threshold while assistant audio is playing, and commits after a
 * short dynamic silence window instead of waiting for the server-side 500 ms VAD.
 */
class EndpointDetector(
    private val onSpeechStarted: () -> Unit,
    private val onEndpointDetected: () -> Unit,
    private val onLevel: (dbfs: Float, noiseFloorDbfs: Float, speaking: Boolean) -> Unit,
) {
    private var noiseFloorDbfs = -60f
    private var speaking = false
    private var consecutiveSpeechFrames = 0
    private var silenceFrames = 0
    private var speechFrames = 0
    private var cooldownFrames = 0
    private var levelFrames = 0

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

            // Speaker playback can leak into the microphone even with platform AEC.
            // Require a much stronger rise above the learned noise floor while the
            // assistant is speaking so moderate echo does not trigger false barge-in.
            val startMargin = if (assistantSpeaking) 20f else 10f
            val startThreshold = max(-42f, noiseFloorDbfs + startMargin)
            val likelySpeech = dbfs > startThreshold && dbfs > -55f

            if (!likelySpeech && dbfs < -24f) {
                val bounded = dbfs.coerceIn(-80f, -24f)
                noiseFloorDbfs = noiseFloorDbfs * 0.97f + bounded * 0.03f
            }

            consecutiveSpeechFrames = when {
                cooldownFrames > 0 -> 0
                likelySpeech -> consecutiveSpeechFrames + 1
                else -> (consecutiveSpeechFrames - 1).coerceAtLeast(0)
            }

            if (consecutiveSpeechFrames >= 3) {
                speaking = true
                speechFrames = consecutiveSpeechFrames
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
            }

            // Short utterances need a little more protection against mid-sentence
            // pauses; longer utterances can commit more aggressively.
            val requiredSilenceFrames = when {
                speechFrames >= 100 -> 14 // 280 ms after ~2 seconds of speech
                speechFrames >= 50 -> 16  // 320 ms after ~1 second of speech
                else -> 18                // 360 ms for very short utterances
            }

            if (speechFrames >= 10 && silenceFrames >= requiredSilenceFrames) {
                speaking = false
                consecutiveSpeechFrames = 0
                silenceFrames = 0
                speechFrames = 0
                cooldownFrames = 10
                onEndpointDetected()
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
        cooldownFrames = 0
    }
}
