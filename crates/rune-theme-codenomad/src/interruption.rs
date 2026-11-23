//! Session dock bounds follow interruption-dock.css and its measured usable minimum.
use crate::{
    Length, Space, TextRole,
    layout::{self, Layout},
    tokens,
};
use rune::{Cx, El, ScrollSpec};

pub fn session_surface(expanded: bool) -> El {
    let root = rune::col()
        .key("session-stack")
        .w_full()
        .h_full()
        .reading_surface();
    if expanded {
        root.scroll(ScrollSpec {
            stick_bottom: false,
        })
    } else {
        root
    }
}
pub fn history(expanded: bool) -> El {
    let area = rune::col().key("history").w_full().grow(1.0);
    area.min_h(history_minimum(expanded))
        .scroll(ScrollSpec { stick_bottom: true })
}
pub(crate) fn history_minimum(expanded: bool) -> f32 {
    if expanded {
        tokens(layout::dark()).length(Length::TouchTarget).px()
    } else {
        0.0
    }
}
fn input_minimum() -> f32 {
    let t = tokens(layout::dark());
    t.text(TextRole::Body).line_px() + t.space(Space::Sm).px() * 2.0
}
pub fn scroll_region() -> El {
    rune::col()
        .w_full()
        .grow(1.0)
        .min_h(input_minimum())
        .scroll(ScrollSpec {
            stick_bottom: false,
        })
}
fn measured<S>(cx: &Cx<S>, key: &str, fallback: f32) -> f32 {
    cx.layout_size(key).map_or(fallback, |size| size[1])
}
pub fn panel<S>(cx: &Cx<S>, picker: bool, pending: bool) -> El {
    let t = tokens(layout::dark());
    let gap = t.space(Space::Sm).px();
    let control = t.metric("button", "minHeight").px();
    let mut root = rune::col()
        .key("agent-panel")
        .w_full()
        .gap(gap)
        .padding(gap)
        .fill(t.color("surface-overlay"));
    if !picker && !pending {
        return root;
    }
    let header = measured(cx, "agent-actions", control);
    let navigation = if pending {
        measured(cx, "pending-navigation", control)
    } else {
        0.0
    };
    let footer = if pending {
        measured(cx, "pending-actions", control)
    } else {
        0.0
    };
    let search = if picker {
        measured(cx, "model-search", input_minimum())
    } else {
        0.0
    };
    let regions = usize::from(picker) + usize::from(pending);
    let sections = 1 + usize::from(pending) * 3 + usize::from(picker) * 2;
    let minimum = header
        + navigation
        + footer
        + search
        + input_minimum() * regions as f32
        + gap * (sections + 1) as f32;
    let viewport = measured(cx, "session-stack", minimum);
    let session = (viewport - measured(cx, "session-header", control)).max(0.0);
    // .interruption-dock max-height:min(60%,45vh), with the measured minimum winning.
    let bound = (session * 0.60).min(viewport * 0.45).max(minimum);
    let natural_fields = if pending {
        measured(cx, "pending-fields", input_minimum())
    } else {
        0.0
    };
    let natural_models = if picker {
        measured(cx, "model-items", input_minimum())
    } else {
        0.0
    };
    let desired =
        minimum + (natural_fields + natural_models - input_minimum() * regions as f32).max(0.0);
    root = root.h(desired.min(bound));
    root
}

#[cfg(test)]
mod tests {
    #[test]
    fn dock_bound_tracks_the_shared_css_contract() {
        let css = include_str!("../../../packages/ui/src/styles/components/interruption-dock.css");
        assert!(css.contains("max-height: min(60%, 45vh)"));
        assert!(css.contains("overflow-y: auto"));
        assert!(css.contains("flex-shrink: 0"));
    }
}
