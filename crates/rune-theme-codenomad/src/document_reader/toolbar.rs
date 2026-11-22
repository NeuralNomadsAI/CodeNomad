use super::*;

pub enum Tool {
    Refresh,
    Source,
    Preview,
    Wrap,
}

// Lucide glyphs, the source of the Files controls.
const WRAP: Icon = Icon {
    name: "lucide-wrap-text",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h15a3 3 0 1 1 0 6h-4m2-2-2 2 2 2M3 18h7"/></g>"#,
};
const REFRESH: Icon = Icon {
    name: "lucide-refresh-cw",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16m5 0H3v5"/></g>"#,
};
const SOURCE: Icon = Icon {
    name: "lucide-code",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/></g>"#,
};

pub fn toolbar_icon<S: 'static>(
    dark: bool,
    tool: Tool,
    label: &str,
    disabled: bool,
    toggled: Option<bool>,
    press: impl Fn(&mut S) + 'static,
) -> El {
    let t = tokens(dark);
    let active = toggled == Some(true);
    let side = t.length(Length::IconButton).px();
    let outline = t.metric("windowIconFocus", "outlineWidth").px();
    let icon = match tool {
        Tool::Refresh => &REFRESH,
        Tool::Source => &SOURCE,
        Tool::Preview => kit(dark).glyph.eye,
        Tool::Wrap => &WRAP,
    };
    let button = rune::row()
        .size(side, side)
        .center()
        .role("button")
        .label(label)
        .help(label)
        .disabled(disabled)
        .focusable(!disabled)
        .fill(t.color(if active {
            "icon-toggle-active-bg"
        } else {
            "surface-canvas"
        }))
        .border(outline, t.color("border-base"))
        .focus_ring(
            outline,
            t.metric("windowIconFocus", "outlineOffset").px(),
            t.color("focus-ring-color"),
        )
        .child(
            rune::icon(icon, t.length(Length::Icon).px())
                .color(t.color(if active {
                    "text-primary"
                } else {
                    "icon-button-color"
                }))
                .a11y_hidden(),
        );
    let button = if let Some(checked) = toggled {
        button.checked(checked)
    } else {
        button
    };
    if disabled {
        button.opacity(t.metric("readerToolDisabled", "opacity").px())
    } else {
        let press = std::rc::Rc::new(press);
        let enter = press.clone();
        button
            .hover(t.color(if active {
                "icon-toggle-active-bg"
            } else {
                "surface-hover"
            }))
            .on_key(move |s: &mut S, key, _| {
                if key.key != rune::Key::Enter {
                    return false;
                }
                enter(s);
                true
            })
            .on_press(move |s: &mut S| press(s))
    }
}
