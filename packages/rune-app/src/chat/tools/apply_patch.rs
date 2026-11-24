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

fn operation_code(status: &str) -> Option<&'static str> {
    match status {
        "added" => Some("A"),
        "deleted" => Some("D"),
        "modified" => Some("M"),
        "renamed" => Some("R"),
        _ => None,
    }
}

fn file_change(s: Option<&State>, file: &Value, truncate_display: bool) -> (&'static str, String) {
    let path = string(file, &["relativePath", "filePath", "file", "path"]);
    let patch = patch(file);
    let display = |p: &str| {
        let normalized = s
            .and_then(|s| super::super::links::native_file(s, p))
            .unwrap_or_else(|| p.replace('\\', "/"));
        if truncate_display {
            normalized.chars().take(250).collect::<String>()
        } else {
            normalized
        }
    };
    let mut target = if path.is_empty() {
        String::new()
    } else {
        display(path)
    };
    let mut status = match file["status"].as_str().unwrap_or_default() {
        "added" => "added",
        "deleted" => "deleted",
        "modified" => "modified",
        "renamed" => "renamed",
        _ => "",
    };
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
            if status == "renamed" || source != target && !source.ends_with(&format!("/{target}")) {
                status = "renamed";
                target = format!("{source} → {target}");
            }
        }
    }
    (status, target)
}

fn file_copy_text(s: Option<&State>, file: &Value) -> String {
    let diff = patch(file);
    if !diff.trim().is_empty() {
        return diff.to_owned();
    }
    let (status, target) = file_change(s, file, false);
    if let Some(code) = operation_code(status)
        && !target.is_empty()
    {
        format!("{code} {target}")
    } else {
        diff.to_owned()
    }
}

pub(super) fn has_patch(tool: &Tool) -> bool {
    let mut remaining = TOOL_LIMIT;
    for file in files(tool).iter().take(FILE_LIMIT) {
        let (status, target) = file_change(None, file, true);
        if operation_code(status).is_some() && !target.is_empty() {
            return true;
        }
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
        .map(|file| file_copy_text(None, file))
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

fn matches_diagnostic_path(file: &Value, diagnostics: &[String]) -> bool {
    if diagnostics.is_empty() {
        return false;
    }
    let candidates = [
        string(file, &["relativePath"]),
        string(file, &["filePath", "file", "path"]),
    ];
    candidates.iter().any(|cand| {
        if cand.is_empty() {
            return false;
        }
        let norm = cand.replace('\\', "/");
        diagnostics.iter().any(|diag| {
            norm == *diag
                || norm.ends_with(&format!("/{diag}"))
                || diag.ends_with(&format!("/{norm}"))
        })
    })
}

pub(super) fn view(
    s: &State,
    message: &str,
    key: &str,
    tool: &Arc<Tool>,
    query: Option<rune_theme_codenomad::timeline::search::Query<'_>>,
) -> Option<El> {
    let changes = files(tool);
    let diagnostics: Vec<String> = tool.metadata["diagnostics"]
        .as_object()
        .into_iter()
        .flat_map(|map| map.keys())
        .take(FILE_LIMIT)
        .map(|path| path.replace('\\', "/"))
        .collect();
    let mut selected: Vec<(usize, &Value)> = Vec::new();
    let mut scanned = 0usize;
    let mut scanned_chars = 0usize;
    let mut truncated = false;
    for (index, file) in changes.iter().enumerate() {
        if selected.len() >= FILE_LIMIT || scanned >= 10_000 {
            truncated = true;
            break;
        }
        scanned += 1;
        let diff = patch(file);
        let status = file["status"].as_str().unwrap_or_default();
        let probe_limit = TOOL_LIMIT.saturating_sub(scanned_chars);
        let probe_end = diff.floor_char_boundary(diff.len().min(probe_limit));
        let prefix = &diff[..probe_end];
        scanned_chars = scanned_chars.saturating_add(prefix.len());
        let has_diff = prefix.chars().any(|c| !c.is_whitespace()) || probe_end < diff.len();
        let has_explicit_op = matches!(status, "added" | "deleted" | "renamed");
        if has_diff || has_explicit_op || matches_diagnostic_path(file, &diagnostics) {
            selected.push((index, file));
        }
    }
    let search_active = query.is_some_and(|q| q.active);
    let mut remaining = super::super::document::search_limit_for(s, key, query);
    let mut rendered = 0;
    let mut view = col().full_width().separate(Space::Sm);
    for (display_idx, (index, file)) in selected.into_iter().enumerate() {
        let patch = patch(file);
        let path = string(file, &["relativePath", "filePath", "file", "path"]);
        let key = format!("{key}-patch-{index}");
        let label = label(s, file, display_idx);
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
                            screen::action_tx(&s.input_scope, move |s, tx| {
                                s.transcript_display.children.cancel_copy();
                                if let Some(file) = files(&snapshot).get(index) {
                                    tx.copy(self::patch(file));
                                }
                            }),
                        )
                        .key(format!("{key}-copy-patch")),
                    ),
                )
                .child(markdown::tool_pane(
                    window(s, key.clone(), &[patch], remaining, |shown, units| {
                        markdown::search_code(shown, "diff", units <= TOOL_LIMIT, true, query)
                    }),
                    true,
                ))
        };
        let body = if !search_active
            && complete
            && !message.starts_with("child:")
            && tool_diff::structured_candidate(patch)
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

fn label(s: &State, file: &Value, index: usize) -> String {
    let (status, target) = file_change(Some(s), file, true);
    let label = if target.is_empty() {
        catalogue::format(
            locale(),
            "toolCall.applyPatch.fileFallback",
            &[("number", &(index + 1).to_string())],
        )
    } else {
        target
    };
    let label_key = match status {
        "added" => "toolCall.applyPatch.added",
        "deleted" => "toolCall.applyPatch.deleted",
        "modified" => "toolCall.applyPatch.modified",
        "renamed" => "toolCall.applyPatch.renamed",
        _ => "toolCall.diff.label.withPath",
    };
    catalogue::format(locale(), label_key, &[("path", &label)])
}
