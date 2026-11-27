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
    let (status, target) = file_change(s, file, false);
    if let Some(code) = operation_code(status)
        && !target.is_empty()
    {
        if diff.is_empty() {
            format!("{code} {target}")
        } else {
            format!("{code} {target}\n{diff}")
        }
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

pub(super) fn copy_all(s: Option<&State>, tool: &Tool) -> Option<String> {
    let source = files(tool)
        .iter()
        .map(|file| file_copy_text(s, file))
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
    let mut diag_paths: Vec<(&String, String)> = Vec::new();
    let mut diag_paths_truncated = false;
    if let Some(map) = tool.metadata["diagnostics"].as_object() {
        let mut probe_keys = 0usize;
        let mut probe_entries = 0usize;
        for (path, value) in map {
            probe_keys += 1;
            if diag_paths.len() >= FILE_LIMIT || probe_keys > 10_000 || probe_entries >= 10_000 {
                diag_paths_truncated = true;
                break;
            }
            if path.len() > 4096 {
                continue;
            }
            let Some(entries) = value.as_array() else {
                continue;
            };
            let mut has_message = false;
            for entry in entries {
                if probe_entries >= 10_000 {
                    diag_paths_truncated = true;
                    break;
                }
                probe_entries += 1;
                if entry["message"].is_string() {
                    has_message = true;
                    break;
                }
            }
            if has_message {
                diag_paths.push((path, path.replace('\\', "/")));
            }
        }
    }
    let diagnostics: Vec<String> = diag_paths.iter().map(|(_, norm)| norm.clone()).collect();
    let mut selected: Vec<(Option<usize>, Option<&Value>, Option<&str>)> = Vec::new();
    let mut known_paths: Vec<String> = Vec::new();
    let mut scanned = 0usize;
    let mut scanned_chars = 0usize;
    let mut truncated = diag_paths_truncated;
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
            for field in ["relativePath", "filePath", "file", "path"] {
                let p = string(file, &[field]);
                if !p.is_empty() {
                    known_paths.push(p.replace('\\', "/"));
                }
            }
            selected.push((Some(index), Some(file), None));
        }
    }
    for (raw, norm) in &diag_paths {
        if selected.len() >= FILE_LIMIT {
            truncated = true;
            break;
        }
        let already = known_paths.iter().any(|known| {
            known == norm
                || known.ends_with(&format!("/{norm}"))
                || norm.ends_with(&format!("/{known}"))
        });
        if !already {
            known_paths.push(norm.clone());
            selected.push((None, None, Some(raw.as_str())));
        }
    }
    let search_active = query.is_some_and(|q| q.active);
    let mut remaining = super::super::document::search_limit_for(s, key, query);
    let mut diag_remaining = 100usize;
    let mut diag_scanned = 0usize;
    let mut diag_matched_keys: Vec<String> = Vec::new();
    let mut rendered = 0;
    let mut view = col().full_width().separate(Space::Sm);
    for (display_idx, (index_opt, file_opt, synth_path)) in selected.into_iter().enumerate() {
        let patch = file_opt.map_or("", patch);
        let path = file_opt
            .map(|f| string(f, &["relativePath", "filePath", "file", "path"]))
            .or(synth_path)
            .unwrap_or_default();
        let rel_path = file_opt.map_or("", |f| string(f, &["relativePath"]));
        let file_path = file_opt.map_or("", |f| string(f, &["filePath", "file", "path"]));
        let card_key = match index_opt {
            Some(index) => format!("{key}-patch-{index}"),
            None => format!("{key}-diag-file-{display_idx}"),
        };
        let label = match file_opt {
            Some(file) => label(s, file, display_idx),
            None => {
                let normalized = super::super::links::native_file(s, path)
                    .unwrap_or_else(|| path.replace('\\', "/"));
                let short: String = normalized.chars().take(250).collect();
                catalogue::format(
                    locale(),
                    "toolCall.diff.label.withPath",
                    &[("path", &short)],
                )
            }
        };
        let heading = if super::super::links::native_file(s, path).is_some() {
            let path = path.to_owned();
            layout::button(
                &label,
                false,
                screen::action(&s.input_scope, move |s| {
                    super::super::links::open_native(s, &path);
                }),
            )
            .key(format!("{card_key}-file"))
        } else {
            text(label).wrap()
        };
        let mut card = col()
            .key(card_key.clone())
            .full_width()
            .separate(Space::Sm)
            .child(heading);
        rendered += 1;
        let inline_diag = super::diagnostics::inline_for_file(
            s,
            &card_key,
            tool,
            &[file_path, rel_path, path],
            &mut diag_remaining,
            &mut diag_scanned,
            &mut diag_matched_keys,
        );
        if patch.is_empty() || remaining == 0 {
            truncated |= !patch.is_empty();
            if let Some(diag) = inline_diag {
                card = card.child(diag);
            }
            view = view.child(card);
            continue;
        }
        let Some(index) = index_opt else {
            if let Some(diag) = inline_diag {
                card = card.child(diag);
            }
            view = view.child(card);
            continue;
        };
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
                        .key(format!("{card_key}-copy-patch")),
                    ),
                )
                .child(
                    markdown::tool_pane(
                        window(s, card_key.clone(), &[patch], remaining, |shown, units| {
                            markdown::search_code(shown, "diff", units <= TOOL_LIMIT, true, query)
                        }),
                        true,
                    )
                    .data(crate::chat::reading::InnerScrollRegion),
                )
        };
        let body = if !search_active
            && complete
            && !message.starts_with("child:")
            && tool_diff::structured_candidate(patch)
        {
            tool_diff::body(s, message, &card_key, tool, patch, path, fallback)
        } else {
            fallback()
        };
        card = card.child(body);
        if let Some(diag) = inline_diag {
            card = card.child(diag);
        }
        view = view.child(card);
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

#[cfg(test)]
#[test]
fn multi_file_copy_preserves_operations_and_inline_diagnostics_include_unmodified_files() {
    use rune::{Env, Runtime};
    use serde_json::json;
    let rename_patch = "--- src/example.ts\n+++ right/shared.ts\n@@ -1 +1 @@\n-old\n+new\n";
    let mod_patch = "--- left/shared.ts\n+++ left/shared.ts\n@@ -1 +1 @@\n-a\n+b\n";
    let row = crate::history::decode_message(&json!({
        "id":"change","type":"assistant","time":{"completed":1},
        "content":[{"type":"tool","name":"apply_patch","id":"patch","state":{
            "status":"completed",
            "metadata":{
                "files":[
                    {"file":"right/shared.ts","patch":rename_patch,"status":"modified"},
                    {"file":"left/shared.ts","patch":mod_patch,"status":"modified"}
                ],
                "diagnostics":{
                    "src/unmodified.ts":[{"severity":1,"message":"unused import","range":{"start":{"line":4,"character":2}}}]
                }
            }
        }}]
    }))
    .unwrap();
    let mut s = crate::init();
    s.phase = crate::Phase::Ready;
    s.messages.push(row.into());
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
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    for _ in 0..10 {
        rt.frame(0.02);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(tree.contains("src/unmodified.ts") && tree.contains("unused import"));
    let (x, y) = rt.find("copy-tool-change:5:patch-output").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    assert_eq!(
        clipboard.text().unwrap().as_str(),
        format!(
            "R src/example.ts → right/shared.ts\n{rename_patch}\nM left/shared.ts\n{mod_patch}"
        )
        .as_str()
    );
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
