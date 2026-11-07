#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include "input.h"
#include "page_read.generated.h"
#include <math.h>
#include <objc/runtime.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>

/* WebKit samples this class method while translating native mouse input.
 * Only the dispatching UI thread sees synthetic state. Other threads retain
 * the original behavior, and every exit path restores the implementation. */
static _Thread_local unsigned synthetic_depth;
static _Thread_local NSUInteger synthetic_buttons;
static _Atomic(IMP) original_buttons;
static NSUInteger pressed_buttons(id object, SEL selector) {
    if (synthetic_depth) return synthetic_buttons;
    return ((NSUInteger (*)(id, SEL))atomic_load(&original_buttons))(object, selector);
}
static void with_buttons(NSUInteger buttons, void (^dispatch)(void)) {
    NSCAssert(NSThread.isMainThread, @"Native input requires the UI thread");
    Method method = class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons));
    NSUInteger previous = synthetic_buttons;
    BOOL outer = synthetic_depth == 0;
    IMP original = NULL;
    if (outer) {
        original = method_getImplementation(method);
        atomic_store(&original_buttons, original);
        method_setImplementation(method, (IMP)pressed_buttons);
    }
    synthetic_depth++;
    synthetic_buttons = buttons;
    @try { dispatch(); }
    @finally {
        synthetic_buttons = previous;
        synthetic_depth--;
        if (outer) method_setImplementation(method, original);
    }
}
static void trace(NSString *message) {
    if (getenv("CN_INPUT_TRACE")) fprintf(stderr, "%s\n", message.UTF8String);
}
static _Thread_local unsigned modifier_depth;
static _Thread_local NSEventModifierFlags synthetic_modifiers;
static _Atomic(IMP) original_modifiers;
static NSEventModifierFlags modifier_flags(id object, SEL selector) {
    if (modifier_depth) return synthetic_modifiers;
    return ((NSEventModifierFlags (*)(id, SEL))atomic_load(&original_modifiers))(object, selector);
}
static void with_modifiers(NSEventModifierFlags flags, void (^dispatch)(void)) {
    NSCAssert(NSThread.isMainThread, @"Native input requires the UI thread");
    Method method = class_getClassMethod(NSEvent.class, @selector(modifierFlags));
    BOOL outer = modifier_depth == 0;
    NSEventModifierFlags previous = synthetic_modifiers;
    IMP original = NULL;
    if (outer) {
        original = method_getImplementation(method);
        atomic_store(&original_modifiers, original);
        method_setImplementation(method, (IMP)modifier_flags);
    }
    modifier_depth++;
    synthetic_modifiers = flags;
    @try { dispatch(); }
    @finally {
        synthetic_modifiers = previous;
        modifier_depth--;
        if (outer) method_setImplementation(method, original);
    }
}
#ifdef CN_INPUT_SELF_TEST
void cn_test_scoped_buttons(void) {
    Method method = class_getClassMethod(NSEvent.class, @selector(pressedMouseButtons));
    IMP original = method_getImplementation(method);
    NSUInteger physical = NSEvent.pressedMouseButtons;
    @try {
        with_buttons(1, ^{
            NSCAssert(NSEvent.pressedMouseButtons == 1, @"synthetic button missing");
            with_buttons(2, ^{ NSCAssert(NSEvent.pressedMouseButtons == 2, @"nested button missing"); });
            NSCAssert(NSEvent.pressedMouseButtons == 1, @"nested state leaked");
            dispatch_semaphore_t observed = dispatch_semaphore_create(0);
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                NSCAssert(NSEvent.pressedMouseButtons == physical, @"synthetic state leaked to another thread");
                dispatch_semaphore_signal(observed);
            });
            NSCAssert(dispatch_semaphore_wait(observed, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC)) == 0, @"background check timed out");
            @throw [NSException exceptionWithName:@"Qualification" reason:@"test cleanup" userInfo:nil];
        });
    } @catch (NSException *exception) {
        NSCAssert([exception.name isEqualToString:@"Qualification"], @"unexpected exception");
    }
    NSCAssert(method_getImplementation(method) == original, @"method implementation leaked");
    NSCAssert(NSEvent.pressedMouseButtons == physical, @"button state leaked");
    Method modifier_method = class_getClassMethod(NSEvent.class, @selector(modifierFlags));
    IMP modifier_original = method_getImplementation(modifier_method);
    NSEventModifierFlags physical_modifiers = NSEvent.modifierFlags;
    @try {
        with_modifiers(NSEventModifierFlagCommand, ^{
            NSCAssert(NSEvent.modifierFlags == NSEventModifierFlagCommand, @"synthetic modifier missing");
            with_modifiers(0, ^{ NSCAssert(NSEvent.modifierFlags == 0, @"zero modifier missing"); });
            NSCAssert(NSEvent.modifierFlags == NSEventModifierFlagCommand, @"nested modifier leaked");
            @throw [NSException exceptionWithName:@"Qualification" reason:@"modifier cleanup" userInfo:nil];
        });
    } @catch (NSException *exception) {
        NSCAssert([exception.name isEqualToString:@"Qualification"], @"unexpected exception");
    }
    NSCAssert(method_getImplementation(modifier_method) == modifier_original, @"modifier implementation leaked");
    NSCAssert(NSEvent.modifierFlags == physical_modifiers, @"modifier state leaked");
}
#endif

