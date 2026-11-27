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
        let label = t(if preview {
            "markdown.mermaid.source"
        } else {
            "markdown.mermaid.preview"
        });
        let button = layout::button(label, false, toggle)
            .key(format!("{key}-diagram-toggle"))
            .checked(preview);
        header = header.child(button);
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

    fn render(source: &str, streaming: bool) -> Runtime<crate::State> {
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
                    super::super::prose_at(s, "example".into(), &row.body, !row.completed, 70_000)
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

    fn find_a11y<'a>(node: &'a serde_json::Value, key: &str) -> Option<&'a serde_json::Value> {
        if node.get("key").and_then(|v| v.as_str()) == Some(key) {
            return Some(node);
        }
        node.get("children")?
            .as_array()?
            .iter()
            .find_map(|child| find_a11y(child, key))
    }

    fn toggle_state(rt: &Runtime<crate::State>) -> (String, Option<bool>) {
        let tree = rt.accessibility_json();
        let node = find_a11y(&tree, "example-code-0-diagram-toggle").unwrap();
        let name = node["name"].as_str().unwrap().to_owned();
        let states = node.get("states").and_then(|s| s.as_array());
        let checked =
            if states.is_some_and(|states| states.iter().any(|s| s.as_str() == Some("checked"))) {
                Some(true)
            } else if states
                .is_some_and(|states| states.iter().any(|s| s.as_str() == Some("unchecked")))
            {
                Some(false)
            } else {
                None
            };
        (name, checked)
    }

    #[test]
    fn accessible_toggle_name_reports_the_current_mode_and_the_next_action() {
        let mut rt = render("```mermaid\nflowchart LR\n  A --> B\n```", false);
        assert_eq!(toggle_state(&rt), ("Show source".into(), Some(true)));
        click(&mut rt, "example-code-0-diagram-toggle");
        assert_eq!(toggle_state(&rt), ("Show diagram".into(), Some(false)));
        click(&mut rt, "example-code-0-diagram-toggle");
        assert_eq!(toggle_state(&rt), ("Show source".into(), Some(true)));
    }

    #[test]
    fn comma_modifiers_are_copyable_source_instead_of_kit_diagrams() {
        for source in [
            "```mermaid,compact\nflowchart LR\n  A --> B\n```",
            "~~~MMD,compact\nflowchart LR\n  A --> B\n~~~",
            "> ```mermaid,compact\n> flowchart LR\n>   A --> B\n> ```",
            "```merm&#97;id,compact\nflowchart LR\n  A --> B\n```",
        ] {
            let mut rt = render(source, false);
            let clipboard = rune::clipboard::memory();
            rt.use_clipboard(&clipboard);
            let tree = rt.accessibility_json().to_string();
            assert!(!tree.contains("Mermaid diagram"), "{source}");
            assert!(
                rt.find("example-code-0-diagram-toggle").is_none(),
                "{source}"
            );
            click(&mut rt, "example-code-0-copy");
            assert_eq!(
                clipboard.text().unwrap().trim_end(),
                "flowchart LR\n  A --> B",
                "{source}"
            );
        }
    }

    #[test]
    fn a_complete_diagram_over_the_utf16_limit_stays_copyable_source() {
        let source = format!(
            "```mermaid\nflowchart LR\n  A --> B\n%% {}\n```",
            "🦀".repeat(25_000)
        );
        let rt = render(&source, false);
        assert!(rt.find("example-code-0-diagram").is_none());
        assert!(rt.find("example-code-0-copy").is_some());
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("supported diagram formats")
        );
    }

    #[test]
    fn a_flowchart_with_500_edges_renders_and_over_1500_items_stays_source() {
        let fence = |edges: usize| {
            let mut body = String::from("```mermaid\nflowchart LR\n");
            for i in 0..edges {
                body.push_str(&format!("  N{i} --> N{}\n", i + 1));
            }
            body.push_str("```");
            body
        };
        let within_cap = render(&fence(500), false);
        assert!(within_cap.find("example-code-0-diagram").is_some());
        assert!(within_cap.find("example-code-0-diagram-toggle").is_some());

        let over_cap = render(&fence(750), false);
        assert!(over_cap.find("example-code-0-diagram").is_none());
        assert!(over_cap.find("example-code-0-copy").is_some());
        assert!(
            over_cap
                .accessibility_json()
                .to_string()
                .contains("supported diagram formats")
        );
    }

    #[test]
    fn a_closed_mermaid_fence_can_switch_to_copyable_source_and_back() {
        for source in [
            "```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```",
            "```mmd\nflowchart LR\n  A[Start] --> B[Finish]\n```",
            "- ```mermaid\n  flowchart LR\n    A[Start] --> B[Finish]\n  ```",
            "- > ```mermaid\n  > flowchart LR\n  >   A[Start] --> B[Finish]\n  > ```",
            "10. Diagram\n\n    ```mermaid\n    flowchart LR\n      A[Start] --> B[Finish]\n    ```",
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
            (
                "```mermaid\nflowchart LR\n  A --> B\n    ```",
                false,
                "A --> B",
            ),
            (
                "> - ```mermaid\n>   flowchart LR\n>     A --> B\n>       ```",
                false,
                "A --> B",
            ),
            (
                "```mermaid\nflowchart LR\n  A --> B\n> ```",
                false,
                "A --> B",
            ),
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
