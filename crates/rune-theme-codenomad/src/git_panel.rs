use crate::{
    Space, TextRole,
    layout::{Layout, dark},
    tokens,
};
use rune::{El, ScrollSpec, Tx, col, icon, row, text};
use std::{cell::Cell, rc::Rc};
#[path = "git_panel_controls.rs"]
mod controls;
pub use controls::*;

pub use crate::workspace_tree::icons::{CHEVRON_DOWN, CHEVRON_RIGHT, EYE, REFRESH_CW};
#[path = "git_panel_icons.rs"]
mod icons;
pub use icons::{
    ARROW_LEFT, COLUMNS, FOLD_VERTICAL, GIT_BRANCH as BRANCH, GIT_COMMIT_HORIZONTAL as COMMIT,
    MINUS, MORE_HORIZONTAL, PLUS, ROWS, UNFOLD_VERTICAL, WRAP_TEXT,
};

pub fn selector_width(panel: f32) -> f32 {
    panel - 2.0 * tokens(dark()).space(Space::Md).px()
}

pub fn panel() -> El {
    col()
        .full_height()
        .fill(tokens(dark()).color("surface-secondary"))
}

pub fn dock(panel: El, width: f32) -> El {
    panel.w(width).min_w(width).max_w(width)
}

pub fn with_overlays(panel: El, overlays: Vec<El>) -> El {
    rune_kit::root(panel, overlays)
}

pub fn conversation_column() -> El {
    col().remaining().shrink()
}

pub fn clipped(value: impl Into<String>, role: TextRole) -> El {
    text(value).text_role(role).truncate()
}

pub fn header() -> El {
    col().full_width().pad(Space::Md).separate(Space::Sm)
}

pub fn context() -> El {
    band("gitContext")
}

pub fn tools() -> El {
    band("gitTools").items_start()
}

fn band(component: &str) -> El {
    let t = tokens(dark());
    let px = t.metric(component, "paddingLeft").px();
    let py = t.metric(component, "paddingTop").px();
    let border = t.metric(component, "borderBottomWidth").px();
    col()
        .full_width()
        .px(px)
        .py(py)
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, border, 0.0], t.color("border-base"))
        .border_layout()
}

pub fn scroll() -> El {
    col().full_width().remaining().scroll(ScrollSpec {
        stick_bottom: false,
    })
}

#[derive(Default)]
pub struct ScrollBookmark(Rc<Cell<(f32, bool)>>);

impl ScrollBookmark {
    pub fn retain_for_remount(&self) {
        self.0.set((self.0.get().0, true));
    }

    pub fn apply<S: 'static>(&self, viewport: El, key: &'static str) -> El {
        let save = self.0.clone();
        let restore = self.0.clone();
        viewport
            .key(key)
            .on_scroll_offset(move |position| {
                if !save.get().1 {
                    save.set((position.offset[1], false));
                }
            })
            .on_layout_tx(move |_: &mut S, _, tx| {
                let (offset, queued) = restore.get();
                if queued {
                    restore.set((offset, false));
                    tx.scroll_to_instant(key, 0.0, offset);
                }
            })
    }
}

pub fn saved_scroll<S: 'static>(key: &'static str, bookmark: &ScrollBookmark) -> El {
    bookmark.apply::<S>(scroll(), key)
}

pub fn section(last: bool) -> El {
    let group = col().full_width().items_stretch();
    if last {
        group
    } else {
        let t = tokens(dark());
        let border = t.metric("gitContext", "borderBottomWidth").px();
        group
            .border_sides([0.0, 0.0, border, 0.0], t.color("border-divider"))
            .border_layout()
    }
}

pub fn file_row(selected: bool) -> El {
    let t = tokens(dark());
    let body = row()
        .full_width()
        .items_center()
        .hover_group()
        .hover_motion(rune::Anim::INSTANT, rune::Anim::INSTANT);
    if selected {
        body.fill(t.color("selection-neutral-bg"))
    } else {
        body.hover(t.color("surface-hover-overlay"))
    }
}

pub fn bordered_control(el: El) -> El {
    let t = tokens(dark());
    let border = t.metric("gitContext", "borderBottomWidth").px();
    el.border(border, t.color("border-base")).border_layout()
}

pub fn file_row_actions(reveal: bool) -> El {
    let t = tokens(dark());
    row()
        .items_center()
        .pr(t.space(Space::Xs).px())
        .gap(t.metric("fileRowActions", "gap").px())
        .motion(rune::Spring::NONE)
        .group_opacity(if reveal { 1.0 } else { 0.0 }, 1.0)
}

