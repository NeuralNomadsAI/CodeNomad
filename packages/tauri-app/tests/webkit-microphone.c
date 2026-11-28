/* Build with cc webkit-microphone.c $(pkg-config --cflags --libs webkit2gtk-4.1) -o webkit-microphone
 * Run with GDK_BACKEND=x11 xvfb-run -a ./webkit-microphone
 */
#include <webkit2/webkit2.h>

static gboolean permit;
static unsigned grants, denials, phase;
static int result = 1;

static gboolean permission(WebKitWebView *view, WebKitPermissionRequest *request, gpointer data) {
    if (!WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request))
        return FALSE;
    WebKitUserMediaPermissionRequest *media = WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request);
    if (permit && webkit_user_media_permission_is_for_audio_device(media)
        && !webkit_user_media_permission_is_for_video_device(media)) {
        permit = FALSE;
        ++grants;
        webkit_permission_request_allow(request);
    } else {
        ++denials;
        webkit_permission_request_deny(request);
    }
    return TRUE;
}

/* Exercise the engine's permission cache with a real capture device replacement.
 * Rust tests separately exercise CodeNomad's ownership and IPC permit rules. */
static const struct {
    gboolean permit;
    const char *body;
} cases[] = {
    { FALSE, "try { await navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
             "catch (error) { return error.name === 'NotAllowedError'; }" },
    { TRUE, "const preview = document.createElement('iframe');"
            "preview.setAttribute('allow', \"microphone 'none'; camera 'none'\");"
            "document.body.append(preview);"
            "try { await preview.contentWindow.navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
            "catch (error) { return error.name === 'NotAllowedError'; } finally { preview.remove(); }" },
    { TRUE, "window.frame = document.body.appendChild(document.createElement('iframe'));"
            "frame.hidden = true;"
            "const audio = await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true});"
            "const context = new AudioContext();"
            "const worklet = `registerProcessor('mock', class extends AudioWorkletProcessor {"
            "   process(inputs) { if (inputs[0]?.[0]?.length) this.port.postMessage(inputs[0][0].length); return true; }"
            "});`;"
            "const url = URL.createObjectURL(new Blob([worklet], { type:'text/javascript' }));"
            "await context.audioWorklet.addModule(url); URL.revokeObjectURL(url);"
            "const node = new AudioWorkletNode(context, 'mock');"
            "const count = new Promise(resolve => node.port.onmessage = event => resolve(event.data));"
            "context.createMediaStreamSource(audio).connect(node).connect(context.destination);"
            "await context.resume(); if (await count <= 0) return false;"
            "audio.getTracks().forEach(track => track.stop()); frame.remove(); await context.close();"
            "return audio.getAudioTracks()[0].readyState === 'ended';" },
    { FALSE, "try { await navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
             "catch (error) { return error.name === 'NotAllowedError'; }" },
    { TRUE, "window.frame = document.body.appendChild(document.createElement('iframe'));"
            "frame.hidden = true;"
            "window.audio = await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:{channelCount:1}});"
            "const context = new AudioContext();"
            "const source = context.createMediaStreamSource(audio);"
            "source.connect(context.createAnalyser());"
            "await context.resume(); await context.close();"
            "return audio.getAudioTracks()[0].readyState === 'live';" },
    { FALSE, "frame.remove(); return audio.getAudioTracks()[0].readyState === 'ended';" },
    { FALSE, "try { await navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
             "catch (error) { return error.name === 'NotAllowedError'; }" },
    { TRUE, "window.frame = document.body.appendChild(document.createElement('iframe'));"
            "window.audio = await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true});"
            "return audio.getAudioTracks()[0].readyState === 'live';" },
    { FALSE, "const track = audio.getAudioTracks()[0];"
             "if (track.readyState !== 'ended') await new Promise(resolve => track.addEventListener('ended', resolve, {once:true}));"
             "try { await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
             "catch (error) { return error.name === 'NotAllowedError'; } finally { frame.remove(); }" },
    { FALSE, "try { await navigator.mediaDevices.getUserMedia({audio:true}); return false; }"
             "catch (error) { return error.name === 'NotAllowedError'; }" },
};

static void next(WebKitWebView *view);

static void evaluated(WebKitWebView *view, GAsyncResult *reply, gpointer data) {
    GError *error = NULL;
    JSCValue *value = webkit_web_view_call_async_javascript_function_finish(view, reply, &error);
    gboolean passed = value && jsc_value_is_boolean(value) && jsc_value_to_boolean(value);
    g_print("capture check %u: %s\n", phase + 1, passed ? "ok" : error ? error->message : "failed");
    g_clear_error(&error);
    g_clear_object(&value);
    if (!passed) {
        gtk_main_quit();
    } else if (++phase == G_N_ELEMENTS(cases)) {
        result = grants != 3 || denials != 5;
        g_print("decisions: %u allowed, %u denied\n", grants, denials);
        gtk_main_quit();
    } else if (phase + 1 == G_N_ELEMENTS(cases)) {
        webkit_web_view_load_html(view, "<!doctype html><title>Reload</title>", "http://127.0.0.1/");
    } else {
        if (phase == G_N_ELEMENTS(cases) - 2)
            webkit_web_view_set_microphone_capture_state(view, WEBKIT_MEDIA_CAPTURE_STATE_NONE);
        next(view);
    }
}

static void next(WebKitWebView *view) {
    permit = cases[phase].permit;
    webkit_web_view_call_async_javascript_function(view, cases[phase].body, -1, NULL, NULL,
                                                   NULL, NULL, (GAsyncReadyCallback)evaluated, NULL);
}

static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer data) {
    if (event == WEBKIT_LOAD_FINISHED)
        next(view);
}

static gboolean expired(gpointer data) {
    g_printerr("Timed out during check %u\n", phase + 1);
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

int main(int argc, char **argv) {
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new());
    WebKitSettings *settings = webkit_web_view_get_settings(view);
    webkit_settings_set_enable_media_stream(settings, TRUE);
    webkit_settings_set_enable_mock_capture_devices(settings, TRUE);
    gboolean mock_prompt = FALSE;
    WebKitFeatureList *features = webkit_settings_get_all_features();
    for (gsize i = 0; i < webkit_feature_list_get_length(features); ++i) {
        WebKitFeature *feature = webkit_feature_list_get(features, i);
        if (g_str_equal(webkit_feature_get_identifier(feature), "MockCaptureDevicesPrompt")) {
            webkit_settings_set_feature_enabled(settings, feature, TRUE);
            mock_prompt = TRUE;
            break;
        }
    }
    webkit_feature_list_unref(features);
    if (!mock_prompt) {
        g_printerr("WebKitGTK does not expose mock capture prompts; no capture attempted\n");
        return 77;
    }
    g_signal_connect(view, "permission-request", G_CALLBACK(permission), NULL);
    g_signal_connect(view, "load-changed", G_CALLBACK(loaded), NULL);
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
    gtk_widget_show_all(window);
    webkit_web_view_load_html(view, "<!doctype html><title>Mock microphone</title>", "http://127.0.0.1/");
    g_timeout_add_seconds(15, expired, NULL);
    gtk_main();
    return result;
}
