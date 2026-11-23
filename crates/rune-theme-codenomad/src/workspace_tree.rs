//! Workspace row geometry from the Solid tree; its owner supplies actions and input policy.
use crate::{Space, layout::Layout, tokens};
use rune::{El, Icon, TextStyle, icon};
#[path = "workspace_tree_icons.rs"]
pub mod icons;

pub struct Row<'a> {
    pub label: &'a str,
    pub depth: u32,
    pub selected: bool,
    pub expanded: Option<bool>,
    pub icon: &'static Icon,
    pub busy: bool,
    pub actions: Option<El>,
}

pub fn entry_icon(name: &str, expanded: Option<bool>) -> &'static Icon {
    if let Some(expanded) = expanded {
        return if expanded {
            &icons::FOLDER_OPEN
        } else {
            &icons::FOLDER
        };
    }
    let extension = name
        .rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some("png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" | "ico" | "bmp" | "avif") => {
            &icons::IMAGE
        }
        Some("md" | "mdx" | "txt" | "rst") => &icons::FILE_TEXT,
        Some(
            "ts" | "tsx" | "js" | "jsx" | "json" | "yaml" | "yml" | "css" | "html" | "py" | "rs"
            | "sh",
        ) => &icons::FILE_CODE,
        _ => &icons::FILE,
    }
}

pub fn root(dark: bool, name: &str, directory: &str) -> El {
    let t = tokens(dark);
    let size = t.number("font-size-sm").px();
    rune::row()
        .w_full()
        .center_y()
        .px(t.space(Space::Md).px())
        .py(t.space(Space::Sm).px())
        .gap(t.space(Space::Sm).px())
        .help(directory)
        .child(icon(&icons::FOLDER_OPEN, t.metric("workspaceRoot", "glyph").px()).a11y_hidden())
        .child(
            rune::text(name).truncate().font(
                TextStyle::new(size, t.number("font-weight-medium").px())
                    .lh(size * t.number("line-height-normal").px()),
            ),
        )
}

pub fn workspace_body(header: El, tree: El, status: Option<El>) -> El {
    rune::col()
        .py(tokens(crate::layout::dark()).space(Space::Sm).px())
        .full_width()
        .child(header)
        .child(tree)
        .children(status)
}

pub fn row(dark: bool, rtl: bool, row: Row<'_>) -> El {
    let t = tokens(dark);
    let m = |name| t.metric("workspaceRow", name).px();
    let start = m("base") + row.depth as f32 * m("step");
    let end = m("paddingInlineEnd");
    let ink = t.color(if row.selected {
        "text-primary"
    } else {
        "text-secondary"
    });
    let muted = t.color("text-muted");
    let mut e = rune::row()
        .dir(if rtl {
            rune::Direction::Rtl
        } else {
            rune::Direction::Ltr
        })
        .role("treeitem")
        .label(row.label)
        .level(row.depth)
        .focus_selected(row.selected)
        .w_full()
        .min_h(m("minHeight"))
        .pt(m("paddingTop"))
        .pb(m("paddingBottom"))
        .pl(start)
        .pr(end)
        .gap(m("columnGap"))
        .center_y()
        .focusable(true)
        .hover_group()
        .focus_ring(
            m("outlineWidth"),
            m("outlineOffset"),
            t.color("accent-primary"),
        );
    if row.selected {
        e = e.fill(t.color("selection-neutral-strong-bg"));
    }
    if let Some(open) = row.expanded {
        e = e.expanded(open);
    }
    let lane = match row.expanded {
        Some(open) => icon(
            if open {
                &icons::CHEVRON_DOWN
            } else {
                &icons::CHEVRON_RIGHT
            },
            m("chevron"),
        )
        .color(muted),
        None => rune::el().w(m("chevron")),
    };
    e = e
        .children((!row.selected).then(|| {
            rune::el()
                .key("rollover")
                .pin(Some(0.0), Some(0.0), Some(0.0), Some(0.0))
                .fill(t.color("surface-hover-overlay"))
                .group_opacity(0.0, 1.0)
                .a11y_hidden()
        }))
        .child(lane.key("chevron").a11y_hidden())
        .child(
            icon(row.icon, m("icon"))
                .key("icon")
                .color(muted)
                .a11y_hidden(),
        )
        .child(
            rune::text(row.label)
                .key("label")
                .grow(1.0)
                .shrink()
                .min_w(0.0)
                .truncate()
                .font(TextStyle::new(m("fontSize"), m("fontWeight")).lh(m("lineHeight")))
                .color(ink)
                .a11y_hidden(),
        );
    if row.busy {
        e = e.child(
            icon(&icons::REFRESH_CW, m("busy"))
                .key("busy")
                .color(muted)
                .a11y_hidden()
                .looping(rune::LoopSpec::rotation(m("spinSeconds") as f64)),
        );
    }
    e.children(row.actions)
}

#[cfg(test)]
#[path = "workspace_tree_tests.rs"]
mod tests;