pub fn change_section_button<S: 'static>(
    name: &str,
    count: usize,
    open: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let title = |property| t.metric("gitSectionTitle", property).px();
    let chip = |property| t.metric("gitSectionCount", property).px();
    let title_font =
        rune::TextStyle::new(title("fontSize"), title("fontWeight")).lh(title("lineHeight"));
    let focus_width = t.metric("windowIconFocus", "outlineWidth").px();
    let label = format!("{name} · {count}");
    let ink = t.color("text-secondary");
    let counter = text(count.to_string())
        .font(
            rune::TextStyle::new(chip("fontSize"), t.number("font-weight-regular").px())
                .lh(chip("lineHeight")),
        )
        .color(t.color("text-muted"))
        .fill(t.color("surface-inset"))
        .radius(t.number("chip-radius").px())
        .opacity(chip("opacity"))
        .px(chip("paddingLeft"))
        .py(chip("paddingTop"))
        .border(chip("borderTopWidth"), t.color("border-base"))
        .border_layout()
        .a11y_hidden();
    let press = Rc::new(press);
    let key_press = press.clone();
    row()
        .full_width()
        .px(t.space(Space::Sm).px())
        .py(t.space(Space::Xs).px())
        .items_center()
        .gap(t.metric("gitSection", "columnGap").px())
        .hover(t.color("surface-hover"))
        .focus_ring(focus_width, -focus_width, t.color("focus-ring-color"))
        .role("button")
        .label(label)
        .expanded(open)
        .focusable(true)
        .child(
            icon(
                if open { &CHEVRON_DOWN } else { &CHEVRON_RIGHT },
                t.length(crate::Length::Icon).px(),
            )
            .color(ink)
            .a11y_hidden(),
        )
        .child(
            text(name.to_uppercase())
                .key("git-section-title")
                .font(title_font)
                .color(ink)
                .truncate()
                .remaining()
                .a11y_hidden(),
        )
        .child(counter)
        .on_press_tx(move |s, tx| press(s, tx))
        .on_key(move |s: &mut S, key, tx| {
            if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
                return false;
            }
            if !tx.key_repeat() {
                key_press(s, tx);
            }
            true
        })
}

pub fn commit_box() -> El {
    let t = tokens(dark());
    let border = t.metric("gitContext", "borderBottomWidth").px();
    col()
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .border_sides([0.0, 0.0, border, 0.0], t.color("border-base"))
        .border_layout()
}

pub fn panel_more_button<S: 'static>(
    label: impl Into<String>,
    help: Option<String>,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let focus_width = t.metric("windowIconFocus", "outlineWidth").px();
    let label = label.into();
    let mut button = row()
        .full_width()
        .justify_center()
        .items_center()
        .pad(Space::Sm)
        .role("button")
        .label(label.clone())
        .focusable(!disabled)
        .disabled(disabled)
        .focus_ring(focus_width, -focus_width, t.color("focus-ring-color"))
        .child(
            text(label)
                .text_role(TextRole::Small)
                .color(t.color("text-secondary"))
                .truncate()
                .content_direction()
                .a11y_hidden(),
        );
    if let Some(help) = help {
        button = button.help(help);
    }
    if disabled {
        button.opacity(0.5)
    } else {
        let press = Rc::new(press);
        let key_press = press.clone();
        button
            .hover(t.color("surface-hover"))
            .on_press_tx(move |s, tx| press(s, tx))
            .on_key(move |s: &mut S, key, tx| {
                let activate = key.key == rune::Key::Enter
                    || matches!(&key.key, rune::Key::Text(ch) if ch == " ");
                if !activate || key.mods != rune::Mods::default() {
                    return false;
                }
                if !tx.key_repeat() {
                    key_press(s, tx);
                }
                true
            })
    }
}

