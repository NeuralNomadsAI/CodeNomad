#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
@interface WKWebView (CNMobileTrial)
- (void)_setOverrideDeviceScaleFactor:(CGFloat)scale;
- (void)_setLayoutMode:(NSUInteger)mode;
- (void)_setFixedLayoutSize:(CGSize)size;
- (void)_setViewScale:(CGFloat)scale;
@end
int cn_mobile_trial(void *opaque,const char *ua,double zoom,double dpr,double width,double height,int mode) {
    WKWebView *view=(__bridge WKWebView *)opaque;
    view.customUserAgent=ua&&*ua?[NSString stringWithUTF8String:ua]:nil;
    view.pageZoom=zoom;
    int flags=0;
    if([view respondsToSelector:@selector(_setOverrideDeviceScaleFactor:)]) {flags|=1;[view _setOverrideDeviceScaleFactor:dpr];}
    if([view respondsToSelector:@selector(_setLayoutMode:)] && [view respondsToSelector:@selector(_setFixedLayoutSize:)]) {
        flags|=2;[view _setLayoutMode:mode==1?1:0];[view _setFixedLayoutSize:CGSizeMake(width,height)];
    }
    if([view respondsToSelector:@selector(_setViewScale:)]) {flags|=4;[view _setViewScale:mode==2?0.5:1];}
    return flags;
}
int cn_mobile_touch(void *opaque,int phase,double x,double y) {(void)opaque;(void)phase;(void)x;(void)y;return 0;}
