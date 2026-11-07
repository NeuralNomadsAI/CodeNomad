#include "input.h"
#include "page_read.generated.h"
#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <math.h>
#include <string.h>

typedef struct { CNCompletion done; void *context; } Completion;

static void evaluated(GObject *object, GAsyncResult *result, gpointer data) {
    Completion *completion = data;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(object), result, &error);
    char *text = value ? jsc_value_to_string(value) : NULL;
    completion->done(completion->context, (unsigned char *)text, text ? strlen(text) : 0,
                     error ? error->message : (text ? NULL : "WebKit evaluation returned no value"));
    g_free(text);
    g_clear_object(&value);
    g_clear_error(&error);
    g_free(completion);
}

void cn_checkpoint(void *view, CNCompletion done, void *context) {
    Completion *completion = g_new(Completion, 1);
    *completion = (Completion){done, context};
    webkit_web_view_evaluate_javascript(WEBKIT_WEB_VIEW(view), CN_CHECKPOINT, -1,
        CN_WORLD, "codenomad-checkpoint", NULL, evaluated, completion);
}

typedef struct { CNCompletion done; void *context; GCancellable *cancel; guint timeout; } PageRead;
static gboolean cancel_page_read(gpointer data) { g_cancellable_cancel(data); return G_SOURCE_REMOVE; }
static void page_read_done(GObject *object, GAsyncResult *result, gpointer data) {
    PageRead *read = data;
    GError *error = NULL;
    JSCValue *value = webkit_web_view_call_async_javascript_function_finish(WEBKIT_WEB_VIEW(object), result, &error);
    char *text = value ? jsc_value_to_string(value) : NULL;
    const char *failure = error ? error->message : (webkit_web_view_is_loading(WEBKIT_WEB_VIEW(object)) ? "Native browser page is loading" : NULL);
    read->done(read->context, (unsigned char *)text, text ? strlen(text) : 0, failure);
    if (read->timeout && g_main_context_find_source_by_id(NULL, read->timeout)) g_source_remove(read->timeout);
    g_object_unref(read->cancel);
    g_free(text); g_clear_object(&value); g_clear_error(&error); g_free(read);
}
int cn_install_page_read(void *view) {
    WebKitUserScript *script = webkit_user_script_new(CN_PAGE_HOOK, WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES, WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START, NULL, NULL);
    webkit_user_content_manager_add_script(webkit_web_view_get_user_content_manager(WEBKIT_WEB_VIEW(view)), script);
    webkit_user_script_unref(script);
    return 1;
}
void cn_page_read(void *view, const char *request, unsigned timeout_ms, CNCompletion done, void *context) {
    if (webkit_web_view_is_loading(WEBKIT_WEB_VIEW(view))) { done(context,NULL,0,"Native browser page is loading"); return; }
    PageRead *read = g_new0(PageRead,1);
    read->done=done; read->context=context; read->cancel=g_cancellable_new();
    read->timeout=g_timeout_add_full(G_PRIORITY_DEFAULT, MAX(1,timeout_ms),cancel_page_read,g_object_ref(read->cancel),g_object_unref);
    GVariantBuilder args; g_variant_builder_init(&args,G_VARIANT_TYPE_VARDICT);
    g_variant_builder_add(&args,"{sv}","request",g_variant_new_string(request));
    GVariant *arguments=g_variant_ref_sink(g_variant_builder_end(&args));
    webkit_web_view_call_async_javascript_function(WEBKIT_WEB_VIEW(view),CN_PAGE_READ,-1,arguments,CN_WORLD,"codenomad-page-read",read->cancel,page_read_done,read);
    g_variant_unref(arguments);
}

static GdkModifierType modifiers(unsigned flags) {
    return ((flags & CN_SHIFT) ? GDK_SHIFT_MASK : 0) |
           ((flags & CN_CONTROL) ? GDK_CONTROL_MASK : 0) |
           ((flags & CN_ALT) ? GDK_MOD1_MASK : 0) |
           ((flags & CN_META) ? GDK_META_MASK : 0);
}

static GdkEvent *event_for(GtkWidget *view, GdkEventType type, int keyboard) {
    GdkWindow *window = gtk_widget_get_window(view);
    if (!window || !gtk_widget_get_mapped(view)) return NULL;
    GdkSeat *seat = gdk_display_get_default_seat(gtk_widget_get_display(view));
    GdkDevice *device = keyboard ? gdk_seat_get_keyboard(seat) : gdk_seat_get_pointer(seat);
    if (!device) return NULL;
    GdkEvent *event = gdk_event_new(type);
    event->any.window = g_object_ref(window);
    /* WebKit accepts these as targeted native events on either display backend. */
    event->any.send_event = FALSE;
    gdk_event_set_device(event, device);
    return event;
}

static int valid_point(GtkWidget *view, double x, double y) {
    return isfinite(x) && isfinite(y) && x >= 0 && y >= 0 &&
        x < gtk_widget_get_allocated_width(view) && y < gtk_widget_get_allocated_height(view);
}

static int deliver(GdkEvent *event) {
    if (!event) return 0;
    gtk_main_do_event(event);
    gdk_event_free(event);
    return 1;
}

