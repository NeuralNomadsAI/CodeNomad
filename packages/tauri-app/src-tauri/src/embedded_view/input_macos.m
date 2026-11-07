#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#include "input.h"
#include <math.h>

static void fail(CNCompletion done, void *context, NSString *error) {
    done(context, NULL, 0, error.UTF8String);
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

static NSView *target(WKWebView *view, double x, double y, NSPoint *point) {
    if (!view.window || view.hidden || !isfinite(x) || !isfinite(y) ||
        x < 0 || y < 0 || x >= view.bounds.size.width || y >= view.bounds.size.height) return nil;
    NSPoint local = NSMakePoint(x, view.isFlipped ? y : view.bounds.size.height - y);
    *point = [view convertPoint:local toView:nil];
    return [view hitTest:[view convertPoint:local toView:view.superview]];
}

int cn_pointer(void *opaque, int action, double x, double y, unsigned flags) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSPoint point;
    NSView *receiver = target(view, x, y, &point);
    if (!receiver || action < CN_MOVE || action > CN_DRAG) return 0;
    NSEventType types[] = {NSEventTypeMouseMoved, NSEventTypeLeftMouseDown,
        NSEventTypeLeftMouseUp, NSEventTypeRightMouseDown, NSEventTypeRightMouseUp,
        NSEventTypeLeftMouseDragged};
    NSEvent *event = [NSEvent mouseEventWithType:types[action] location:point
        modifierFlags:modifiers(flags) timestamp:NSProcessInfo.processInfo.systemUptime
        windowNumber:view.window.windowNumber context:nil eventNumber:0
        clickCount:(action == CN_MOVE || action == CN_DRAG) ? 0 : 1
        pressure:(action == CN_LEFT_DOWN || action == CN_DRAG) ? 1 : 0];
    switch (action) {
        case CN_MOVE: [receiver mouseMoved:event]; break;
        case CN_LEFT_DOWN: [receiver mouseDown:event]; break;
        case CN_LEFT_UP: [receiver mouseUp:event]; break;
        case CN_RIGHT_DOWN: [receiver rightMouseDown:event]; break;
        case CN_RIGHT_UP: [receiver rightMouseUp:event]; break;
        case CN_DRAG: [receiver mouseDragged:event]; break;
    }
    return 1;
}

int cn_wheel(void *opaque, double x, double y, double dx, double dy, unsigned flags) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSPoint point;
    NSView *receiver = target(view, x, y, &point);
    if (!receiver || !isfinite(dx) || !isfinite(dy)) return 0;
    /* CGEvent is only an event value here: never post it to the system queue. */
    CGEventRef cg = CGEventCreateScrollWheelEvent(NULL, kCGScrollEventUnitPixel, 2,
        (int32_t)-dy, (int32_t)-dx);
    if (!cg) return 0;
    CGEventSetFlags(cg, (CGEventFlags)modifiers(flags));
    CGEventSetLocation(cg, point);
    NSEvent *event = [NSEvent eventWithCGEvent:cg];
    [receiver scrollWheel:event];
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
    /* Keycodes for command shortcuts on the ANSI layout. Text insertion uses
     * the responder API and is independent of keyboard layout. */
    NSArray *keys = @[@"a", @"s", @"d", @"f", @"h", @"g", @"z", @"x", @"c", @"v", @"", @"b", @"q", @"w", @"e", @"r", @"y", @"t", @"1", @"2", @"3", @"4", @"6", @"5", @"=", @"9", @"7", @"-", @"8", @"0", @"]", @"o", @"u", @"[", @"i", @"p", @"", @"l", @"j", @"'", @"k", @";", @"\\", @",", @"/", @"n", @"m", @".", @"", @" "];
    NSUInteger index = [keys indexOfObject:text.lowercaseString];
    if (index == NSNotFound || !text.length) return nil;
    *code = (unsigned short)index;
    return text;
}

int cn_key(void *opaque, const char *key, unsigned flags, int down) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    if (!view.window || view.hidden) return 0;
    unsigned short code = 0;
    NSString *text = characters(key, &code);
    if (!text) return 0;
    NSEvent *event = [NSEvent keyEventWithType:down ? NSEventTypeKeyDown : NSEventTypeKeyUp
        location:NSZeroPoint modifierFlags:modifiers(flags)
        timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:view.window.windowNumber
        context:nil characters:text charactersIgnoringModifiers:text isARepeat:NO keyCode:code];
    NSResponder *receiver = view.window.firstResponder;
    if (![receiver isKindOfClass:NSView.class] || ![(NSView *)receiver isDescendantOf:view]) receiver = view;
    if (down) [receiver keyDown:event]; else [receiver keyUp:event];
    return 1;
}

int cn_text(void *opaque, const char *text) {
    WKWebView *view = (__bridge WKWebView *)opaque;
    NSResponder *receiver = view.window.firstResponder;
    if (!view.window || view.hidden || ![receiver isKindOfClass:NSView.class] ||
        ![(NSView *)receiver isDescendantOf:view] || ![receiver respondsToSelector:@selector(insertText:replacementRange:)]) return 0;
    [(id<NSTextInputClient>)receiver insertText:[NSString stringWithUTF8String:text]
        replacementRange:NSMakeRange(NSNotFound, 0)];
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
