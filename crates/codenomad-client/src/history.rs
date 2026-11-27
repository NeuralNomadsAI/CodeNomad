use crate::Message;
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};
pub type Row = Arc<Message>;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
pub const MAX_ROWS: usize = 2048;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MESSAGE_BYTES: usize = 16 * 1024 * 1024;
pub const WINDOW_BYTES: usize = 24 * 1024 * 1024;
pub(crate) const MAX_TOOL_TEXT_BYTES: usize = 32 * 1024 * 1024;
const MAX_SHELL_BODY_BYTES: usize = 32 * 1024;

fn truncate_utf8(text: &str, max_bytes: usize) -> &str {
    if text.len() <= max_bytes {
        return text;
    }
    let mut end = max_bytes;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

#[derive(Clone, Debug)]
pub struct Page {
    pub rows: Vec<Row>,
    pub older: Option<Value>,
    pub newer: Option<Value>,
    pub running: bool,
    pub user_file_references: bool,
}

pub fn retained_bytes(rows: &[Row]) -> usize {
    rows.iter().fold(0usize, |total, row| {
        total.saturating_add(
            size_of::<Message>()
                + row.id.len()
                + row.role.len()
                + row.body.len()
                + crate::content::bytes(&row.parts)
                + crate::content::tool_text_bytes(&row.parts)
                + crate::content::media_bytes(&row.parts),
        )
    })
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
}
pub fn decode_message(v: &Value) -> Result<Message> {
    let id = v["id"]
        .as_str()
        .filter(|id| valid_id(id))
        .ok_or("invalid message id")?;
    let role = v["type"].as_str().ok_or("missing message type")?;
    let parts = crate::content::decode(v)?;
    let body = match role {
        "user" => v["text"].as_str().ok_or("invalid native user text")?.into(),
        "system" => v["text"].as_str().unwrap_or_default().into(),
        "compaction" => v["summary"]
            .as_str()
            .or_else(|| v["error"]["message"].as_str())
            .unwrap_or_default()
            .into(),
        "shell" => {
            let command = v["command"].as_str().unwrap_or_default();
            let output = v["output"]["output"]
                .as_str()
                .or_else(|| v["output"].as_str())
                .unwrap_or_default();
            let mut body = match (command.is_empty(), output.is_empty()) {
                (false, false) => {
                    let cmd_limit = MAX_SHELL_BODY_BYTES.saturating_sub(3);
                    let prefix = format!("$ {}\n", truncate_utf8(command, cmd_limit));
                    let remaining = MAX_SHELL_BODY_BYTES.saturating_sub(prefix.len());
                    format!("{prefix}{}", truncate_utf8(output, remaining))
                }
                (true, false) => truncate_utf8(output, MAX_SHELL_BODY_BYTES).into(),
                (false, true) => truncate_utf8(command, MAX_SHELL_BODY_BYTES).into(),
                (true, true) => String::new(),
            };
            body.shrink_to_fit();
            body
        }
        _ => crate::content::text_body(&parts),
    };
    Ok(Message {
        id: id.into(),
        role: role.into(),
        completed: role == "user"
            || !v["time"]["completed"].is_null()
            || (role == "shell" && v["status"].as_str().is_some_and(|s| s != "running")),
        body,
        usage: (role == "assistant")
            .then(|| crate::content::Usage::decode(v))
            .flatten(),
        parts,
    })
}
fn cursor_fits(v: &Value) -> bool {
    struct Cap(usize);
    impl std::io::Write for Cap {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0 = self
                .0
                .checked_sub(buf.len())
                .ok_or(std::io::ErrorKind::FileTooLarge)?;
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Cap(4096), v).is_ok()
}

pub(crate) fn cursor(v: &Value, kind: &str) -> Result<Option<Value>> {
    if v.is_null() {
        return Ok(None);
    }
    if v["kind"] != kind || !v["messageID"].as_str().is_some_and(valid_id) || !cursor_fits(v) {
        return Err("invalid history cursor".into());
    }
    Ok(Some(v.clone()))
}
#[derive(Debug)]
pub(crate) struct AnchorMissing;
impl std::fmt::Display for AnchorMissing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("history anchor missing")
    }
}
impl std::error::Error for AnchorMissing {}

pub fn decode(v: Value) -> Result<Page> {
    decode_target(v, &Value::Null)
}

