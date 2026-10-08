package ai.neuralnomads.codenomad.recovery

import java.net.URI
import java.util.UUID

// Pure JVM authority used by the actual WebView adapter and its unit tests.
// Readiness is a read, never selection. Each WebView has a unique identity.
class ConnectionAuthority {
    companion object { const val LAUNCHER = "https://tauri.localhost/index.html" }
    private val identity = UUID.randomUUID().toString()
    private var revision = 0L
    private var endpoint: URI? = null
    private var pendingDocument: String? = null
    private fun token() = "$identity:$revision"

    @Synchronized fun snapshot(): String = token()
    @Synchronized fun canConnect(): Boolean = endpoint == null && pendingDocument == null

    @Synchronized fun commit(generation: String, value: String): Boolean {
        if (generation != token() || !canConnect()) return false
        val uri = try { URI(value) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || uri.host == null || uri.rawUserInfo != null ||
            uri.rawPath != "/" || uri.rawQuery != null || uri.rawFragment != null ||
            uri.host == "localhost" || uri.host.endsWith(".localhost")) return false
        endpoint = uri
        revision++
        return true
    }

    @Synchronized fun disconnect() { endpoint = null; revision++ }

    @Synchronized fun documentStarted(url: String) {
        revision++
        pendingDocument = url
        if (url == LAUNCHER) endpoint = null
    }

    @Synchronized fun documentFinished(url: String) {
        if (pendingDocument == url) pendingDocument = null
    }

    @Synchronized fun admits(url: String): Boolean {
        if (url == LAUNCHER) return true
        val selected = endpoint ?: return false
        val uri = try { URI(url) } catch (_: Exception) { return false }
        fun port(value: URI) = if (value.port == -1) 443 else value.port
        return uri.scheme == "https" && uri.rawUserInfo == null &&
            uri.host == selected.host && port(uri) == port(selected)
    }

    // Deny the INITIAL main-frame POST/PUT/etc before networking. Android does
    // not re-run shouldInterceptRequest for redirects; 307/308 preserve POST.
    // fetch/XHR API POSTs are subresources, not top-level navigation.
    @Synchronized fun allowsRequest(url: String, method: String, mainFrame: Boolean): Boolean =
        !mainFrame || (method == "GET" && admits(url))

    // Admission plus invalidation is atomic against a queued connection, even
    // on the background request thread before onPageStarted reaches the UI.
    @Synchronized fun interceptRequest(url: String, method: String, mainFrame: Boolean): Boolean {
        if (!allowsRequest(url, method, mainFrame)) return false
        if (mainFrame) documentStarted(url)
        return true
    }
}
