#pragma once
#include <stddef.h>
#include <stdint.h>

/* UI-thread only. Bytes passed to completion are borrowed until it returns.
 * The caller owns the exact guest, visibility/generation and deadline fences.
 * No function raises a window or injects global desktop input. */
typedef void (*CNCompletion)(void *, const unsigned char *, size_t, const char *);
enum CNPointer { CN_MOVE, CN_LEFT_DOWN, CN_LEFT_UP, CN_RIGHT_DOWN, CN_RIGHT_UP, CN_DRAG };
enum CNModifier { CN_SHIFT = 1, CN_CONTROL = 2, CN_ALT = 4, CN_META = 8 };
void cn_checkpoint(void *view, CNCompletion done, void *context);
int cn_pointer(void *view, int action, double x, double y, unsigned modifiers);
int cn_wheel(void *view, double x, double y, double dx, double dy, unsigned modifiers);
int cn_key(void *view, const char *key, unsigned modifiers, int down);
int cn_text(void *view, const char *text);
void cn_capture(void *view, CNCompletion done, void *context);
int cn_install_page_read(void *view);
void cn_page_read(void *view, const char *request, unsigned timeout_ms, CNCompletion done, void *context);

/* Fixed isolated-world program. A page-global value must never leak into it.
 * The document fields also permit an external fixture to publish observations. */
#define CN_CHECKPOINT "JSON.stringify({url:location.href,title:document.title,body:document.body?document.body.innerText:'',width:innerWidth,height:innerHeight,pageGlobal:typeof window.__codenomadPageOnly})"
#define CN_WORLD "com.codenomad.preview.automation.v1"
