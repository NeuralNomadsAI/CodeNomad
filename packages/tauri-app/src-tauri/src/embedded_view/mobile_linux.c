#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include "zoom.h"
typedef struct { gboolean mobile, active, sending; double x, y; } TouchState;
static void touch(GtkWidget *view, TouchState *state, GdkEventType type, double x, double y) {
    GdkWindow *window = gtk_widget_get_window(view);
    GdkSeat *seat = gdk_display_get_default_seat(gtk_widget_get_display(view));
    if (!window || !seat) return;
    GdkEvent *event = gdk_event_new(type);
    event->touch.window = g_object_ref(window);
    event->touch.send_event = FALSE;
    event->touch.time = GDK_CURRENT_TIME;
    event->touch.x = x; event->touch.y = y;
    event->touch.sequence = (GdkEventSequence *)state;
    event->touch.emulating_pointer = TRUE;
    int ox = 0, oy = 0;
    gdk_window_get_origin(window, &ox, &oy);
    event->touch.x_root = ox + x; event->touch.y_root = oy + y;
    gdk_event_set_device(event, gdk_seat_get_pointer(seat));
    state->sending = TRUE;
    gtk_widget_event(view, event);
    state->sending = FALSE;
    gdk_event_free(event);
    state->x = x; state->y = y;
}
static gboolean pressed(GtkWidget *view, GdkEventButton *event, gpointer data) {
    TouchState *state = data;
    if (state->sending || gdk_event_get_pointer_emulated((GdkEvent *)event)) return FALSE;
    if (!state->mobile || event->button != 1) return FALSE;
    // GTK also emits multi-click notifications after the ordinary press.
    if (event->type != GDK_BUTTON_PRESS) return TRUE;
    state->active = TRUE;
    touch(view, state, GDK_TOUCH_BEGIN, event->x, event->y);
    return TRUE;
}
static gboolean released(GtkWidget *view, GdkEventButton *event, gpointer data) {
    TouchState *state = data;
    if (state->sending || gdk_event_get_pointer_emulated((GdkEvent *)event)) return FALSE;
    if (!state->mobile || event->button != 1 || !state->active) return FALSE;
    state->active = FALSE;
    touch(view, state, GDK_TOUCH_END, event->x, event->y);
    return TRUE;
}
static gboolean moved(GtkWidget *view, GdkEventMotion *event, gpointer data) {
    TouchState *state = data;
    if (state->sending || gdk_event_get_pointer_emulated((GdkEvent *)event)) return FALSE;
    if (!state->mobile) return FALSE;
    if (state->active) touch(view, state, GDK_TOUCH_UPDATE, event->x, event->y);
    return TRUE;
}
double cn_preview_scale(void *opaque, double *device) {
    *device = gtk_widget_get_scale_factor(GTK_WIDGET(opaque));
    return webkit_web_view_get_zoom_level(WEBKIT_WEB_VIEW(opaque)) * *device;
}
int cn_preview_profile(void *opaque, const char *ua, double zoom, double density) {
    (void)density;
    GtkWidget *view = GTK_WIDGET(opaque);
    TouchState *state = g_object_get_data(G_OBJECT(view), "codenomad-mobile-touch");
    if (!state) {
        state = g_new0(TouchState, 1);
        g_object_set_data_full(G_OBJECT(view), "codenomad-mobile-touch", state, g_free);
        g_signal_connect(view, "button-press-event", G_CALLBACK(pressed), state);
        g_signal_connect(view, "button-release-event", G_CALLBACK(released), state);
        g_signal_connect(view, "motion-notify-event", G_CALLBACK(moved), state);
    }
    if (state->active) touch(view, state, GDK_TOUCH_CANCEL, state->x, state->y);
    state->active = FALSE; state->mobile = ua && *ua;
    WebKitWebView *web = WEBKIT_WEB_VIEW(view);
    webkit_settings_set_user_agent(webkit_web_view_get_settings(web), state->mobile ? ua : NULL);
    cn_preview_zoom_base(opaque, zoom);
    return 0;
}
