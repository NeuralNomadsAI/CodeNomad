//! Project occurrence tabs; interaction comes from rune-kit, visuals from CodeNomad tokens.
use crate::{
    Length, catalogue, kit,
    layout::{self, Layout},
    tokens,
};
use rune::{Color, El, Icon, Tx};
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

const TOUCH_BAR_TARGET: f32 = 44.0;

pub enum BarAction {
    Settings,
    Conversation,
}

impl BarAction {
    pub fn button<S: 'static>(
        self,
        touch: bool,
        label: &'static str,
        invoke: impl Fn(&mut S) + 'static,
    ) -> El {
        if !touch {
            return layout::button(label, false, invoke);
        }
        use crate::shell::icons;
        let icon = match self {
            Self::Settings => &icons::SETTINGS,
            Self::Conversation => &icons::CONVERSATION,
        };
        touch_bar_button(icon, label, label, move |s, _| invoke(s))
    }
}

pub(crate) fn touch_bar_button<S: 'static>(
    icon: &'static Icon,
    label: &str,
    help: &str,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    bar_button(icon, label, help, TOUCH_BAR_TARGET, invoke)
}

fn bar_button<S: 'static>(
    icon: &'static Icon,
    label: &str,
    help: &str,
    side: f32,
    invoke: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(layout::dark());
    rune::row()
        .role("button")
        .focusable(true)
        .label(label)
        .help(help)
        .size(side, side)
        .center()
        .fill(t.color("new-tab-bg"))
        .hover(t.color("new-tab-hover-bg"))
        .focus_ring(
            t.metric("windowIconFocus", "outlineWidth").px(),
            t.metric("button", "borderTopWidth").px(),
            t.color("accent-primary"),
        )
        .on_press_tx(invoke)
        .child(
            rune::icon(icon, t.length(Length::Icon).px())
                .color(t.color("new-tab-text"))
                .a11y_hidden(),
        )
}

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
    pub temporary: bool,
}
fn focus_layers(element: El, key: &str, metric: &str) -> El {
    let t = tokens(layout::dark());
    rune::row()
        .focus_ring_for(
            key,
            t.metric(metric, "ringOffset").px(),
            0.0,
            t.color(&format!("{metric}-offset")),
        )
        .child(element.focus_ring_for(
            key,
            t.metric(metric, "ringWidth").px(),
            t.metric(metric, "ringOffset").px(),
            t.color(&format!("{metric}-ring")),
        ))
}
pub fn tab<S: 'static>(
    locale: &str,
    tab: &ProjectTab<'_>,
    selected: bool,
    first: bool,
    on_select: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_close: impl Fn(&mut S, &str, &mut Tx) + 'static,
) -> El {
    let close_help = catalogue::message(locale, "instanceTab.actions.close.ariaLabel").unwrap();
    tab_with_help(
        locale, tab, selected, first, close_help, false, on_select, on_close,
    )
}