pub(crate) fn decode_target(v: Value, target: &Value) -> Result<Page> {
    if v["status"] == "blocked" && v["reason"] == "anchor_missing" {
        return Err(AnchorMissing.into());
    }
    if v["status"] != "window" {
        return Err("history unavailable or anchor changed".into());
    }
    let mut v = v;
    let native = v["messages"]
        .as_array_mut()
        .filter(|rows| rows.len() <= 200)
        .ok_or("invalid history window")?;
    let mut window_bytes = 0;
    for row in native.iter_mut() {
        let bytes = stored_size(row)?;
        window_bytes += bytes;
        if bytes > MESSAGE_BYTES || window_bytes > WINDOW_BYTES {
            return Err("native history window exceeds its bound".into());
        }
    }
    let mut rows = native
        .iter()
        .map(|value| decode_message(value).map(Arc::new))
        .collect::<Result<Vec<_>>>()?;
    check(&rows)?;
    let mut running = false;
    for row in native {
        if row["type"] == "assistant" {
            running = row["time"].get("completed").is_none();
        }
        if row["type"] == "idle" {
            running = false;
        }
    }
    let mut newer = cursor(&v["newer"], "after")?;
    if v["latest"].as_bool() != Some(newer.is_none()) {
        return Err("inconsistent latest marker".into());
    }
    let mut older = cursor(&v["older"], "before")?;
    // The wire window has a fixed size. Keep a smaller contiguous reader window
    // around the requested row; a single large native row must remain readable.
    if !rows.is_empty() {
        let anchor = target["messageID"]
            .as_str()
            .and_then(|id| rows.iter().position(|row| row.id == id))
            .unwrap_or_else(|| match target["kind"].as_str() {
                Some("oldest" | "after") => 0,
                _ => rows.len() - 1,
            });
        let bias_older = !matches!(target["kind"].as_str(), Some("oldest" | "after"));
        let (start, end) = reasoning_window(&rows, anchor, bias_older, &target["kind"]);
        if end < rows.len() {
            newer = Some(serde_json::json!({"kind":"after","messageID":rows[end - 1].id}));
        }
        if start > 0 {
            older = Some(serde_json::json!({"kind":"before","messageID":rows[start].id}));
        }
        rows.truncate(end);
        rows.drain(..start);
    }
    Ok(Page {
        rows,
        older,
        newer,
        running,
        user_file_references: v["userFiles"] == crate::attachments::USER_FILES_REFERENCE,
    })
}

fn reasoning_window(rows: &[Row], anchor: usize, bias_older: bool, kind: &Value) -> (usize, usize) {
    let (mut start, mut end) = (anchor, anchor + 1);
    // A continuation retains its overlap anchor and makes progress.
    start -= usize::from(kind == "before" && start > 0);
    end += usize::from(kind == "after" && end < rows.len());
    let mut left = MAX_BYTES.saturating_sub(reasoning_bytes(&rows[start..end]));
    loop {
        let previous = (start, end);
        for take_older in [bias_older, !bias_older] {
            let index = if take_older {
                start.checked_sub(1)
            } else {
                (end < rows.len()).then_some(end)
            };
            if let Some(index) = index {
                let weight = crate::content::reasoning_bytes(&rows[index].parts);
                if weight <= left {
                    left -= weight;
                    if take_older {
                        start -= 1;
                    } else {
                        end += 1;
                    }
                }
            }
        }
        if previous == (start, end) {
            return previous;
        }
    }
}

#[derive(Debug)]
pub(crate) struct ReasoningLimit;
impl std::fmt::Display for ReasoningLimit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("resident reasoning exceeds its bound")
    }
}
impl std::error::Error for ReasoningLimit {}

