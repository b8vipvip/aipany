package cn.mv3.aipany

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.AdapterView
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
    private lateinit var autoUpdateSwitch: Switch
    private lateinit var mobileApi: MobileApiClient

    private var previewToken: String? = null
    private var previewTrack: AudioTrack? = null
    private var loadingValues = true
    private var initialized = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mobileApi = MobileApiClient()
        val result = runCatching {
            val initial = AppSettings.load(this)
            experienceModes = ClientCapabilitiesCache.loadExperienceModes(this)
                .filter { it.id.isNotBlank() }
            require(experienceModes.isNotEmpty()) { "实时体验模式列表为空" }
            voices = selectedMode(initial.experienceMode)?.voices.orEmpty()
                .ifEmpty { ClientCapabilitiesCache.loadVoices(this) }
                .filter { it.id.isNotBlank() }
            buildUi()
            loadValues(initial)
            installListeners()
            loadingValues = false
            initialized = true
        }
        result.onFailure { showRecoveryScreen(it) }
    }

    override fun onDestroy() {
        runCatching { previewTrack?.stopSafely() }
        runCatching { previewTrack?.release() }
        previewTrack = null
        if (::mobileApi.isInitialized) runCatching { mobileApi.release() }
        super.onDestroy()
    }

    private fun buildUi() {
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(16), dp(18), dp(34))
            setBackgroundColor(PAGE_BG)
        }
        page.addView(buildHeader())

        val experienceCard = sectionCard(
            page,
            "实时体验模式",
            "在 Economy Live 与服务器已启用的原生实时语音之间切换。",
        )
        fieldLabel(experienceCard, "体验模式")
        experienceSpinner = styledSpinner(experienceModes.map { it.title })
        experienceCard.addView(experienceSpinner, matchWrap(top = 6))
        experienceDescription = bodyText()
        experienceCard.addView(experienceDescription, matchWrap(top = 9))

        fieldLabel(experienceCard, "声音")
        voiceSpinner = styledSpinner(voices.map { it.displayName() })
        experienceCard.addView(voiceSpinner, matchWrap(top = 6))
        voiceDescription = bodyText()
        experienceCard.addView(voiceDescription, matchWrap(top = 9))
        previewButton = secondaryButton("试听当前音色")
        experienceCard.addView(previewButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply {
            topMargin = dp(12)
        })

        val conversationCard = sectionCard(
            page,
            "对话方式",
            "控制小派如何参与、主动回应和识别称呼。",
        )
        fieldLabel(conversationCard, "交互模式")
        modeSpinner = styledSpinner(listOf("自动判断", "专注主人", "多人聊天"))
        conversationCard.addView(modeSpinner, matchWrap(top = 6))

        val proactivityHeader = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        proactivityHeader.addView(TextView(this).apply {
            text = "主动参与程度"
            textSize = 14f
            setTextColor(TEXT_PRIMARY)
            setTypeface(typeface, Typeface.BOLD)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        proactivityValue = valueBadge()
        proactivityHeader.addView(proactivityValue)
        conversationCard.addView(proactivityHeader, matchWrap(top = 18))
        proactivitySeek = SeekBar(this).apply { max = 100 }
        conversationCard.addView(proactivitySeek, matchWrap(top = 4))
        conversationCard.addView(hintText("数值越高，小派越愿意自然参与；不会再用固定“我在听”话术刷存在感。"), matchWrap(top = 2))

        fieldLabel(conversationCard, "唤醒名 / 助手别名")
        aliasesInput = EditText(this).apply {
            hint = "Aipany, 小派"
            textSize = 15f
            setSingleLine(true)
            background = rounded(Color.WHITE, dp(14).toFloat(), BORDER)
            setPadding(dp(14), dp(12), dp(14), dp(12))
        }
        conversationCard.addView(aliasesInput, matchWrap(top = 6))

        val realtimeCard = sectionCard(
            page,
            "实时控制",
            "调整断句、打断和转写显示。",
        )
        fieldLabel(realtimeCard, "本地自动断句")
        endpointSpinner = styledSpinner(EndpointProfile.entries.map { "${it.title} · ${it.subtitle}" })
        realtimeCard.addView(endpointSpinner, matchWrap(top = 6))
        bargeInSwitch = settingsSwitch(
            realtimeCard,
            "允许随时打断小派",
            "检测到你开口后立即停止当前语音。",
            true,
        )
        transcriptSwitch = settingsSwitch(
            realtimeCard,
            "显示实时识别文字",
            "在主界面显示转写内容。",
            true,
        )

        val updateCard = sectionCard(
            page,
            "关于与更新",
            "GitHub Release 分发，下载完成后校验 APK 完整性。",
        )
        updateCard.addView(infoRow("当前版本", "${BuildConfig.VERSION_NAME}  (${BuildConfig.VERSION_CODE})"), matchWrap(top = 8))
        updateCard.addView(infoRow("更新通道", if (BuildConfig.DEBUG) "开发调试版" else "开发预览版"), matchWrap(top = 4))
        autoUpdateSwitch = settingsSwitch(
            updateCard,
            "自动检查新版本",
            "启动应用及联网后台任务会检查更新。",
            runCatching { AppUpdateManager.isAutoCheckEnabled(this) }.getOrDefault(true),
        )
        updateCard.addView(secondaryButton("检查更新").apply {
            setOnClickListener {
                runCatching { AppUpdateManager.checkForUpdate(this@SettingsActivity, interactive = true) }
                    .onFailure { showToast("检查更新启动失败：${it.javaClass.simpleName}") }
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(14) })

        page.addView(primaryButton("保存并应用设置").apply {
            textSize = 16f
            setOnClickListener { saveAndFinish() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(56)).apply { topMargin = dp(22) })
        page.addView(hintText("保存后主界面会重新建立语音会话，使模式、音色和实时控制立即生效。").apply {
            gravity = Gravity.CENTER
        }, matchWrap(top = 10))

        setContentView(ScrollView(this).apply {
            isFillViewport = true
            addView(page)
        })
    }

    private fun installListeners() {
        experienceSpinner.onItemSelectedListener = SimpleItemSelectedListener { position ->
            val selected = experienceModes.getOrNull(position) ?: return@SimpleItemSelectedListener
            experienceDescription.text = "${selected.subtitle}\n模型 · ${selected.model}"
            refreshVoicesForMode(selected, preserveVoice = !loadingValues)
        }
        voiceSpinner.onItemSelectedListener = SimpleItemSelectedListener { position ->
            voiceDescription.text = voices.getOrNull(position)?.description.orEmpty()
            updatePreviewButton()
        }
        proactivitySeek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(seekBar: SeekBar?, progress: Int, fromUser: Boolean) {
                proactivityValue.text = "$progress%"
            }
            override fun onStartTrackingTouch(seekBar: SeekBar?) = Unit
            override fun onStopTrackingTouch(seekBar: SeekBar?) = Unit
        })
        previewButton.setOnClickListener { previewSelectedVoice() }
        autoUpdateSwitch.setOnCheckedChangeListener { _, checked ->
            if (loadingValues) return@setOnCheckedChangeListener
            runCatching { AppUpdateManager.setAutoCheckEnabled(this, checked) }
                .onFailure { showToast("更新设置保存失败：${it.javaClass.simpleName}") }
        }
    }

    private fun loadValues(settings: AppSettings) {
        val modePosition = experienceModes.indexOfFirst { it.id == settings.experienceMode }.takeIf { it >= 0 } ?: 0
        experienceSpinner.setSelection(modePosition, false)
        experienceModes.getOrNull(modePosition)?.let { mode ->
            experienceDescription.text = "${mode.subtitle}\n模型 · ${mode.model}"
            refreshVoicesForMode(mode, preserveVoice = false, preferredVoice = settings.voiceId)
        }
        modeSpinner.setSelection(
            when (settings.interactionMode) {
                "owner_focus" -> 1
                "group" -> 2
                else -> 0
            },
            false,
        )
        proactivitySeek.progress = (settings.socialProactivity * 100).roundToInt()
        proactivityValue.text = "${proactivitySeek.progress}%"
        aliasesInput.setText(settings.assistantAliases)
        endpointSpinner.setSelection(EndpointProfile.entries.indexOf(settings.endpointProfile).coerceAtLeast(0), false)
        bargeInSwitch.isChecked = settings.bargeInEnabled
        transcriptSwitch.isChecked = settings.showTranscript
        autoUpdateSwitch.isChecked = runCatching { AppUpdateManager.isAutoCheckEnabled(this) }.getOrDefault(true)
        updatePreviewButton()
    }

    private fun refreshVoicesForMode(
        mode: ClientExperienceModeOption,
        preserveVoice: Boolean,
        preferredVoice: String? = null,
    ) {
        val previous = if (preserveVoice && ::voiceSpinner.isInitialized) {
            voices.getOrNull(voiceSpinner.selectedItemPosition)?.id
        } else {
            preferredVoice
        }
        voices = mode.voices.filter { it.id.isNotBlank() }
            .ifEmpty { ClientCapabilitiesCache.loadVoices(this).filter { it.id.isNotBlank() } }
        if (!::voiceSpinner.isInitialized) return
        voiceSpinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, voices.map { it.displayName() })
        val target = previous?.takeIf { value -> voices.any { it.id == value } }
            ?: mode.defaultVoice.takeIf { value -> voices.any { it.id == value } }
            ?: voices.firstOrNull()?.id
        val position = voices.indexOfFirst { it.id == target }.coerceAtLeast(0)
        voiceSpinner.setSelection(position, false)
        voiceDescription.text = voices.getOrNull(position)?.description.orEmpty()
        updatePreviewButton()
    }

    private fun previewSelectedVoice() {
        if (!initialized) return
        val mode = experienceModes.getOrNull(experienceSpinner.selectedItemPosition) ?: return
        val voice = voices.getOrNull(voiceSpinner.selectedItemPosition) ?: return
        if (!voice.previewable) {
            showToast("当前模型暂不支持独立音色试听")
            return
        }
        previewButton.isEnabled = false
        previewButton.text = "正在生成试听…"
        ensurePreviewToken { tokenResult ->
            tokenResult.onSuccess { token ->
                mobileApi.previewVoice(token, mode.model, voice.id) { result ->
                    runOnUiThread {
                        if (isFinishing || isDestroyed) return@runOnUiThread
                        previewButton.isEnabled = true
                        previewButton.text = "试听当前音色"
                        result.onSuccess { playPreview(it) }
                            .onFailure { showToast(it.message ?: "音色试听失败") }
                    }
                }
            }.onFailure { error ->
                runOnUiThread {
                    if (isFinishing || isDestroyed) return@runOnUiThread
                    previewButton.isEnabled = true
                    previewButton.text = "试听当前音色"
                    showToast(error.message ?: "无法获取试听会话")
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
        runCatching {
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
            check(track.state == AudioTrack.STATE_INITIALIZED) { "AudioTrack 未初始化" }
            check(track.write(audio, 0, audio.size) > 0) { "试听音频写入失败" }
            previewTrack = track
            track.play()
        }.onFailure { showToast("试听音频播放失败：${it.javaClass.simpleName}") }
    }

    private fun updatePreviewButton() {
        if (!::previewButton.isInitialized || !::voiceSpinner.isInitialized) return
        val available = voices.getOrNull(voiceSpinner.selectedItemPosition)?.previewable == true
        previewButton.isEnabled = available
        previewButton.alpha = if (available) 1f else 0.48f
        previewButton.text = if (available) "试听当前音色" else "当前音色暂不可试听"
    }

    private fun saveAndFinish() {
        val result = runCatching {
            val current = AppSettings.load(this)
            val experience = experienceModes.getOrNull(experienceSpinner.selectedItemPosition)
            val value = current.copy(
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
            )
            AppSettings.save(this, value)
            runCatching { AppUpdateManager.setAutoCheckEnabled(this, autoUpdateSwitch.isChecked) }
            setResult(RESULT_OK)
            finish()
        }
        result.onFailure { showToast("设置保存失败：${it.javaClass.simpleName}") }
    }

    private fun showRecoveryScreen(error: Throwable) {
        initialized = false
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(24), dp(36), dp(24), dp(36))
            setBackgroundColor(PAGE_BG)
            addView(TextView(this@SettingsActivity).apply {
                text = "设置页已安全恢复"
                textSize = 24f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(TEXT_PRIMARY)
            })
            addView(TextView(this@SettingsActivity).apply {
                text = "某项本地配置未能加载，APP没有退出。错误类型：${error.javaClass.simpleName}"
                textSize = 14f
                gravity = Gravity.CENTER
                setTextColor(TEXT_SECONDARY)
                setPadding(0, dp(14), 0, dp(20))
            })
            addView(primaryButton("恢复默认设置并返回").apply {
                setOnClickListener {
                    AppSettings.save(this@SettingsActivity, AppSettings())
                    finish()
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)))
            addView(secondaryButton("关闭设置页").apply { setOnClickListener { finish() } },
                LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(50)).apply { topMargin = dp(12) })
        }
        setContentView(page)
    }

    private fun buildHeader(): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(Button(this@SettingsActivity).apply {
            text = "‹"
            textSize = 28f
            setTextColor(TEXT_PRIMARY)
            background = rounded(Color.WHITE, dp(14).toFloat(), BORDER)
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(52), dp(48)).apply { marginEnd = dp(12) })
        addView(LinearLayout(this@SettingsActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SettingsActivity).apply {
                text = "小派设置"
                textSize = 27f
                setTextColor(TEXT_PRIMARY)
                setTypeface(typeface, Typeface.BOLD)
            })
            addView(TextView(this@SettingsActivity).apply {
                text = "语音体验、对话偏好与应用更新"
                textSize = 13f
                setTextColor(TEXT_SECONDARY)
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
    }

    private fun selectedMode(id: String): ClientExperienceModeOption? = experienceModes.firstOrNull { it.id == id }

    private fun sectionCard(parent: LinearLayout, title: String, subtitle: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(18), dp(18), dp(18), dp(18))
        background = rounded(Color.WHITE, dp(22).toFloat(), CARD_BORDER)
        addView(TextView(this@SettingsActivity).apply {
            text = title
            textSize = 20f
            setTextColor(TEXT_PRIMARY)
            setTypeface(typeface, Typeface.BOLD)
        })
        addView(TextView(this@SettingsActivity).apply {
            text = subtitle
            textSize = 12f
            setTextColor(TEXT_SECONDARY)
            setPadding(0, dp(5), 0, 0)
        })
        parent.addView(this, matchWrap(top = 16))
    }

    private fun styledSpinner(items: List<String>): Spinner = Spinner(this).apply {
        adapter = ArrayAdapter(this@SettingsActivity, android.R.layout.simple_spinner_dropdown_item, items)
        background = rounded(INPUT_BG, dp(14).toFloat(), BORDER)
        setPadding(dp(12), dp(4), dp(8), dp(4))
        minimumHeight = dp(52)
    }

    private fun fieldLabel(parent: LinearLayout, value: String) {
        parent.addView(TextView(this).apply {
            text = value
            textSize = 13f
            setTextColor(TEXT_PRIMARY)
            setTypeface(typeface, Typeface.BOLD)
        }, matchWrap(top = 18))
    }

    private fun bodyText(): TextView = TextView(this).apply {
        textSize = 13f
        setTextColor(TEXT_SECONDARY)
        setLineSpacing(0f, 1.16f)
    }

    private fun hintText(value: String): TextView = TextView(this).apply {
        text = value
        textSize = 11f
        setTextColor(TEXT_MUTED)
        setLineSpacing(0f, 1.12f)
    }

    private fun valueBadge(): TextView = TextView(this).apply {
        textSize = 13f
        gravity = Gravity.CENTER
        setTextColor(ACCENT)
        setTypeface(typeface, Typeface.BOLD)
        background = rounded(ACCENT_SOFT, dp(14).toFloat())
        setPadding(dp(10), dp(5), dp(10), dp(5))
    }

    private fun infoRow(label: String, value: String): LinearLayout = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(TextView(this@SettingsActivity).apply {
            text = label
            textSize = 13f
            setTextColor(TEXT_SECONDARY)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        addView(TextView(this@SettingsActivity).apply {
            text = value
            textSize = 13f
            setTextColor(TEXT_PRIMARY)
            setTypeface(typeface, Typeface.BOLD)
        })
    }

    @Suppress("DEPRECATION")
    private fun settingsSwitch(parent: LinearLayout, title: String, subtitle: String, checked: Boolean): Switch {
        val control = Switch(this).apply { isChecked = checked }
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, dp(16), 0, 0)
            addView(LinearLayout(this@SettingsActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(TextView(this@SettingsActivity).apply {
                    text = title
                    textSize = 14f
                    setTextColor(TEXT_PRIMARY)
                    setTypeface(typeface, Typeface.BOLD)
                })
                addView(TextView(this@SettingsActivity).apply {
                    text = subtitle
                    textSize = 11f
                    setTextColor(TEXT_MUTED)
                    setPadding(0, dp(3), dp(12), 0)
                })
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
            addView(control)
        }
        parent.addView(row, matchWrap())
        return control
    }

    private fun primaryButton(label: String): Button = Button(this).apply {
        text = label
        textSize = 14f
        setTextColor(Color.WHITE)
        setTypeface(typeface, Typeface.BOLD)
        background = rounded(ACCENT, dp(16).toFloat())
    }

    private fun secondaryButton(label: String): Button = Button(this).apply {
        text = label
        textSize = 14f
        setTextColor(ACCENT)
        setTypeface(typeface, Typeface.BOLD)
        background = rounded(ACCENT_SOFT, dp(16).toFloat(), Color.rgb(205, 211, 255))
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

    private fun showToast(message: String) = Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()

    companion object {
        private const val PREVIEW_SAMPLE_RATE = 24_000
        private val PAGE_BG = Color.rgb(244, 246, 251)
        private val TEXT_PRIMARY = Color.rgb(24, 31, 50)
        private val TEXT_SECONDARY = Color.rgb(91, 103, 126)
        private val TEXT_MUTED = Color.rgb(125, 136, 157)
        private val ACCENT = Color.rgb(79, 70, 229)
        private val ACCENT_SOFT = Color.rgb(238, 240, 255)
        private val INPUT_BG = Color.rgb(249, 250, 253)
        private val BORDER = Color.rgb(220, 225, 236)
        private val CARD_BORDER = Color.rgb(230, 233, 241)
    }
}

private fun AudioTrack.stopSafely() {
    runCatching { if (playState == AudioTrack.PLAYSTATE_PLAYING) stop() }
}

private class SimpleItemSelectedListener(
    private val onSelected: (Int) -> Unit,
) : AdapterView.OnItemSelectedListener {
    override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) = onSelected(position)
    override fun onNothingSelected(parent: AdapterView<*>?) = Unit
}
