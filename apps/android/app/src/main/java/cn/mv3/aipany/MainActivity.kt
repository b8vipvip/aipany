package cn.mv3.aipany

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
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

    private lateinit var serverInput: EditText
    private lateinit var tokenInput: EditText
    private lateinit var tenantInput: EditText
    private lateinit var userInput: EditText
    private lateinit var connectButton: Button
    private lateinit var statusView: TextView
    private lateinit var meterView: TextView
    private lateinit var transcriptView: TextView
    private lateinit var answerView: TextView
    private lateinit var latencyView: TextView

    private lateinit var realtimeClient: RealtimeClient
    private lateinit var audioEngine: AudioEngine

    private var sessionActive = false
    private var pendingConnect = false
    private val assistantText = StringBuilder()

    private var endpointAt = 0L
    private var transcriptFinalAt = 0L
    private var llmFirstTokenAt = 0L
    private var firstAudioAt = 0L
    private var waitingForFirstAudio = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        buildUi()

        realtimeClient = RealtimeClient(
            onState = { message ->
                runOnUiThread {
                    statusView.text = message
                    if (message.startsWith("连接失败") || message.startsWith("连接已关闭")) {
                        sessionActive = false
                        connectButton.text = "连接并开始"
                        audioEngine.stop()
                    }
                }
            },
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
                realtimeClient.cancelResponse()
                audioEngine.setAssistantSpeaking(false)
                runOnUiThread { statusView.text = "检测到你开始说话，已触发本地 Barge-in" }
            },
            onEndpointDetected = {
                endpointAt = SystemClock.elapsedRealtime()
                transcriptFinalAt = 0L
                llmFirstTokenAt = 0L
                firstAudioAt = 0L
                waitingForFirstAudio = false
                val sent = realtimeClient.commitAudio()
                runOnUiThread {
                    statusView.text = if (sent) {
                        "本地 Endpoint Detection：检测到说完，已自动 commit"
                    } else {
                        "本地 Endpoint Detection：已检测到说完，但连接不可用"
                    }
                    renderLatency()
                }
            },
            onLevel = { dbfs, noiseFloor, speaking ->
                runOnUiThread {
                    meterView.text = "麦克风 ${dbfs.roundToInt()} dBFS · 噪声底 ${noiseFloor.roundToInt()} dBFS · ${if (speaking) "正在说话" else "监听中"}"
                }
            },
        )
    }

    override fun onDestroy() {
        realtimeClient.release()
        audioEngine.release()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == RECORD_AUDIO_REQUEST) {
            val granted = grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED
            if (granted && pendingConnect) connectNow()
            if (!granted) Toast.makeText(this, "需要麦克风权限才能进行实时语音测试", Toast.LENGTH_LONG).show()
            pendingConnect = false
        }
    }

    private fun buildUi() {
        val prefs = getSharedPreferences("aipany", MODE_PRIVATE)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(40))
        }

        root.addView(TextView(this).apply {
            text = "Aipany 实时语音测试"
            textSize = 26f
            setTextColor(Color.rgb(20, 30, 50))
        })
        root.addView(TextView(this).apply {
            text = "Android v0.1 · 本地智能断句 + 自动 Commit + Barge-in"
            textSize = 14f
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(4), 0, dp(18))
        })

        serverInput = addField(
            root,
            "Gateway WSS",
            prefs.getString("server", "wss://aipany.mv3.cn/v1/realtime") ?: "wss://aipany.mv3.cn/v1/realtime",
        )
        tokenInput = addField(root, "Gateway Token（仅当前 App 内存使用）", "").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        tenantInput = addField(root, "Tenant ID", prefs.getString("tenant", "mobile-test") ?: "mobile-test")
        userInput = addField(root, "User ID", prefs.getString("user", "android-test-user") ?: "android-test-user")

        connectButton = Button(this).apply {
            text = "连接并开始"
            setOnClickListener {
                if (sessionActive) disconnect() else requestPermissionAndConnect()
            }
        }
        root.addView(connectButton, matchWrap(top = 12))

        statusView = section(root, "状态", "尚未连接")
        meterView = section(root, "Endpoint Detection", "等待麦克风")
        transcriptView = section(root, "你说的话", "-")
        answerView = section(root, "小派", "-")
        latencyView = section(root, "首响延迟", "等待一次完整对话")

        root.addView(TextView(this).apply {
            text = "提示：第一版测试包使用服务器现有 Gateway Token。不要把 Token 发到聊天里，只需在手机本地输入。"
            textSize = 12f
            setTextColor(Color.GRAY)
            setPadding(0, dp(18), 0, 0)
        })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun requestPermissionAndConnect() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            connectNow()
            return
        }
        pendingConnect = true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), RECORD_AUDIO_REQUEST)
    }

    private fun connectNow() {
        val server = serverInput.text.toString().trim()
        val token = tokenInput.text.toString().trim()
        val tenant = tenantInput.text.toString().trim()
        val user = userInput.text.toString().trim()
        if (server.isBlank() || token.isBlank() || tenant.isBlank() || user.isBlank()) {
            Toast.makeText(this, "请填写 Gateway、Token、Tenant ID 和 User ID", Toast.LENGTH_SHORT).show()
            return
        }

        getSharedPreferences("aipany", MODE_PRIVATE).edit()
            .putString("server", server)
            .putString("tenant", tenant)
            .putString("user", user)
            .apply()

        connectButton.isEnabled = false
        connectButton.text = "连接中…"
        statusView.text = "正在建立安全 WebSocket 连接"
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID) ?: "android-device"
        realtimeClient.connect(server, token, tenant, user, deviceId)
    }

    private fun disconnect() {
        audioEngine.stop()
        realtimeClient.close()
        sessionActive = false
        connectButton.isEnabled = true
        connectButton.text = "连接并开始"
        statusView.text = "已主动断开"
    }

    private fun handleServerEvent(event: JSONObject) {
        when (event.optString("type")) {
            "session.created" -> statusView.text = "会话已创建，等待 ASR Ready"
            "session.ready" -> {
                sessionActive = true
                connectButton.isEnabled = true
                connectButton.text = "断开"
                statusView.text = "已连接，直接对手机说话即可"
                try {
                    audioEngine.start()
                } catch (error: Exception) {
                    statusView.text = "启动麦克风失败：${error.message}"
                }
            }
            "input_audio_buffer.speech_started" -> statusView.text = "服务端检测到语音"
            "input_audio_buffer.speech_stopped" -> statusView.text = "服务端 VAD 已结束当前语音"
            "transcript.partial" -> transcriptView.text = event.optString("text", "-")
            "transcript.final" -> {
                transcriptFinalAt = SystemClock.elapsedRealtime()
                transcriptView.text = event.optString("text", "-")
                renderLatency()
            }
            "response.created" -> {
                assistantText.setLength(0)
                answerView.text = ""
                llmFirstTokenAt = 0L
                firstAudioAt = 0L
                waitingForFirstAudio = false
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
                statusView.text = "AI 开始返回语音"
            }
            "response.audio.done", "response.done" -> {
                audioEngine.setAssistantSpeaking(false)
                statusView.text = "本轮回答完成，可以继续说话"
                renderLatency()
            }
            "response.interrupted" -> {
                audioEngine.setAssistantSpeaking(false)
                audioEngine.interruptPlayback()
                statusView.text = "上一轮回答已被打断"
            }
            "error" -> {
                statusView.text = "${event.optString("code")}: ${event.optString("message")}".trim()
            }
        }
    }

    private fun renderLatency() {
        fun delta(from: Long, to: Long): String = if (from > 0 && to >= from) "${to - from} ms" else "-"
        latencyView.text = buildString {
            append("本地说完 → ASR Final：${delta(endpointAt, transcriptFinalAt)}\n")
            append("ASR Final → LLM 首 Token：${delta(transcriptFinalAt, llmFirstTokenAt)}\n")
            append("LLM 首 Token → AI 首音频：${delta(llmFirstTokenAt, firstAudioAt)}\n")
            append("本地说完 → AI 首音频：${delta(endpointAt, firstAudioAt)}")
        }
    }

    private fun addField(parent: LinearLayout, label: String, value: String): EditText {
        parent.addView(TextView(this).apply {
            text = label
            textSize = 13f
            setTextColor(Color.DKGRAY)
            setPadding(0, dp(10), 0, dp(4))
        })
        return EditText(this).apply {
            setText(value)
            textSize = 15f
            setSingleLine(true)
            setPadding(dp(12), dp(10), dp(12), dp(10))
            parent.addView(this, matchWrap())
        }
    }

    private fun section(parent: LinearLayout, title: String, initial: String): TextView {
        parent.addView(TextView(this).apply {
            text = title
            textSize = 16f
            setTextColor(Color.rgb(40, 55, 85))
            setPadding(0, dp(20), 0, dp(6))
        })
        return TextView(this).apply {
            text = initial
            textSize = 15f
            setTextColor(Color.rgb(25, 25, 25))
            setBackgroundColor(Color.rgb(245, 247, 251))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            gravity = Gravity.START
            parent.addView(this, matchWrap())
        }
    }

    private fun matchWrap(top: Int = 0): LinearLayout.LayoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
    ).apply { topMargin = dp(top) }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()
}