pub fn file_item<S: 'static>(
    path: String,
    kind: String,
    colored_status: bool,
    counts: Option<(u64, u64)>,
    help: String,
    disabled: bool,
    selected: bool,
    click: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let small = t.text(TextRole::Small);
    let focus_width = t.metric("windowIconFocus", "outlineWidth").px();
    let label = counts.map_or_else(
        || format!("{kind} {path}"),
        |(a, d)| format!("{kind} {path} +{a} −{d}"),
    );
    let status_ink = if colored_status {
        match kind.as_str() {
            "A" => t.color("status-success"),
            "D" => t.color("status-error"),
            _ => t.color("text-muted"),
        }
    } else {
        t.color("text-muted")
    };
    let mut item = row()
        .remaining()
        .shrink()
        .min_w(0.0)
        .min_h(t.length(crate::Length::TouchCompact).px())
        .items_center()
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Sm).px())
        .gap(t.space(Space::Sm).px())
        .role("button")
        .label(label)
        .help(help)
        .focusable(!disabled)
        .disabled(disabled)
        .checked(selected)
        .focus_ring(focus_width, -focus_width, t.color("focus-ring-color"))
        .child(
            text(kind)
                .w(t.length(crate::Length::Icon).px())
                .font(small.mono())
                .color(status_ink)
                .a11y_hidden(),
        )
        .child(
            text(path)
                .font(small)
                .color(t.color("text-primary"))
                .truncate()
                .remaining()
                .shrink()
                .min_w(0.0)
                .literal_direction()
                .a11y_hidden(),
        )
        .child(counts.map_or_else(rune::el, |(plus, minus)| {
            changes(plus, minus)
                .opacity(t.metric("gitCount", "opacity").px())
                .a11y_hidden()
        }));
    if disabled {
        item.opacity(0.5)
    } else {
        let click = Rc::new(click);
        let key_click = click.clone();
        item = item
            .on_press_tx(move |s, tx| click(s, tx))
            .on_key(move |s: &mut S, key, tx| {
                let activate = key.key == rune::Key::Enter
                    || matches!(&key.key, rune::Key::Text(ch) if ch == " ");
                if !activate || key.mods != rune::Mods::default() {
                    return false;
                }
                if !tx.key_repeat() {
                    key_click(s, tx);
                }
                true
            });
        item
    }
}

pub fn filter_bar(input: El) -> El {
    let t = tokens(dark());
    col()
        .full_width()
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Sm).px())
        .child(input)
}

pub fn filter_input<S: 'static>(
    value: &rune::edit::TextEdit,
    label: &str,
    edit: impl for<'a> Fn(&'a mut S) -> &'a mut rune::edit::TextEdit + 'static,
) -> El {
    let dark = dark();
    let t = tokens(dark);
    let small = t.text(TextRole::Small);
    let height = small.line_px() + 2.0 * t.space(Space::Xs).px();
    bordered_control(
        crate::layout::hinted_field(value, label)
            .label(label)
            .text_style(small)
            .height(height)
            .input_mode(rune::InputMode::Search)
            .autofill(rune::Autofill::Off)
            .on_edit(edit)
            .build(&crate::field_kit(dark)),
    )
    .key("git-filter")
}

pub fn commit_input<S: 'static>(
    draft: &rune::edit::TextEdit,
    label: &str,
    edit: impl for<'a> Fn(&'a mut S) -> &'a mut rune::edit::TextEdit + 'static,
    submit_label: &str,
    submit_disabled: bool,
    submit: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let dark = dark();
    let t = tokens(dark);
    let mut btn_kit = crate::kit(dark).clone();
    btn_kit.c.bg_button_neutral = t.color("surface-canvas");
    btn_kit.c.hover = t.color("surface-hover");
    btn_kit.c.pressed = t.color("surface-hover");
    let submit_btn = bordered_control(
        rune_kit::Button::new(submit_label)
            .variant(rune_kit::ButtonVariant::Neutral)
            .control_size(rune_kit::ControlSize::Small)
            .disabled(submit_disabled)
            .on_press_tx(submit)
            .build(&btn_kit),
    )
    .key("git-commit");
    let mut area_kit = crate::field_kit(dark).clone();
    area_kit.metrics.text_area = Some(rune_kit::TextAreaMetrics {
        style: t.text(TextRole::Label),
        padding: t.space(Space::Xs).px(),
    });
    bordered_control(
        crate::layout::textarea(draft)
            .label(label)
            .placeholder(label)
            .auto_grow(1, 6)
            .on_edit(edit)
            .trailing(submit_btn)
            .build(&area_kit),
    )
    .key("git-commit-message")
}

