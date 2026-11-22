//! Offscreen row/slot layout gallery for Source's platform desktop-local caller.
//! Actions are synthetic visual slots; FileRowActions interaction has its own qualification.
use rune::{Cx, El};
use rune_theme_codenomad::{
    layout, tokens,
    workspace_tree::{self, Row, icons},
};
struct Gallery {
    rtl: bool,
    mode: String,
}
fn init() -> Gallery {
    Gallery {
        rtl: std::env::var("RUNE_ROW_RTL").as_deref() == Ok("true"),
        mode: std::env::var("RUNE_ROW_CASE").unwrap_or_else(|_| "closed".into()),
    }
}
fn view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    layout::render(cx, |_| {
        let dark = layout::dark();
        let t = tokens(dark);
        let file = s.mode == "file";
        let open = s.mode == "open";
        let node = rune_kit::FileNode::<()> {
            name: if file { "example.rs" } else { "src" }.into(),
            path: "synthetic".into(),
            dir: !file,
            data: None,
        };
        let side = t.metric("fileRowAction", "minWidth").px();
        let control = |key, glyph, disabled| {
            rune::el()
                .key(key)
                .disabled(disabled)
                .size(side, side)
                .center()
                .child(
                    rune::icon(glyph, t.metric("fileRowActionGlyph", "width").px())
                        .color(t.color("text-muted")),
                )
                .opacity(t.metric("fileRowAction", "opacity").px())
        };
        let mut actions = rune::row()
            .gap(t.metric("workspaceRow", "actionGap").px())
            .center_y();
        if file {
            actions = actions.child(control("preview", &icons::EYE, true));
            if cfg!(target_os = "windows") {
                actions = actions.child(control("open-default", &icons::EXTERNAL_LINK, false));
            }
            actions = actions.child(control("show-in-folder", &icons::FOLDER_OPEN, false));
        } else {
            actions = actions
                // FileRowActions retains its empty pinned-actions slot before the inline group.
                .child(rune::el())
                .child(control("open-folder", &icons::FOLDER_OPEN, false))
                .child(control("open-terminal", &icons::TERMINAL_SQUARE, false));
        }
        let actions = actions
            .child(control("copy-path", &icons::COPY, false))
            .opacity(if s.mode == "focus" { 1.0 } else { 0.0 });
        rune::col()
            .w_full()
            .h_full()
            .fill(t.color("surface-canvas"))
            .child(
                workspace_tree::row(
                    dark,
                    s.rtl,
                    Row {
                        label: &node.name,
                        depth: 1,
                        selected: open || s.mode == "focus",
                        expanded: (!file).then_some(open),
                        icon: if file {
                            &icons::FILE_CODE
                        } else if open {
                            &icons::FOLDER_OPEN
                        } else {
                            &icons::FOLDER
                        },
                        busy: s.mode == "busy",
                        actions: Some(actions),
                    },
                )
                .key("row"),
            )
    })
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if !args.iter().any(|a| a == "--tree") || !args.iter().any(|a| a == "--snap") {
        std::process::exit(2)
    }
    rune::run(layout::app_spec("Workspace tree row", init, view));
}
