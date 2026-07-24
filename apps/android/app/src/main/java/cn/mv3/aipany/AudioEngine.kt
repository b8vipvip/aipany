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
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class AudioEngine(
    private val context: Context,
    private val onPcmFrame: (ByteArray) -> Unit,
    private val onLocalSpeechStarted: () -> Unit,
    private val onEndpointDetected: () -> Unit,
    private val onLevel: (Float, Float, Boolean) -> Unit,
    private val onPlaybackStarted: () -> Unit = { ClientTelemetryBus.report("playback_started") },
    private val onPlaybackStopCompleted: (Double) -> Unit = { ClientTelemetryBus.report("playback_stop_completed", it) },
) {
    companion object {
        const val INPUT_SAMPLE_RATE = 16_000
        const val OUTPUT_SAMPLE_RATE = 24_000
        private const val FRAME_SAMPLES = 320
        private const val OUTPUT_WRITE_CHUNK_BYTES = 1_920 // 40 ms PCM16 mono at 24 kHz
    }

    data class EffectsStatus(
        val acousticEchoCanceler: Boolean,
        val noiseSuppressor: Boolean,
        val automaticGainControl: Boolean,
    )

    private val captureExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val playbackExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val playbackLock = Any()
    private val playbackGeneration = AtomicLong(0)

    @Volatile private var running = false
    @Volatile private var released = false
    @Volatile private var assistantSpeaking = false
    @Volatile private var bargeInEnabled = true
    @Volatile private var playbackStartedGeneration = Long.MIN_VALUE

    private var audioRecord: AudioRecord? = null
    private var audioTrack: AudioTrack? = null
    private var acousticEchoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var automaticGainControl: AutomaticGainControl? = null

    private val endpointDetector = EndpointDetector(
        onSpeechStarted = onLocalSpeechStarted,
        onEndpointDetected = onEndpointDetected,
        onLevel = onLevel,
    )

    init {
        ClientAudioControlBus.attach(
            onAssistantSpeaking = { setAssistantSpeaking(it) },
            onInterruptPlayback = { interruptPlayback() },
        )
    }

    fun updatePreferences(settings: AppSettings) {
        bargeInEnabled = settings.bargeInEnabled
        endpointDetector.setProfile(settings.endpointProfile)
    }

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
        enableAudioEffects(record.audioSessionId)

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
            .setBufferSizeInBytes(maxOf(outputMinBuffer, OUTPUT_SAMPLE_RATE * 2 / 6))
            .setTransferMode(AudioTrack.MODE_STREAM)
            .setPerformanceMode(AudioTrack.PERFORMANCE_MODE_LOW_LATENCY)
            .build()
        check(track.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack initialization failed" }

        audioRecord = record
        audioTrack = track
        playbackGeneration.incrementAndGet()
        playbackStartedGeneration = Long.MIN_VALUE
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
        if (value && !assistantSpeaking) playbackStartedGeneration = Long.MIN_VALUE
        assistantSpeaking = value
    }

    fun prepareForAssistantResponse() {
        playbackStartedGeneration = Long.MIN_VALUE
    }

    fun playPcm(audio: ByteArray) {
        if (released || audio.isEmpty()) return
        val generation = playbackGeneration.get()
        playbackExecutor.execute {
            var offset = 0
            while (offset < audio.size && generation == playbackGeneration.get()) {
                var notifyStarted = false
                val written = synchronized(playbackLock) {
                    if (generation != playbackGeneration.get()) return@synchronized -1
                    val track = audioTrack?.takeIf { it.state == AudioTrack.STATE_INITIALIZED }
                        ?: return@synchronized -1
                    try {
                        if (track.playState != AudioTrack.PLAYSTATE_PLAYING) track.play()
                        val length = minOf(OUTPUT_WRITE_CHUNK_BYTES, audio.size - offset)
                        val count = track.write(audio, offset, length, AudioTrack.WRITE_BLOCKING)
                        if (count > 0 && generation == playbackGeneration.get() && playbackStartedGeneration != generation) {
                            playbackStartedGeneration = generation
                            notifyStarted = true
                        }
                        count
                    } catch (_: IllegalStateException) {
                        -1
                    }
                }
                if (written <= 0 || generation != playbackGeneration.get()) return@execute
                offset += written
                if (notifyStarted) onPlaybackStarted()
            }
        }
    }

    fun interruptPlayback() {
        val startedNs = System.nanoTime()
        playbackGeneration.incrementAndGet()
        playbackStartedGeneration = Long.MIN_VALUE
        assistantSpeaking = false
        synchronized(playbackLock) {
            val track = audioTrack
            if (track != null) {
                try {
                    track.pause()
                    track.flush()
                    track.play()
                } catch (_: IllegalStateException) {
                }
            }
        }
        onPlaybackStopCompleted((System.nanoTime() - startedNs) / 1_000_000.0)
    }

    fun effectsStatus(): EffectsStatus = EffectsStatus(
        acousticEchoCanceler = acousticEchoCanceler?.enabled == true,
        noiseSuppressor = noiseSuppressor?.enabled == true,
        automaticGainControl = automaticGainControl?.enabled == true,
    )

    fun stop() {
        if (!running && audioRecord == null && audioTrack == null) return
        running = false
        playbackGeneration.incrementAndGet()
        playbackStartedGeneration = Long.MIN_VALUE
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
        releaseAudioEffects()

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
        ClientAudioControlBus.detach()
        captureExecutor.shutdownNow()
        playbackExecutor.shutdownNow()
    }

    private fun enableAudioEffects(audioSessionId: Int) {
        releaseAudioEffects()
        acousticEchoCanceler = runCatching {
            if (AcousticEchoCanceler.isAvailable()) AcousticEchoCanceler.create(audioSessionId)?.apply { enabled = true } else null
        }.getOrNull()
        noiseSuppressor = runCatching {
            if (NoiseSuppressor.isAvailable()) NoiseSuppressor.create(audioSessionId)?.apply { enabled = true } else null
        }.getOrNull()
        automaticGainControl = runCatching {
            if (AutomaticGainControl.isAvailable()) AutomaticGainControl.create(audioSessionId)?.apply { enabled = true } else null
        }.getOrNull()
    }

    private fun releaseAudioEffects() {
        runCatching { acousticEchoCanceler?.release() }
        runCatching { noiseSuppressor?.release() }
        runCatching { automaticGainControl?.release() }
        acousticEchoCanceler = null
        noiseSuppressor = null
        automaticGainControl = null
    }
}
