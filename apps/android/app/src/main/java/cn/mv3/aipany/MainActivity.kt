package cn.mv3.aipany

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import kotlin.math.roundToInt

class MainActivity : Activity() {
    companion object {
        private const val RECORD_AUDIO_REQUEST = 1001
    }

    private lateinit var statusView: TextView
    private lateinit var statusPill: TextView
    private lateinit var meterView: TextView
    private lateinit var transcriptView: TextView
    private lateinit var transcriptCard: LinearLayout
    private lateinit var answerView: TextView
    private lateinit var latencyView: TextView
    private lateinit var settingsSummaryView: TextView
    private lateinit var pauseButton: Button
    private lateinit var reconnectButton: Button
    private lateinit var orbView: VoiceOrbView

    private lateinit var realtimeClient: RealtimeClient
    private lateinit var mobileApi: MobileApiClient
    private lateinit var audioEngine: AudioEngine

    private val handler = Handler(Looper.getMainLooper())
    private var sessionActive = false
    private var connectionAttempt = false
    private var micPaused = false
    private var hasResumedOnce = false
    private var settings = AppSettings()
    private var lastAppliedSettings = AppSettings()
    private val assistantText = StringBuilder()

    private var endpointAt = 0L
    private var transcriptFinalAt = 0L
    private var llmFirstTokenAt = 0L
    private var firstAudioAt = 0L
    private var waitingForFirstAudio = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = AppSettings.load(this)
        lastAppliedSettings = settings
        buildUi()

