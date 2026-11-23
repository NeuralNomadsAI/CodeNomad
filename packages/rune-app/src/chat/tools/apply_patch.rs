use super::{TOOL_LIMIT, Tool, string, tool_diff, window};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    markdown,
};
use serde_json::Value;
use std::sync::Arc;

const FILE_LIMIT: usize = 20;

fn files(tool: &Tool) -> &[Value] {
    tool.metadata["files"].as_array().map_or(&[], Vec::as_slice)
}

#[cfg(test)]
#[test]
fn file_order_shared_diff_and_raw_copy_survive_a_multi_file_patch() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let good = "@@ -1 +1 @@\n-old\n+new";
    let raw = "@@ -1,2 +1,2 @@\n-outside\n+raw fallback";
    let row = crate::history::decode_message(&json!({
        "type":"assistant", "id":"change", "time":{"completed":1},
        "content":[{"type":"tool", "name":"apply_patch", "id":"patch", "state":{
            "status":"completed",
            "metadata":{"files":[
                {"relativePath":"src/first.rs", "diff":good},
                {"relativePath":"src/second.rs", "patch":raw},
            ]}
        }}],
    }))
    .unwrap();
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    s.messages.push(row.into());
    crate::settings::fixture_transcript(
        &mut s,
        json!({
            "toolCallExpansionDefaults":{"tools":{"other":"expanded"}},
        }),
    );
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (1000.0, 900.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    for _ in 0..20 {
        rt.frame(0.02);
    }
    let prefix = "tool-change:5:patch";
    assert!(rt.find(&format!("{prefix}-patch-0-mode")).is_some());
    assert!(rt.find(&format!("{prefix}-patch-1-mode")).is_none());
    let first = rt.find(&format!("{prefix}-patch-0-copy-patch")).unwrap();
    let second = rt.find(&format!("{prefix}-patch-1-copy-patch")).unwrap();
    assert!(first.1 < second.1);
    let all = rt.find(&format!("copy-{prefix}-output")).unwrap();
    let joined = format!("{good}\n{raw}");
    for ((x, y), expected) in [(first, good), (second, raw), (all, joined.as_str())] {
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.02);
        assert_eq!(clipboard.text().unwrap().as_str(), expected);
    }
}

fn patch(file: &Value) -> &str {
    string(file, &["diff", "patch"])
}

pub(super) fn has_patch(tool: &Tool) -> bool {
    let mut remaining = TOOL_LIMIT;
    for file in files(tool).iter().take(FILE_LIMIT) {
        for ch in patch(file).chars() {
            if !ch.is_whitespace() || remaining < ch.len_utf16() {
                return true;
            }
            remaining -= ch.len_utf16();
        }
    }
    files(tool).len() > FILE_LIMIT
}

pub(super) fn copy_all(tool: &Tool) -> Option<String> {
    let source = files(tool)
        .iter()
        .map(patch)
        .filter(|source| !source.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!source.is_empty()).then_some(source)
}

pub(super) fn title(tool: &Tool) -> String {
    let count = files(tool).len();
    if count == 0 {
        return tool.name.clone();
    }
    catalogue::format(
        locale(),
        if count == 1 {
            "toolCall.applyPatch.title.withFileCount.one"
        } else {
            "toolCall.applyPatch.title.withFileCount.other"
        },
        &[("tool", &tool.name), ("count", &count.to_string())],
    )
}

pub(super) fn view(s: &State, message: &str, key: &str, tool: &Arc<Tool>) -> Option<El> {
    let changes = files(tool);
    let mut remaining = TOOL_LIMIT;
    let mut rendered = 0;
    let mut truncated = changes.len() > FILE_LIMIT;
    let mut view = col().full_width().separate(Space::Sm);
    for (index, file) in changes.iter().take(FILE_LIMIT).enumerate() {
        let patch = patch(file);
        if patch.trim().is_empty() {
            continue;
        }
        if remaining == 0 {
            truncated = true;
            break;
        }
        let path = string(file, &["relativePath", "filePath", "file", "path"]);
        let key = format!("{key}-patch-{index}");
        let mut units = patch.encode_utf16();
        let used = units.by_ref().take(remaining).count();
        let complete = units.next().is_none();
        let fallback = || {
            let label = if path.is_empty() {
                catalogue::format(
                    locale(),
                    "toolCall.applyPatch.fileFallback",
                    &[("number", &(index + 1).to_string())],
                )
            } else {
                path.chars().take(250).collect()
            };
            let snapshot = tool.clone();
            col()
                .full_width()
                .separate(Space::Sm)
                .child(
                    layout::action_row().child(text(label)).child(
                        markdown::copy_button(
                            t("toolCall.diff.copyPatch"),
                            screen::action_tx(&s.input_scope, move |_, tx| {
                                tx.copy(self::patch(&files(&snapshot)[index]));
                            }),
                        )
                        .key(format!("{key}-copy-patch")),
                    ),
                )
                .child(markdown::tool_pane(
                    window(s, key.clone(), &[patch], remaining, |shown, units| {
                        markdown::code(shown, "diff", units <= TOOL_LIMIT, true)
                    }),
                    true,
                ))
        };
        let body =
            if complete && !message.starts_with("child:") && tool_diff::structured_candidate(patch)
            {
                tool_diff::body(s, message, &key, tool, patch, path, fallback)
            } else {
                fallback()
            };
        view = view.child(col().key(key).full_width().child(body));
        rendered += 1;
        remaining -= used;
    }
    Some(view.children(truncated.then(|| text(t("toolCall.output.truncated")).role("status"))))
        .filter(|_| rendered > 0)
}