pub fn header_icon_button<S: 'static>(
    glyph: &'static Glyph,
    name: impl Into<String>,
    disabled: bool,
    active: Option<bool>,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    let t = tokens(dark());
    let side = t.length(crate::Length::IconButton).px();
    let border = t.metric("gitContext", "borderBottomWidth").px();
    let focus_width = t.metric("windowIconFocus", "outlineWidth").px();
    let is_active = active == Some(true) && !disabled;
    let name = name.into();
    let mut button = row()
        .size(side, side)
        .center()
        .role("button")
        .label(name.clone())
        .help(name)
        .focusable(!disabled)
        .disabled(disabled)
        .fill(t.color(if is_active {
            "icon-toggle-active-bg"
        } else {
            "surface-canvas"
        }))
        .border(border, t.color("border-base"))
        .border_layout()
        .focus_ring(
            focus_width,
            t.metric("windowIconFocus", "outlineOffset").px(),
            t.color("focus-ring-color"),
        )
        .child(
            icon(glyph, t.length(crate::Length::Icon).px())
                .color(t.color(if is_active {
                    "text-primary"
                } else {
                    "icon-button-color"
                }))
                .a11y_hidden(),
        );
    if let Some(on) = active {
        button = button.checked(on);
    }
    if disabled {
        button.opacity(0.55)
    } else {
        let press = Rc::new(press);
        let key_press = press.clone();
        button
            .hover(t.color(if is_active {
                "icon-toggle-active-bg"
            } else {
                "surface-hover"
            }))
            .on_press_tx(move |s, tx| press(s, tx))
            .on_key(move |s: &mut S, key, tx| {
                if key.key != rune::Key::Enter || key.mods != rune::Mods::default() {
                    return false;
                }
                if !tx.key_repeat() {
                    key_press(s, tx);
                }
                true
            })
    }
}

pub fn diff_close_button<S: 'static>(
    name: impl Into<String>,
    press: impl Fn(&mut S, &mut Tx) + 'static,
) -> El {
    header_icon_button(&crate::window_control::CLOSE, name, false, None, press)
}

pub fn diff_title(path: impl Into<String>) -> El {
    let t = tokens(dark());
    let font = rune::TextStyle::new(
        t.metric("readerTitle", "fontSize").px(),
        t.metric("readerTitle", "fontWeight").px(),
    )
    .lh(t.metric("readerTitle", "lineHeight").px());
    text(path)
        .font(font)
        .color(t.color("text-primary"))
        .truncate()
        .literal_direction()
}

pub fn diff_subtitle(label: impl Into<String>) -> El {
    let t = tokens(dark());
    let font = rune::TextStyle::new(
        t.metric("readerDirectory", "fontSize").px(),
        t.metric("readerDirectory", "fontWeight").px(),
    )
    .lh(t.metric("readerDirectory", "lineHeight").px());
    text(label)
        .font(font)
        .color(t.color("text-muted"))
        .truncate()
        .content_direction()
}

pub fn diff_body<S: 'static>(
    state: &S,
    key: String,
    get: impl Fn(&S) -> &crate::git_diff::DiffState + 'static,
    get_mut: impl Fn(&mut S) -> &mut crate::git_diff::DiffState + 'static,
    comment: Option<crate::git_diff::LineAction<S>>,
) -> El {
    // rune-kit DiffView always emits a 44 pt Row::File header and sticky overlay; clear its
    // inner content and clip it above the viewport until rune-kit exposes a headerless option.
    const KIT_FILE_HEADER_H: f32 = 44.0;
    let view = rune_kit::diff::DiffView::new(get, get_mut)
        .key(key)
        .file_header(|_, _, _| rune::el());
    let view = match comment {
        Some(comment) => view.on_comment(move |s, lines, tx| comment(s, lines, tx)),
        None => view,
    };
    col().full_width().remaining().clip_rounded(0.0).child(
        view.build(state, &crate::kit(dark())).pin(
            Some(0.0),
            Some(-KIT_FILE_HEADER_H),
            Some(0.0),
            Some(0.0),
        ),
    )
}

pub fn history_row<S: 'static>(
    name: String,
    content: El,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    history_action(name, &COMMIT, content, disabled, press)
}

pub fn history_back<S: 'static>(
    name: &str,
    press: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    history_action(
        name.into(),
        &ARROW_LEFT,
        text(name).text_role(TextRole::Small),
        false,
        press,
    )
}