        mobileApi = MobileApiClient()
        realtimeClient = RealtimeClient(
            onState = { message -> runOnUiThread { handleConnectionState(message) } },
            onEvent = { event -> runOnUiThread { handleServerEvent(event) } },
            onAudio = { audio ->
                if (waitingForFirstAudio) {
                    firstAudioAt = SystemClock.elapsedRealtime()
                    waitingForFirstAudio = false
                    runOnUiThread { renderLatency() }
                }
                audioEngine.playPcm(audio)
            },
        )
        audioEngine = AudioEngine(
            context = this,
            onPcmFrame = { realtimeClient.sendPcm(it) },
            onLocalSpeechStarted = {
                if (settings.bargeInEnabled) {
                    realtimeClient.cancelResponse()
                    audioEngine.setAssistantSpeaking(false)
                    runOnUiThread { updateStatus("正在听你说", "已触发本地打断", VoiceOrbView.State.LISTENING) }
                } else {
                    runOnUiThread { updateStatus("正在听你说", "检测到语音", VoiceOrbView.State.LISTENING) }
                }
            },
            onEndpointDetected = {
                endpointAt = SystemClock.elapsedRealtime()
                transcriptFinalAt = 0L
                llmFirstTokenAt = 0L
                firstAudioAt = 0L
                waitingForFirstAudio = false
                realtimeClient.commitAudio()
                runOnUiThread {
                    updateStatus("正在理解", "本地智能断句已提交", VoiceOrbView.State.THINKING)
                    renderLatency()
                }
            },
            onLevel = { dbfs, noiseFloor, speaking ->
                runOnUiThread {
                    orbView.setInputLevel(dbfs)
                    meterView.text = if (speaking) {
                        "正在听你说 · ${dbfs.roundToInt()} dBFS"
                    } else {
                        "环境 ${noiseFloor.roundToInt()} dBFS · 随时可以说话"
                    }
                }
            },
        )
        audioEngine.updatePreferences(settings)
        refreshSettingsSummary()
        fetchCapabilities()
        requestPermissionAndAutoConnect()
    }

    override fun onResume() {
        super.onResume()
        val latest = AppSettings.load(this)
        if (hasResumedOnce && latest != lastAppliedSettings) {
            settings = latest
            lastAppliedSettings = latest
            audioEngine.updatePreferences(settings)
            refreshSettingsSummary()
            transcriptCard.visibility = if (settings.showTranscript) View.VISIBLE else View.GONE
            reconnect()
        } else {
            settings = latest
            lastAppliedSettings = latest
        }
        hasResumedOnce = true
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        realtimeClient.release()
        mobileApi.release()
        audioEngine.release()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != RECORD_AUDIO_REQUEST) return
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            connectAutomatically()
        } else {
            updateStatus("需要麦克风权限", "点击重新连接后授权即可使用", VoiceOrbView.State.ERROR)
            Toast.makeText(this, "需要麦克风权限才能和小派实时对话", Toast.LENGTH_LONG).show()
        }
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(32))
            setBackgroundColor(Color.rgb(247, 248, 252))
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@MainActivity).apply {
                text = "Aipany"
                textSize = 28f
                setTextColor(Color.rgb(20, 28, 48))
            })
            addView(TextView(this@MainActivity).apply {
                text = "小派 · 实时语音助手"
                textSize = 13f
                setTextColor(Color.rgb(103, 113, 135))
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(Button(this).apply {
            text = "设置"
            textSize = 14f
            background = rounded(Color.WHITE, dp(14).toFloat(), Color.rgb(226, 229, 238))
            setOnClickListener { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) }
        }, LinearLayout.LayoutParams(dp(76), dp(46)))
        root.addView(header)

        settingsSummaryView = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.rgb(102, 112, 134))
            setPadding(0, dp(8), 0, 0)
        }
        root.addView(settingsSummaryView)

        statusPill = TextView(this).apply {
            text = "正在连接"
            textSize = 13f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(67, 56, 202))
            background = rounded(Color.rgb(238, 242, 255), dp(20).toFloat())
            setPadding(dp(16), dp(8), dp(16), dp(8))
        }
        root.addView(statusPill, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            topMargin = dp(24)
        })

        orbView = VoiceOrbView(this)
        root.addView(orbView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(238)).apply { topMargin = dp(2) })

        statusView = TextView(this).apply {
            text = "正在为你准备实时语音"
            textSize = 20f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(28, 36, 56))
        }
        root.addView(statusView)
        meterView = TextView(this).apply {
            text = "连接后直接说话，不需要按住按钮"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(120, 130, 150))
            setPadding(0, dp(5), 0, dp(18))
        }
        root.addView(meterView)

        val answerCard = card(root, "小派")
        answerView = TextView(this).apply {
            text = "你好，我是小派。连接完成后，直接和我说话就好。"
            textSize = 17f
            setTextColor(Color.rgb(35, 43, 63))
            setLineSpacing(0f, 1.16f)
        }
        answerCard.addView(answerView)

        transcriptCard = card(root, "你说的话")
        transcriptView = TextView(this).apply {
            text = "等待你开口…"
            textSize = 15f
            setTextColor(Color.rgb(75, 86, 108))
            setLineSpacing(0f, 1.12f)
        }
        transcriptCard.addView(transcriptView)
        transcriptCard.visibility = if (settings.showTranscript) View.VISIBLE else View.GONE

        val latencyCard = card(root, "实时响应")
        latencyView = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(91, 102, 124))
        }
        latencyCard.addView(latencyView)
        renderLatency()

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        pauseButton = Button(this).apply {
            text = "暂停聆听"
            background = rounded(Color.rgb(79, 70, 229), dp(15).toFloat())
            setTextColor(Color.WHITE)
            setOnClickListener { toggleMicrophone() }
        }
        reconnectButton = Button(this).apply {
            text = "重新连接"
            background = rounded(Color.WHITE, dp(15).toFloat(), Color.rgb(220, 224, 235))
            setTextColor(Color.rgb(55, 65, 85))
            setOnClickListener { reconnect() }
        }
        actions.addView(pauseButton, LinearLayout.LayoutParams(0, dp(52), 1f).apply { marginEnd = dp(6) })
        actions.addView(reconnectButton, LinearLayout.LayoutParams(0, dp(52), 1f).apply { marginStart = dp(6) })
        root.addView(actions, matchWrap(top = 18))

        root.addView(TextView(this).apply {
            text = "本地智能断句已开启 · 支持自动 Commit 与实时打断"
            textSize = 11f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(142, 150, 168))
            setPadding(0, dp(12), 0, 0)
        })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun fetchCapabilities() {
        mobileApi.fetchCapabilities { result ->
            runOnUiThread {
                result.onSuccess { capabilities ->
                    ClientCapabilitiesCache.save(this, capabilities)
                    val available = capabilities.voices.any { it.id == settings.voiceId }
                    if (!available && capabilities.voices.isNotEmpty()) {
                        settings = settings.copy(voiceId = capabilities.defaultVoice)
                        AppSettings.save(this, settings)
                        lastAppliedSettings = settings
                    }
                    refreshSettingsSummary()
                }
            }
        }
    }

    private fun requestPermissionAndAutoConnect() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            connectAutomatically()
        } else {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST)
        }
    }

    private fun connectAutomatically() {
        if (connectionAttempt || sessionActive) return
        connectionAttempt = true
        updateStatus("正在连接小派", "自动获取安全会话", VoiceOrbView.State.CONNECTING)
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "android-device-${System.currentTimeMillis()}"
        mobileApi.bootstrap(deviceId) { result ->
            runOnUiThread {
                connectionAttempt = false
                result.onSuccess { bootstrap ->
                    settings = AppSettings.load(this)
                    lastAppliedSettings = settings
                    audioEngine.updatePreferences(settings)
                    realtimeClient.connect(
                        mobileApi.websocketUrl(bootstrap.websocketPath),
                        bootstrap.token,
                        bootstrap.tenantId,
                        bootstrap.userId,
                        deviceId,
                        settings,
                    )
                }.onFailure { error ->
                    updateStatus("暂时无法连接", error.message ?: "请稍后重试", VoiceOrbView.State.ERROR)
                }
            }
        }
    }

    private fun reconnect() {
        audioEngine.stop()
        realtimeClient.close()
        sessionActive = false
        connectionAttempt = false
        handler.postDelayed({ connectAutomatically() }, 350)
    }

    private fun toggleMicrophone() {
        if (!sessionActive) {
            connectAutomatically()
            return
        }
        micPaused = !micPaused
        if (micPaused) {
            audioEngine.stop()
            pauseButton.text = "继续聆听"
            updateStatus("已暂停聆听", "点继续后恢复麦克风", VoiceOrbView.State.PAUSED)
        } else {
            audioEngine.updatePreferences(settings)
            audioEngine.start()
            pauseButton.text = "暂停聆听"
            updateStatus("我在听", "直接说话即可", VoiceOrbView.State.LISTENING)
        }
    }

    private fun handleConnectionState(message: String) {
        if (message.startsWith("连接失败") || message == "连接已断开") {
            sessionActive = false
            audioEngine.stop()
            updateStatus("连接中断", "可以点击重新连接", VoiceOrbView.State.ERROR)
        } else if (message.contains("正在连接") || message.contains("安全连接")) {
            updateStatus("正在连接小派", message, VoiceOrbView.State.CONNECTING)
        }
    }

    private fun handleServerEvent(event: JSONObject) {
        when (event.optString("type")) {
            "session.created" -> updateStatus("正在启动语音", "ASR 会话准备中", VoiceOrbView.State.CONNECTING)
            "session.ready" -> {
                sessionActive = true
                if (!micPaused) {
                    audioEngine.updatePreferences(settings)
                    runCatching { audioEngine.start() }.onFailure {
                        updateStatus("麦克风启动失败", it.message ?: "未知错误", VoiceOrbView.State.ERROR)
                        return
                    }
                }
                updateStatus("我在听", "直接说话即可", if (micPaused) VoiceOrbView.State.PAUSED else VoiceOrbView.State.LISTENING)
            }
            "input_audio_buffer.speech_started" -> updateStatus("我在听", "检测到语音", VoiceOrbView.State.LISTENING)
            "input_audio_buffer.speech_stopped" -> updateStatus("正在理解", "语音输入结束", VoiceOrbView.State.THINKING)
            "transcript.partial" -> if (settings.showTranscript) transcriptView.text = event.optString("text", "")
            "transcript.final" -> {
                transcriptFinalAt = SystemClock.elapsedRealtime()
                transcriptView.text = event.optString("text", "")
                updateStatus("正在思考", "已理解你的话", VoiceOrbView.State.THINKING)
                renderLatency()
            }
            "response.created" -> {
                assistantText.setLength(0)
                answerView.text = ""
                llmFirstTokenAt = 0L
                firstAudioAt = 0L
                waitingForFirstAudio = false
                updateStatus("正在思考", "小派正在组织回答", VoiceOrbView.State.THINKING)
            }
            "response.text.delta" -> {
                if (llmFirstTokenAt == 0L) {
                    llmFirstTokenAt = SystemClock.elapsedRealtime()
                    renderLatency()
                }
                assistantText.append(event.optString("delta"))
                answerView.text = assistantText.toString()
            }
            "response.audio.started" -> {
                audioEngine.setAssistantSpeaking(true)
                waitingForFirstAudio = true
                updateStatus("小派正在说话", "你可以随时直接打断", VoiceOrbView.State.SPEAKING)
            }
            "response.audio.done", "response.done" -> {
                audioEngine.setAssistantSpeaking(false)
                updateStatus("我在听", "可以继续说话", if (micPaused) VoiceOrbView.State.PAUSED else VoiceOrbView.State.LISTENING)
                renderLatency()
            }
            "response.interrupted" -> {
                audioEngine.setAssistantSpeaking(false)
                audioEngine.interruptPlayback()
                updateStatus("我在听", "上一轮已被打断", VoiceOrbView.State.LISTENING)
            }
            "mode.changed" -> refreshSettingsSummary()
            "error" -> updateStatus(
                "发生错误",
                "${event.optString("code")}: ${event.optString("message")}".trim(),
                VoiceOrbView.State.ERROR,
            )
        }
    }

    private fun updateStatus(title: String, subtitle: String, state: VoiceOrbView.State) {
        statusView.text = title
        statusPill.text = when (state) {
            VoiceOrbView.State.CONNECTING -> "连接中"
            VoiceOrbView.State.LISTENING -> "在线 · 正在聆听"
            VoiceOrbView.State.THINKING -> "在线 · 正在思考"
            VoiceOrbView.State.SPEAKING -> "在线 · 正在回答"
            VoiceOrbView.State.PAUSED -> "在线 · 已暂停"
            VoiceOrbView.State.ERROR -> "连接异常"
        }
        meterView.text = subtitle
        orbView.setState(state)
    }

    private fun refreshSettingsSummary() {
        val voice = ClientCapabilitiesCache.loadVoices(this).firstOrNull { it.id == settings.voiceId }
        val mode = when (settings.interactionMode) {
            "owner_focus" -> "专注主人"
            "group" -> "多人聊天"
            else -> "自动模式"
        }
        settingsSummaryView.text = "${voice?.name ?: settings.voiceId} · $mode · ${settings.endpointProfile.title}断句"
        transcriptCard.visibility = if (settings.showTranscript) View.VISIBLE else View.GONE
    }

    private fun renderLatency() {
        fun delta(from: Long, to: Long): String = if (from > 0 && to >= from) "${to - from} ms" else "—"
        latencyView.text = buildString {
            append("说完 → ASR：${delta(endpointAt, transcriptFinalAt)}")
            append("   ·   ASR → LLM：${delta(transcriptFinalAt, llmFirstTokenAt)}\n")
            append("LLM → 首音频：${delta(llmFirstTokenAt, firstAudioAt)}")
            append("   ·   总首响：${delta(endpointAt, firstAudioAt)}")
        }
    }

    private fun card(parent: LinearLayout, title: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(16))
            background = rounded(Color.WHITE, dp(18).toFloat())
            addView(TextView(this@MainActivity).apply {
                text = title
                textSize = 12f
                setTextColor(Color.rgb(115, 124, 145))
                setPadding(0, 0, 0, dp(7))
            })
            parent.addView(this, matchWrap(top = 12))
        }
    }

    private fun rounded(color: Int, radius: Float, strokeColor: Int? = null): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
        if (strokeColor != null) setStroke(dp(1), strokeColor)
    }

    private fun matchWrap(top: Int = 0): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = dp(top) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()
}