fn reasoning_bytes(rows: &[Row]) -> usize {
    rows.iter()
        .map(|row| crate::content::reasoning_bytes(&row.parts))
        .sum()
}
fn stored_size(row: &mut Value) -> Result<usize> {
    struct Count(usize);
    impl std::io::Write for Count {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let fields = row.as_object_mut().ok_or("invalid native history row")?;
    // Source counts the stored projection before adding the database row's identity.
    let id = fields.remove("id");
    let kind = fields.remove("type");
    let mut count = Count(0);
    serde_json::to_writer(&mut count, fields)?;
    fields.extend(id.map(|id| ("id".into(), id)));
    fields.extend(kind.map(|kind| ("type".into(), kind)));
    Ok(count.0)
}
pub fn check(rows: &[Row]) -> Result<()> {
    let mut ids = HashSet::new();
    if rows.len() > MAX_ROWS
        || rows
            .iter()
            .map(|r| {
                r.body.len() + crate::content::bytes(&r.parts)
                    - crate::content::attachment_bytes(&r.parts)
                    - crate::content::reasoning_bytes(&r.parts)
            })
            .sum::<usize>()
            > MAX_BYTES
    {
        return Err("resident history limit reached".into());
    }
    if reasoning_bytes(rows) > WINDOW_BYTES {
        return Err(ReasoningLimit.into());
    }
    if rows
        .iter()
        .map(|r| crate::content::attachment_bytes(&r.parts))
        .sum::<usize>()
        > WINDOW_BYTES
    {
        return Err("resident attachments exceed their bound".into());
    }
    if rows
        .iter()
        .map(|row| crate::content::media_bytes(&row.parts))
        .sum::<usize>()
        > WINDOW_BYTES
    {
        return Err("resident image references exceed their bound".into());
    }
    if rows
        .iter()
        .map(|row| crate::content::tool_text_bytes(&row.parts))
        .sum::<usize>()
        > MAX_TOOL_TEXT_BYTES
    {
        return Err("resident tool text limit reached".into());
    }
    if rows.iter().any(|row| !ids.insert(&row.id)) {
        return Err("duplicate native row".into());
    }
    Ok(())
}
/// The server's ordered overlap is the continuity proof; IDs never determine ordering.
pub fn join(left: &[Row], right: &[Row]) -> Result<Vec<Row>> {
    if left.is_empty() {
        check(right)?;
        return Ok(right.to_vec());
    }
    if right.is_empty() {
        check(left)?;
        return Ok(left.to_vec());
    }
    let overlap = overlap(left, right)?;
    let mut rows = left[..left.len() - overlap].to_vec();
    rows.extend_from_slice(right);
    check(&rows)?;
    Ok(rows)
}

fn overlap(left: &[Row], right: &[Row]) -> Result<usize> {
    (1..=left.len().min(right.len()))
        .rev()
        .find(|&n| {
            left[left.len() - n..]
                .iter()
                .zip(&right[..n])
                .all(|(a, b)| a.id == b.id)
        })
        .ok_or_else(|| "history windows lost their overlap".into())
}

pub(crate) fn edge_page(
    page: &Page,
    shown: &[Row],
    edge: crate::transport::HistoryEdge,
) -> Result<()> {
    use crate::transport::HistoryEdge;
    check(&page.rows)?;
    if edge == HistoryEdge::Oldest {
        return if page.older.is_none() {
            Ok(())
        } else {
            Err("oldest history has an older cursor".into())
        };
    }
    let anchor = if edge == HistoryEdge::Before {
        shown.first()
    } else {
        shown.last()
    };
    if !shown.is_empty()
        && !page.rows.is_empty()
        && !page
            .rows
            .iter()
            .any(|row| anchor.is_some_and(|anchor| anchor.id == row.id))
    {
        return Err("history windows lost their overlap".into());
    }
    Ok(())
}

/// True when every row present in both snapshots keeps the same relative order.
pub fn order_consistent(left: &[Row], right: &[Row]) -> bool {
    let mut positions = std::collections::HashMap::with_capacity(left.len());
    for (index, row) in left.iter().enumerate() {
        positions.insert(row.id.as_str(), index);
    }
    let mut previous = None;
    for row in right {
        if let Some(&index) = positions.get(row.id.as_str()) {
            if previous.is_some_and(|prior| index <= prior) {
                return false;
            }
            previous = Some(index);
        }
    }
    true
}

#[cfg(test)]
#[test]
fn reasoning_heavy_windows_keep_the_tail_and_restore_the_requested_anchor() {
    use serde_json::json;
    let text = "R".repeat(90 * 1024);
    let rows: Vec<_> = (0..100)
        .map(|i| {
            json!({
                "id":format!("step-{i}"), "type":"assistant", "time":{"completed":i},
                "content":[{"type":"reasoning","text":text},{"type":"text","text":"Reply"}]
            })
        })
        .collect();
    let payload = json!({"status":"window","latest":true,"messages":rows});
    let latest = decode_target(payload.clone(), &json!({"kind":"latest"})).unwrap();
    assert_eq!(latest.rows.last().unwrap().id, "step-99");
    assert!(latest.older.is_some() && latest.newer.is_none());
    assert!(reasoning_bytes(&latest.rows) <= MAX_BYTES && latest.rows.len() < 100);
    let anchored = decode_target(payload, &json!({"kind":"around","messageID":"step-50"})).unwrap();
    let saved = anchored
        .rows
        .iter()
        .find(|row| row.id == "step-50")
        .unwrap();
    assert!(matches!(&saved.parts[0], crate::content::Part::Reasoning(part) if part.text == text));
    assert!(anchored.older.is_some() && anchored.newer.is_some());
    assert!(reasoning_bytes(&anchored.rows) <= MAX_BYTES);
}
