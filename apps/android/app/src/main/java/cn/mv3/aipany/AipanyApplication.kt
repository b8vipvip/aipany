package cn.mv3.aipany

import android.app.Activity
import android.app.Application
import android.os.Bundle

class AipanyApplication : Application(), Application.ActivityLifecycleCallbacks {
    override fun onCreate() {
        super.onCreate()
        ClientCrashDiagnostics.install(this)
        LiveDiagnosticAutoUploader.initialize(this)
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityResumed(activity: Activity) {
        // Only the launcher activity owns update initialization. Settings has its
        // own explicit update controls; avoiding duplicate resume/install calls
        // also keeps activity transitions side-effect free.
        if (activity is MainActivity) {
            runCatching { AppUpdateManager.initialize(activity) }
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
