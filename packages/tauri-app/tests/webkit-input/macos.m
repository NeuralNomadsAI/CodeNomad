#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include "sequence.h"
#include <objc/runtime.h>
extern void cn_test_scoped_buttons(void);
@interface WKWebView (CNInputDrain)
- (void)_doAfterProcessingAllPendingKeyEvents:(void (^)(void))completion;
- (void)_doAfterProcessingAllPendingMouseEvents:(void (^)(void))completion;
@end

@interface Runner : NSObject <WKNavigationDelegate>
@property NSWindow *window;
@property WKWebView *view;
@property NSInteger step;
@property NSPoint pointer;
@end
static void painted(void *context, const unsigned char *bytes, size_t length, const char *error) {
    (void)bytes; (void)length;
    assert(!error);
    Runner *runner = (__bridge Runner *)context;
    [NSTimer scheduledTimerWithTimeInterval:0.25 target:runner selector:@selector(tick:) userInfo:nil repeats:YES];
}
@implementation Runner
- (void)webView:(WKWebView *)view didFinishNavigation:(WKNavigation *)navigation {
    (void)view; (void)navigation;
    self.pointer = NSEvent.mouseLocation;
    self.step = -4;
    cn_capture((__bridge void *)self.view, painted, (__bridge void *)self);
}
- (void)tick:(NSTimer *)timer {
    void *view = (__bridge void *)self.view;
    if (self.step >= 0) assert(!self.window.isKeyWindow && !NSApp.active);
    if (self.step == -1) {
        self.window.acceptsMouseMovedEvents = YES;
        [self.view updateTrackingAreas];
        fprintf(stderr, "hover variant=prime-5,5-then-target trackingAreas=%lu acceptsMouseMoved=%d\n", (unsigned long)self.view.trackingAreas.count, self.window.acceptsMouseMovedEvents);
        assert(cn_pointer(view, CN_MOVE, 5, 5, 0));
    }
    IMP buttons = class_getMethodImplementation(object_getClass(NSEvent.class), @selector(pressedMouseButtons));
    IMP modifiers = class_getMethodImplementation(object_getClass(NSEvent.class), @selector(modifierFlags));
    BOOL omit_chord = getenv("CN_INPUT_NO_CHORD") && (self.step == 12 || self.step == 13);
    if (self.step >= 0 && self.step <= 19 && !omit_chord) sequence(view, (int)self.step);
    assert(class_getMethodImplementation(object_getClass(NSEvent.class), @selector(pressedMouseButtons)) == buttons);
    assert(class_getMethodImplementation(object_getClass(NSEvent.class), @selector(modifierFlags)) == modifiers);
    if (self.step >= 0 && self.step <= 19 && getenv("CN_INPUT_TRACE")) {
        NSInteger current = self.step;
        if ([self.view respondsToSelector:@selector(_doAfterProcessingAllPendingKeyEvents:)])
            [self.view _doAfterProcessingAllPendingKeyEvents:^{ fprintf(stderr, "key-drained step=%ld\n", (long)current); }];
        if ([self.view respondsToSelector:@selector(_doAfterProcessingAllPendingMouseEvents:)])
            [self.view _doAfterProcessingAllPendingMouseEvents:^{ fprintf(stderr, "mouse-drained step=%ld\n", (long)current); }];
    }
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
        cn_test_scoped_buttons();
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