/* Public mouseMoved: is inherited from NSView on the qualified WebKit build.
 * This SPI is explicitly checked at runtime; its DOM behavior stays gated by
 * the strict hover assertion before application integration. */
@interface WKWebView (CNTargetedMouseMove)
- (void)_simulateMouseMove:(NSEvent *)event;
@end
#ifdef CN_INPUT_SELF_TEST
int cn_test_direct_hover(void *opaque, double x, double y) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSPoint local = NSMakePoint(x, view.isFlipped ? y : view.bounds.size.height - y);
    NSPoint point = [view convertPoint:local toView:nil];
    NSEvent *entered = [NSEvent enterExitEventWithType:NSEventTypeMouseEntered location:point
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber
        context:nil eventNumber:1 trackingNumber:0 userData:NULL];
    NSEvent *moved = [NSEvent mouseEventWithType:NSEventTypeMouseMoved location:point
        modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber
        context:nil eventNumber:2 clickCount:0 pressure:0];
    trace([NSString stringWithFormat:@"hover direct mouseEntered+mouseMoved css=%g,%g window=%g,%g flipped=%d keyWindow=%d", x, y, point.x, point.y, view.isFlipped, view.window.isKeyWindow]);
    [view mouseEntered:entered];
    [view mouseMoved:moved];
    return 1;
}
#endif

