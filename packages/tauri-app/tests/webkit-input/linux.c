#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include "sequence.h"

static GtkWidget *window, *view;
static int step = -4;
static gint initial_x, initial_y;
static GdkDevice *pointer;
static gboolean tick(gpointer unused) {
    (void)unused;
    if (step >= 0 && step <= 19) sequence(view, step);
    if (step == 21) cn_checkpoint(view, write_result, "checkpoint.json");
    if (step == 22) cn_capture(view, write_result, "capture.png");
    if (step == 26) {
        gint x, y;
        gdk_device_get_position(pointer, NULL, &x, &y);
        printf("window_active=%d pointer_before=%d,%d pointer_after=%d,%d backend=%s\n",
            gtk_window_is_active(GTK_WINDOW(window)), initial_x, initial_y, x, y,
            G_OBJECT_TYPE_NAME(gtk_widget_get_display(window)));
        assert(!gtk_window_is_active(GTK_WINDOW(window)));
        assert(x == initial_x && y == initial_y);
        gtk_main_quit();
        return G_SOURCE_REMOVE;
    }
    step++;
    return G_SOURCE_CONTINUE;
}
static void loaded(WebKitWebView *webview, WebKitLoadEvent event, gpointer unused) {
    (void)webview; (void)unused;
    if (event == WEBKIT_LOAD_FINISHED) g_timeout_add(250, tick, NULL);
}
int main(int argc, char **argv) {
    assert(argc == 2);
    gtk_init(&argc, &argv);
    window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "CodeNomad input qualification (no activation)");
    gtk_window_set_focus_on_map(GTK_WINDOW(window), FALSE);
    gtk_window_set_default_size(GTK_WINDOW(window), 700, 600);
    view = webkit_web_view_new();
    gtk_container_add(GTK_CONTAINER(window), view);
    g_signal_connect(view, "load-changed", G_CALLBACK(loaded), NULL);
    gtk_widget_show_all(window);
    pointer = gdk_seat_get_pointer(gdk_display_get_default_seat(gtk_widget_get_display(window)));
    gdk_device_get_position(pointer, NULL, &initial_x, &initial_y);
    char *html = NULL;
    assert(g_file_get_contents(argv[1], &html, NULL, NULL));
    webkit_web_view_load_html(WEBKIT_WEB_VIEW(view), html, "http://127.0.0.1/");
    g_free(html);
    gtk_main();
    gtk_widget_destroy(window);
    return 0;
}
