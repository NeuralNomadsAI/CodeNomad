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
    let name = super::format::label(&tool.name);
    let count = files(tool).len();
    if count == 0 {
        return name;
    }
    catalogue::format(
        locale(),
        if count == 1 {
            "toolCall.applyPatch.title.withFileCount.one"
        } else {
            "toolCall.applyPatch.title.withFileCount.other"
        },
        &[("tool", &name), ("count", &count.to_string())],
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
        let path = string(file, &["relativePath", "filePath", "file", "path"]);
        let key = format!("{key}-patch-{index}");
        let label = label(s, file, path, patch, index);
        let heading = if super::super::links::native_file(s, path).is_some() {
            let path = path.to_owned();
            layout::button(
                &label,
                false,
                screen::action(&s.input_scope, move |s| {
                    super::super::links::open_native(s, &path);
                }),
            )
            .key(format!("{key}-file"))
        } else {
            text(label).wrap()
        };
        let card = col()
            .key(key.clone())
            .full_width()
            .separate(Space::Sm)
            .child(heading);
        rendered += 1;
        if patch.is_empty() || remaining == 0 {
            truncated |= !patch.is_empty();
            view = view.child(card);
            continue;
        }
        let mut units = patch.encode_utf16();
        let used = units.by_ref().take(remaining).count();
        let complete = units.next().is_none();
        let fallback = || {
            let snapshot = tool.clone();
            col()
                .full_width()
                .separate(Space::Sm)
                .child(
                    layout::action_row().child(
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
        view = view.child(card.child(body));
        remaining -= used;
    }
    Some(view.children(truncated.then(|| text(t("toolCall.output.truncated")).role("status"))))
        .filter(|_| rendered > 0)
}

#[cfg(test)]
#[test]
fn native_file_summaries_include_diff_less_changes_and_open_the_destination() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let row = crate::history::decode_message(&json!({
        "id":"change","type":"assistant","time":{"completed":1},
        "content":[{"type":"tool","name":"apply_patch","id":"patch","state":{
            "status":"completed","metadata":{"files":[
                {"relativePath":"new.rs","status":"added"},
                {"relativePath":"gone.rs","status":"deleted"},
                {"relativePath":"next #1.rs","status":"renamed","oldPath":"old.rs"}
            ]}
        }}]
    }))
    .unwrap();
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    s.messages.push(row.into());
    let mut backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:1").unwrap();
    backend.workspace = "owned".into();
    backend.session = "session".into();
    backend.session_directory = Some("/project".into());
    s.files = Some(crate::files::Ui::new(
        backend.clone(),
        "/other".into(),
        s.reads.clone(),
        s.wake.clone(),
    ));
    crate::git::connected_placed(&mut s, &backend, "root");
    crate::settings::fixture_transcript(
        &mut s,
        json!({"toolCallExpansionDefaults":{"tools":{"other":"expanded"}}}),
    );
    let mut rt = Runtime::new(
        s,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (1000.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.02);
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.contains("Added · new.rs")
            && tree.contains("Deleted · gone.rs")
            && tree.contains("Renamed · old.rs → next #1.rs")
    );
    let (x, y) = rt.find("tool-change:5:patch-patch-2-file").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    let files = rt.state.files.as_ref().unwrap();
    let target = files.reader.target().unwrap();
    assert_eq!(
        (target.directory.as_str(), target.path.as_str()),
        ("/project", "next #1.rs")
    );
    assert_eq!(files.tree.directory(), "/other");
}

fn label(s: &State, file: &Value, path: &str, patch: &str, index: usize) -> String {
    let display = |path: &str| {
        super::super::links::native_file(s, path)
            .unwrap_or_else(|| path.replace('\\', "/"))
            .chars()
            .take(250)
            .collect::<String>()
    };
    let mut label = if path.is_empty() {
        catalogue::format(
            locale(),
            "toolCall.applyPatch.fileFallback",
            &[("number", &(index + 1).to_string())],
        )
    } else {
        display(path)
    };
    let mut status = file["status"].as_str().unwrap_or_default();
    if !path.is_empty()
        && (status == "renamed" || matches!(status, "" | "modified") && file["file"].is_string())
    {
        let header = &patch[..patch.floor_char_boundary(patch.len().min(TOOL_LIMIT))];
        let header: Vec<_> = header
            .lines()
            .take_while(|line| !tool_diff::is_hunk(line))
            .collect();
        let old = string(file, &["oldPath", "sourcePath", "oldFilePath"]);
        let old = (!old.is_empty())
            .then_some(old)
            .or_else(|| {
                header
                    .iter()
                    .find_map(|line| line.strip_prefix("rename from "))
            })
            .or_else(|| header.iter().find_map(|line| line.strip_prefix("Index: ")))
            .or_else(|| {
                header.iter().find_map(|line| {
                    line.strip_prefix("--- ").map(|old| {
                        let old = old.split('\t').next().unwrap_or(old);
                        if header.iter().any(|line| line.starts_with("diff --git ")) {
                            old.strip_prefix("a/").unwrap_or(old)
                        } else {
                            old
                        }
                    })
                })
            });
        if let Some(source) = old.filter(|old| !old.is_empty() && *old != "/dev/null") {
            let source = display(source);
            if status == "renamed" || source != label && !source.ends_with(&format!("/{label}")) {
                status = "renamed";
                label = format!("{source} → {label}");
            }
        }
    }
    let label_key = match status {
        "added" => "toolCall.applyPatch.added",
        "deleted" => "toolCall.applyPatch.deleted",
        "modified" => "toolCall.applyPatch.modified",
        "renamed" => "toolCall.applyPatch.renamed",
        _ => "toolCall.diff.label.withPath",
    };
    catalogue::format(locale(), label_key, &[("path", &label)])
}
