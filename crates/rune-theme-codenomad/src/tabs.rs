//! Project occurrence tabs; interaction comes from rune-kit, visuals from CodeNomad tokens.
use crate::{
    Length, catalogue, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{Color, Cx, El, Icon, Tx};
use rune_kit::{Button, ButtonVariant};
use std::rc::Rc;

// Lucide Plus, as used by Solid instance-tabs.tsx.
static PLUS: Icon = Icon {
    name: "lucide-plus",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></g>"#,
};
// Lucide FolderOpen, the imported source used by InstanceTab.
static FOLDER: Icon = Icon {
    name: "lucide-folder-open",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></g>"#,
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
    fn color(self) -> &'static str {
        match self {
            Self::Working => "session-status-working-fg",
            Self::Compacting => "session-status-compacting-fg",
            Self::Permission => "session-status-permission-fg",
            Self::Idle => "session-status-idle-fg",
            Self::Unavailable => "status-error-fg",
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
pub fn tab<S: 'static>(
    locale: &str,
    tab: &ProjectTab<'_>,
    selected: bool,
    first: bool,
    on_select: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_close: impl Fn(&mut S, &str, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    let mut theme = kit(layout::dark()).clone();
    let metric = move |key| t.metric("tabActive", key).px();
    let font =
        rune::TextStyle::new(metric("fontSize"), metric("fontWeight")).lh(metric("lineHeight"));
    theme.c.hover = Color::TRANSPARENT;
    theme.c.pressed = Color::TRANSPARENT;
    let ink = t.color(if selected {
        "tab-active-text"
    } else {
        "tab-inactive-text"
    });
    let background = t.color(if selected {
        "surface-shade-light"
    } else {
        "surface-secondary"
    });
    let select = Rc::new(on_select);
    let close = Rc::new(on_close);
    let key = format!("t-{}", tab.id);
    let id = tab.id.to_owned();
    let action = select.clone();
    let title = tab.title.to_owned();
    let mut select_button = Button::new(tab.title)
        .variant(ButtonVariant::Ghost)
        .label_with(move |_, _| {
            rune::row()
                .items_center()
                .gap(metric("columnGap"))
                .child(
                    rune::icon(&FOLDER, t.metric("tabGlyph", "width").px())
                        .color(ink)
                        .a11y_hidden(),
                )
                .child(
                    rune::text(title)
                        .font(font)
                        .color(ink)
                        .truncate()
                        .dir(rune::Direction::Auto),
                )
        })
        .on_press_tx(move |s, tx| {
            action(s, &id, tx);
            tx.scroll_into_view_in("project-tabs-scroll", format!("t-{id}"));
        })
        .build(&theme)
        .key(key.clone())
        .label(tab.title)
        .focus_selected(selected)
        .h_full()
        .padding(0.0)
        .shrink()
        .min_w(0.0)
        .no_focus_ring();
    if tab.closable {
        let (id, action) = (tab.id.to_owned(), close.clone());
        select_button = select_button.on_middle_press(move |s, tx| action(s, &id, tx));
    }
    if let Some(status) = tab.status {
        select_button = select_button.description(catalogue::format(
            locale,
            "instanceTab.status.ariaLabel",
            &[("status", catalogue::message(locale, status.key()).unwrap())],
        ));
    }
    let border = metric("borderTopWidth");
    let end = metric("borderRightWidth");
    let start = if first {
        metric("borderLeftWidth")
    } else {
        0.0
    };
    let (left, right) = if catalogue::direction(locale) == "rtl" {
        (end, start)
    } else {
        (start, end)
    };
    let (id, action) = (tab.id.to_owned(), select);
    let mut slot = rune::row()
        .key(format!("occurrence-{}", tab.id))
        .h(metric("height"))
        .max_w(
            t.metric(
                if selected { "tabActive" } else { "tabInactive" },
                "maxWidth",
            )
            .px(),
        )
        .items_center()
        .gap(metric("columnGap"))
        .px(metric("paddingLeft"))
        .pt(metric("paddingTop"))
        .pb(metric("paddingBottom")
            + if selected {
                metric("borderBottomWidth")
            } else {
                0.0
            })
        .radius(metric("borderRadius"))
        .fill(background)
        .hover(t.color(if selected {
            "surface-shade-light"
        } else {
            "tab-inactive-hover-bg"
        }))
        .border_sides(
            [
                border,
                right,
                if selected {
                    0.0
                } else {
                    metric("borderBottomWidth")
                },
                left,
            ],
            t.color("tab-border"),
        )
        .border_layout()
        .focus_ring_for(
            key,
            t.metric("windowIconFocus", "outlineWidth").px(),
            border,
            t.color("accent-primary"),
        )
        .on_press_tx(move |s, tx| action(s, &id, tx))
        .role("group")
        .label(tab.title)
        .child(select_button.role("tab"));
    if let Some(status) = tab.status {
        let side = t.length(Length::Icon).px() / 2.0;
        slot = slot.child(
            rune::el()
                .size(side, side)
                .radius(side / 2.0)
                .fill(t.color(status.color()))
                .a11y_hidden(),
        );
    }
    if tab.closable {
        let glyph = t.metric("tabCloseGlyph", "width").px();
        let padding = t.metric("tabClose", "paddingLeft").px();
        let label = catalogue::message(locale, "instanceTab.actions.close.ariaLabel").unwrap();
        let id = tab.id.to_owned();
        slot = slot.child(
            Button::new(label)
                .variant(ButtonVariant::Ghost)
                .label_with(move |_, _| {
                    rune::icon(&crate::window_control::CLOSE, glyph)
                        .color(ink)
                        .group_color(t.color("tab-close-hover-fg"))
                        .a11y_hidden()
                })
                .on_press_tx(move |s, tx| close(s, &id, tx))
                .build(&theme)
                .key(format!("c-{}", tab.id))
                .label(label)
                .size(glyph + padding * 2.0, glyph + padding * 2.0)
                .padding(padding)
                .radius(metric("borderRadius"))
                .hover_group()
                .hover(t.color("tab-close-hover-bg"))
                .focus_ring(
                    t.metric("windowIconFocus", "outlineWidth").px(),
                    border,
                    t.color("accent-primary"),
                ),
        );
    }
    slot.locale_direction(locale)
}
pub fn strip<S: 'static>(
    _cx: &mut Cx<S>,
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
    let select = Rc::new(on_select);
    let close = Rc::new(on_close);
    let height = t.metric("tabActive", "height").px();
    let items = tabs.iter().enumerate().map(|(i, descriptor)| {
        let (select, close) = (select.clone(), close.clone());
        tab(
            locale,
            descriptor,
            active == Some(descriptor.id),
            i == 0,
            move |s, id, tx| select(s, id, tx),
            move |s, id, tx| close(s, id, tx),
        )
    });
    let ids: Vec<_> = tabs.iter().map(|tab| tab.id.to_owned()).collect();
    let active_index = tabs
        .iter()
        .position(|tab| Some(tab.id) == active)
        .unwrap_or(0);
    let rtl = catalogue::direction(locale) == "rtl";
    let list = rune::row()
        .key("project-tabs-list")
        .role("tablist")
        .label(word("instanceShell.rightPanel.customize.tabs"))
        .focus_group()
        .items_center()
        .children(items)
        .on_key(move |s, event, tx| {
            if ids.is_empty() || event.mods != rune::Mods::default() {
                return false;
            }
            let index = match event.key {
                rune::Key::Right => {
                    (active_index + if rtl { ids.len() - 1 } else { 1 }) % ids.len()
                }
                rune::Key::Left => (active_index + if rtl { 1 } else { ids.len() - 1 }) % ids.len(),
                rune::Key::Home => 0,
                rune::Key::End => ids.len() - 1,
                _ => return false,
            };
            select(s, &ids[index], tx);
            let key = format!("t-{}", ids[index]);
            tx.focus(key.clone(), true);
            tx.scroll_into_view_in("project-tabs-scroll", key);
            true
        });
    rune::row()
        .key("project-tabs")
        .w_full()
        .h(height)
        .shrink()
        .min_w(0.0)
        .items_center()
        .fill(t.color("surface-secondary"))
        .child(
            rune::row()
                .key("project-tabs-scroll")
                .shrink()
                .min_w(0.0)
                .h(height)
                .scroll_x()
                .child(list),
        )
        .child(new)
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
    fn web_mirror_keeps_tabs_selected_state_and_sibling_closes() {
        let rt = runtime("fr");
        let items: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
        let tabs: Vec<_> = items.iter().filter(|e| e["o"] == "tab").collect();
        assert_eq!(tabs.len(), 2, "real web mirror: {}", rt.a11y_json());
        assert_eq!(tabs.iter().filter(|e| e["se"] == true).count(), 1);
        assert!(tabs.iter().any(|e| e["t"] == "Alpha" && e["se"] == true));
        let close = catalogue::message("fr", "instanceTab.actions.close.ariaLabel").unwrap();
        assert_eq!(
            items
                .iter()
                .filter(|e| e["k"] == "button" && e["t"] == close)
                .count(),
            2
        );
    }
    #[test]
    fn keyboard_arrows_select_tabs_and_close_remains_a_tab_stop() {
        for (locale, key) in [("en", rune::Key::Right), ("he", rune::Key::Left)] {
            let mut rt = runtime(locale);
            let point = rt.find("t-a").unwrap();
            tap(&mut rt, point);
            rt.key(rune::KeyEvent {
                key,
                mods: rune::Mods::default(),
            });
            rt.frame(1.0 / 60.0);
            assert_eq!(rt.state.active, "b", "arrow selection follows tabs");
            assert!(
                rt.elements()
                    .iter()
                    .any(|e| e.key.as_deref() == Some("c-a") && e.focusable)
            );
            let mirror: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
            assert!(
                mirror
                    .iter()
                    .any(|e| e["o"] == "tab" && e["t"] == "Beta" && e["se"] == true)
            );
            rt.update(|_, tx| tx.focus("c-a", true));
            rt.frame(1.0 / 60.0);
            assert!(
                rt.elements()
                    .iter()
                    .any(|e| e.key.as_deref() == Some("c-a") && e.focused),
                "focused: {:?}",
                rt.elements()
                    .iter()
                    .filter(|e| e.focused)
                    .map(|e| &e.path)
                    .collect::<Vec<_>>()
            );
            rt.key(rune::KeyEvent {
                key: rune::Key::Text(" ".into()),
                mods: rune::Mods::default(),
            });
            rt.frame(1.0 / 60.0);
            assert_eq!(rt.state.closed, ["a"]);
            assert_eq!(rt.state.active, "b");
        }
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
            .find(|e| {
                e.key.as_deref() == Some("c-a") && e.label.as_deref() == Some(close) && e.focusable
            })
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
    fn strip_keeps_css_height_in_a_phone_column() {
        fn column(s: &App, cx: &mut Cx<App>) -> El {
            rune::col()
                .w_full()
                .h_full()
                .child(view(s, cx))
                .child(rune::el().key("conversation").w_full().grow(1.0))
        }
        let mut rt = rune::Runtime::new(
            App {
                active: "a".into(),
                closed: vec![],
                new: 0,
                locale: "en",
            },
            column,
            (390.0, 844.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let elements = rt.elements();
        let bounds = |key| {
            elements
                .iter()
                .find(|e| e.key.as_deref() == Some(key))
                .unwrap()
                .rect
        };
        let height = tokens(false).metric("tabActive", "height").px();
        assert_eq!(bounds("project-tabs"), [0.0, 0.0, 390.0, height]);
        assert_eq!(bounds("conversation"), [0.0, height, 390.0, 844.0 - height]);
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
