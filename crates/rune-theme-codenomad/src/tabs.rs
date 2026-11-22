//! Project occurrence tabs; interaction comes from rune-kit, visuals from CodeNomad tokens.
use crate::{
    Length, Space, catalogue, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{Color, Cx, El, Icon, Tx};
use rune_kit::shell::{TabItem, TabItemStatus, TabOrientation, TabStrip, TabWords};

// Lucide Plus, as used by Solid instance-tabs.tsx.
static PLUS: Icon = Icon {
    name: "lucide-plus",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></g>"#,
};

#[derive(Clone, Copy)]
pub enum Status {
    Working,
    Compacting,
    Permission,
    Idle,
    Unavailable,
}
impl Status {
    fn key(self) -> &'static str {
        match self {
            Self::Working => "instanceTab.status.working",
            Self::Compacting => "instanceTab.status.compacting",
            Self::Permission => "instanceTab.status.permission",
            Self::Idle => "instanceTab.status.idle",
            Self::Unavailable => "instanceShell.worktree.unavailable",
        }
    }
    fn mark(self) -> Option<TabItemStatus> {
        match self {
            Self::Working | Self::Compacting => Some(TabItemStatus::Busy),
            Self::Permission => Some(TabItemStatus::Attention),
            Self::Idle => None,
            Self::Unavailable => Some(TabItemStatus::Failed),
        }
    }
}
pub struct ProjectTab<'a> {
    /// Occurrence identity, independently of the folder or displayed title.
    pub id: &'a str,
    pub title: &'a str,
    pub status: Option<Status>,
    pub closable: bool,
}
pub fn strip<S: 'static>(
    cx: &mut Cx<S>,
    locale: &str,
    tabs: &[ProjectTab<'_>],
    active: Option<&str>,
    on_select: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_close: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_new: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let word = |key| catalogue::message(locale, key).expect("generated tab catalogue key");
    let mut theme = kit(dark).clone();
    let size = t.number("font-size-sm").px();
    theme.ty.ui_compact = rune::TextStyle::new(size, t.number("font-weight-regular").px())
        .lh(size * t.number("line-height-normal").px());
    theme.ty.ui_medium = theme.ty.ui_compact;
    theme.c.text_base = t.color("tab-active-text");
    theme.c.text_faint = t.color("tab-inactive-text");
    // The square occurrence slot paints the state; the kit pill remains transparent.
    theme.c.hover = Color::TRANSPARENT;
    theme.c.pressed = Color::TRANSPARENT;
    let new_size = t.length(Length::TouchCompact).px();
    let new = rune::row()
        .key("project-tabs-new")
        .role("button")
        .focusable(true)
        .label(word("instanceTabs.new.ariaLabel"))
        .help(word("instanceTabs.new.title"))
        .size(new_size, new_size)
        .center()
        .radius(t.number("radius-md").px())
        .fill(t.color("new-tab-bg"))
        .hover(t.color("new-tab-hover-bg"))
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            t.metric("button", "borderTopWidth").px(),
            t.color("accent-primary"),
        )
        .on_press_tx(on_new)
        .child(
            rune::icon(&PLUS, t.length(Length::Icon).px())
                .color(t.color("new-tab-text"))
                .a11y_hidden(),
        );
    TabStrip::new("project-tabs", TabOrientation::Horizontal)
        .tabs(tabs.iter().map(|tab| {
            let selected = active == Some(tab.id);
            let description = tab
                .status
                .map(|status| {
                    catalogue::format(
                        locale,
                        "instanceTab.status.ariaLabel",
                        &[("status", word(status.key()))],
                    )
                })
                .unwrap_or_default();
            TabItem::new(tab.id, tab.title)
                .closable(tab.closable)
                .status(tab.status.and_then(Status::mark))
                .decorate(move |el, _| {
                    el.role("tab")
                        .description(description)
                        .radius(t.number("radius-md").px())
                        .fill(t.color(if selected {
                            "surface-shade-light"
                        } else {
                            "surface-secondary"
                        }))
                        .hover(t.color(if selected {
                            "surface-shade-light"
                        } else {
                            "tab-inactive-hover-bg"
                        }))
                })
        }))
        .active(active)
        .viewport_width(cx.layout_size("project-tabs").map(|size| size[0]))
        .row_height(
            t.length(Length::Chrome).px() + t.space(Space::Xs).px()
                - t.metric("button", "borderTopWidth").px(),
        )
        .gap(0.0)
        .fill(t.color("surface-secondary"))
        .hover_none(true)
        .close_tab_stop(true)
        .words(TabWords {
            close: word("instanceTab.actions.close.ariaLabel"),
            busy: word("instanceTab.status.working"),
            attention: word("instanceTab.status.permission"),
            unread: word("settings.nav.notifications"),
            failed: word("instanceShell.worktree.unavailable"),
        })
        .label(word("instanceShell.rightPanel.customize.tabs"))
        .trailing_action(new)
        .trailing_width(new_size)
        .on_select(on_select)
        .on_close(on_close)
        .build(&theme)
        .locale_direction(locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct App {
        active: String,
        closed: Vec<String>,
        new: usize,
        locale: &'static str,
    }
    fn view(s: &App, cx: &mut Cx<App>) -> El {
        layout::render(cx, |cx| {
            strip(
                cx,
                s.locale,
                &[
                    ProjectTab {
                        id: "a",
                        title: "Alpha",
                        status: Some(Status::Working),
                        closable: true,
                    },
                    ProjectTab {
                        id: "b",
                        title: "Beta",
                        status: Some(Status::Permission),
                        closable: true,
                    },
                ],
                Some(&s.active),
                |s, id, _| s.active = id.into(),
                |s, id, _| s.closed.push(id.into()),
                |s, _| s.new += 1,
            )
        })
    }
    fn runtime(locale: &'static str) -> rune::Runtime<App> {
        let mut rt = rune::Runtime::new(
            App {
                active: "a".into(),
                closed: vec![],
                new: 0,
                locale,
            },
            view,
            (800.0, 120.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        for _ in 0..30 {
            rt.frame(1.0 / 60.0);
        }
        rt
    }
    fn tap(rt: &mut rune::Runtime<App>, point: (f32, f32)) {
        rt.pointer_down(point.0, point.1);
        rt.pointer_up(point.0, point.1);
        rt.frame(1.0 / 60.0);
    }
    #[test]
    fn real_kit_tabs_dispatch_select_close_and_trailing_new() {
        let mut rt = runtime("fr");
        let point = rt.find("t-b").unwrap();
        tap(&mut rt, point);
        assert_eq!(rt.state.active, "b");
        let close = catalogue::message("fr", "instanceTab.actions.close.ariaLabel").unwrap();
        let button = rt
            .elements()
            .into_iter()
            .find(|e| e.path.contains("/t-a/") && e.label.as_deref() == Some(close) && e.focusable)
            .expect("scoped close button");
        tap(
            &mut rt,
            (
                button.rect[0] + button.rect[2] / 2.0,
                button.rect[1] + button.rect[3] / 2.0,
            ),
        );
        assert_eq!(rt.state.closed, ["a"]);
        let point = rt.find("project-tabs-new").unwrap();
        tap(&mut rt, point);
        assert_eq!(rt.state.new, 1);
    }
    #[test]
    fn direction_and_words_follow_the_catalogue() {
        for locale in ["en", "he"] {
            let rt = runtime(locale);
            let a = rt.find("t-a").unwrap().0;
            let b = rt.find("t-b").unwrap().0;
            assert_eq!(a > b, catalogue::direction(locale) == "rtl");
            let elements = rt.elements();
            assert!(elements.iter().any(|e| e.role == "tablist"
                && e.label.as_deref()
                    == catalogue::message(locale, "instanceShell.rightPanel.customize.tabs")));
            assert!(
                elements
                    .iter()
                    .any(|e| e.key.as_deref() == Some("project-tabs-new")
                        && e.label.as_deref()
                            == catalogue::message(locale, "instanceTabs.new.ariaLabel"))
            );
        }
    }
}