static void fail(CNCompletion done, void *context, NSString *error) {
    done(context, NULL, 0, error.UTF8String);
}
int cn_install_page_read(void *opaque) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    WKUserScript *hook = [[WKUserScript alloc] initWithSource:[NSString stringWithUTF8String:CN_PAGE_HOOK] injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:NO inContentWorld:WKContentWorld.pageWorld];
    [view.configuration.userContentController addUserScript:hook];
    return 1;
}
void cn_page_read(void *opaque, const char *request, unsigned timeout_ms, CNCompletion done, void *context) {
    (void)timeout_ms; // The Rust request fence rejects late WKWebView callbacks.
    WKWebView *view = (__bridge WKWebView *)opaque;
    if (view.loading) { fail(done,context,@"Native browser page is loading"); return; }
    NSDictionary *arguments = @{ @"request": [NSString stringWithUTF8String:request] };
    [view callAsyncJavaScript:[NSString stringWithUTF8String:CN_PAGE_READ] arguments:arguments inFrame:nil inContentWorld:[WKContentWorld worldWithName:@CN_WORLD]
        completionHandler:^(id result, NSError *error) {
            if (error || view.loading || ![result isKindOfClass:NSString.class]) {
                fail(done,context,error.localizedDescription ?: @"Native browser page changed or is loading"); return;
            }
            NSData *bytes = [result dataUsingEncoding:NSUTF8StringEncoding];
            done(context,bytes.bytes,bytes.length,NULL);
        }];
}
void cn_checkpoint(void *opaque, CNCompletion done, void *context) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    [view evaluateJavaScript:@CN_CHECKPOINT inFrame:nil
        inContentWorld:[WKContentWorld worldWithName:@CN_WORLD]
        completionHandler:^(id result, NSError *error) {
            if (error || ![result isKindOfClass:NSString.class]) {
                fail(done, context, error.localizedDescription ?: @"WebKit evaluation returned no value");
                return;
            }
            NSData *bytes = [result dataUsingEncoding:NSUTF8StringEncoding];
            done(context, bytes.bytes, bytes.length, NULL);
        }];
}
static NSEventModifierFlags modifiers(unsigned flags) {
    return ((flags & CN_SHIFT) ? NSEventModifierFlagShift : 0) |
        ((flags & CN_CONTROL) ? NSEventModifierFlagControl : 0) |
        ((flags & CN_ALT) ? NSEventModifierFlagOption : 0) |
        ((flags & CN_META) ? NSEventModifierFlagCommand : 0);
}
static BOOL target(WKWebView *view, double x, double y, NSPoint *point) {
    if (!view.window || view.hidden || !isfinite(x) || !isfinite(y) ||
        x < 0 || y < 0 || x >= view.bounds.size.width || y >= view.bounds.size.height) return NO;
    NSPoint local = NSMakePoint(x, view.isFlipped ? y : view.bounds.size.height - y);
    *point = [view convertPoint:local toView:nil];
    return YES;
}
int cn_pointer(void *opaque, int action, double x, double y, unsigned flags) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSPoint point;
    if (!target(view, x, y, &point) || action < CN_MOVE || action > CN_DRAG) return 0;
    IMP inherited = class_getMethodImplementation(NSView.class, @selector(mouseMoved:));
    BOOL public_move = class_getMethodImplementation(view.class, @selector(mouseMoved:)) != inherited;
    if (action == CN_MOVE && !public_move && ![view respondsToSelector:@selector(_simulateMouseMove:)]) return 0;
    NSEventType types[] = {NSEventTypeMouseMoved, NSEventTypeLeftMouseDown,
        NSEventTypeLeftMouseUp, NSEventTypeRightMouseDown, NSEventTypeRightMouseUp,
        NSEventTypeLeftMouseDragged};
    static char sequence_key;
    NSInteger number = [objc_getAssociatedObject(view, &sequence_key) integerValue] + 1;
    objc_setAssociatedObject(view, &sequence_key, @(number), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSEvent *event = [NSEvent mouseEventWithType:types[action] location:point
        modifierFlags:modifiers(flags) timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:view.window.windowNumber context:nil eventNumber:number
        clickCount:action == CN_MOVE ? 0 : 1
        pressure:(action == CN_LEFT_DOWN || action == CN_DRAG) ? 1 : 0];
    NSUInteger buttons = (action == CN_LEFT_DOWN || action == CN_DRAG) ? 1 : (action == CN_RIGHT_DOWN ? 2 : 0);
    with_buttons(buttons, ^{
        switch (action) {
            case CN_MOVE:
                trace([NSString stringWithFormat:@"hover css=%g,%g window=%g,%g flipped=%d", x, y, point.x, point.y, view.isFlipped]);
                if (public_move) { trace(@"hover public-mouseMoved"); [view mouseMoved:event]; }
                else { trace(@"hover SPI=_simulateMouseMove:"); [view _simulateMouseMove:event]; }
                break;
            case CN_LEFT_DOWN: [view mouseDown:event]; break;
            case CN_LEFT_UP: [view mouseUp:event]; break;
            case CN_RIGHT_DOWN: [view rightMouseDown:event]; break;
            case CN_RIGHT_UP: [view rightMouseUp:event]; break;
            case CN_DRAG: [view mouseDragged:event]; break;
        }
    });
    return 1;
}
int cn_wheel(void *opaque, double x, double y, double dx, double dy, unsigned flags) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSPoint point;
    if (!target(view, x, y, &point) || !isfinite(dx) || !isfinite(dy)) return 0;
    /* Construct a native event value; never post it to the system queue. */
    CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2, (int32_t)-dy, (int32_t)-dx);
    if (!cg) return 0;
    CGEventSetFlags(cg, (CGEventFlags)modifiers(flags));
    CGEventSetLocation(cg, point);
    [view scrollWheel:[NSEvent eventWithCGEvent:cg]];
    CFRelease(cg);
    return 1;
}
static NSString *characters(const char *key, unsigned short *code) {
    NSString *text = [NSString stringWithUTF8String:key];
    NSDictionary *special = @{
        @"Return": @[@13, @36], @"Tab": @[@9, @48], @"Escape": @[@27, @53],
        @"BackSpace": @[@127, @51], @"Delete": @[@(NSDeleteFunctionKey), @117],
        @"Left": @[@(NSLeftArrowFunctionKey), @123], @"Right": @[@(NSRightArrowFunctionKey), @124],
        @"Down": @[@(NSDownArrowFunctionKey), @125], @"Up": @[@(NSUpArrowFunctionKey), @126],
        @"Home": @[@(NSHomeFunctionKey), @115], @"End": @[@(NSEndFunctionKey), @119],
        @"Page_Up": @[@(NSPageUpFunctionKey), @116], @"Page_Down": @[@(NSPageDownFunctionKey), @121]
    };
    NSArray *entry = special[text];
    if (entry) {
        unichar character = [entry[0] unsignedShortValue];
        *code = [entry[1] unsignedShortValue];
        return [NSString stringWithCharacters:&character length:1];
    }
    // ANSI keycodes serve native shortcuts; Unicode insertion uses the responder API.
    NSArray *keys = @[@"a", @"s", @"d", @"f", @"h", @"g", @"z", @"x", @"c", @"v", @"", @"b", @"q", @"w", @"e", @"r", @"y", @"t", @"1", @"2", @"3", @"4", @"6", @"5", @"=", @"9", @"7", @"-", @"8", @"0", @"]", @"o", @"u", @"[", @"i", @"p", @"", @"l", @"j", @"'", @"k", @";", @"\\", @",", @"/", @"n", @"m", @".", @"", @" "];
    NSUInteger index = [keys indexOfObject:text.lowercaseString];
    if (index == NSNotFound || !text.length) return nil;
    *code = (unsigned short)index;
    return text;
}
static void change_modifiers(WKWebView *view, unsigned before, unsigned after) {
    const unsigned bits[] = {CN_SHIFT, CN_CONTROL, CN_ALT, CN_META};
    const unsigned short codes[] = {56, 59, 58, 55};
    unsigned current = before;
    for (int i = 0; i < 4; i++) {
        if (!((before ^ after) & bits[i])) continue;
        current = (current & ~bits[i]) | (after & bits[i]);
        NSEvent *changed = [NSEvent keyEventWithType:NSEventTypeFlagsChanged location:NSZeroPoint
            modifierFlags:modifiers(current) timestamp:NSProcessInfo.processInfo.systemUptime
            windowNumber:view.window.windowNumber context:nil characters:@"" charactersIgnoringModifiers:@""
            isARepeat:NO keyCode:codes[i]];
        trace([NSString stringWithFormat:@"flagsChanged receiver=%@ code=%hu flags=0x%lx timestamp=%.6f window=%ld", view.class, codes[i], (unsigned long)changed.modifierFlags, changed.timestamp, (long)changed.windowNumber]);
        with_modifiers(changed.modifierFlags, ^{ [view flagsChanged:changed]; });
    }
}
int cn_key(void *opaque, const char *key, unsigned flags, int down) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    if (!view.window || view.hidden) return 0;
    unsigned short code = 0;
    NSString *text = characters(key, &code);
    if (!text) return 0;
    static char held_modifiers_key;
    unsigned held = [objc_getAssociatedObject(view, &held_modifiers_key) unsignedIntValue];
    change_modifiers(view, held, flags);
    objc_setAssociatedObject(view, &held_modifiers_key, @(flags), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSEvent *event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
        location:NSZeroPoint modifierFlags:modifiers(flags)
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber
        context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];
    [view.window makeFirstResponder:view];
    trace([NSString stringWithFormat:@"%@ key=%@ flags=0x%lx timestamp=%.6f window=%ld held=0x%x", down ? @"keyDown" : @"keyUp", [NSString stringWithUTF8String:key], (unsigned long)event.modifierFlags, event.timestamp, (long)event.windowNumber, flags]);
    @try {
    with_modifiers(event.modifierFlags, ^{
    if (down && (flags & CN_META)) {
        BOOL handled = [view performKeyEquivalent:event];
        trace([NSString stringWithFormat:@"key %@ equivalent=%d", text, handled]);
        // An inactive view can acknowledge the key equivalent without executing
        // its editing action. Keep this candidate gated by the harness.
        if (!handled || !view.window.isKeyWindow) {
            NSDictionary *commands = @{@"a": @"selectAll:", @"c": @"copy:", @"v": @"paste:", @"x": @"cut:", @"z": (flags & CN_SHIFT) ? @"redo:" : @"undo:"};
            SEL command = NSSelectorFromString(commands[text.lowercaseString] ?: @"");
            if ([view respondsToSelector:command]) {
                trace([NSString stringWithFormat:@"key %@ native-command=%@", text, NSStringFromSelector(command)]);
                [view tryToPerform:command with:nil];
            } else if (!handled) [view keyDown:event];
        }
    } else if (down) {
        trace([NSString stringWithFormat:@"key %@ keyDown", [NSString stringWithUTF8String:key]]);
        [view keyDown:event];
    } else { trace([NSString stringWithFormat:@"key %@ keyUp", [NSString stringWithUTF8String:key]]); [view keyUp:event]; }
    });
    } @finally {
        if (!down) {
            change_modifiers(view, flags, 0);
            objc_setAssociatedObject(view, &held_modifiers_key, @0, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            trace(@"modifiers reset held=0 synthetic=0");
        }
    }
    return 1;
}
int cn_text(void *opaque, const char *text) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSResponder *receiver = view.window.firstResponder;
    if (!view.window || view.hidden || ![receiver isKindOfClass:NSView.class] ||
        ![(NSView *)receiver isDescendantOf:view] || ![receiver respondsToSelector:@selector(insertText:replacementRange:)]) return 0;
    [(id<NSTextInputClient>)receiver insertText:[NSString stringWithUTF8String:text] replacementRange:NSMakeRange(NSNotFound, 0)];
    return 1;
}
void cn_capture(void *opaque, CNCompletion done, void *context) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    WKSnapshotConfiguration *config = [WKSnapshotConfiguration new];
    config.rect = view.bounds;
    [view takeSnapshotWithConfiguration:config completionHandler:^(NSImage *image, NSError *error) {
        if (error || !image) { fail(done, context, error.localizedDescription ?: @"WebKit snapshot failed"); return; }
        NSBitmapImageRep *bitmap = [NSBitmapImageRep imageRepWithData:image.TIFFRepresentation];
        NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
        if (!png || png.length > 16 * 1024 * 1024) { fail(done, context, @"WebKit snapshot exceeds PNG budget"); return; }
        done(context, png.bytes, png.length, NULL);
    }];
}
