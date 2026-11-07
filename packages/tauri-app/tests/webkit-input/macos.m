#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include "sequence.h"

@interface Runner : NSObject <WKNavigationDelegate>
@property NSWindow *window;
@property WKWebView *view;
@property NSInteger step;
@property NSPoint pointer;
@end
@implementation Runner
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view; (void)navigation;
    self.pointer = NSEvent.mouseLocation;
    self.step = -4;
    [NSTimer scheduledTimerWithTimeInterval:0.25 target:self selector:@selector(tick:) userInfo:nil repeats:YES];
}
- (void)tick:(NSTimer *)timer {
    void *view = (__bridge void *)self.view;
    if (self.step >= 0) assert(!self.window.isKeyWindow && !NSApp.active);
    if (self.step >= 0 && self.step <= 19) sequence(view, (int)self.step);
    if (self.step == 21) cn_checkpoint(view, write_result, "checkpoint.json");
    if (self.step == 22) cn_capture(view, write_result, "capture.png");
    if (self.step == 26) {
        NSPoint pointer = NSEvent.mouseLocation;
        printf("window_key=%d app_active=%d pointer_before=%g,%g pointer_after=%g,%g\n",
            self.window.isKeyWindow, NSApp.active, self.pointer.x, self.pointer.y, pointer.x, pointer.y);
        assert(!self.window.isKeyWindow && !NSApp.active);
        assert(NSEqualPoints(self.pointer, pointer));
        [timer invalidate];
        fflush(stdout);
        exit(0);
    }
    self.step++;
}
@end
int main(int argc, char **argv) {
    assert(argc == 2);
    @autoreleasepool {
        [NSApplication sharedApplication];
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        Runner *runner = [Runner new];
        runner.window = [[NSWindow alloc] initWithContentRect:NSMakeRect(30, 30, 700, 600)
            styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
        runner.window.title = @"CodeNomad input qualification (no activation)";
        runner.view = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 700, 600)];
        runner.window.contentView = runner.view;
        runner.view.navigationDelegate = runner;
        [runner.window orderFront:nil];
        NSString *html = [NSString stringWithContentsOfFile:[NSString stringWithUTF8String:argv[1]]
            encoding:NSUTF8StringEncoding error:nil];
        assert(html);
        [runner.view loadHTMLString:html baseURL:[NSURL URLWithString:@"http://127.0.0.1/"]];
        [NSApp run];
    }
}
