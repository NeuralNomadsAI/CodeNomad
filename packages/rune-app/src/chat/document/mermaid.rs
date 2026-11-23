use crate::{State, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    document_reader,
    layout::{self, Layout},
};

pub(super) fn frame(
    unfinished: bool,
    source_only: bool,
    source: &str,
    key: String,
    toggle: impl Fn(&mut State) + 'static,
    card: El,
    wrap: El,
    copy: El,
) -> El {
    let dark = layout::dark();
    let diagram =
        (!unfinished && !source_only && source.encode_utf16().take(50_001).count() <= 50_000)
            .then(|| document_reader::mermaid(dark, source))
            .flatten();
    let preview = diagram.is_some();
    let mut header = layout::action_row().child(text("mermaid"));
    if !unfinished && (preview || source_only) {
        header = header.child(
            layout::button(
                t(if preview {
                    "markdown.mermaid.source"
                } else {
                    "markdown.mermaid.preview"
                }),
                false,
                toggle,
            )
            .key(format!("{key}-diagram-toggle"))
            .checked(preview),
        );
    }
    if !preview {
        header = header.child(wrap);
    }
    let mut block = col()
        .key(key.clone())
        .full_width()
        .child(header.child(copy));
    if let Some(diagram) = diagram {
        block = block.child(document_reader::mermaid_frame(
            dark,
            diagram
                .key(format!("{key}-diagram"))
                .label(t("markdown.mermaid.diagram")),
        ));
    } else {
        block = block
            .children((!unfinished && !source_only).then(|| text(t("markdown.mermaid.failed"))))
            .child(card);
    }
    block
}

#[cfg(test)]
mod tests {
    use rune::{Env, Runtime};

    fn render(source: &'static str, streaming: bool) -> Runtime<crate::State> {
        let mut s = crate::init();
        s.messages.push(
            crate::Message {
                id: "example".into(),
                role: "assistant".into(),
                body: source.into(),
                completed: !streaming,
                parts: vec![],
                usage: None,
            }
            .into(),
        );
        let mut rt = Runtime::new(
            s,
            |s, _| {
                crate::strings::with_locale("en", || {
                    let row = &s.messages[0];
                    super::super::prose(s, "example".into(), &row.body, !row.completed)
                })
            },
            (880.0, 520.0),
            Env::new(false, 1.0),
        );
        rt.frame(0.02);
        rt
    }

    fn click(rt: &mut Runtime<crate::State>, key: &str) {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
    }

    #[test]
    fn a_closed_mermaid_fence_can_switch_to_copyable_source_and_back() {
        for source in [
            "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```",
            "```mmd\nflowchart LR\n  A[Start] --> B[Finish]\n```",
        ] {
            let mut rt = render(source, false);
            let clipboard = rune::clipboard::memory();
            rt.use_clipboard(&clipboard);
            assert!(rt.find("example-code-0-diagram").is_some());
            click(&mut rt, "example-code-0-diagram-toggle");
            assert!(rt.find("example-code-0-diagram").is_none());
            assert!(rt.accessibility_json().to_string().contains("flowchart LR"));
            click(&mut rt, "example-code-0-copy");
            assert_eq!(
                clipboard.text().unwrap().trim_end(),
                "flowchart LR\n  A[Start] --> B[Finish]"
            );
            click(&mut rt, "example-code-0-diagram-toggle");
            assert!(rt.find("example-code-0-diagram").is_some());
        }
    }

    #[test]
    fn unfinished_streaming_and_unsupported_fences_keep_their_source() {
        for (source, streaming, raw) in [
            ("```mermaid\nflowchart LR\n  A --> B", false, "A --> B"),
            ("```mermaid\nflowchart LR\n  A --> B\n```", true, "A --> B"),
            ("```mermaid\nunknownDiagram\n```", false, "unknownDiagram"),
        ] {
            let rt = render(source, streaming);
            assert!(rt.find("example-code-0-diagram").is_none());
            assert!(rt.find("example-code-0-copy").is_some());
            assert!(rt.accessibility_json().to_string().contains(raw));
        }
    }
}
