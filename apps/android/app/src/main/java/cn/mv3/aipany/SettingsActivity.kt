package cn.mv3.aipany

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import kotlin.math.roundToInt

class SettingsActivity : Activity() {
    private var experienceModes: List<ClientExperienceModeOption> = emptyList()
    private var voices: List<ClientVoiceOption> = emptyList()
    private lateinit var experienceSpinner: Spinner
    private lateinit var experienceDescription: TextView
    private lateinit var voiceSpinner: Spinner
    private lateinit var voiceDescription: TextView
    private lateinit var previewButton: Button
    private lateinit var modeSpinner: Spinner
    private lateinit var proactivitySeek: SeekBar
    private lateinit var proactivityValue: TextView
    private lateinit var aliasesInput: EditText
    private lateinit var endpointSpinner: Spinner
    private lateinit var bargeInSwitch: Switch
    private lateinit var transcriptSwitch: Switch
    private lateinit var mobileApi: MobileApiClient
    private var previewToken: String? = null
    private var previewTrack: AudioTrack? = null
    private var loadingValues = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mobileApi = MobileApiClient()
        experienceModes = ClientCapabilitiesCache.loadExperienceModes(this)
        val initial = AppSettings.load(this)
        voices = selectedMode(initial.experienceMode)?.voices.orEmpty().ifEmpty { ClientCapabilitiesCache.loadVoices(this) }
        buildUi()
        loadValues(initial)
        loadingValues = false
    }

    override fun onDestroy() {
        previewTrack?.stopSafely()
        previewTrack?.release()
        previewTrack = null
        mobileApi.release()
        super.onDestroy()
    }

    private fun buildUi() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(36))
            setBackgroundColor(Color.rgb(247, 248, 252))
        }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        header.addView(Button(this).apply {
            text = "‹"
            textSize = 28f
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(54), dp(48)))
        header.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SettingsActivity).apply {
                text = "小派设置"
                textSize = 25f
                setTextColor(Color.rgb(20, 28, 48))
            })
            addView(TextView(this@SettingsActivity).apply {
                text = "三种实时体验模式 · 当前开发阶段不涉及订阅或收费"
                textSize = 13f
                setTextColor(Color.rgb(100, 112, 138))
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(header)

        val experienceCard = card(root, "实时体验模式", "按体验路线切换底层实时语音架构，保存后自动重新连接")
        experienceSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                experienceModes.map { it.title },
            )
        }
        experienceCard.addView(experienceSpinner, matchWrap(top = 10))
        experienceDescription = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(96, 107, 128))
            setPadding(0, dp(8), 0, 0)
        }
        experienceCard.addView(experienceDescription)
        experienceSpinner.setOnItemSelectedListener(SimpleItemSelectedListener { position ->
            val selected = experienceModes.getOrNull(position) ?: return@SimpleItemSelectedListener
            experienceDescription.text = "${selected.subtitle}\n模型：${selected.model}"
            refreshVoicesForMode(selected, preserveVoice = !loadingValues)
        })

        val voiceCard = card(root, "声音", "Native Live 音色来自当前模型支持列表，可直接试听实际模型声音")
        voiceSpinner = Spinner(this)
        voiceSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, voices.map { it.displayName() })
        voiceCard.addView(voiceSpinner, matchWrap(top = 10))
        voiceDescription = TextView(this).apply {
            textSize = 13f
            setTextColor(Color.rgb(96, 107, 128))
            setPadding(0, dp(8), 0, 0)
        }
        voiceCard.addView(voiceDescription)
        voiceSpinner.setOnItemSelectedListener(SimpleItemSelectedListener { position ->
            voiceDescription.text = voices.getOrNull(position)?.description.orEmpty()
            updatePreviewButton()
        })
        previewButton = Button(this).apply {
            text = "试听声音"
            textSize = 14f
            setOnClickListener { previewSelectedVoice() }
        }
        voiceCard.addView(previewButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(12) })

        val conversationCard = card(root, "对话方式", "这些设置由 Aipany 实时会话原生支持")
        label(conversationCard, "交互模式")
        modeSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                listOf("自动判断", "专注主人", "多人聊天"),
            )
        }
        conversationCard.addView(modeSpinner, matchWrap())

        val proactivityRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        proactivityRow.addView(TextView(this).apply {
            text = "主动参与程度"
            textSize = 14f
            setTextColor(Color.rgb(40, 50, 70))
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        proactivityValue = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.rgb(79, 70, 229))
        }
        proactivityRow.addView(proactivityValue)
        conversationCard.addView(proactivityRow, matchWrap(top = 14))
        proactivitySeek = SeekBar(this).apply {
            max = 100
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                    proactivityValue.text = "$progress%"
                }
                override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
                override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
            })
        }
        conversationCard.addView(proactivitySeek, matchWrap())

        label(conversationCard, "唤醒名 / 助手别名")
        aliasesInput = EditText(this).apply {
            hint = "Aipany, 小派"
            setSingleLine(true)
            background = rounded(Color.WHITE, dp(12).toFloat(), Color.rgb(222, 226, 236))
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        conversationCard.addView(aliasesInput, matchWrap())

        val realtimeCard = card(root, "实时控制", "Economy Live 使用本地断句；Native Live 主要使用模型侧 Smart Turn / VAD")
        label(realtimeCard, "本地自动断句速度")
        endpointSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                EndpointProfile.entries.map { "${it.title} · ${it.subtitle}" },
            )
        }
        realtimeCard.addView(endpointSpinner, matchWrap())
        bargeInSwitch = addSwitch(realtimeCard, "允许随时打断小派", "你一开口就立即停止当前 AI 播放并开始新一轮", true)
        transcriptSwitch = addSwitch(realtimeCard, "显示实时识别文字", "主界面显示你说的话和实时转写结果", true)

        root.addView(Button(this).apply {
            text = "保存并应用"
            textSize = 16f
            setTextColor(Color.WHITE)
            background = rounded(Color.rgb(79, 70, 229), dp(16).toFloat())
            setOnClickListener { saveAndFinish() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)).apply { topMargin = dp(22) })

        root.addView(TextView(this).apply {
            text = "保存后主界面会自动重新连接，让新的体验模式、模型路线和音色立即生效。"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(128, 138, 158))
            setPadding(0, dp(12), 0, 0)
        })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun loadValues(settings: AppSettings) {
        val modePosition = experienceModes.indexOfFirst { it.id == settings.experienceMode }.takeIf { it >= 0 } ?: 0
        experienceSpinner.setSelection(modePosition)
        val mode = experienceModes.getOrNull(modePosition)
        if (mode != null) {
            experienceDescription.text = "${mode.subtitle}\n模型：${mode.model}"
            refreshVoicesForMode(mode, preserveVoice = false, preferredVoice = settings.voiceId)
        }
        modeSpinner.setSelection(when (settings.interactionMode) {
            "owner_focus" -> 1
            "group" -> 2
            else -> 0
        })
        proactivitySeek.progress = (settings.socialProactivity * 100).roundToInt()
        proactivityValue.text = "${proactivitySeek.progress}%"
        aliasesInput.setText(settings.assistantAliases)
        endpointSpinner.setSelection(EndpointProfile.entries.indexOf(settings.endpointProfile).coerceAtLeast(0))
        bargeInSwitch.isChecked = settings.bargeInEnabled
        transcriptSwitch.isChecked = settings.showTranscript
        updatePreviewButton()
    }

    private fun refreshVoicesForMode(
        mode: ClientExperienceModeOption,
        preserveVoice: Boolean,
        preferredVoice: String? = null,
    ) {
        val previous = if (preserveVoice) voices.getOrNull(voiceSpinner.selectedItemPosition)?.id else preferredVoice
        voices = mode.voices
        voiceSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, voices.map { it.displayName() })
        val target = previous?.takeIf { value -> voices.any { it.id == value } } ?: mode.defaultVoice
        voiceSpinner.setSelection(voices.indexOfFirst { it.id == target }.coerceAtLeast(0))
        voiceDescription.text = voices.getOrNull(voiceSpinner.selectedItemPosition)?.description.orEmpty()
        updatePreviewButton()
    }

    private fun previewSelectedVoice() {
        val mode = experienceModes.getOrNull(experienceSpinner.selectedItemPosition) ?: return
        val voice = voices.getOrNull(voiceSpinner.selectedItemPosition) ?: return
        if (mode.engine != "omni_realtime" || !voice.previewable) {
            Toast.makeText(this, "当前模式的独立音色试听将在 Economy Live Humanizer 阶段继续完善", Toast.LENGTH_SHORT).show()
            return
        }
        previewButton.isEnabled = false
        previewButton.text = "正在生成试听…"
        ensurePreviewToken { tokenResult ->
            tokenResult.onSuccess { token ->
                mobileApi.previewVoice(token, mode.model, voice.id) { result ->
                    runOnUiThread {
                        previewButton.isEnabled = true
                        previewButton.text = "试听声音"
                        result.onSuccess { playPreview(it) }
                            .onFailure { Toast.makeText(this, it.message ?: "音色试听失败", Toast.LENGTH_LONG).show() }
                    }
                }
            }.onFailure {
                runOnUiThread {
                    previewButton.isEnabled = true
                    previewButton.text = "试听声音"
                    Toast.makeText(this, it.message ?: "无法获取试听会话", Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    private fun ensurePreviewToken(callback: (Result<String>) -> Unit) {
        previewToken?.takeIf { it.isNotBlank() }?.let {
            callback(Result.success(it))
            return
        }
        val deviceId = Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
            ?: "android-preview-${System.currentTimeMillis()}"
        mobileApi.bootstrap(deviceId) { result ->
            result.map { session ->
                previewToken = session.token
                session.token
            }.let(callback)
        }
    }

    private fun playPreview(audio: ByteArray) {
        previewTrack?.stopSafely()
        previewTrack?.release()
        val minBuffer = AudioTrack.getMinBufferSize(
            PREVIEW_SAMPLE_RATE,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        ).coerceAtLeast(audio.size)
        val track = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build(),
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(PREVIEW_SAMPLE_RATE)
                    .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(minBuffer)
            .setTransferMode(AudioTrack.MODE_STATIC)
            .build()
        val written = track.write(audio, 0, audio.size)
        if (written <= 0) {
            track.release()
            Toast.makeText(this, "试听音频播放失败", Toast.LENGTH_SHORT).show()
            return
        }
        previewTrack = track
        track.play()
    }

    private fun updatePreviewButton() {
        if (!::previewButton.isInitialized || !::voiceSpinner.isInitialized) return
        val mode = experienceModes.getOrNull(experienceSpinner.selectedItemPosition)
        val voice = voices.getOrNull(voiceSpinner.selectedItemPosition)
        val available = mode?.engine == "omni_realtime" && voice?.previewable == true
        previewButton.isEnabled = available
        previewButton.text = if (available) "试听声音" else "Economy 音色试听后续开放"
    }

    private fun saveAndFinish() {
        val current = AppSettings.load(this)
        val experience = experienceModes.getOrNull(experienceSpinner.selectedItemPosition)
        AppSettings.save(
            this,
            current.copy(
                experienceMode = experience?.id ?: current.experienceMode,
                voiceId = voices.getOrNull(voiceSpinner.selectedItemPosition)?.id ?: current.voiceId,
                interactionMode = when (modeSpinner.selectedItemPosition) {
                    1 -> "owner_focus"
                    2 -> "group"
                    else -> "auto"
                },
                socialProactivity = proactivitySeek.progress / 100f,
                assistantAliases = aliasesInput.text.toString().trim().ifBlank { "Aipany,小派" },
                endpointProfile = EndpointProfile.entries.getOrElse(endpointSpinner.selectedItemPosition) { EndpointProfile.BALANCED },
                bargeInEnabled = bargeInSwitch.isChecked,
                showTranscript = transcriptSwitch.isChecked,
            ),
        )
        setResult(RESULT_OK)
        finish()
    }

    private fun selectedMode(id: String): ClientExperienceModeOption? = experienceModes.firstOrNull { it.id == id }

    private fun card(parent: LinearLayout, title: String, subtitle: String): LinearLayout {
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
            background = rounded(Color.WHITE, dp(18).toFloat())
            addView(TextView(this@SettingsActivity).apply {
                text = title
                textSize = 18f
                setTextColor(Color.rgb(24, 32, 52))
            })
            addView(TextView(this@SettingsActivity).apply {
                text = subtitle
                textSize = 12f
                setTextColor(Color.rgb(112, 122, 142))
                setPadding(0, dp(3), 0, dp(6))
            })
            parent.addView(this, matchWrap(top = 16))
        }
    }

    private fun label(parent: LinearLayout, value: String) {
        parent.addView(TextView(this).apply {
            text = value
            textSize = 13f
            setTextColor(Color.rgb(70, 80, 100))
            setPadding(0, dp(12), 0, dp(5))
        })
    }

    @Suppress("DEPRECATION")
    private fun addSwitch(parent: LinearLayout, title: String, subtitle: String, checked: Boolean): Switch {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(14), 0, 0)
        }
        row.addView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SettingsActivity).apply {
                text = title
                textSize = 14f
                setTextColor(Color.rgb(40, 50, 70))
            })
            addView(TextView(this@SettingsActivity).apply {
                text = subtitle
                textSize = 11f
                setTextColor(Color.rgb(128, 138, 158))
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        val control = Switch(this).apply { isChecked = checked }
        row.addView(control)
        parent.addView(row, matchWrap())
        return control
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

    companion object {
        private const val PREVIEW_SAMPLE_RATE = 24_000
    }
}

private fun AudioTrack.stopSafely() {
    runCatching { if (playState == AudioTrack.PLAYSTATE_PLAYING) stop() }
}

private class SimpleItemSelectedListener(
    private val onSelected: (Int) -> Unit,
) : android.widget.AdapterView.OnItemSelectedListener {
    override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) = onSelected(position)
    override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
}
