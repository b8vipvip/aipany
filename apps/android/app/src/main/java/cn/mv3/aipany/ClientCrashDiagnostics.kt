package cn.mv3.aipany

import android.app.Application
import android.content.Context

/**
 * Persists one sanitized uncaught-crash breadcrumb. No exception message,
 * transcript, URL, device identifier or user content is stored.
 */
object ClientCrashDiagnostics {
    private const val PREFS = "aipany_crash_diagnostics"
    private const val KEY_PENDING = "pending"
    private const val KEY_TIMESTAMP = "timestamp"
    private const val KEY_EXCEPTION = "exception"
    private const val KEY_COMPONENT = "component"
    private const val KEY_METHOD = "method"

    fun install(application: Application) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, throwable ->
            runCatching { persist(application, thread, throwable) }
            previous?.uncaughtException(thread, throwable)
        }
    }

    fun consume(context: Context): Map<String, Any>? {
        val preferences = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!preferences.getBoolean(KEY_PENDING, false)) return null
        val result = mapOf(
            "occurredAt" to preferences.getLong(KEY_TIMESTAMP, 0L),
            "exceptionClass" to preferences.getString(KEY_EXCEPTION, "unknown").orEmpty().take(80),
            "component" to preferences.getString(KEY_COMPONENT, "unknown").orEmpty().take(120),
            "method" to preferences.getString(KEY_METHOD, "unknown").orEmpty().take(80),
            "appVersion" to BuildConfig.VERSION_NAME,
        )
        preferences.edit().clear().apply()
        return result
    }

    private fun persist(context: Context, thread: Thread, throwable: Throwable) {
        val appFrame = throwable.stackTrace.firstOrNull { it.className.startsWith("cn.mv3.aipany") }
            ?: throwable.stackTrace.firstOrNull()
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putBoolean(KEY_PENDING, true)
            .putLong(KEY_TIMESTAMP, System.currentTimeMillis())
            .putString(KEY_EXCEPTION, throwable.javaClass.simpleName.take(80))
            .putString(KEY_COMPONENT, (appFrame?.className ?: thread.name).take(120))
            .putString(KEY_METHOD, appFrame?.methodName?.take(80) ?: "unknown")
            .commit()
    }
}