fn history_action<S: 'static>(
    name: String,
    glyph: &'static rune::Icon,
    content: El,
    disabled: bool,
    press: impl Fn(&mut S, &mut Tx) + Clone + 'static,
) -> El {
    let t = tokens(dark());
    let metric = |name| t.metric("gitHistoryRow", name).px();
    let focus_width = t.metric("windowIconFocus", "outlineWidth").px();
    let body = row()
        .full_width()
        .px(metric("paddingLeft"))
        .py(metric("paddingTop"))
        .gap(metric("columnGap"))
        .border_sides(
            [0.0, 0.0, metric("borderBottomWidth"), 0.0],
            t.color("border-base"),
        )
        .border_layout()
        .hover(t.color("surface-hover"))
        .focus_ring(focus_width, -focus_width, t.color("focus-ring-color"))
        .role("button")
        .label(name)
        .focusable(!disabled)
        .disabled(disabled)
        .child(
            icon(glyph, t.length(crate::Length::Icon).px())
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(content.remaining().shrink().min_w(0.0).a11y_hidden());
    if disabled {
        body
    } else {
        let enter = press.clone();
        body.on_press_tx(press)
            .on_key(move |state: &mut S, key, tx| {
                if key.key != rune::Key::Enter {
                    return false;
                }
                enter(state, tx);
                true
            })
    }
}

pub fn history_summary(id: &str, message: &str, count: String) -> El {
    let t = tokens(dark());
    let small = t.text(TextRole::Small);
    let muted = t.color("text-muted");
    band("gitCommitSummary")
        .child(
            text(id.chars().take(8).collect::<String>())
                .font(small.mono())
                .color(muted),
        )
        .child(text(message).wrap_anywhere().content_direction())
        .child(text(count).font(small).color(muted))
}

pub fn history_refs(refs: String) -> El {
    clipped(refs, TextRole::Small).color(tokens(dark()).color("accent-primary"))
}

pub fn history_meta(author: String, short: String) -> El {
    let t = tokens(dark());
    let ink = t.color("text-muted");
    row()
        .full_width()
        .separate(Space::Sm)
        .child(clipped(author, TextRole::Small).color(ink).remaining())
        .child(text(short).font(t.text(TextRole::Small).mono()).color(ink))
}

pub fn count(label: String) -> El {
    let t = tokens(dark());
    text(label)
        .text_role(TextRole::Small)
        .color(t.color("text-muted"))
        .opacity(t.metric("gitCount", "opacity").px())
}

pub fn branch(name: String) -> El {
    let t = tokens(dark());
    let size = t.number("font-size-sm").px();
    let font = rune::TextStyle::new(size, t.number("font-weight-bold").px())
        .lh(size * t.number("line-height-normal").px());
    let mut label = text(name.clone()).font(font).truncate().content_direction();
    if !name.is_empty() {
        label = label.help(name);
    }
    row()
        .remaining()
        .items_center()
        .separate(Space::Sm)
        .child(
            icon(&BRANCH, t.length(crate::Length::Icon).px())
                .color(t.color("text-muted"))
                .a11y_hidden(),
        )
        .child(label)
}

pub fn chrome() -> El {
    let t = tokens(dark());
    let border = t.metric("readerHeader", "borderBottomWidth").px();
    row()
        .full_width()
        .items_center()
        .flex_wrap()
        .separate(Space::Xs)
        .pad(Space::Sm)
        .fill(t.color("surface-chrome"))
        .border_sides([0.0, 0.0, border, 0.0], t.color("border-divider"))
        .border_layout()
}

pub fn diff_notice(label: impl Into<String>) -> El {
    let t = tokens(dark());
    let border = t.metric("gitContext", "borderBottomWidth").px();
    text(label)
        .role("status")
        .text_role(TextRole::Label)
        .color(t.color("text-secondary"))
        .full_width()
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Sm).px())
        .border_sides([0.0, 0.0, border, 0.0], t.color("border-base"))
        .border_layout()
        .wrap()
}

pub fn note(label: impl Into<String>, role: &'static str) -> El {
    let token = if role == "alert" {
        "status-error"
    } else {
        "text-muted"
    };
    text(label)
        .role(role)
        .text_role(TextRole::Small)
        .color(tokens(dark()).color(token))
        .full_width()
        .pad(Space::Md)
        .wrap()
}

