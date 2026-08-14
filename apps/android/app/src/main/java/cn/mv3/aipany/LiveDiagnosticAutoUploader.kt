package cn.mv3.aipany

import android.content.Context
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

object LiveDiagnosticAutoUploader {
    private const val DEBOUNCE_MS = 1_800L
    private const val COOLDOWN_MS = 5 * 60 * 1_000L

    private val lock = Any()
    private val executor = Executors.newSingleThreadScheduledExecutor { runnable ->
        Thread(runnable, "aipany-diagnostic-upload").apply { isDaemon = true }
    }
    @Volatile private var appContext: Context? = null
    private var pending: ScheduledFuture<*>? = null
    private var uploadInFlight = false
    private var lastAttemptAtMs = 0L

    fun initialize(context: Context) {
        appContext = context.applicationContext
    }

    fun schedule(reason: String = "live_error") {
        if (appContext == null) return
        synchronized(lock) {
            val now = System.currentTimeMillis()
            if (uploadInFlight || now - lastAttemptAtMs < COOLDOWN_MS) return
            pending?.cancel(false)
            pending = executor.schedule(
                { uploadCurrent(reason) },
                DEBOUNCE_MS,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    private fun uploadCurrent(reason: String) {
        val context = appContext ?: return
        synchronized(lock) {
            if (uploadInFlight) return
            val now = System.currentTimeMillis()
            if (now - lastAttemptAtMs < COOLDOWN_MS) return
            uploadInFlight = true
            lastAttemptAtMs = now
            pending = null
        }

        val snapshot = LiveDiagnosticsStore.snapshot()
        val healthClient = GatewayHealthClient()
        healthClient.fetch { healthResult ->
            val health = healthResult.getOrNull()
            val healthError = healthResult.exceptionOrNull()?.message.orEmpty()
            val assessment = diagnoseLiveChain(snapshot, health, healthError)
            if (assessment.severity != DiagnosticSeverity.ERROR) {
                runCatching { healthClient.close() }
                finishAttempt()
                return@fetch
            }

            val report = LiveDiagnosticReportExporter.buildReport(
                snapshot = snapshot,
                health = health,
                healthError = healthError,
                assessment = assessment,
            )
            report.put("upload", org.json.JSONObject()
                .put("automatic", true)
                .put("trigger", redactDiagnosticText(reason).take(80)))

            val uploadClient = ClientDiagnosticUploadClient()
            uploadClient.upload(context, report) {
                runCatching { uploadClient.close() }
                runCatching { healthClient.close() }
                finishAttempt()
            }
        }
    }

    private fun finishAttempt() {
        synchronized(lock) {
            uploadInFlight = false
        }
    }
}
