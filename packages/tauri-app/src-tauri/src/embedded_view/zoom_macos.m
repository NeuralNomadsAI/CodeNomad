#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include "zoom.h"

@interface CNPreviewZoom : NSObject
@property double base;
@property double user;
@property(strong) id monitor;
@end
@implementation CNPreviewZoom
- (void)dealloc { if (_monitor) [NSEvent removeMonitor:_monitor]; }
@end
static char zoomKey;
static CNPreviewZoom *state(WKWebView *view) {
    CNPreviewZoom *zoom = objc_getAssociatedObject(view, &zoomKey);
    if (!zoom) {
        zoom = [CNPreviewZoom new]; zoom.base = view.pageZoom; zoom.user = 1;
        objc_setAssociatedObject(view, &zoomKey, zoom, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    return zoom;
}
static BOOL focused(WKWebView *view) {
    NSResponder *responder = view.window.firstResponder;
    return view.window.isKeyWindow && !view.isHiddenOrHasHiddenAncestor
        && [responder isKindOfClass:NSView.class]
        && [(NSView *)responder isDescendantOf:view];
}
int cn_preview_zoom_focused(void *opaque, int action) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    if (action < -1 || action > 1 || !focused(view)) return 0;
    CNPreviewZoom *zoom = state(view);
    zoom.user = cn_preview_next_zoom(zoom.user, action);
    view.pageZoom = zoom.base * zoom.user;
    return 1;
}
void cn_preview_zoom_install(void *opaque) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    CNPreviewZoom *zoom = state(view);
    if (zoom.monitor) return;
    __weak WKWebView *weakView = view;
    zoom.monitor = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
        NSEventModifierFlags flags = event.modifierFlags & (NSEventModifierFlagCommand | NSEventModifierFlagControl | NSEventModifierFlagOption);
        if (flags != NSEventModifierFlagCommand) return event;
        NSString *key = event.charactersIgnoringModifiers;
        int action;
        if ([key isEqualToString:@"+"] || [key isEqualToString:@"="]) action = 1;
        else if ([key isEqualToString:@"-"]) action = -1;
        else if ([key isEqualToString:@"0"]) action = 0;
        else return event;
        WKWebView *target = weakView;
        return target && cn_preview_zoom_focused((__bridge void *)target, action) ? nil : event;
    }];
}
void cn_preview_zoom_base(void *opaque, double base) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    CNPreviewZoom *zoom = state(view);
    zoom.base = base;
    view.pageZoom = base * zoom.user;
}
