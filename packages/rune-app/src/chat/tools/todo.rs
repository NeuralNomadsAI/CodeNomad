use super::{TOOL_LIMIT, Tool};
use crate::strings::t;
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
};
use serde_json::Value;

const ROW_LIMIT: usize = 200;
const SCAN_LIMIT: usize = 10_000;

fn items(tool: &Tool) -> &[Value] {
    tool.metadata["todos"].as_array().map_or(&[], Vec::as_slice)
}

fn status(value: &Value) -> &'static str {
    match value["status"].as_str() {
        Some("completed") => "completed",
        Some("in_progress") => "inProgress",
        Some("cancelled") => "cancelled",
        _ => "pending",
    }
}

pub(super) fn title(tool: &Tool) -> String {
    let todos = items(tool);
    t(if tool.status != "completed" || todos.is_empty() {
        "toolCall.renderer.todo.title.plan"
    } else if todos.len() <= SCAN_LIMIT && todos.iter().all(|todo| status(todo) == "pending") {
        "toolCall.renderer.todo.title.creating"
    } else if todos.len() <= SCAN_LIMIT && todos.iter().all(|todo| status(todo) == "completed") {
        "toolCall.renderer.todo.title.completing"
    } else {
        "toolCall.renderer.todo.title.updating"
    })
    .into()
}

pub(super) fn copy(tool: &Tool) -> Option<String> {
    let todos = items(tool);
    if todos.is_empty() {
        None
    } else {
        serde_json::to_string_pretty(todos).ok()
    }
}

pub(super) fn view(tool: &Tool) -> El {
    let mut body = col().role("list").full_width().separate(Space::Sm);
    let mut remaining = TOOL_LIMIT;
    let mut count = 0;
    let mut truncated = false;
    for (index, todo) in items(tool).iter().enumerate() {
        if index >= SCAN_LIMIT || count == ROW_LIMIT || remaining == 0 {
            truncated = true;
            break;
        }
        let content = todo["content"].as_str().unwrap_or_default();
        let mut left = remaining;
        let bytes = content
            .chars()
            .scan((), |_, c| {
                left = left.checked_sub(c.len_utf16())?;
                Some(c.len_utf8())
            })
            .sum();
        remaining = left;
        let visible = content[..bytes].trim();
        if !visible.is_empty() {
            body = body.child(
                layout::action_row()
                    .role("listitem")
                    .child(text(visible).wrap())
                    .child(
                        text(t(&format!(
                            "toolCall.renderer.todo.status.{}",
                            status(todo)
                        )))
                        .text_role(TextRole::Label),
                    ),
            );
            count += 1;
        }
        if bytes < content.len() {
            truncated = true;
            break;
        }
    }
    if truncated {
        body.child(text(t("toolCall.output.truncated")).role("status"))
    } else if count == 0 {
        body.child(text(t("toolCall.renderer.todo.empty")))
    } else {
        body
    }
}

#[cfg(test)]
#[test]
fn todo_statuses_and_copy_follow_the_native_list() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let todos = json!([
        {"content":"Finished sample","status":"completed"},
        {"content":"Current sample","status":"in_progress"},
        {"content":"Stopped sample","status":"cancelled"}
    ]);
    let row = history::decode_message(&json!({"id":"step","type":"assistant","time":{"completed":2},
        "content":[{"type":"tool","id":"todo","name":"todowrite","state":{"status":"completed","metadata":{"todos":todos}}}]
    })).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(row.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 760.0),
        Env::new(false, 1.0),
    );
    let clipboard = rune::clipboard::memory();
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    for key in ["toggle-tool-step:4:todo", "copy-tool-step:4:todo-output"] {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
    }
    let tree = rt.accessibility_json().to_string();
    for marker in [
        "Finished sample",
        "Current sample",
        "In progress",
        "Cancelled",
        "Updating plan",
    ] {
        assert!(tree.contains(marker), "missing {marker}");
    }
    let copied: Value = serde_json::from_str(clipboard.text().unwrap().as_str()).unwrap();
    assert_eq!(copied, todos);
}

#[cfg(test)]
#[test]
fn failed_todo_shows_the_native_reason_before_its_list() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let row = history::decode_message(
        &json!({"id":"step","type":"assistant","time":{"completed":2},
            "content":[{"type":"tool","id":"todo","name":"todowrite","state":{
            "status":"error","error":{"message":"Native plan failure"},
                "metadata":{"todos":[{"content":"Pending after failure","status":"pending"}]}}}]
        }),
    )
    .unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(row.into());
    let mut rt = Runtime::new(state, crate::view, (960.0, 760.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let (x, y) = rt.find("toggle-tool-step:4:todo").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    assert!(
        tree.find("Native plan failure").unwrap() < tree.find("Pending after failure").unwrap()
    );
}
