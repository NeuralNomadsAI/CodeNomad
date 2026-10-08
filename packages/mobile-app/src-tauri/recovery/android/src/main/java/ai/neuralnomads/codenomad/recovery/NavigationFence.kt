package ai.neuralnomads.codenomad.recovery

import android.graphics.Bitmap
import android.net.http.SslError
import android.webkit.*
import java.io.ByteArrayInputStream

// shouldOverrideUrlLoading alone does NOT cover POST navigations on Android.
// Wrap Wry's client to also reject cross-origin main-frame requests and recover
// from an unexpected page start. Do not disable TLS or replace protocol handling.
class NavigationFence(
    private val original: WebViewClient,
    private val authority: ConnectionAuthority,
    private val rendererGone: (WebView) -> Unit
) : WebViewClient() {
    companion object { const val LAUNCHER = ConnectionAuthority.LAUNCHER }
    var loading = false
        private set

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        if (!authority.allowsRequest(request.url.toString(), request.method, request.isForMainFrame) ||
            !authority.admits(request.url.toString())) return true
        if (request.isForMainFrame && request.url.toString() == LAUNCHER) authority.disconnect()
        return original.shouldOverrideUrlLoading(view, request)
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        if (!authority.interceptRequest(request.url.toString(), request.method, request.isForMainFrame)) {
            return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(),
                ByteArrayInputStream(ByteArray(0)))
        }
        if (request.isForMainFrame && request.url.toString() == LAUNCHER) authority.disconnect()
        return original.shouldInterceptRequest(view, request)
    }

    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        loading = true
        if (!authority.admits(url)) {
            authority.disconnect()
            view.stopLoading()
            view.loadUrl(LAUNCHER)
            return
        }
        authority.documentStarted(url)
        original.onPageStarted(view, url, favicon)
    }

    override fun onPageFinished(view: WebView, url: String) {
        if (authority.admits(url)) {
            authority.documentFinished(url)
            loading = false
        }
        original.onPageFinished(view, url)
    }
    override fun onPageCommitVisible(view: WebView, url: String) = original.onPageCommitVisible(view, url)
    override fun doUpdateVisitedHistory(view: WebView, url: String, reload: Boolean) =
        original.doUpdateVisitedHistory(view, url, reload)
    override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
        if (!request.isForMainFrame || authority.admits(request.url.toString())) original.onReceivedError(view, request, error)
    }
    override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) =
        original.onReceivedHttpError(view, request, response)
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        handler.cancel()
    }
    override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) { request.cancel() }
    override fun onReceivedHttpAuthRequest(view: WebView, handler: HttpAuthHandler, host: String, realm: String) {
        handler.cancel()
    }

    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
        authority.disconnect()
        // Do not delegate to Wry's default unhandled callback or reuse a dead
        // WebView. The host removes/destroys it and closes the Activity; reopen.
        rendererGone(view)
        return true
    }
}
