use super::{actions::Display, document};
use crate::{
    State,
    content::{Reasoning, TextProvenance},
    screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};

pub(crate) fn block_key(message: &str, ordinal: usize) -> String {
    format!("reasoning-{message}:{ordinal}")
}

pub(super) fn view(s: &State, message: &str, parts: &[crate::content::Part]) -> Option<El> {
    let mut reasoning = parts.iter().filter_map(|part| match part {
        crate::content::Part::Reasoning(part) if !part.text.trim().is_empty() => Some(part),
        _ => None,
    });
    let first = reasoning.next()?;
    let last = reasoning.clone().next_back().unwrap_or(first);
    let key = block_key(message, first.ordinal);
    let expanded = s.transcript_display.toggled(&key);
    let title = last.text.trim().strip_prefix("**").and_then(|source| {
        let (title, rest) = source.split_once("**")?;
        (!title.is_empty()
            && !title.contains(['*', '\n'])
            && (rest.is_empty() || rest.starts_with("\n\n") || rest.starts_with("\r\n\r\n")))
        .then_some(title.trim())
    });
    let duration = std::iter::once(first)
        .chain(reasoning.clone())
        .filter_map(|part| part.created.zip(part.completed))
        .filter_map(|(start, end)| end.checked_sub(start))
        .fold(0u64, u64::saturating_add);
    let base = if last.provenance != TextProvenance::Closed {
        t("messageBlock.reasoning.thinkingLabel").into()
    } else if duration >= 1_000 {
        let (unit, count) = match duration {
            3_600_000.. => ("hours", duration / 3_600_000),
            60_000.. => ("minutes", duration / 60_000),
            _ => ("seconds", duration / 1_000),
        };
        catalogue::format(
            locale(),
            &format!(
                "messageBlock.reasoning.thoughtFor.{unit}.{}",
                if count == 1 { "one" } else { "other" }
            ),
            &[("count", &count.to_string())],
        )
    } else {
        t("messageBlock.reasoning.thoughtLabel").into()
    };
    let toggle = key.clone();
    let header = layout::action_row()
        .child(
            layout::button(
                &base,
                false,
                screen::action(&s.input_scope, move |s| {
                    Display::toggle(s, &toggle);
                }),
            )
            .key(format!("toggle-{key}"))
            .expanded(expanded),
        )
        .children(title.map(|title| text(title.chars().take(250).collect::<String>())));
    let mut group = col()
        .key(key.clone())
        .full_width()
        .pad(Space::Sm)
        .separate(Space::Sm)
        .inset_surface()
        .child(header);
    if expanded {
        group = group.children(std::iter::once(first).chain(reasoning).map(|part| {
            let fragment = block_key(message, part.ordinal);
            let pane = body(s, &fragment, part);
            if part.ordinal == first.ordinal {
                pane
            } else {
                pane.key(fragment)
            }
        }));
    }
    Some(group)
}

fn body(s: &State, key: &str, part: &Reasoning) -> El {
    markdown::tool_pane(
        document::window(
            s,
            format!("{key}-body"),
            &[part.text.trim()],
            document::TOOL_LIMIT,
            |shown, _| {
                text(shown)
                    .full_width()
                    .wrap()
                    .content_direction()
                    .selectable(true)
            },
        ),
        false,
    )
}

#[cfg(test)]
#[test]
fn reasoning_group_uses_native_block_keys_and_reveals_its_parts() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let row = crate::history::decode_message(&json!({
        "id":"step","type":"assistant","time":{"completed":4000},"content":[
            {"type":"reasoning","text":""},
            {"type":"reasoning","text":"First private thought","time":{"created":1000,"completed":2000}},
            {"type":"reasoning","text":"**Summary**\n\nSecond private thought","time":{"created":2000,"completed":4000}},
            {"type":"text","text":"Public reply"},
            {"type":"reasoning","text":"A separate reasoning run"}
        ]
    })).unwrap();
    let mut s = crate::init();
    s.messages.push(row.into());
    s.phase = crate::Phase::Ready;
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 820.0),
        Env::new(false, 1.0),
    );
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("Thought for 3 seconds") && tree.contains("Summary"));
    assert!(!tree.contains("First private thought"));
    assert!(rt.find(&block_key("step", 3)).is_some());
    let key = block_key("step", 1);
    let (x, y) = rt.find(&format!("toggle-{key}")).unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    assert!(rt.find(&block_key("step", 2)).is_some());
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("First private thought") && tree.contains("Second private thought"));
    assert!(tree.contains("Public reply"));
}
