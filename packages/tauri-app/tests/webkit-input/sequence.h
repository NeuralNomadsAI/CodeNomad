#include "../../src-tauri/src/embedded_view/input.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Deliberately space IPC deliveries across frames. No JS input substitutes. */
static void sequence(void *view, int step) {
    int ok = 1;
    switch (step) {
        case 0: ok = cn_pointer(view, CN_MOVE, 30, 160, 0); break;
        case 1: ok = cn_pointer(view, CN_RIGHT_DOWN, 30, 160, 0); break;
        case 2: ok = cn_pointer(view, CN_RIGHT_UP, 30, 160, 0); break;
        case 3: ok = cn_pointer(view, CN_LEFT_DOWN, 30, 160, 0); break;
        case 4: ok = cn_pointer(view, CN_DRAG, 90, 190, 0); break;
        case 5: ok = cn_pointer(view, CN_LEFT_UP, 90, 190, 0); break;
        case 6: ok = cn_wheel(view, 90, 190, 0, 100, 0); break;
        case 7: ok = cn_pointer(view, CN_LEFT_DOWN, 30, 30, 0); break;
        case 8: ok = cn_pointer(view, CN_LEFT_UP, 30, 30, 0); break;
        case 9: ok = cn_key(view, "a", 0, 1); break;
        case 10: ok = cn_key(view, "a", 0, 0); break;
        case 11: ok = cn_text(view, "é漢🙂"); break;
        case 12: ok = cn_key(view, "a",
#ifdef __APPLE__
            CN_META,
#else
            CN_CONTROL,
#endif
            1); break;
        case 13: ok = cn_key(view, "a",
#ifdef __APPLE__
            CN_META,
#else
            CN_CONTROL,
#endif
            0); break;
        case 14: ok = cn_text(view, "remplacé漢🙂"); break;
        case 15: ok = cn_pointer(view, CN_LEFT_DOWN, 30, 90, 0); break;
        case 16: ok = cn_pointer(view, CN_LEFT_UP, 30, 90, 0); break;
        case 17: ok = cn_text(view, "éditeur漢🙂"); break;
        case 18: ok = cn_key(view, "Return", 0, 1); break;
        case 19: ok = cn_key(view, "Return", 0, 0); break;
    }
    if (!ok) { fprintf(stderr, "Native primitive refused at step %d\n", step); exit(2); }
}

static void write_result(void *context, const unsigned char *bytes, size_t length, const char *error) {
    if (error) { fprintf(stderr, "%s: %s\n", (char *)context, error); exit(3); }
    FILE *file = fopen(context, "wb");
    assert(file);
    assert(fwrite(bytes, 1, length, file) == length);
    fclose(file);
    printf("saved %s (%zu bytes)\n", (char *)context, length);
    fflush(stdout);
}
