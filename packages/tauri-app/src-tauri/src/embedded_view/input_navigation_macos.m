#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#include <stdint.h>

typedef void (*CNLoad)(void *, uint64_t, int, const char *, const char *);
typedef void (*CNRelease)(void *);
@interface CNLoadObserver : NSObject <WKNavigationDelegate>
@property (strong) id<WKNavigationDelegate> original;
@property CNLoad callback;
@property CNRelease releaseContext;
@property void *context;
@end
@implementation CNLoadObserver
- (BOOL)respondsToSelector:(SEL)selector {
    return [super respondsToSelector:selector] || [self.original respondsToSelector:selector];
}
- (id)forwardingTargetForSelector:(SEL)selector { return self.original; }
- (void)webView:(WKWebView *)view didStartProvisionalNavigation:(WKNavigation *)navigation {
    if ([self.original respondsToSelector:_cmd]) [self.original webView:view didStartProvisionalNavigation:navigation];
    self.callback(self.context, (uint64_t)(uintptr_t)(__bridge void *)navigation, 0, view.URL.absoluteString.UTF8String, NULL);
}
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    if ([self.original respondsToSelector:_cmd]) [self.original webView:view didFinishNavigation:navigation];
    self.callback(self.context, (uint64_t)(uintptr_t)(__bridge void *)navigation, 1, view.URL.absoluteString.UTF8String, NULL);
}
- (void)webView:(WKWebView *)view didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([self.original respondsToSelector:_cmd]) [self.original webView:view didFailProvisionalNavigation:navigation withError:error];
    self.callback(self.context, (uint64_t)(uintptr_t)(__bridge void *)navigation, 2, view.URL.absoluteString.UTF8String, error.localizedDescription.UTF8String);
}
- (void)webView:(WKWebView *)view didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if ([self.original respondsToSelector:_cmd]) [self.original webView:view didFailNavigation:navigation withError:error];
    self.callback(self.context, (uint64_t)(uintptr_t)(__bridge void *)navigation, 2, view.URL.absoluteString.UTF8String, error.localizedDescription.UTF8String);
}
- (void)dealloc { if (self.releaseContext) self.releaseContext(self.context); }
@end

int cn_observe_load(void *opaque, CNLoad callback, CNRelease releaseContext, void *context) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    if (!view.navigationDelegate) return 0;
    CNLoadObserver *observer = [CNLoadObserver new];
    observer.original = view.navigationDelegate;
    observer.callback = callback;
    observer.context = context;
    observer.releaseContext = releaseContext;
    static char key;
    objc_setAssociatedObject(view, &key, observer, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    view.navigationDelegate = observer;
    return 1;
}

uint64_t cn_navigate(void *opaque, const char *url) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSURL *target = [NSURL URLWithString:[NSString stringWithUTF8String:url]];
    WKNavigation *navigation = [view loadRequest:[NSURLRequest requestWithURL:target]];
    return (uint64_t)(uintptr_t)(__bridge void *)navigation;
}
