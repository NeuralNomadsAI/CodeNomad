/* cc webkit-live-audio.c $(pkg-config --cflags --libs webkit2gtk-4.1) -o webkit-live-audio
 * From packages/ui/src/lib, serve the worklet with python3 -m http.server --bind 127.0.0.1 8000.
 * GDK_BACKEND=x11 xvfb-run -a ./webkit-live-audio http://127.0.0.1:8000/
 */
#include <webkit2/webkit2.h>

static int result = 1;

static void evaluated(WebKitWebView *view, GAsyncResult *reply, gpointer data) {
    GError *error = NULL;
    JSCValue *value = webkit_web_view_call_async_javascript_function_finish(view, reply, &error);
    result = !(value && jsc_value_is_boolean(value) && jsc_value_to_boolean(value));
    g_print("WebKitGTK synthetic live audio: %s\n", result ? (error ? error->message : "failed") : "ok");
    g_clear_error(&error);
    g_clear_object(&value);
    gtk_main_quit();
}

static void loaded(WebKitWebView *view, WebKitLoadEvent event, gpointer data) {
    if (event != WEBKIT_LOAD_FINISHED)
        return;

    const char *test =
        "const ctx = new AudioContext();"
        "const resume = ctx.resume();"
        "const frame = document.body.appendChild(document.createElement('iframe'));"
        "frame.hidden = true;"
        "const stream = await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio: true});"
        "try {"
        "  await ctx.audioWorklet.addModule('./live-voice-worklet.js');"
        "  const recorder = new AudioWorkletNode(ctx, 'codenomad-live-capture', {"
        "    outputChannelCount: [1], processorOptions: {inputRate: 16000}"
        "  });"
        "  const player = new AudioWorkletNode(ctx, 'codenomad-live-playback', {"
        "    numberOfInputs: 0, outputChannelCount: [1], processorOptions: {outputRate: 24000, capacity: 24000}"
        "  });"
        "  ctx.createMediaStreamSource(stream).connect(recorder).connect(ctx.destination);"
        "  player.connect(ctx.destination);"
        "  const captured = new Promise((resolve, reject) => recorder.port.onmessage = ({data}) => {"
        "    if (!(data instanceof ArrayBuffer) || data.byteLength !== 640) { reject(new Error('invalid capture chunk')); return; }"
        "    recorder.port.postMessage(null);"
        "    if (new Uint8Array(data).some(n => n)) resolve(true);"
        "  });"
        "  const cleared = new Promise(resolve => player.port.onmessage = ({data}) => {"
        "    if (data.flush) resolve(data.rendered);"
        "    else if (data.rendered > 1200) player.port.postMessage(true);"
        "  });"
        "  player.port.postMessage(new ArrayBuffer(48000));"
        "  const [pcm, rendered] = await Promise.race([Promise.all([captured, cleared, resume]), new Promise((_, reject) => {"
        "    recorder.onprocessorerror = () => reject(new Error('capture processor error'));"
        "    player.onprocessorerror = () => reject(new Error('playback processor error'));"
        "    setTimeout(() => reject(new Error(`audio graph stalled: ${ctx.state} at ${ctx.currentTime}s`)), 3000);"
        "  })]);"
        "  if (!pcm || rendered <= 1200 || rendered >= 24000) throw new Error(`bad interruption: ${rendered} frames`);"
        "  return true;"
        "} finally { stream.getTracks().forEach(track => track.stop()); frame.remove(); void ctx.close(); }";

    webkit_web_view_call_async_javascript_function(view, test, -1, NULL, NULL,
                                                  NULL, NULL, (GAsyncReadyCallback)evaluated, NULL);
}

static gboolean expired(gpointer data) {
    g_printerr("WebKitGTK synthetic live audio timed out\n");
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

static gboolean permission(WebKitWebView *view, WebKitPermissionRequest *request, gpointer data) {
    if (!WEBKIT_IS_USER_MEDIA_PERMISSION_REQUEST(request))
        return FALSE;
    WebKitUserMediaPermissionRequest *media = WEBKIT_USER_MEDIA_PERMISSION_REQUEST(request);
    WebKitSettings *settings = webkit_web_view_get_settings(view);
    if (webkit_settings_get_enable_mock_capture_devices(settings)
        && webkit_user_media_permission_is_for_audio_device(media)
        && !webkit_user_media_permission_is_for_video_device(media))
        webkit_permission_request_allow(request);
    else
        webkit_permission_request_deny(request);
    return TRUE;
}

int main(int argc, char **argv) {
    if (argc != 2)
        return 2;
    gtk_init(&argc, &argv);
    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    WebKitWebView *view = WEBKIT_WEB_VIEW(webkit_web_view_new());
    WebKitSettings *settings = webkit_web_view_get_settings(view);
    webkit_settings_set_media_playback_requires_user_gesture(settings, FALSE);
    webkit_settings_set_enable_media_stream(settings, TRUE);
    webkit_settings_set_enable_mock_capture_devices(settings, TRUE);
    g_signal_connect(view, "permission-request", G_CALLBACK(permission), NULL);
    g_signal_connect(view, "load-changed", G_CALLBACK(loaded), NULL);
    gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));
    gtk_widget_show_all(window);
    webkit_web_view_load_uri(view, argv[1]);
    g_timeout_add_seconds(12, expired, NULL);
    gtk_main();
    return result;
}
