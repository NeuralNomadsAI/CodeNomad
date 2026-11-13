#include "../../src-tauri/src/embedded_view/zoom.h"
#include <assert.h>
int main(void) {
    assert(cn_preview_next_zoom(1, 1) == 1.2);
    assert(cn_preview_next_zoom(1.2, -1) == 1);
    assert(cn_preview_next_zoom(4, 0) == 1);
    assert(cn_preview_next_zoom(5, 1) == 5);
    assert(cn_preview_next_zoom(0.25, -1) == 0.25);
    assert(cn_preview_next_zoom(NAN, 1) == 1.2);
    assert(cn_preview_next_zoom(INFINITY, -1) == 0.8);
    return 0;
}
