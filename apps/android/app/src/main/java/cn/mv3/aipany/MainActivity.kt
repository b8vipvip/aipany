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
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.roundToInt

class MainActivity : Activity() {
    companion object {
        private const val RECORD_AUDIO_REQUEST = 1001
        private const val AUDIO_START_TIMEOUT_MS = 8_000L
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
    private val audioLifecycleExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val audioStartupGuard = AudioStartupGuard(AUDIO_START_TIMEOUT_MS)

    @Volatile private var destroyed = false
    private var sessionActive = false
    private var audioReady = false
    private var connectionAttempt = false
    private var micPaused = false
    private var hasResumedOnce = false
    private var pendingCrashUploaded = false
    private var initialExperienceResolved = true
    private var settings = AppSettings()
    private var lastAppliedSettings = AppSettings()
    private val assistantText = StringBuilder()

    private var endpointAt = 0L
    private var transcriptFinalAt = 0L
    private var llmFirstTokenAt = 0L
    private var firstAudioAt = 0L
    private var waitingForFirstAudio = false
    private var responseWatchdogGeneration = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initialExperienceResolved = AppSettings.hasPersistedExperienceMode(this)
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
                    val interrupted = realtimeClient.cancelResponse()
                    audioEngine.setAssistantSpeaking(false)
                    runOnUiThread {
                        updateStatus(
                            "正在听你说",
                            if (interrupted) "已触发本地打断" else "检测到语音",
                            VoiceOrbView.State.LISTENING,
                        )
                    }
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
                val committed = realtimeClient.commitAudio()
                runOnUiThread {
                    if (isNativeExperienceMode()) {
                        updateStatus(
                            "正在理解",
                            if (isChat2ApiLiveMode()) "GPT-Live 正在判断本轮表达是否结束" else "Native Live 正在判断本轮表达是否结束",
                            VoiceOrbView.State.THINKING,
                        )
                    } else if (committed) {
                        updateStatus("正在理解", "本地智能断句已提交", VoiceOrbView.State.THINKING)
                    } else {
                        updateStatus("我在听", "已合并连续语音，继续等待完整表达", VoiceOrbView.State.LISTENING)
                    }
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
        destroyed = true
        audioStartupGuard.invalidate()
        responseWatchdogGeneration += 1
        handler.removeCallbacksAndMessages(null)
        runCatching { realtimeClient.release() }
        runCatching { mobileApi.release() }
        audioLifecycleExecutor.execute { runCatching { audioEngine.release() } }
        audioLifecycleExecutor.shutdown()
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
            setOnClickListener {
                runCatching { startActivity(Intent(this@MainActivity, SettingsActivity::class.java)) }
                    .onFailure { Toast.makeText(this@MainActivity, "设置页打开失败：${it.javaClass.simpleName}", Toast.LENGTH_LONG).show() }
            }
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
            text = "支持智能断句 · 原生实时语音 · 随时打断"
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
                if (destroyed) return@runOnUiThread
                result.onSuccess { capabilities ->
                    ClientCapabilitiesCache.save(this, capabilities)
                    var nextSettings = settings
                    if (!AppSettings.hasPersistedExperienceMode(this)) {
                        val selected = selectInitialExperience(capabilities)
                        nextSettings = nextSettings.copy(
                            experienceMode = selected.experienceMode,
                            voiceId = selected.voiceId,
                        )
                    } else {
                        val selectedMode = capabilities.mode(nextSettings.experienceMode)
                        if (selectedMode != null && selectedMode.voices.none { it.id == nextSettings.voiceId }) {
                            val replacementVoice = selectedMode.defaultVoice
                                .takeIf { candidate -> selectedMode.voices.any { it.id == candidate } }
                                ?: selectedMode.voices.firstOrNull()?.id
                            if (!replacementVoice.isNullOrBlank()) {
                                nextSettings = nextSettings.copy(voiceId = replacementVoice)
                            }
                        }
                    }
                    if (nextSettings != settings) {
                        settings = nextSettings
                        lastAppliedSettings = nextSettings
                        AppSettings.save(this, nextSettings)
                        audioEngine.updatePreferences(nextSettings)
                    }
                    refreshSettingsSummary()
                }
                if (!initialExperienceResolved) {
                    initialExperienceResolved = true
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        connectAutomatically()
                    }
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
        if (destroyed || connectionAttempt || sessionActive) return
        if (!initialExperienceResolved) {
            updateStatus("正在选择最佳语音", "优先检测 ChatGPT Live / GPT-Live 可用性", VoiceOrbView.State.CONNECTING)
            return
        }
        connectionAttempt = true
        updateStatus(
            if (isChat2ApiLiveMode()) "正在连接 ChatGPT Live" else "正在连接小派",
            "自动获取安全会话",
            VoiceOrbView.State.CONNECTING,
        )
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            ?: "android-device-${System.currentTimeMillis()}"
        mobileApi.bootstrap(deviceId) { result ->
            runOnUiThread {
                if (destroyed) return@runOnUiThread
                connectionAttempt = false
                result.onSuccess { bootstrap ->
                    settings = AppSettings.load(this)
                    lastAppliedSettings = settings
                    audioEngine.updatePreferences(settings)
                    refreshSettingsSummary()
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
        invalidateAudioStartup()
        responseWatchdogGeneration += 1
        sessionActive = false
        connectionAttempt = false
        realtimeClient.close()
        stopAudioAsync()
        handler.postDelayed({ connectAutomatically() }, 450)
    }

    private fun toggleMicrophone() {
        if (!sessionActive) {
            connectAutomatically()
            return
        }
        micPaused = !micPaused
        if (micPaused) {
            audioReady = false
            audioStartupGuard.invalidate()
            stopAudioAsync()
            pauseButton.text = "继续聆听"
            updateStatus("已暂停聆听", "点继续后恢复麦克风", VoiceOrbView.State.PAUSED)
        } else {
            pauseButton.text = "暂停聆听"
            startAudioAsync("manual_resume")
        }
    }

    private fun handleConnectionState(message: String) {
        if (message.startsWith("连接失败") || message == "连接已断开") {
            invalidateAudioStartup()
            responseWatchdogGeneration += 1
            sessionActive = false
            stopAudioAsync()
            updateStatus("连接中断", "正在等待自动重连，也可点击重新连接", VoiceOrbView.State.ERROR)
        } else if (message.contains("正在连接") || message.contains("安全连接")) {
            updateStatus(
                if (isChat2ApiLiveMode()) "正在连接 ChatGPT Live" else "正在连接小派",
                message,
                VoiceOrbView.State.CONNECTING,
            )
            if (message.contains("安全连接") && !pendingCrashUploaded) {
                ClientCrashDiagnostics.consume(this)?.let { details ->
                    if (realtimeClient.sendTelemetry("android_previous_crash", details = details)) {
                        pendingCrashUploaded = true
                    }
                }
            }
        }
    }

    private fun handleServerEvent(event: JSONObject) {
        when (event.optString("type")) {
            "session.created" -> updateStatus(
                "正在启动语音",
                if (isChat2ApiLiveMode()) "正在建立 chat2api / ChatGPT Voice 原生实时会话" else "服务端实时语音会话准备中",
                VoiceOrbView.State.CONNECTING,
            )
            "session.ready" -> {
                sessionActive = true
                realtimeClient.sendTelemetry("session_ready_received")
                if (micPaused) {
                    updateStatus("已暂停聆听", "语音会话已就绪", VoiceOrbView.State.PAUSED)
                } else {
                    startAudioAsync("session_ready")
                }
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
                val generation = ++responseWatchdogGeneration
                handler.postDelayed({
                    if (generation == responseWatchdogGeneration && llmFirstTokenAt == 0L && sessionActive) {
                        updateStatus("还在思考", "正在切换更合适的回答路径", VoiceOrbView.State.THINKING)
                    }
                }, 1_800)
            }
            "response.text.delta" -> {
                responseWatchdogGeneration += 1
                if (llmFirstTokenAt == 0L) {
                    llmFirstTokenAt = SystemClock.elapsedRealtime()
                    renderLatency()
                }
                assistantText.append(event.optString("delta"))
                answerView.text = assistantText.toString()
            }
            "response.audio.started" -> {
                responseWatchdogGeneration += 1
                audioEngine.setAssistantSpeaking(true)
                waitingForFirstAudio = true
                updateStatus("小派正在说话", "你可以随时直接打断", VoiceOrbView.State.SPEAKING)
            }
            "response.audio.done", "response.done" -> {
                responseWatchdogGeneration += 1
                audioEngine.setAssistantSpeaking(false)
                updateStatus("我在听", "可以继续说话", if (micPaused) VoiceOrbView.State.PAUSED else VoiceOrbView.State.LISTENING)
                renderLatency()
            }
            "response.interrupted" -> {
                responseWatchdogGeneration += 1
                audioEngine.setAssistantSpeaking(false)
                updateStatus("我在听", "上一轮已被打断", VoiceOrbView.State.LISTENING)
            }
            "mode.changed" -> refreshSettingsSummary()
            "error" -> {
                responseWatchdogGeneration += 1
                val retryable = event.optBoolean("retryable", false)
                val code = event.optString("code")
                val message = event.optString("message")
                if (retryable || code == "INVALID_EVENT") {
                    updateStatus("我还在线", "$code: $message".trim(), VoiceOrbView.State.LISTENING)
                } else {
                    updateStatus("发生错误", "$code: $message".trim(), VoiceOrbView.State.ERROR)
                }
            }
        }
    }

    private fun startAudioAsync(reason: String) {
        if (destroyed || micPaused || !sessionActive) return
        val token = audioStartupGuard.begin(SystemClock.elapsedRealtime())
        audioReady = false
        updateStatus("正在启动麦克风", "语音会话已就绪，正在连接手机音频设备", VoiceOrbView.State.CONNECTING)
        realtimeClient.sendTelemetry("audio_start_requested", details = mapOf("reason" to reason))

        handler.postDelayed({
            if (destroyed || !audioStartupGuard.isTimedOut(token, SystemClock.elapsedRealtime())) return@postDelayed
            audioStartupGuard.markFailed(token)
            audioReady = false
            sessionActive = false
            realtimeClient.sendTelemetry("audio_start_timeout", (SystemClock.elapsedRealtime() - token.startedAtMs).toDouble())
            updateStatus("麦克风启动超时", "正在自动重建语音链路，界面不会再卡死", VoiceOrbView.State.ERROR)
            realtimeClient.close()
            connectionAttempt = false
            handler.postDelayed({ connectAutomatically() }, 800)
        }, AUDIO_START_TIMEOUT_MS)

        audioLifecycleExecutor.execute {
            val result = runCatching {
                audioEngine.updatePreferences(settings)
                audioEngine.start()
            }
            val elapsed = SystemClock.elapsedRealtime() - token.startedAtMs
            if (destroyed || !audioStartupGuard.isCurrent(token)) {
                runCatching { audioEngine.stop() }
                return@execute
            }
            runOnUiThread {
                if (destroyed) return@runOnUiThread
                result.onSuccess {
                    if (!audioStartupGuard.markReady(token)) return@onSuccess
                    audioReady = true
                    realtimeClient.sendTelemetry("audio_start_ready", elapsed.toDouble())
                    if (micPaused) {
                        audioReady = false
                        stopAudioAsync()
                        updateStatus("已暂停聆听", "语音会话已就绪", VoiceOrbView.State.PAUSED)
                    } else {
                        updateStatus("我在听", "直接说话即可", VoiceOrbView.State.LISTENING)
                    }
                }.onFailure { error ->
                    audioStartupGuard.markFailed(token)
                    audioReady = false
                    realtimeClient.sendTelemetry(
                        "audio_start_failed",
                        elapsed.toDouble(),
                        mapOf("errorType" to error.javaClass.simpleName.take(60)),
                    )
                    updateStatus("麦克风启动失败", "${error.javaClass.simpleName}：请点重新连接", VoiceOrbView.State.ERROR)
                }
            }
        }
    }

    private fun invalidateAudioStartup() {
        audioStartupGuard.invalidate()
        audioReady = false
    }

    private fun stopAudioAsync() {
        audioLifecycleExecutor.execute { runCatching { audioEngine.stop() } }
    }

    private fun updateStatus(title: String, subtitle: String, state: VoiceOrbView.State) {
        statusView.text = title
        val liveTag = if (isChat2ApiLiveMode()) "GPT-Live" else null
        statusPill.text = when (state) {
            VoiceOrbView.State.CONNECTING -> if (liveTag != null) "连接中 · $liveTag" else "连接中"
            VoiceOrbView.State.LISTENING -> if (liveTag != null) "在线 · $liveTag · 聆听" else "在线 · 正在聆听"
            VoiceOrbView.State.THINKING -> if (liveTag != null) "在线 · $liveTag · 思考" else "在线 · 正在思考"
            VoiceOrbView.State.SPEAKING -> if (liveTag != null) "在线 · $liveTag · 回答" else "在线 · 正在回答"
            VoiceOrbView.State.PAUSED -> if (liveTag != null) "在线 · $liveTag · 已暂停" else "在线 · 已暂停"
            VoiceOrbView.State.ERROR -> "连接异常"
        }
        meterView.text = subtitle
        orbView.setState(state)
    }

    private fun refreshSettingsSummary() {
        val experiences = ClientCapabilitiesCache.loadExperienceModes(this)
        val experience = experiences.firstOrNull { it.id == settings.experienceMode }
        val voice = experience?.voices?.firstOrNull { it.id == settings.voiceId }
            ?: ClientCapabilitiesCache.loadVoices(this).firstOrNull { it.id == settings.voiceId }
        val interaction = when (settings.interactionMode) {
            "owner_focus" -> "专注主人"
            "group" -> "多人聊天"
            else -> "自动模式"
        }
        val experienceLabel = when {
            experience?.id == "chat2api_live" -> "ChatGPT Live · chat2api · ${experience.model.ifBlank { "gpt-live" }}"
            experience != null -> "${experience.title.substringBefore(" · 未启用")} · ${experience.model}"
            settings.experienceMode == "chat2api_live" -> "ChatGPT Live · chat2api · gpt-live"
            else -> settings.experienceMode
        }
        settingsSummaryView.text = "$experienceLabel · ${voice?.name ?: settings.voiceId} · $interaction · ${settings.endpointProfile.title}断句"
        transcriptCard.visibility = if (settings.showTranscript) View.VISIBLE else View.GONE
    }

    private fun isChat2ApiLiveMode(): Boolean = settings.experienceMode == "chat2api_live"

    private fun isNativeExperienceMode(): Boolean = ClientCapabilitiesCache.loadExperienceModes(this)
        .firstOrNull { it.id == settings.experienceMode }
        ?.engine == "omni_realtime"

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
