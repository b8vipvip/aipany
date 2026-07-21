package cn.mv3.aipany

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.os.SystemClock
import android.util.AttributeSet
import android.view.View
import kotlin.math.sin

class VoiceOrbView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    enum class State { CONNECTING, LISTENING, THINKING, SPEAKING, PAUSED, ERROR }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var state = State.CONNECTING
    private var inputLevel = 0f

    fun setState(value: State) {
        state = value
        invalidate()
    }

    fun setInputLevel(dbfs: Float) {
        inputLevel = ((dbfs + 55f) / 35f).coerceIn(0f, 1f)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val desired = (220 * resources.displayMetrics.density).toInt()
        setMeasuredDimension(resolveSize(desired, widthMeasureSpec), resolveSize(desired, heightMeasureSpec))
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val cx = width / 2f
        val cy = height / 2f
        val time = SystemClock.elapsedRealtime() / 700f
        val pulse = (sin(time) + 1f) / 2f
        val colors = when (state) {
            State.CONNECTING -> intArrayOf(Color.rgb(107, 114, 128), Color.rgb(31, 41, 55))
            State.LISTENING -> intArrayOf(Color.rgb(99, 102, 241), Color.rgb(37, 99, 235))
            State.THINKING -> intArrayOf(Color.rgb(139, 92, 246), Color.rgb(79, 70, 229))
            State.SPEAKING -> intArrayOf(Color.rgb(16, 185, 129), Color.rgb(14, 116, 144))
            State.PAUSED -> intArrayOf(Color.rgb(148, 163, 184), Color.rgb(71, 85, 105))
            State.ERROR -> intArrayOf(Color.rgb(248, 113, 113), Color.rgb(185, 28, 28))
        }
        val baseRadius = minOf(width, height) * 0.28f
        val levelBoost = if (state == State.LISTENING) inputLevel * baseRadius * 0.20f else 0f
        val radius = baseRadius + pulse * baseRadius * 0.06f + levelBoost

        paint.color = colors[0]
        paint.alpha = 35
        canvas.drawCircle(cx, cy, radius * 1.55f, paint)
        paint.alpha = 55
        canvas.drawCircle(cx, cy, radius * 1.32f, paint)
        paint.alpha = 255
        paint.shader = RadialGradient(
            cx - radius * 0.25f,
            cy - radius * 0.30f,
            radius * 1.45f,
            intArrayOf(Color.WHITE, colors[0], colors[1]),
            floatArrayOf(0f, 0.30f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx, cy, radius, paint)
        paint.shader = null
        postInvalidateDelayed(32)
    }
}
