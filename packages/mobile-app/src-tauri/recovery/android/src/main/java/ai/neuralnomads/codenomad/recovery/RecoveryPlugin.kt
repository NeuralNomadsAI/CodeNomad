package ai.neuralnomads.codenomad.recovery

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.ViewGroup
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import androidx.webkit.WebViewFeature
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// Native chrome, not DOM and not a second WebView. No frontend permission grants.
// Live-WebView recovery covers TLS/HTTP/JS errors, not renderer death.
@TauriPlugin
class RecoveryPlugin(private val activity: Activity) : Plugin(activity) {
    private var ready = false
    private var button: Button? = null
    private class Binding(val view: WebView, val authority: ConnectionAuthority, val fence: NavigationFence)
    private var binding: Binding? = null

    private fun currentLauncher(): Binding? {
        val current = binding ?: return null
        if (!ready || activity.isFinishing || activity.isDestroyed ||
            button?.isAttachedToWindow != true || !current.view.isAttachedToWindow ||
            current.view.webViewClient !== current.fence || current.fence.loading ||
            !current.authority.canConnect() ||
            current.view.url != NavigationFence.LAUNCHER) return null
        return current
    }

    // Called only by Rust, before a connection. No frontend command permission.
    @Command
    fun readiness(invoke: Invoke) {
        activity.runOnUiThread {
            val current = currentLauncher()
            // SIDE-EFFECT FREE: no client installation or origin selection here.
            val result = JSObject().put("ready", current != null)
            if (current != null) result.put("generation", current.authority.snapshot())
            invoke.resolve(result)
        }
    }

    // Rust calls this only after its own generation commit. Native authority
    // commit + loadUrl are serialized together with return/replacement on UI.
    @Command
    fun connect(invoke: Invoke) {
        val args = invoke.parseArgs(ConnectionArgs::class.java)
        activity.runOnUiThread {
            val current = currentLauncher()
            if (current == null || !current.authority.commit(args.generation, args.endpoint)) {
                invoke.resolve(JSObject().put("connected", false))
                return@runOnUiThread
            }
            try {
                current.view.loadUrl(args.endpoint)
                invoke.resolve(JSObject().put("connected", true))
            } catch (_: Exception) {
                current.authority.disconnect()
                invoke.resolve(JSObject().put("connected", false))
            }
        }
    }

    override fun load(webView: WebView) {
        // Wry uses HTTPS-intercepted tauri.localhost / ipc.localhost, not an
        // HTTP server. Set this synchronously before any hosted navigation.
        webView.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // post (rather than inline runOnUiThread) waits for Wry's creation/client
        // setup to finish. A later client replacement makes readiness fail closed.
        webView.post {
            binding?.authority?.disconnect()
            val authority = ConnectionAuthority()
            val fence = NavigationFence(webView.webViewClient, authority) { dead ->
                if (binding?.view === dead) {
                    ready = false
                    binding = null
                }
                (dead.parent as? ViewGroup)?.removeView(dead)
                dead.destroy()
                // Never stop/loadUrl/reuse this WebView after renderer death.
                activity.finish()
            }
            webView.webViewClient = fence
            binding = Binding(webView, authority, fence)
            webView.settings.javaScriptCanOpenWindowsAutomatically = false
            webView.settings.setSupportMultipleWindows(false)
            ready = WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
            button?.bringToFront()
        }
        activity.runOnUiThread {
            if (button != null) return@runOnUiThread
            val root = activity.findViewById<ViewGroup>(android.R.id.content)
            val density = activity.resources.displayMetrics.density
            val button = Button(activity).apply {
                text = "↩ CodeNomad"
                contentDescription = "↩ CodeNomad"
                setTextColor(Color.WHITE)
                background = ColorDrawable(Color.rgb(0, 82, 204))
                minHeight = (48 * density).toInt()
                setOnClickListener {
                    val current = binding ?: return@setOnClickListener
                    current.authority.disconnect()
                    current.view.stopLoading()
                    // Never use history or a value supplied by remote content.
                    current.view.loadUrl(NavigationFence.LAUNCHER)
                }
            }
            val params = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, (48 * density).toInt(),
                Gravity.BOTTOM or Gravity.END
            ).apply {
                rightMargin = (12 * density).toInt()
                bottomMargin = (24 * density).toInt()
            }
            root.addView(button, params)
            this.button = button
            button.setOnApplyWindowInsetsListener { view, insets ->
                val layout = view.layoutParams as FrameLayout.LayoutParams
                @Suppress("DEPRECATION")
                val bottom = insets.systemWindowInsetBottom
                layout.bottomMargin = bottom + (12 * density).toInt()
                view.layoutParams = layout
                insets
            }
            button.requestApplyInsets()
        }
    }
}

@InvokeArg
class ConnectionArgs {
    lateinit var endpoint: String
    lateinit var generation: String
}
