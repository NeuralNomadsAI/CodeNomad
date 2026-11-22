//! Offscreen row gallery, with synthetic content and no backend.
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
        let control = |glyph| {
            rune::el()
                .size(side, side)
                .center()
                .child(
                    rune::icon(glyph, t.metric("fileRowActionGlyph", "width").px())
                        .color(t.color("text-muted")),
                )
                .opacity(t.metric("fileRowAction", "opacity").px())
        };
        let actions = rune::row()
            .gap(t.metric("workspaceRow", "actionGap").px())
            .center_y()
            .child(if file {
                control(&icons::EYE)
            } else {
                rune::el()
            })
            .child(control(&icons::COPY))
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
