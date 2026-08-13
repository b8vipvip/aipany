package cn.mv3.aipany

enum class DiagnosticLayer {
    HEALTHY,
    MOBILE_NETWORK,
    GATEWAY,
    CHAT2API_BRIDGE,
    CHATGPT_VOICE,
    GPT_LIVE_HEARTBEAT,
    ANDROID_AUDIO,
    REALTIME_LATENCY,
    UNKNOWN,
}

enum class DiagnosticSeverity {
    OK,
    WARNING,
    ERROR,
}

data class DiagnosticAssessment(
    val layer: DiagnosticLayer,
    val severity: DiagnosticSeverity,
    val confidence: Int,
    val title: String,
    val summary: String,
    val evidence: List<String>,
    val actions: List<String>,
)

fun diagnoseLiveChain(
    snapshot: LiveDiagnosticsSnapshot,
    health: GatewayHealthSnapshot? = null,
    healthError: String = "",
): DiagnosticAssessment {
    val events = snapshot.events
    val recentUpstream = events.filter { it.source == "upstream" }.takeLast(16)
    val gatewayFailure = snapshot.gatewayState.startsWith("连接失败") ||
        snapshot.gatewayState == "连接已断开" ||
        snapshot.gatewayState.startsWith("Bootstrap 失败")
    val healthFailure = health == null && healthError.isNotBlank()

    if (health != null && !health.ok) {
        return assessment(
            layer = DiagnosticLayer.GATEWAY,
            severity = DiagnosticSeverity.ERROR,
            confidence = 95,
            title = "Aipany Gateway 状态异常",
            summary = "手机能够访问 Gateway 的 /health，但服务端明确报告异常，优先处理 Gateway 本身。",
            evidence = listOf("/health ok=false", "Gateway：${snapshot.gatewayState}"),
            actions = listOf("检查 Aipany Gateway 进程与反向代理", "查看 Gateway CI/运行日志和 Observability 错误事件"),
        )
    }

    if (healthFailure && gatewayFailure) {
        return assessment(
            layer = DiagnosticLayer.MOBILE_NETWORK,
            severity = DiagnosticSeverity.ERROR,
            confidence = 68,
            title = "手机网络或 Gateway 不可达",
            summary = "WebSocket 与 /health 同时失败。仅凭手机侧无法完全区分本地网络、DNS/代理和 Gateway 停机，但故障发生在 Chat2API 之前。",
            evidence = listOf("Gateway：${snapshot.gatewayState}", "/health：${healthError.take(180)}"),
            actions = listOf("先切换 Wi‑Fi/蜂窝网络后重试", "确认 aipany.mv3.cn 可访问，再检查 Gateway 进程与反向代理"),
        )
    }

    if (health != null && !health.nativeLiveAvailable && snapshot.upstreamState in setOf("unknown", "connecting")) {
        return assessment(
            layer = DiagnosticLayer.GATEWAY,
            severity = DiagnosticSeverity.ERROR,
            confidence = 90,
            title = "Gateway 未提供 Native Live",
            summary = "Gateway 在线，但 /health 显示 Native Live 不可用，GPT-Live 会话无法正常建立。",
            evidence = listOf("Native Live：不可用", "GPT-Live：${snapshot.upstreamState}"),
            actions = listOf("检查 Aipany 的 CHAT2API_LIVE_* 配置是否完整", "确认 chat2api_live capability 在 Gateway 中处于可用状态"),
        )
    }

    val heartbeatEvidence = sequenceOf(snapshot.upstreamDetail, snapshot.lastError)
        .plus(recentUpstream.asSequence().map { it.detail })
        .any { it.contains("心跳") || it.contains("heartbeat", ignoreCase = true) || it.contains("pong", ignoreCase = true) }
    if (heartbeatEvidence && snapshot.upstreamState in setOf("degraded", "recovering", "unavailable")) {
        return assessment(
            layer = DiagnosticLayer.GPT_LIVE_HEARTBEAT,
            severity = DiagnosticSeverity.ERROR,
            confidence = 96,
            title = "GPT-Live 心跳异常",
            summary = "Gateway 与 bridge 已经建立过实时链路，但 GPT-Live 心跳/存活检测触发降级或恢复。",
            evidence = listOfNotBlank(snapshot.upstreamDetail, snapshot.lastError, "状态：${snapshot.upstreamState}"),
            actions = listOf("检查 Gateway 到 chat2api 的长连接稳定性与反向代理超时", "观察自动恢复能否重新进入 ready；若频繁复发，重点排查网络抖动"),
        )
    }

    if (snapshot.upstreamState == "bridge_connected") {
        return assessment(
            layer = DiagnosticLayer.CHATGPT_VOICE,
            severity = DiagnosticSeverity.WARNING,
            confidence = 92,
            title = "ChatGPT Voice 会话尚未就绪",
            summary = "Aipany 已连接 chat2api bridge，但尚未收到上游 session.ready，故障点位于 bridge 之后、GPT-Live ready 之前。",
            evidence = listOf("GPT-Live：bridge_connected", snapshot.upstreamDetail.ifBlank { "bridge 已连接，等待 Voice ready" }),
            actions = listOf("检查浏览器 Voice 页面是否已经绑定并可用", "等待自动恢复；若持续停留在此状态，重点检查 ChatGPT Voice 会话建立"),
        )
    }

    if (snapshot.upstreamState == "connecting") {
        return assessment(
            layer = DiagnosticLayer.CHAT2API_BRIDGE,
            severity = DiagnosticSeverity.WARNING,
            confidence = 86,
            title = "正在连接 chat2api bridge",
            summary = "Gateway 已进入 GPT-Live 模式，但尚未确认 chat2api WebSocket 建立。",
            evidence = listOf("GPT-Live：connecting", snapshot.upstreamDetail.ifBlank { "尚未收到 bridge_connected" }),
            actions = listOf("检查 Aipany Gateway 到 chat2api 的网络/DNS/反向代理", "确认 CHAT2API_LIVE_BASE_URL 与鉴权配置有效"),
        )
    }

    if (snapshot.upstreamState in setOf("degraded", "recovering", "unavailable")) {
        val bridgeSeen = recentUpstream.any { it.state == "bridge_connected" }
        val readySeen = recentUpstream.any { it.state == "ready" } || snapshot.lastReadyAtMs > 0L
        val layer = when {
            !bridgeSeen && !readySeen -> DiagnosticLayer.CHAT2API_BRIDGE
            bridgeSeen && !readySeen -> DiagnosticLayer.CHATGPT_VOICE
            else -> DiagnosticLayer.CHATGPT_VOICE
        }
        val title = if (layer == DiagnosticLayer.CHAT2API_BRIDGE) "chat2api bridge 链路异常" else "ChatGPT Voice / GPT-Live 会话异常"
        return assessment(
            layer = layer,
            severity = DiagnosticSeverity.ERROR,
            confidence = if (bridgeSeen || readySeen) 86 else 80,
            title = title,
            summary = "上游实时链路正在降级或自动恢复，当前状态为 ${snapshot.upstreamState}。",
            evidence = listOfNotBlank(snapshot.upstreamDetail, snapshot.lastError, "恢复次数：${snapshot.recoveryAttempt}"),
            actions = listOf("保持 Aipany 主连接并观察自动恢复结果", "若连续恢复失败，结合导出报告中的最近状态顺序定位 bridge 或 Voice 会话"),
        )
    }

    if (snapshot.upstreamState == "ready" && snapshot.androidAudioState in setOf("audio_timeout", "audio_failed")) {
        return assessment(
            layer = DiagnosticLayer.ANDROID_AUDIO,
            severity = DiagnosticSeverity.ERROR,
            confidence = 97,
            title = "Android 音频设备启动失败",
            summary = "GPT-Live 已经 ready，但手机麦克风/音频引擎没有正常启动，故障在 Android 本地音频层。",
            evidence = listOfNotBlank("GPT-Live：ready", snapshot.androidAudioDetail, snapshot.lastAudioError),
            actions = listOf("检查麦克风权限和系统是否占用录音设备", "重新连接；若仍失败，重启应用并检查蓝牙/USB 音频设备切换"),
        )
    }

    val totalMs = snapshot.latency.totalFirstResponseMs
    if (snapshot.upstreamState == "ready" && totalMs >= 8_000L) {
        return assessment(
            layer = DiagnosticLayer.REALTIME_LATENCY,
            severity = DiagnosticSeverity.ERROR,
            confidence = 88,
            title = "实时首响严重偏慢",
            summary = "链路已经 ready，但最近一次从说完到首音频耗时 ${totalMs} ms。",
            evidence = latencyEvidence(snapshot.latency),
            actions = listOf("根据报告中的 ASR/LLM/首音频分段耗时定位慢点", "若主要耗时在首音频前且伴随恢复事件，优先检查 GPT-Live 上游"),
        )
    }
    if (snapshot.upstreamState == "ready" && totalMs >= 4_000L) {
        return assessment(
            layer = DiagnosticLayer.REALTIME_LATENCY,
            severity = DiagnosticSeverity.WARNING,
            confidence = 82,
            title = "实时首响偏慢",
            summary = "链路在线，但最近一次总首响为 ${totalMs} ms，建议继续观察分段延迟。",
            evidence = latencyEvidence(snapshot.latency),
            actions = listOf("连续测试多轮确认是否稳定复现", "对照 ASR → LLM 与 LLM → 首音频耗时判断上游瓶颈"),
        )
    }

    if (snapshot.upstreamState == "ready") {
        val evidence = mutableListOf("GPT-Live：ready")
        if (snapshot.androidAudioState == "audio_ready") evidence += "Android 音频：ready"
        if (health?.ok == true) evidence += "Gateway /health：正常"
        if (totalMs > 0L) evidence += "最近总首响：${totalMs} ms"
        return assessment(
            layer = DiagnosticLayer.HEALTHY,
            severity = DiagnosticSeverity.OK,
            confidence = if (health?.ok == true) 96 else 90,
            title = "实时语音链路当前正常",
            summary = "Gateway、chat2api bridge、ChatGPT Voice / GPT-Live 当前没有发现明确故障。",
            evidence = evidence,
            actions = listOf("若仍主观感觉异常，可导出报告保留最近状态与延迟", "复现问题后立即打开诊断页，避免后续正常状态覆盖关键线索"),
        )
    }

    if (health?.ok == true && snapshot.upstreamState == "unknown") {
        return assessment(
            layer = DiagnosticLayer.UNKNOWN,
            severity = DiagnosticSeverity.WARNING,
            confidence = 55,
            title = "Gateway 正常，但尚无 GPT-Live 状态",
            summary = "Gateway 可以访问，但当前诊断历史里还没有 GPT-Live upstream.status，可能尚未进入 ChatGPT Live 会话。",
            evidence = listOf("/health：正常", "GPT-Live：unknown"),
            actions = listOf("先进入 ChatGPT Live 并完成一次连接", "若始终没有 upstream.status，再检查当前体验模式是否为 chat2api_live"),
        )
    }

    return assessment(
        layer = DiagnosticLayer.UNKNOWN,
        severity = DiagnosticSeverity.WARNING,
        confidence = 45,
        title = "暂时无法确定单一根因",
        summary = "现有状态不足以把故障稳定归因到某一层，建议刷新 /health 并复现一次完整语音会话。",
        evidence = listOfNotBlank("Gateway：${snapshot.gatewayState}", "GPT-Live：${snapshot.upstreamState}", healthError),
        actions = listOf("点击刷新后重新连接一次", "问题复现后立即导出诊断报告"),
    )
}

private fun assessment(
    layer: DiagnosticLayer,
    severity: DiagnosticSeverity,
    confidence: Int,
    title: String,
    summary: String,
    evidence: List<String>,
    actions: List<String>,
): DiagnosticAssessment = DiagnosticAssessment(
    layer = layer,
    severity = severity,
    confidence = confidence.coerceIn(0, 100),
    title = title,
    summary = summary,
    evidence = evidence.filter { it.isNotBlank() }.take(6),
    actions = actions.filter { it.isNotBlank() }.take(4),
)

private fun listOfNotBlank(vararg values: String): List<String> = values.filter { it.isNotBlank() }

private fun latencyEvidence(latency: LiveLatencySnapshot): List<String> = buildList {
    if (latency.endpointToAsrMs >= 0L) add("说完 → ASR：${latency.endpointToAsrMs} ms")
    if (latency.asrToLlmMs >= 0L) add("ASR → LLM：${latency.asrToLlmMs} ms")
    if (latency.llmToAudioMs >= 0L) add("LLM → 首音频：${latency.llmToAudioMs} ms")
    if (latency.totalFirstResponseMs >= 0L) add("总首响：${latency.totalFirstResponseMs} ms")
}
