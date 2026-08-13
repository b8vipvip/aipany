package cn.mv3.aipany

data class Chat2ApiUpstreamUiStatus(
    val summary: String,
    val title: String,
    val subtitle: String,
)

fun chat2ApiUpstreamUiStatus(
    state: String,
    detail: String = "",
    attempt: Int = 0,
): Chat2ApiUpstreamUiStatus {
    LiveDiagnosticsStore.recordUpstream(state = state, detail = detail, attempt = attempt)
    val cleanDetail = detail.trim()
    return when (state) {
        "connecting" -> Chat2ApiUpstreamUiStatus(
            summary = "GPT-Live · 正在连接",
            title = "正在连接 ChatGPT Live",
            subtitle = cleanDetail.ifBlank { "正在连接 chat2api bridge" },
        )
        "bridge_connected" -> Chat2ApiUpstreamUiStatus(
            summary = "chat2api bridge 在线 · Voice 准备中",
            title = "Chat2API 已连接",
            subtitle = "浏览器桥在线 · 正在等待 ChatGPT Voice / GPT-Live 就绪",
        )
        "ready" -> Chat2ApiUpstreamUiStatus(
            summary = "chat2api bridge 在线 · Voice 已就绪 · GPT-Live 在线",
            title = "GPT-Live 已就绪",
            subtitle = "浏览器桥在线 · ChatGPT Voice 会话已就绪",
        )
        "recovering" -> {
            val suffix = if (attempt > 0) " · 第 ${attempt} 次" else ""
            Chat2ApiUpstreamUiStatus(
                summary = "GPT-Live 自动恢复中$suffix",
                title = "正在恢复 GPT-Live",
                subtitle = cleanDetail.ifBlank { "Aipany 正在重新建立 ChatGPT Voice 会话" },
            )
        }
        "degraded" -> Chat2ApiUpstreamUiStatus(
            summary = "GPT-Live 链路波动 · 自动恢复中",
            title = "GPT-Live 链路波动",
            subtitle = cleanDetail.ifBlank { "Aipany 正在自动恢复实时语音链路" },
        )
        "unavailable" -> Chat2ApiUpstreamUiStatus(
            summary = "GPT-Live 暂不可用 · 等待恢复",
            title = "GPT-Live 暂不可用",
            subtitle = cleanDetail.ifBlank { "浏览器 Voice 链路暂不可用，Aipany 会自动重试" },
        )
        "closed" -> Chat2ApiUpstreamUiStatus(
            summary = "GPT-Live 会话已关闭",
            title = "GPT-Live 会话已关闭",
            subtitle = cleanDetail.ifBlank { "实时语音会话已结束" },
        )
        else -> Chat2ApiUpstreamUiStatus(
            summary = "GPT-Live · $state",
            title = "ChatGPT Live 状态更新",
            subtitle = cleanDetail.ifBlank { state },
        )
    }
}
