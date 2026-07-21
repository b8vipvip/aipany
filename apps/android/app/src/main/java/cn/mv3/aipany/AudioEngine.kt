package cn.mv3.aipany

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

class AudioEngine(
    private val context: Context,
    private val onPcmFrame: (ByteArray) -> Unit,
    private val onLocalSpeechStarted: () -> Unit,
    private val onEndpointDetected: () -> Unit,
    private val onLevel: (Float, Float, Boolean) -> Unit,
) {
    companion object {
        const val INPUT_SAMPLE_RATE = 16_000
        const val OUTPUT_SAMPLE_RATE = 24_000
        private const val FRAME_SAMPLES = 320 // 20 ms at 16 kHz
    }

    private val captureExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val playbackExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val playbackLock = Any()

    @Volatile private var running = false
    @Volatile private var released = false
    @Volatile private var assistantSpeaking = false

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null

    private val endpointDetector = EndpointDetector(
        onSpeechStarted = {
            if (assistantSpeaking) interruptPlayback()
            onLocalSpeechStarted()
        },
        onEndpointDetected = onEndpointDetected,
        onLevel = onLevel,
    )

    fun start() {
        if (running || released) return
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("RECORD_AUDIO permission is required")
        }

        val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
        @Suppress("DEPRECATION")
        run { audioManager.isSpeakerphoneOn = true }

        val inputFormat = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(INPUT_SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .build()
        val inputMinBuffer = AudioRecord.getMinBufferSize(
            INPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val record = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
            .setAudioFormat(inputFormat)
            .setBufferSizeInBytes(maxOf(inputMinBuffer, FRAME_SAMPLES * 2 * 12))
            .build()
        check(record.state == AudioRecord.STATE_INITIALIZED) { "AudioRecord initialization failed" }

        val outputFormat = AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(OUTPUT_SAMPLE_RATE)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()
        val outputMinBuffer = AudioTrack.getMinBufferSize(
            OUTPUT_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(outputFormat)
            .setBufferSizeInBytes(maxOf(outputMinBuffer, OUTPUT_SAMPLE_RATE * 2 / 2))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        check(track.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack initialization failed" }

        audioRecord = record
        audioTrack = track
        endpointDetector.reset()
        track.play()
        record.startRecording()
        running = true

        captureExecutor.execute {
            val samples = ShortArray(FRAME_SAMPLES)
            while (running && !released) {
                val count = try {
                    record.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
                } catch (_: Exception) {
                    break
                }
                if (count <= 0) continue

                val bytes = ByteArray(count * 2)
                for (index in 0 until count) {
                    val value = samples[index].toInt()
                    bytes[index * 2] = (value and 0xff).toByte()
                    bytes[index * 2 + 1] = ((value ushr 8) and 0xff).toByte()
                }
                onPcmFrame(bytes)
                endpointDetector.process(samples, count, assistantSpeaking)
            }
        }
    }

    fun setAssistantSpeaking(value: Boolean) {
        assistantSpeaking = value
    }

    fun playPcm(audio: ByteArray) {
        if (released || audio.isEmpty()) return
        playbackExecutor.execute {
            synchronized(playbackLock) {
                val track = audioTrack ?: return@synchronized
                if (track.state != AudioTrack.STATE_INITIALIZED) return@synchronized
                if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
                track.write(audio, 0, audio.size, AudioTrack.WRITE_BLOCKING)
            }
        }
    }

    fun interruptPlayback() {
        synchronized(playbackLock) {
            val track = audioTrack ?: return
            try {
                track.pause()
                track.flush()
                track.play()
            } catch (_: IllegalStateException) {
                // The stream may already be stopping; the next response will recreate audio naturally.
            }
        }
    }

    fun stop() {
        if (!running) return
        running = false
        endpointDetector.reset()
        assistantSpeaking = false

        audioRecord?.let { record ->
            try {
                record.stop()
            } catch (_: IllegalStateException) {
            }
            record.release()
        }
        audioRecord = null

        synchronized(playbackLock) {
            audioTrack?.let { track ->
                try {
                    track.pause()
                    track.flush()
                    track.stop()
                } catch (_: IllegalStateException) {
                }
                track.release()
            }
            audioTrack = null
        }
    }

    fun release() {
        if (released) return
        stop()
        released = true
        captureExecutor.shutdownNow()
        playbackExecutor.shutdownNow()
    }
}
