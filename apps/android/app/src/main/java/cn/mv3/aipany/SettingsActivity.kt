package cn.mv3.aipany

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
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
import kotlin.math.roundToInt

class SettingsActivity : Activity() {
    private lateinit var voices: List<ClientVoiceOption>
    private lateinit var voiceSpinner: Spinner
    private lateinit var voiceDescription: TextView
    private lateinit var modeSpinner: Spinner
    private lateinit var proactivitySeek: SeekBar
    private lateinit var proactivityValue: TextView
    private lateinit var aliasesInput: EditText
    private lateinit var endpointSpinner: Spinner
    private lateinit var bargeInSwitch: Switch
    private lateinit var transcriptSwitch: Switch

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        voices = ClientCapabilitiesCache.loadVoices(this)
        buildUi()
        loadValues()
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
                text = "让声音和对话方式更像你喜欢的样子"
                textSize = 13f
                setTextColor(Color.rgb(100, 112, 138))
            })
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        root.addView(header)

        val voiceCard = card(root, "声音", "选择小派回答时使用的实时音色")
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
        })

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

        val realtimeCard = card(root, "实时体验", "本地断句决定你说完后多快提交给服务端")
        label(realtimeCard, "自动断句速度")
        endpointSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@SettingsActivity,
                android.R.layout.simple_spinner_dropdown_item,
                EndpointProfile.entries.map { "${it.title} · ${it.subtitle}" },
            )
        }
        realtimeCard.addView(endpointSpinner, matchWrap())
        bargeInSwitch = addSwitch(realtimeCard, "允许随时打断小派", "你一开口就立即停止当前 AI 播放并开始新一轮", true)
        transcriptSwitch = addSwitch(realtimeCard, "显示实时识别文字", "主界面显示你说的话和 ASR 实时结果", true)

        root.addView(Button(this).apply {
            text = "保存并应用"
            textSize = 16f
            setTextColor(Color.WHITE)
            background = rounded(Color.rgb(79, 70, 229), dp(16).toFloat())
            setOnClickListener { saveAndFinish() }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(54)).apply { topMargin = dp(22) })

        root.addView(TextView(this).apply {
            text = "保存后主界面会自动重新连接，让新的音色和会话偏好立即生效。"
            textSize = 12f
            gravity = Gravity.CENTER
            setTextColor(Color.rgb(128, 138, 158))
            setPadding(0, dp(12), 0, 0)
        })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun loadValues() {
        val settings = AppSettings.load(this)
        voiceSpinner.setSelection(voices.indexOfFirst { it.id == settings.voiceId }.coerceAtLeast(0))
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
    }

    private fun saveAndFinish() {
        val current = AppSettings.load(this)
        AppSettings.save(
            this,
            current.copy(
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
}

private class SimpleItemSelectedListener(
    private val onSelected: (Int) -> Unit,
) : android.widget.AdapterView.OnItemSelectedListener {
    override fun onItemSelected(parent: android.widget.AdapterView<*>?, view: View?, position: Int, id: Long) = onSelected(position)
    override fun onNothingSelected(parent: android.widget.AdapterView<*>?) = Unit
}