int cn_pointer(void *opaque, int action, double x, double y, unsigned flags) {
    GtkWidget *view = GTK_WIDGET(opaque);
    if (!valid_point(view, x, y) || action < CN_MOVE || action > CN_DRAG) return 0;
    GdkEventType type = (action == CN_MOVE || action == CN_DRAG) ? GDK_MOTION_NOTIFY :
        ((action == CN_LEFT_DOWN || action == CN_RIGHT_DOWN) ? GDK_BUTTON_PRESS : GDK_BUTTON_RELEASE);
    GdkEvent *event = event_for(view, type, 0);
    if (!event) return 0;
    if (type == GDK_MOTION_NOTIFY) {
        event->motion.time = GDK_CURRENT_TIME;
        event->motion.x = x; event->motion.y = y;
        event->motion.state = modifiers(flags) | (action == CN_DRAG ? GDK_BUTTON1_MASK : 0);
    } else {
        event->button.time = GDK_CURRENT_TIME;
        event->button.x = x; event->button.y = y;
        event->button.button = (action == CN_RIGHT_DOWN || action == CN_RIGHT_UP) ? 3 : 1;
        event->button.state = modifiers(flags) | (type == GDK_BUTTON_RELEASE ?
            (event->button.button == 1 ? GDK_BUTTON1_MASK : GDK_BUTTON3_MASK) : 0);
    }
    return deliver(event);
}

int cn_wheel(void *opaque, double x, double y, double dx, double dy, unsigned flags) {
    GtkWidget *view = GTK_WIDGET(opaque);
    if (!valid_point(view, x, y) || !isfinite(dx) || !isfinite(dy)) return 0;
    GdkEvent *event = event_for(view, GDK_SCROLL, 0);
    if (!event) return 0;
    event->scroll.time = GDK_CURRENT_TIME;
    event->scroll.x = x; event->scroll.y = y;
    event->scroll.state = modifiers(flags);
    event->scroll.direction = GDK_SCROLL_SMOOTH;
    /* GDK smooth deltas are wheel steps (WebKit maps one step to 40 CSS px). */
    event->scroll.delta_x = dx / 40; event->scroll.delta_y = dy / 40;
    return deliver(event);
}

int cn_key(void *opaque, const char *key, unsigned flags, int down) {
    GtkWidget *view = GTK_WIDGET(opaque);
    guint keyval = gdk_keyval_from_name(key);
    if (keyval == GDK_KEY_VoidSymbol && g_utf8_strlen(key, -1) == 1)
        keyval = gdk_unicode_to_keyval(g_utf8_get_char(key));
    if (keyval == GDK_KEY_VoidSymbol) return 0;
    GdkEvent *event = event_for(view, down ? GDK_KEY_PRESS : GDK_KEY_RELEASE, 1);
    if (!event) return 0;
    event->key.time = GDK_CURRENT_TIME;
    event->key.state = modifiers(flags);
    event->key.keyval = keyval;
    GdkKeymapKey *entries = NULL;
    gint count = 0;
    if (gdk_keymap_get_entries_for_keyval(gdk_keymap_get_for_display(gtk_widget_get_display(view)),
                                         keyval, &entries, &count) && count) {
        event->key.hardware_keycode = entries[0].keycode;
        event->key.group = entries[0].group;
    }
    g_free(entries);
    /* gtk_main_do_event routes keys by toplevel focus; dispatch directly to the
     * exact WebKit widget so another child cannot receive a background key. */
    gtk_widget_event(view, event);
    gdk_event_free(event);
    return 1;
}

int cn_text(void *view, const char *text) {
    if (!text || !g_utf8_validate(text, -1, NULL) || !gtk_widget_get_mapped(GTK_WIDGET(view))) return 0;
    webkit_web_view_execute_editing_command_with_argument(WEBKIT_WEB_VIEW(view), "InsertText", text);
    return 1;
}

static void captured(GObject *object, GAsyncResult *result, gpointer data);
static cairo_status_t png_write(void *context, const unsigned char *data, unsigned length) {
    GByteArray *bytes = context;
    if (bytes->len + (size_t)length > 16 * 1024 * 1024) return CAIRO_STATUS_WRITE_ERROR;
    g_byte_array_append(bytes, data, length);
    return CAIRO_STATUS_SUCCESS;
}
static void captured(GObject *object, GAsyncResult *result, gpointer data) {
    Completion *completion = data;
    GError *error = NULL;
    cairo_surface_t *surface = webkit_web_view_get_snapshot_finish(WEBKIT_WEB_VIEW(object), result, &error);
    GByteArray *bytes = g_byte_array_new();
    cairo_status_t status = surface ? cairo_surface_write_to_png_stream(surface, png_write, bytes) : CAIRO_STATUS_NULL_POINTER;
    completion->done(completion->context, bytes->data, bytes->len,
        error ? error->message : (status == CAIRO_STATUS_SUCCESS ? NULL : cairo_status_to_string(status)));
    g_byte_array_unref(bytes);
    if (surface) cairo_surface_destroy(surface);
    g_clear_error(&error);
    g_free(completion);
}
void cn_capture(void *view, CNCompletion done, void *context) {
    Completion *completion = g_new(Completion, 1);
    *completion = (Completion){done, context};
    webkit_web_view_get_snapshot(WEBKIT_WEB_VIEW(view), WEBKIT_SNAPSHOT_REGION_VISIBLE,
        WEBKIT_SNAPSHOT_OPTIONS_NONE, NULL, captured, completion);
}
