package cn.mv3.aipany

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object LiveDiagnosticReportExporter {
    fun buildReport(
        snapshot: LiveDiagnosticsSnapshot,
        health: GatewayHealthSnapshot?,
        healthError: String,
        assessment: DiagnosticAssessment = diagnoseLiveChain(snapshot, health, healthError),
        generatedAtMs: Long = System.currentTimeMillis(),
    ): JSONObject {
        val root = JSONObject()
            .put("schema", "aipany-live-diagnostics-v1")
            .put("generatedAtMs", generatedAtMs)
            .put("generatedAt", isoTime(generatedAtMs))
            .put("app", JSONObject()
                .put("version", BuildConfig.VERSION_NAME)
                .put("versionCode", BuildConfig.VERSION_CODE))
            .put("device", JSONObject()
                .put("manufacturer", redactDiagnosticText(Build.MANUFACTURER))
                .put("model", redactDiagnosticText(Build.MODEL))
                .put("androidSdk", Build.VERSION.SDK_INT))
            .put("diagnosis", assessmentToJson(assessment))
            .put("gatewayHealth", health?.let(::healthToJson) ?: JSONObject.NULL)
            .put("gatewayHealthError", redactDiagnosticText(healthError))
            .put("session", snapshotToJson(snapshot))
            .put("privacy", JSONObject()
                .put("apiKeysIncluded", false)
                .put("authorizationIncluded", false)
                .put("gatewayAdminCredentialIncluded", false)
                .put("deviceIdIncluded", false)
                .put("urlsRedacted", true))
        return root
    }

    fun writeReport(
        context: Context,
        snapshot: LiveDiagnosticsSnapshot,
        health: GatewayHealthSnapshot?,
        healthError: String,
        assessment: DiagnosticAssessment = diagnoseLiveChain(snapshot, health, healthError),
    ): File {
        val directory = File(context.cacheDir, "diagnostics").apply { mkdirs() }
        directory.listFiles()?.filter { it.isFile }?.sortedByDescending { it.lastModified() }?.drop(6)?.forEach { runCatching { it.delete() } }
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        val file = File(directory, "aipany-live-diagnostics-$stamp.json")
        file.writeText(buildReport(snapshot, health, healthError, assessment).toString(2), Charsets.UTF_8)
        return file
    }

    fun shareReport(context: Context, file: File) {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "application/json"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_SUBJECT, "Aipany 实时链路诊断报告")
            putExtra(Intent.EXTRA_TEXT, "Aipany GPT-Live 脱敏诊断报告。")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        context.startActivity(Intent.createChooser(intent, "分享诊断报告"))
    }

    private fun snapshotToJson(snapshot: LiveDiagnosticsSnapshot): JSONObject = JSONObject()
        .put("gatewayState", redactDiagnosticText(snapshot.gatewayState))
        .put("upstreamState", snapshot.upstreamState)
        .put("upstreamDetail", redactDiagnosticText(snapshot.upstreamDetail))
        .put("model", redactDiagnosticText(snapshot.model))
        .put("recoveryAttempt", snapshot.recoveryAttempt)
        .put("lastReadyAtMs", snapshot.lastReadyAtMs)
        .put("lastError", redactDiagnosticText(snapshot.lastError))
        .put("androidAudioState", snapshot.androidAudioState)
        .put("androidAudioDetail", redactDiagnosticText(snapshot.androidAudioDetail))
        .put("lastAudioReadyAtMs", snapshot.lastAudioReadyAtMs)
        .put("lastAudioError", redactDiagnosticText(snapshot.lastAudioError))
        .put("latency", JSONObject()
            .put("endpointToAsrMs", snapshot.latency.endpointToAsrMs)
            .put("asrToLlmMs", snapshot.latency.asrToLlmMs)
            .put("llmToAudioMs", snapshot.latency.llmToAudioMs)
            .put("totalFirstResponseMs", snapshot.latency.totalFirstResponseMs)
            .put("updatedAtMs", snapshot.latency.updatedAtMs))
        .put("updatedAtMs", snapshot.updatedAtMs)
        .put("events", JSONArray().apply {
            snapshot.events.forEach { event ->
                put(JSONObject()
                    .put("timestampMs", event.timestampMs)
                    .put("source", event.source)
                    .put("state", event.state)
                    .put("detail", redactDiagnosticText(event.detail))
                    .put("attempt", event.attempt)
                    .put("model", redactDiagnosticText(event.model)))
            }
        })

    private fun assessmentToJson(assessment: DiagnosticAssessment): JSONObject = JSONObject()
        .put("layer", assessment.layer.name.lowercase(Locale.US))
        .put("severity", assessment.severity.name.lowercase(Locale.US))
        .put("confidence", assessment.confidence)
        .put("title", assessment.title)
        .put("summary", assessment.summary)
        .put("evidence", JSONArray(assessment.evidence.map(::redactDiagnosticText)))
        .put("actions", JSONArray(assessment.actions))

    private fun healthToJson(health: GatewayHealthSnapshot): JSONObject = JSONObject()
        .put("ok", health.ok)
        .put("service", health.service)
        .put("version", health.version)
        .put("realtimeEngine", health.realtimeEngine)
        .put("nativeLiveAvailable", health.nativeLiveAvailable)
        .put("authMode", health.authMode)

    private fun isoTime(timestampMs: Long): String = java.text.SimpleDateFormat(
        "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
        Locale.US,
    ).format(Date(timestampMs))
}

fun redactDiagnosticText(value: String): String {
    var output = value.trim().take(2_000)
    if (output.isBlank()) return ""
    output = output.replace(Regex("(?i)(authorization\\s*[:=]\\s*bearer\\s+)[^\\s,;]+")) { match ->
        "${match.groupValues[1]}<redacted>"
    }
    output = output.replace(Regex("(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\\s*[:=]\\s*)[^\\s,;]+")) { match ->
        "${match.groupValues[1]}<redacted>"
    }
    output = output.replace(Regex("(?i)([?&](?:token|api_key|apikey|key|secret)=)[^&\\s]+")) { match ->
        "${match.groupValues[1]}<redacted>"
    }
    output = output.replace(Regex("https?://[^\\s\"']+", RegexOption.IGNORE_CASE), "<redacted-url>")
    return output
}