pub fn changes(additions: u64, deletions: u64) -> El {
    let t = tokens(dark());
    let small = t.text(TextRole::Small);
    let bold =
        rune::TextStyle::new(small.size, t.number("font-weight-bold").px()).lh(small.line_px());
    row()
        .separate(Space::Xs)
        .child(
            text(format!("+{additions}"))
                .font(bold)
                .color(t.color("status-success")),
        )
        .child(
            text(format!("−{deletions}"))
                .font(bold)
                .color(t.color("status-error")),
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scroll_returns_to_last_offset_after_the_view_unmounts() {
        #[derive(Default)]
        struct Test {
            bookmark: ScrollBookmark,
            hidden: bool,
        }
        fn view(test: &Test, _: &mut rune::Cx<Test>) -> El {
            let mut root = col().full_width().full_height().child(
                crate::layout::button("toggle", false, |test: &mut Test| {
                    if !test.hidden {
                        test.bookmark.retain_for_remount();
                    }
                    test.hidden = !test.hidden;
                })
                .key("toggle"),
            );
            if !test.hidden {
                root = root.child(
                    saved_scroll::<Test>("list", &test.bookmark)
                        .children((0..100).map(|n| text(format!("entry {n}")))),
                );
            }
            root
        }
        let mut rt = rune::Runtime::new(
            Test::default(),
            view,
            (340.0, 300.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        rt.set_wheel_glide(false);
        rt.wheel(160.0, 170.0, -420.0);
        for _ in 0..20 {
            rt.frame(1.0 / 60.0);
        }
        let offset = rt.state.bookmark.0.get().0;
        assert!(offset > 100.0, "offset {offset}");
        for _ in 0..2 {
            let (x, y) = rt.find("toggle").unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            for _ in 0..10 {
                rt.frame(1.0 / 60.0);
            }
        }
        assert!(!rt.state.hidden);
        assert_eq!(rt.state.bookmark.0.get(), (offset, false));
    }

    #[test]
    fn chrome_branch_section_and_diff_notice_follow_light_and_dark_tokens() {
        fn find_node<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
            if node.get("key").and_then(|v| v.as_str()) == Some(key) {
                return Some(node);
            }
            node.get("children")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
                .find_map(|child| find_node(child, key))
        }

        for dark in [false, true] {
            let mut rt = rune::Runtime::new(
                dark,
                |&dark, cx| {
                    crate::layout::render_with_dark(cx, dark, |_| {
                        col()
                            .full_width()
                            .child(chrome().key("chrome"))
                            .child(branch("feat/rust-server".into()).key("branch"))
                            .child(diff_notice("Whitespace only").key("notice"))
                            .child(section(false).key("section-mid"))
                            .child(section(true).key("section-last"))
                    })
                },
                (420.0, 280.0),
                rune::Env::new(dark, 1.0),
            );
            rt.frame(0.0);
            let t = tokens(dark);
            let elements = rt.elements();

            let chrome_el = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("chrome"))
                .expect("chrome element");
            assert_eq!(chrome_el.fill, t.color("surface-chrome"));
            assert_eq!(chrome_el.border_color, Some(t.color("border-divider")));

            let branch_el = elements
                .iter()
                .find(|el| el.help.as_deref() == Some("feat/rust-server"))
                .expect("branch title with tooltip for truncated names");
            assert_eq!(t.number("font-size-sm").px(), 12.0);
            assert_eq!(t.number("font-weight-bold").px(), 700.0);
            assert!(
                branch_el.rect[3]
                    >= t.number("font-size-sm").px() * t.number("line-height-normal").px() - 0.5,
                "branch title height must match 12px line height"
            );

            let notice_el = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("notice"))
                .expect("diff_notice element");
            assert_eq!(t.text(TextRole::Label).size, t.number("font-size-sm").px());
            assert_eq!(notice_el.text_color, Some(t.color("text-secondary")));
            assert_eq!(notice_el.border_color, Some(t.color("border-base")));
            let expected_notice_min_h =
                t.text(TextRole::Label).line_px() + 2.0 * t.space(Space::Sm).px();
            assert!(
                notice_el.rect[3] >= expected_notice_min_h,
                "diff_notice height {} must match 12px TextRole::Label + padding ({expected_notice_min_h})",
                notice_el.rect[3]
            );
            let a11y = rt.accessibility_json();
            let notice_node = find_node(&a11y, "notice").expect("notice a11y node");
            assert_eq!(notice_node["role"], "status");
            assert_eq!(notice_node["name"], "Whitespace only");

            let mid_section = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("section-mid"))
                .expect("non-last section");
            assert_eq!(mid_section.border_color, Some(t.color("border-divider")));

            let last_section = elements
                .iter()
                .find(|el| el.key.as_deref() == Some("section-last"))
                .expect("last section");
            assert_eq!(
                last_section.border_color, None,
                "last section must omit bottom border matching Solid last:border-b-0"
            );
        }
    }
}
