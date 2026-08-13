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
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.roundToInt

class LiveDiagnosticsActivity : Activity() {
    private lateinit var healthClient: GatewayHealthClient
    private lateinit var localSummaryView: TextView
    private lateinit var healthView: TextView
    private lateinit var historyView: TextView

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
            text = "用于定位 手机 → Aipany Gateway → chat2api bridge → ChatGPT Voice / GPT-Live 的实时状态。页面不会显示 API Key。"
            textSize = 12f
            setTextColor(Color.rgb(103, 113, 135))
            setPadding(0, dp(8), 0, dp(8))
        })

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
            text = "清空历史"
            setOnClickListener {
                LiveDiagnosticsStore.clear()
                refreshLocal()
            }
        }, LinearLayout.LayoutParams(0, dp(50), 1f).apply { marginStart = dp(6) })
        root.addView(actions, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(14)
        })

        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun refresh() {
        refreshLocal()
        healthView.text = "正在检查 ${MobileApiClient.BASE_URL}/health …"
        healthClient.fetch { result ->
            runOnUiThread {
                result.fold(
                    onSuccess = { health ->
                        healthView.text = buildString {
                            appendLine("状态：${if (health.ok) "正常" else "异常"}")
                            appendLine("服务：${health.service} · ${health.version}")
                            appendLine("Realtime Engine：${health.realtimeEngine}")
                            appendLine("Native Live：${if (health.nativeLiveAvailable) "可用" else "不可用"}")
                            append("鉴权：${health.authMode}")
                        }
                    },
                    onFailure = { error ->
                        healthView.text = "Gateway /health 请求失败\n${error.message ?: error.javaClass.simpleName}\n\n如果当前会话仍在线，通常是 HTTP 探测受网络/代理影响；如果会话也断开，则优先检查 Gateway。"
                    },
                )
            }
        }
    }

    private fun refreshLocal() {
        val snapshot = LiveDiagnosticsStore.snapshot()
        val lastReady = formatTime(snapshot.lastReadyAtMs)
        localSummaryView.text = buildString {
            appendLine("Gateway：${snapshot.gatewayState}")
            appendLine("GPT-Live：${snapshot.upstreamState}")
            appendLine("模型：${snapshot.model.ifBlank { "未收到" }}")
            appendLine("恢复次数：${snapshot.recoveryAttempt}")
            appendLine("最近就绪：$lastReady")
            appendLine("最近详情：${snapshot.upstreamDetail.ifBlank { "—" }}")
            append("最近错误：${snapshot.lastError.ifBlank { "—" }}")
        }

        historyView.text = if (snapshot.events.isEmpty()) {
            "暂无状态记录。进入 ChatGPT Live 会话后，这里会记录最近 ${48} 条连接、就绪、链路波动和自动恢复状态。"
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

    private fun rounded(color: Int, radius: Float): GradientDrawable = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).roundToInt()
}
