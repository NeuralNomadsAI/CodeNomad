//! Session dock bounds follow interruption-dock.css and its measured usable minimum.
use crate::{
    Space, TextRole,
    layout::{self, Layout},
    tokens,
};
use rune::{Cx, El, ScrollSpec};

const DEFAULT_COMPOSER_MIN: f32 = 104.0;
const MIN_COMPOSER_HEIGHT: f32 = 44.0;
const MIN_COMPOSER_HEIGHT_RATIO: f32 = 0.08;
const MAX_COMPOSER_HEIGHT: f32 = 320.0;
const TRANSCRIPT_RESERVE: f32 = 64.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SessionLayout {
    pub(crate) scroll_stack: bool,
    pub(crate) history_min: f32,
    pub(crate) composer_min: f32,
    pub(crate) composer_max: f32,
}

impl SessionLayout {
    pub fn scrolls_stack(self) -> bool {
        self.scroll_stack
    }

    pub(crate) fn history_min(self) -> f32 {
        finite_non_negative(self.history_min).unwrap_or(0.0)
    }
}

impl Default for SessionLayout {
    fn default() -> Self {
        Self {
            scroll_stack: false,
            history_min: 0.0,
            composer_min: DEFAULT_COMPOSER_MIN,
            composer_max: MAX_COMPOSER_HEIGHT,
        }
    }
}

fn finite_positive(value: f32) -> Option<f32> {
    (value.is_finite() && value > 0.0).then_some(value)
}

fn finite_non_negative(value: f32) -> Option<f32> {
    (value.is_finite() && value >= 0.0).then_some(value)
}

fn composer_minimum_for_viewport(visible: f32) -> f32 {
    finite_positive(visible).map_or(DEFAULT_COMPOSER_MIN, |h| {
        MIN_COMPOSER_HEIGHT
            .max((h * MIN_COMPOSER_HEIGHT_RATIO).floor())
            .min(MAX_COMPOSER_HEIGHT)
    })
}

fn scrolled_history_min(stack_h: f32, touch_handle: f32) -> f32 {
    (stack_h - touch_handle).clamp(0.0, TRANSCRIPT_RESERVE)
}

fn non_expanded_layout(
    stack_h: f32,
    top_chrome: f32,
    viewport_h: f32,
    field_space: f32,
    touch_handle: f32,
) -> SessionLayout {
    let avail = (stack_h - top_chrome).max(0.0);
    let reserve = TRANSCRIPT_RESERVE.min(avail);
    let scroll_stack = field_space < MIN_COMPOSER_HEIGHT;
    let composer_max = (field_space - reserve).clamp(MIN_COMPOSER_HEIGHT, MAX_COMPOSER_HEIGHT);
    let default_min = composer_minimum_for_viewport(viewport_h);
    SessionLayout {
        scroll_stack,
        history_min: if scroll_stack {
            scrolled_history_min(stack_h, touch_handle)
        } else {
            (field_space - composer_max).clamp(0.0, reserve)
        },
        composer_min: default_min.min(composer_max),
        composer_max,
    }
}

pub fn session_layout<S>(
    cx: &Cx<S>,
    expanded: bool,
    has_agent: bool,
    has_attachment_error: bool,
    has_controls: bool,
    has_restore: bool,
    has_restore_error: bool,
    timeline_notice: Option<&str>,
    reference_height: Option<f32>,
) -> SessionLayout {
    let t = tokens(layout::dark());
    let control = t.metric("button", "minHeight").px();
    let line = t.text(TextRole::Body).line_px();
    let stack_h = cx
        .layout_size("session-stack")
        .and_then(|size| finite_positive(size[1]));
    let viewport_h = cx
        .layout_size("session-shell")
        .and_then(|size| finite_positive(size[1]))
        .or(stack_h);
    let controls_h = if has_controls {
        measured(cx, "transcript-controls", control)
    } else {
        0.0
    };
    let restore_h = if has_restore {
        measured(cx, "restore-message-history", control)
    } else {
        0.0
    };
    let restore_error_h = if has_restore_error {
        measured(cx, "message-action-error", line)
    } else {
        0.0
    };
    let notice_h = match timeline_notice {
        Some("timeline-destination-filtered") => {
            measured(cx, "timeline-destination-filtered", line)
        }
        Some(key) => measured(cx, key, control),
        None => 0.0,
    };
    let top_chrome = controls_h + restore_h + restore_error_h + notice_h;
    if expanded {
        let composer_h = viewport_h.map_or(MIN_COMPOSER_HEIGHT, composer_minimum_for_viewport);
        return SessionLayout {
            scroll_stack: true,
            history_min: stack_h.map_or(TRANSCRIPT_RESERVE, |h| scrolled_history_min(h, control)),
            composer_min: composer_h,
            composer_max: composer_h,
        };
    }
    let Some(stack_h) = stack_h else {
        return SessionLayout::default();
    };
    let gap = t.space(Space::Sm).px();
    let pad = t.space(Space::Md).px();
    let agent_h = if has_agent {
        measured(cx, "agent-panel", control + gap * 2.0)
    } else {
        0.0
    };
    let error_h = if has_attachment_error {
        measured(cx, "attachment-error", t.text(TextRole::Body).line_px())
    } else {
        0.0
    };
    let chrome = match (
        cx.layout_size("session-composer")
            .and_then(|size| finite_positive(size[1])),
        cx.layout_size("composer")
            .and_then(|size| finite_positive(size[1])),
    ) {
        (Some(outer), Some(field)) if outer > field => outer - field,
        _ => pad * 2.0 + gap + control,
    };
    let field_space = stack_h - top_chrome - agent_h - error_h - chrome;
    let reference_h = reference_height
        .and_then(finite_positive)
        .or(viewport_h)
        .unwrap_or(stack_h);
    non_expanded_layout(stack_h, top_chrome, reference_h, field_space, control)
}

