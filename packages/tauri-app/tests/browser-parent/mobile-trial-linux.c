#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
int cn_mobile_trial(void *opaque,const char *ua,double zoom,double dpr,double width,double height,int mode) {
    (void)dpr;(void)width;(void)height;(void)mode;
    WebKitWebView *view=WEBKIT_WEB_VIEW(opaque);
    webkit_settings_set_user_agent(webkit_web_view_get_settings(view),ua&&*ua?ua:NULL);
    webkit_web_view_set_zoom_level(view,zoom);
    return 0;
}
int cn_mobile_touch(void *opaque,int phase,double x,double y) {
    GtkWidget *view=GTK_WIDGET(opaque);
    GdkWindow *window=gtk_widget_get_window(view);
    GdkSeat *seat=gdk_display_get_default_seat(gtk_widget_get_display(view));
    if(!window||!seat)return 0;
    GdkEvent *event=gdk_event_new(phase==0?GDK_TOUCH_BEGIN:phase==1?GDK_TOUCH_UPDATE:GDK_TOUCH_END);
    event->touch.window=g_object_ref(window);event->touch.send_event=FALSE;
    event->touch.time=GDK_CURRENT_TIME;event->touch.x=x;event->touch.y=y;
    event->touch.sequence=(GdkEventSequence *)view;event->touch.emulating_pointer=TRUE;
    int ox=0,oy=0;gdk_window_get_origin(window,&ox,&oy);event->touch.x_root=ox+x;event->touch.y_root=oy+y;
    gdk_event_set_device(event,gdk_seat_get_pointer(seat));
    gtk_widget_event(view,event);gdk_event_free(event);return 1;
}