#[allow(clippy::too_many_arguments)]
fn tab_with_help<S: 'static>(
    locale: &str,
    tab: &ProjectTab<'_>,
    selected: bool,
    first: bool,
    close_help: &str,
    skip_tab: bool,
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
    let rtl = catalogue::direction(locale) == "rtl";
    let temporary = tab.temporary;
    let mut select_button = Button::new(tab.title)
        .variant(ButtonVariant::Ghost)
        .label_with(move |_, _| {
            let title = rune::text(title)
                .font(font)
                .color(ink)
                .shrink()
                .min_w(0.0)
                .dir(rune::Direction::Auto);
            let title = if rtl {
                title.truncate_head()
            } else {
                title.truncate()
            };
            let glyph = if temporary {
                &crate::shell::icons::HOURGLASS
            } else {
                &FOLDER
            };
            rune::row()
                .w_full()
                .min_w(0.0)
                .items_center()
                .gap(metric("columnGap"))
                .child(
                    rune::icon(glyph, t.metric("tabGlyph", "width").px())
                        .color(ink)
                        .a11y_hidden(),
                )
                .child(title)
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
    if tab.temporary {
        select_button =
            select_button.help(catalogue::message(locale, "instanceTab.temporary.title").unwrap());
    }
    let temporary_aria = tab
        .temporary
        .then(|| catalogue::message(locale, "instanceTab.temporary.ariaLabel").unwrap());
    let status_aria = tab.status.map(|status| {
        catalogue::format(
            locale,
            "instanceTab.status.ariaLabel",
            &[("status", catalogue::message(locale, status.key()).unwrap())],
        )
    });
    match (temporary_aria, status_aria) {
        (Some(temp), Some(status)) => {
            select_button = select_button.description(format!("{temp}, {status}"));
        }
        (Some(temp), None) => {
            select_button = select_button.description(temp);
        }
        (None, Some(status)) => {
            select_button = select_button.description(status);
        }
        (None, None) => {}
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
        .on_press_tx(move |s, tx| action(s, &id, tx))
        .role("group")
        .label(tab.title)
        .child(
            select_button
                .role("tab")
                .tab_index(if skip_tab { -1 } else { 0 }),
        );
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
        let close_key = format!("c-{}", tab.id);
        slot = slot.child(focus_layers(
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
                .key(close_key.clone())
                .label(label)
                .help(close_help)
                .size(glyph + padding * 2.0, glyph + padding * 2.0)
                .padding(padding)
                .radius(metric("borderRadius"))
                .hover_group()
                .hover(t.color("tab-close-hover-bg"))
                .no_focus_ring()
                .tab_index(if skip_tab { -1 } else { 0 }),
            &close_key,
            "tabCloseFocus",
        ));
    }
    focus_layers(slot.locale_direction(locale), &key, "tabFocus").locale_direction(locale)
}
pub fn strip<S: 'static>(
    touch: bool,
    locale: &str,
    tabs: &[ProjectTab<'_>],
    active: Option<&str>,
    on_select: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_close: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_new: impl Fn(&mut S, &mut Tx) + 'static,
    actions: impl IntoIterator<Item = El>,
) -> El {
    let word = |key| catalogue::message(locale, key).expect("generated tab catalogue key");
    strip_with_help(
        touch,
        locale,
        tabs,
        active,
        word("instanceTabs.new.title"),
        word("instanceTab.actions.close.ariaLabel"),
        false,
        on_select,
        on_close,
        on_new,
        actions,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn strip_with_help<S: 'static>(
    touch: bool,
    locale: &str,
    tabs: &[ProjectTab<'_>],
    active: Option<&str>,
    new_help: &str,
    active_close_help: &str,
    skip_tab: bool,
    on_select: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_close: impl Fn(&mut S, &str, &mut Tx) + 'static,
    on_new: impl Fn(&mut S, &mut Tx) + 'static,
    actions: impl IntoIterator<Item = El>,
) -> El {
    let dark = layout::dark();
    let t = tokens(dark);
    let word = |key| catalogue::message(locale, key).expect("generated tab catalogue key");
    let new_size = if touch {
        TOUCH_BAR_TARGET
    } else {
        t.length(Length::TouchCompact).px()
    };
    let new = bar_button(
        &PLUS,
        word("instanceTabs.new.ariaLabel"),
        new_help,
        new_size,
        on_new,
    )
    .key("project-tabs-new")
    .tab_index(if skip_tab { -1 } else { 0 });
    let select = Rc::new(on_select);
    let close = Rc::new(on_close);
    let close_label = word("instanceTab.actions.close.ariaLabel");
    let height = t.metric("tabActive", "height").px().max(new_size);
    let items = tabs.iter().enumerate().map(|(i, descriptor)| {
        let (select, close) = (select.clone(), close.clone());
        let selected = active == Some(descriptor.id);
        tab_with_help(
            locale,
            descriptor,
            selected,
            i == 0,
            if selected {
                active_close_help
            } else {
                close_label
            },
            skip_tab,
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
        .child(rune::spacer())
        .child(
            rune::row()
                .key("project-tabs-actions")
                .items_center()
                .gap(t.space(crate::Space::Xs).px())
                .children(actions),
        )
        .locale_direction(locale)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::Cx;
    struct App {
        active: String,
        closed: Vec<String>,
        new: usize,
        locale: &'static str,
    }
    fn view(s: &App, cx: &mut Cx<App>) -> El {
        layout::render(cx, |_| strip_view(s, false, []))
    }
    fn strip_view(s: &App, touch: bool, actions: impl IntoIterator<Item = El>) -> El {
        strip(
            touch,
            s.locale,
            &[
                ProjectTab {
                    id: "a",
                    title: "Alpha",
                    status: Some(Status::Working),
                    closable: true,
                    temporary: false,
                },
                ProjectTab {
                    id: "b",
                    title: "Beta",
                    status: Some(Status::Permission),
                    closable: true,
                    temporary: false,
                },
            ],
            Some(&s.active),
            |s: &mut App, id, _| s.active = id.into(),
            |s, id, _| s.closed.push(id.into()),
            |s, _| s.new += 1,
            actions,
        )
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
        let tablist_label =
            catalogue::message("fr", "instanceShell.rightPanel.customize.tabs").unwrap();
        let tablist_index = items
            .iter()
            .position(|e| e["o"] == "tablist" && e["t"] == tablist_label)
            .unwrap_or_else(|| panic!("missing tablist in web mirror: {}", rt.a11y_json()));
        let inside_tablist = |item: &serde_json::Value| {
            let mut ancestor = item["a"].as_u64().map(|index| index as usize);
            while let Some(index) = ancestor {
                if index == tablist_index {
                    return true;
                }
                ancestor = items[index]["a"].as_u64().map(|next| next as usize);
            }
            false
        };
        let tabs: Vec<_> = items.iter().filter(|e| e["o"] == "tab").collect();
        assert_eq!(tabs.len(), 2, "real web mirror: {}", rt.a11y_json());
        assert!(
            tabs.iter().all(|tab| inside_tablist(tab)),
            "tabs must be grouped inside tablist in web mirror: {}",
            rt.a11y_json()
        );
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
    fn long_titles_keep_folder_text_and_close_inside_the_tab() {
        const TITLE: &str = "Alpha synthetic project with a deliberately long folder label exceeding both tab maxima";
        fn long_view(s: &App, cx: &mut Cx<App>) -> El {
            layout::render(cx, |_| {
                tab::<App>(
                    s.locale,
                    &ProjectTab {
                        id: "a",
                        title: TITLE,
                        status: None,
                        closable: true,
                        temporary: false,
                    },
                    s.active == "a",
                    true,
                    |_, _, _| {},
                    |_, _, _| {},
                )
            })
        }
        for locale in ["en", "he"] {
            for selected in [false, true] {
                let mut rt = rune::Runtime::new(
                    App {
                        active: if selected { "a" } else { "b" }.into(),
                        closed: vec![],
                        new: 0,
                        locale,
                    },
                    long_view,
                    (400.0, 80.0),
                    rune::Env::new(false, 1.0),
                );
                rt.frame(0.0);
                let elements = rt.elements();
                let control = elements
                    .iter()
                    .find(|e| e.key.as_deref() == Some("t-a"))
                    .unwrap()
                    .rect;
                let content: Vec<_> = elements
                    .iter()
                    .filter(|e| {
                        e.role == "icon"
                            && e.rect[2] == tokens(false).metric("tabGlyph", "width").px()
                            || e.text.as_deref() == Some(TITLE)
                    })
                    .collect();
                assert_eq!(content.len(), 2, "real folder and title elements");
                for element in content {
                    assert!(
                        element.rect[0] >= control[0]
                            && element.rect[0] + element.rect[2] <= control[0] + control[2],
                        "{locale} selected={selected}: {:?} escapes {control:?}",
                        element.rect
                    );
                }
                let occurrence = elements
                    .iter()
                    .find(|e| e.key.as_deref() == Some("occurrence-a"))
                    .unwrap()
                    .rect;
                let close = elements
                    .iter()
                    .find(|e| e.key.as_deref() == Some("c-a"))
                    .unwrap()
                    .rect;
                assert!(
                    close[0] >= occurrence[0]
                        && close[0] + close[2] <= occurrence[0] + occurrence[2]
                );
            }
        }
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
    fn touch_actions_reserve_their_own_space_and_dispatch_separately() {
        fn phone(s: &App, cx: &mut Cx<App>) -> El {
            layout::render(cx, |_| {
                let actions = [
                    ("settings", BarAction::Settings),
                    ("chat", BarAction::Conversation),
                ]
                .map(|(key, action)| {
                    action
                        .button(true, key, move |s: &mut App| s.closed.push(key.into()))
                        .key(key)
                });
                let bell = crate::shell::notices::bell(
                    "bell",
                    None,
                    false,
                    true,
                    false,
                    |s: &mut App, _| s.closed.push("bell".into()),
                );
                strip_view(s, true, actions.into_iter().chain([bell]))
            })
        }
        for locale in ["fr", "he"] {
            for width in [320.0, 390.0, 430.0] {
                let mut rt = rune::Runtime::new(
                    App {
                        active: "a".into(),
                        closed: vec![],
                        new: 0,
                        locale,
                    },
                    phone,
                    (width, 844.0),
                    rune::Env::new(false, 1.0),
                );
                rt.frame(0.0);
                let keys = [
                    "project-tabs-new",
                    "settings",
                    "chat",
                    crate::shell::notices::ANCHOR,
                ];
                let elements = rt.elements();
                let mut bounds = keys.map(|key| {
                    elements
                        .iter()
                        .find(|e| e.key.as_deref() == Some(key))
                        .unwrap()
                        .rect
                });
                bounds.sort_by(|a, b| a[0].total_cmp(&b[0]));
                for [x, _, w, h] in bounds {
                    assert!(
                        w >= 44.0 && h >= 44.0 && x >= 0.0 && x + w <= width,
                        "{locale}: {bounds:?}"
                    );
                }
                assert!(
                    bounds
                        .windows(2)
                        .all(|pair| pair[0][0] + pair[0][2] <= pair[1][0])
                );
                for key in keys {
                    let point = rt.find(key).unwrap();
                    tap(&mut rt, point);
                }
                assert_eq!(rt.state.new, 1);
                assert_eq!(rt.state.closed, ["settings", "chat", "bell"]);
            }
        }
    }

    #[test]
    fn temporary_tab_uses_hourglass_and_localized_temporary_description() {
        let mut rt = rune::Runtime::new(
            App {
                active: "temp".into(),
                closed: vec![],
                new: 0,
                locale: "fr",
            },
            |s, cx| {
                layout::render(cx, |_| {
                    tab::<App>(
                        s.locale,
                        &ProjectTab {
                            id: "temp",
                            title: "Temporaire · 12:30",
                            status: None,
                            closable: true,
                            temporary: true,
                        },
                        true,
                        true,
                        |_, _, _| {},
                        |_, _, _| {},
                    )
                })
            },
            (400.0, 80.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        let items: Vec<serde_json::Value> = serde_json::from_str(&rt.a11y_json()).unwrap();
        let tab_node = items.iter().find(|e| e["o"] == "tab").unwrap();
        let expected_desc = catalogue::message("fr", "instanceTab.temporary.ariaLabel").unwrap();
        assert_eq!(tab_node["d"], expected_desc);
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