pub fn session_surface(layout: SessionLayout) -> El {
    let root = rune::col()
        .key("session-stack")
        .w_full()
        .h_full()
        .reading_surface();
    if layout.scroll_stack {
        root.scroll(ScrollSpec {
            stick_bottom: false,
        })
    } else {
        root
    }
}
pub fn history(layout: SessionLayout) -> El {
    let area = rune::col().key("history").w_full().grow(1.0);
    area.min_h(finite_non_negative(layout.history_min).unwrap_or(0.0))
        .scroll(ScrollSpec { stick_bottom: true })
}
pub(crate) fn history_minimum(reserve: bool) -> f32 {
    if reserve { TRANSCRIPT_RESERVE } else { 0.0 }
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
    cx.layout_size(key)
        .and_then(|size| finite_non_negative(size[1]))
        .unwrap_or(fallback)
}
pub fn panel<S>(
    cx: &Cx<S>,
    picker: bool,
    pending: bool,
    multiple_pending: bool,
    has_error: bool,
    layout_viewport_height: Option<f32>,
) -> El {
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
    let error = if has_error {
        measured(cx, "agent-error", t.text(TextRole::Body).line_px())
    } else {
        0.0
    };
    let navigation = if pending && multiple_pending {
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
    let sections = 1
        + usize::from(has_error)
        + usize::from(pending) * (2 + usize::from(multiple_pending))
        + usize::from(picker) * 2;
    let minimum = header
        + error
        + navigation
        + footer
        + search
        + input_minimum() * regions as f32
        + gap * (sections + 1) as f32;
    let session = measured(cx, "session-stack", minimum);
    let shell = measured(cx, "application-shell", session);
    let window = layout_viewport_height
        .filter(|height| height.is_finite() && *height > 0.0)
        .map_or(shell, |height| height.max(shell));
    // .interruption-dock max-height:min(60%,45vh), with the measured minimum winning.
    let bound = dock_bound(session, window, minimum);
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

fn dock_bound(session: f32, window: f32, minimum: f32) -> f32 {
    (session * 0.60).min(window * 0.45).max(minimum)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dock_bound_tracks_the_shared_css_contract() {
        let css = include_str!("../../../packages/ui/src/styles/components/interruption-dock.css");
        assert!(css.contains("max-height: min(60%, 45vh)"));
        assert!(css.contains("overflow-y: auto"));
        assert!(css.contains("flex-shrink: 0"));
        let prompt =
            include_str!("../../../packages/ui/src/components/prompt-input/usePromptViewport.ts");
        let prompt_input = include_str!("../../../packages/ui/src/components/prompt-input.tsx");
        let height_state =
            include_str!("../../../packages/ui/src/components/prompt-input/height-state.ts");
        assert_eq!(TRANSCRIPT_RESERVE, 64.0);
        assert_eq!(MIN_COMPOSER_HEIGHT, 44.0);
        assert_eq!(DEFAULT_COMPOSER_MIN, 104.0);
        assert!(prompt.contains("const TRANSCRIPT_RESERVE = 64"));
        assert!(prompt_input.contains("const MIN_PROMPT_FIELD_HEIGHT = 44"));
        assert!(prompt_input.contains("const DEFAULT_PROMPT_FIELD_HEIGHT = 104"));
        assert!(height_state.contains("export const MIN_PROMPT_FIELD_HEIGHT_RATIO = 0.08"));
        assert_eq!(composer_minimum_for_viewport(316.0), 44.0);
        assert_eq!(composer_minimum_for_viewport(740.0), 59.0);
        // 45vh uses the layout viewport height (e.g. 844 px) rather than visualViewport (514 px),
        // matching Solid min(60% of 410 = 246 px, 45% of 844 = 379.8 px) = 246 px.
        assert!((dock_bound(410.0, 844.0, 120.0) - 246.0).abs() < 0.01);
        assert!((dock_bound(410.0, 514.0, 120.0) - 231.3).abs() < 0.01);
        assert_eq!(scrolled_history_min(56.0, 27.0), 29.0);
        assert_eq!(scrolled_history_min(20.0, 27.0), 0.0);
        assert_eq!(scrolled_history_min(111.0, 27.0), 64.0);
        assert_eq!(scrolled_history_min(40.0, 27.0), 13.0);
        for touch_handle in [24.0_f32, 27.0, 28.0] {
            for stack_h in 0..140 {
                let a = scrolled_history_min(stack_h as f32, touch_handle);
                let b = scrolled_history_min((stack_h + 1) as f32, touch_handle);
                assert!(
                    b >= a && (b - a) <= 1.0 + f32::EPSILON,
                    "scrolled_history_min must be monotonic and continuous: touch_handle={touch_handle}, {stack_h}->{}: {a}->{b}",
                    stack_h + 1
                );
            }
        }
        // Without an active interruption, Rune applies the same fieldSpace < 44 crowding rule on
        // any tight viewport (including Chrome Android resizes-content and compact desktop windows,
        // whereas Solid limits fieldSpace crowding to coarse-pointer visualViewport occlusion),
        // keeps the empty composer floor at min(minimumForViewport(viewport_h), composer_max), and
        // caps auto-growth at 320px (MAX_COMPOSER_HEIGHT; no manual 60% drag handle).
        assert_eq!(
            non_expanded_layout(260.0, 0.0, 500.0, 160.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 64.0,
                composer_min: 44.0,
                composer_max: 96.0,
            }
        );
        assert_eq!(
            non_expanded_layout(200.0, 0.0, 420.0, 90.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 46.0,
                composer_min: 44.0,
                composer_max: 44.0,
            }
        );
        assert_eq!(
            non_expanded_layout(240.0, 0.0, 740.0, 110.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 64.0,
                composer_min: 46.0,
                composer_max: 46.0,
            }
        );
        assert_eq!(
            non_expanded_layout(600.0, 0.0, 740.0, 400.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 64.0,
                composer_min: 59.0,
                composer_max: 320.0,
            }
        );
        assert_eq!(
            non_expanded_layout(160.0, 0.0, 400.0, 44.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 0.0,
                composer_min: 44.0,
                composer_max: 44.0,
            }
        );
        assert_eq!(
            non_expanded_layout(140.0, 0.0, 320.0, 30.0, 27.0),
            SessionLayout {
                scroll_stack: true,
                history_min: 64.0,
                composer_min: 44.0,
                composer_max: 44.0,
            }
        );
        assert_eq!(
            non_expanded_layout(56.0, 0.0, 160.0, -40.0, 27.0),
            SessionLayout {
                scroll_stack: true,
                history_min: 29.0,
                composer_min: 44.0,
                composer_max: 44.0,
            }
        );
        // Visual-viewport keyboard occlusion with larger unoccluded reference height matches Solid.
        assert_eq!(
            non_expanded_layout(450.0, 0.0, 800.0, 350.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 64.0,
                composer_min: 64.0,
                composer_max: 286.0,
            }
        );
        assert_eq!(
            non_expanded_layout(180.0, 0.0, 800.0, 90.0, 27.0),
            SessionLayout {
                scroll_stack: false,
                history_min: 46.0,
                composer_min: 44.0,
                composer_max: 44.0,
            }
        );
        assert_eq!(finite_positive(f32::NAN), None);
        assert_eq!(finite_positive(f32::INFINITY), None);
        assert_eq!(finite_positive(0.0), None);
        assert_eq!(finite_non_negative(-1.0), None);
        assert_eq!(finite_non_negative(0.0), Some(0.0));
        let dock_layout =
            include_str!("../../../packages/ui/src/components/interruption-dock-layout.ts");
        assert!(dock_layout.contains(".form-request-error, .tool-call-permission-error"));
        // 60% of session wins when tighter than 45% of window.
        assert!((dock_bound(500.0, 900.0, 120.0) - 300.0).abs() < 1e-3);
        // 45% of window wins when tighter than 60% of session.
        assert!((dock_bound(700.0, 800.0, 120.0) - 360.0).abs() < 1e-3);
        // Measured usable minimum wins over both percentage bounds on short viewports.
        assert!((dock_bound(200.0, 320.0, 180.0) - 180.0).abs() < 1e-3);
    }
}
