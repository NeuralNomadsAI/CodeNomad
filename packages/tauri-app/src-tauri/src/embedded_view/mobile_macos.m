#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
@interface WKWebView (CNDeviceScale)
- (void)_setOverrideDeviceScaleFactor:(CGFloat)scale;
@end
double cn_preview_scale(void *opaque,double *device) {
    WKWebView *view=(__bridge WKWebView *)opaque;
    *device=view.window.backingScaleFactor;
    return view.pageZoom * *device;
}
int cn_preview_profile(void *opaque,const char *ua,double zoom,double density) {
    WKWebView *view=(__bridge WKWebView *)opaque;
    view.customUserAgent=ua&&*ua?[NSString stringWithUTF8String:ua]:nil;
    view.pageZoom=zoom;
    if([view respondsToSelector:@selector(_setOverrideDeviceScaleFactor:)]) {
        [view _setOverrideDeviceScaleFactor:density];return 1;
    }
    return 0;
}
