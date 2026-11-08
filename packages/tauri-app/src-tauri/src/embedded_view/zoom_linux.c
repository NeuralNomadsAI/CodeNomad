#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include "zoom.h"

typedef struct { double base, user; gboolean installed; } Zoom;
static Zoom *state(WebKitWebView *view) {
    Zoom *zoom = g_object_get_data(G_OBJECT(view), "codenomad-preview-zoom");
    if (!zoom) {
        zoom = g_new0(Zoom, 1);
        zoom->base = webkit_web_view_get_zoom_level(view); zoom->user = 1;
        g_object_set_data_full(G_OBJECT(view), "codenomad-preview-zoom", zoom, g_free);
    }
    return zoom;
}
static gboolean focused(GtkWidget *view) {
    GtkWidget *window = gtk_widget_get_toplevel(view);
    return gtk_widget_get_mapped(view) && GTK_IS_WINDOW(window)
        && gtk_window_is_active(GTK_WINDOW(window))
        && gtk_window_get_focus(GTK_WINDOW(window)) == view;
}
int cn_preview_zoom_focused(void *opaque, int action) {
    GtkWidget *view = GTK_WIDGET(opaque);
    if (action < -1 || action > 1 || !focused(view)) return 0;
    Zoom *zoom = state(WEBKIT_WEB_VIEW(view));
    zoom->user = cn_preview_next_zoom(zoom->user, action);
    webkit_web_view_set_zoom_level(WEBKIT_WEB_VIEW(view), zoom->base * zoom->user);
    return 1;
}
static gboolean key_press(GtkWidget *view, GdkEventKey *event, gpointer unused) {
    (void)unused;
    GdkModifierType modifiers = event->state & gtk_accelerator_get_default_mod_mask();
    modifiers &= ~GDK_SHIFT_MASK;
    if (modifiers != GDK_CONTROL_MASK) return FALSE;
    int action;
    switch (event->keyval) {
        case GDK_KEY_plus: case GDK_KEY_equal: case GDK_KEY_KP_Add: action = 1; break;
        case GDK_KEY_minus: case GDK_KEY_KP_Subtract: action = -1; break;
        case GDK_KEY_0: case GDK_KEY_KP_0: action = 0; break;
        default: return FALSE;
    }
    return cn_preview_zoom_focused(view, action);
}
void cn_preview_zoom_install(void *opaque) {
    WebKitWebView *view = WEBKIT_WEB_VIEW(opaque);
    Zoom *zoom = state(view);
    if (!zoom->installed) {
        zoom->installed = TRUE;
        g_signal_connect(view, "key-press-event", G_CALLBACK(key_press), NULL);
    }
}
void cn_preview_zoom_base(void *opaque, double base) {
    WebKitWebView *view = WEBKIT_WEB_VIEW(opaque);
    Zoom *zoom = state(view);
    zoom->base = base;
    webkit_web_view_set_zoom_level(view, base * zoom->user);
}
