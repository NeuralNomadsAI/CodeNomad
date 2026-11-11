#pragma once
#include <math.h>

static inline double cn_preview_next_zoom(double current, int action) {
    if (!isfinite(current) || current <= 0) current = 1;
    double next = action == 0 ? 1 : current + action * 0.2;
    return round(fmin(5, fmax(0.25, next)) * 1000000) / 1000000;
}
void cn_preview_zoom_install(void *view);
int cn_preview_zoom_focused(void *view, int action);
void cn_preview_zoom_base(void *view, double base);
