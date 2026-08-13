package cn.mv3.aipany

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

class LiveDiagnosticsActivity : Activity() {
    private lateinit var healthClient: GatewayHealthClient
    private lateinit var diagnosisView: TextView
    private lateinit var localSummaryView: TextView
    private lateinit var healthView: TextView
    private lateinit var historyView: TextView
    private var lastHealth: GatewayHealthSnapshot? = null
    private var lastHealthError: String = "尚未完成 /health 探测"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        healthClient = GatewayHealthClient()
        buildUi()
        refresh()
    }

    override fun onResume() {
        super.onResume()
        if (::localSummaryView.isInitialized) refreshLocal()
    }

    override fun onDestroy() {
        runCatching { healthClient.close() }
        super.onDestroy()
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
        header.addView(TextView(this).apply {
            text = "实时链路诊断"
            textSize = 25f
            setTextColor(Color.rgb(20, 28, 48))
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        header.addView(Button(this).apply {
            text = "返回"
            setOnClickListener { finish() }
        }, LinearLayout.LayoutParams(dp(72), dp(44)))
        root.addView(header)

        root.addView(TextView(this).apply {
            text = "用于定位 手机 → Aipany Gateway → chat2api bridge → ChatGPT Voice / GPT-Live → Android 音频。可一键生成脱敏报告，不包含 API Key、管理员密码或设备 ID。"
            textSize = 12f
            setTextColor(Color.rgb(103, 113, 135))
            setPadding(0, dp(8), 0, dp(8))
        })

        diagnosisView = card(root, "自动根因判断")
        localSummaryView = card(root, "当前会话")
        healthView = card(root, "Gateway /health")
        historyView = card(root, "最近状态历史")

        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
        }
        actions.addView(Button(this).apply {
            text = "刷新"
            setOnClickListener { refresh() }
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginEnd = dp(6) })
        actions.addView(Button(this).apply {
            text = "导出报告"
            setOnClickListener { exportReport() }
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(6) })
        root.addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(14)
        })

        root.addView(Button(this).apply {
            text = "清空本地诊断历史"
            setOnClickListener {
                LiveDiagnosticsStore.clear()
                refreshLocal()
            }
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(48)).apply { topMargin = dp(8) })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun refresh() {
        refreshLocal()
        lastHealth = null
        lastHealthError = "正在探测 /health"
        renderDiagnosis()
        healthView.text = "正在检查 ${MobileApiClient.BASE_URL}/health …"
        healthClient.fetch { result ->
            runOnUiThread {
                result.fold(
                    onSuccess = { health ->
                        lastHealth = health
                        lastHealthError = ""
                        healthView.text = buildString {
                            appendLine("状态：${if (health.ok) "正常" else "异常"}")
                            appendLine("服务：${health.service} · ${health.version}")
                            appendLine("Realtime Engine：${health.realtimeEngine}")
                            appendLine("Native Live：${if (health.nativeLiveAvailable) "可用" else "不可用"}")
                            append("鉴权：${health.authMode}")
                        }
                    },
                    onFailure = { error ->
                        lastHealth = null
                        lastHealthError = error.message ?: error.javaClass.simpleName
                        healthView.text = "Gateway /health 请求失败\n${lastHealthError}\n\n如果当前会话仍在线，通常是 HTTP 探测受网络/代理影响；如果会话也断开，则优先检查手机网络与 Gateway。"
                    },
                )
                renderDiagnosis()
            }
        }
    }

    private fun refreshLocal() {
        val snapshot = LiveDiagnosticsStore.snapshot()
        val lastReady = formatTime(snapshot.lastReadyAtMs)
        val lastAudioReady = formatTime(snapshot.lastAudioReadyAtMs)
        localSummaryView.text = buildString {
            appendLine("Gateway：${snapshot.gatewayState}")
            appendLine("GPT-Live：${snapshot.upstreamState}")
            appendLine("模型：${snapshot.model.ifBlank { "未收到" }}")
            appendLine("恢复次数：${snapshot.recoveryAttempt}")
            appendLine("最近 GPT-Live 就绪：$lastReady")
            appendLine("Android 音频：${snapshot.androidAudioState}")
            appendLine("最近音频就绪：$lastAudioReady")
            appendLine("最近音频详情：${snapshot.androidAudioDetail.ifBlank { "—" }}")
            appendLine("最近上游详情：${snapshot.upstreamDetail.ifBlank { "—" }}")
            appendLine("延迟：${formatLatency(snapshot.latency)}")
            append("最近错误：${(snapshot.lastAudioError.ifBlank { snapshot.lastError }).ifBlank { "—" }}")
        }

        historyView.text = if (snapshot.events.isEmpty()) {
            "暂无状态记录。进入 ChatGPT Live 会话后，这里会记录最近 48 条 Gateway、GPT-Live、自动恢复和 Android 音频状态。"
        } else {
            snapshot.events.asReversed().joinToString("\n\n") { event ->
                buildString {
                    append(formatTime(event.timestampMs))
                    append(" · ")
                    append(event.source)
                    append(" · ")
                    append(event.state)
                    if (event.attempt > 0) append(" · 第 ${event.attempt} 次")
                    if (event.model.isNotBlank()) append(" · ${event.model}")
                    if (event.detail.isNotBlank()) append("\n${event.detail}")
                }
            }
        }
        renderDiagnosis()
    }

    private fun renderDiagnosis() {
        if (!::diagnosisView.isInitialized) return
        val assessment = diagnoseLiveChain(LiveDiagnosticsStore.snapshot(), lastHealth, lastHealthError)
        val severity = when (assessment.severity) {
            DiagnosticSeverity.OK -> "正常"
            DiagnosticSeverity.WARNING -> "需关注"
            DiagnosticSeverity.ERROR -> "异常"
        }
        diagnosisView.text = buildString {
            appendLine("判断：${assessment.title}")
            appendLine("层级：${assessment.layer.name.lowercase(Locale.US)} · $severity · 置信度 ${assessment.confidence}%")
            appendLine(assessment.summary)
            if (assessment.evidence.isNotEmpty()) {
                appendLine()
                appendLine("依据：")
                assessment.evidence.forEach { appendLine("• $it") }
            }
            if (assessment.actions.isNotEmpty()) {
                appendLine()
                appendLine("建议：")
                assessment.actions.forEachIndexed { index, action -> appendLine("${index + 1}. $action") }
            }
        }.trim()
    }

    private fun exportReport() {
        val snapshot = LiveDiagnosticsStore.snapshot()
        val assessment = diagnoseLiveChain(snapshot, lastHealth, lastHealthError)
        runCatching {
            val file = LiveDiagnosticReportExporter.writeReport(
                context = this,
                snapshot = snapshot,
                health = lastHealth,
                healthError = lastHealthError,
                assessment = assessment,
            )
            LiveDiagnosticReportExporter.shareReport(this, file)
        }.onFailure { error ->
            Toast.makeText(this, "诊断报告导出失败：${error.message ?: error.javaClass.simpleName}", Toast.LENGTH_LONG).show()
        }
    }

    private fun card(parent: LinearLayout, title: String): TextView {
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(14), dp(16), dp(16))
            background = rounded(Color.WHITE, dp(18).toFloat())
            addView(TextView(this@LiveDiagnosticsActivity).apply {
                text = title
                textSize = 12f
                setTextColor(Color.rgb(115, 124, 145))
                setPadding(0, 0, 0, dp(8))
            })
        }
        val body = TextView(this).apply {
            textSize = 14f
            setTextColor(Color.rgb(45, 55, 76))
            setLineSpacing(0f, 1.16f)
        }
        container.addView(body)
        parent.addView(container, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(12)
        })
        return body
    }

    private fun formatTime(timestampMs: Long): String {
        if (timestampMs <= 0L) return "—"
        return SimpleDateFormat("HH:mm:ss", Locale.getDefault()).format(Date(timestampMs))
    }

    private fun formatLatency(latency: LiveLatencySnapshot): String {
        fun part(value: Long): String = if (value >= 0L) "$value ms" else "—"
        return "说完→ASR ${part(latency.endpointToAsrMs)} · ASR→LLM ${part(latency.asrToLlmMs)} · LLM→首音频 ${part(latency.llmToAudioMs)} · 总首响 ${part(latency.totalFirstResponseMs)}"
    }

    private fun rounded(color: Int, radius: Float): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()
}
