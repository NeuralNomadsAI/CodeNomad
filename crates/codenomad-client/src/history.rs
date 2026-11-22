use crate::Message;
use serde_json::Value;
use std::collections::HashSet;
pub type Error = Box<dyn std::error::Error + Send + Sync>;
pub type Result<T> = std::result::Result<T, Error>;
pub const MAX_ROWS: usize = 2048;
pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub const MESSAGE_BYTES: usize = 16 * 1024 * 1024;
pub const WINDOW_BYTES: usize = 24 * 1024 * 1024;
pub(crate) const RESPONSE_BYTES: usize = WINDOW_BYTES + 64 * 1024;

#[derive(Clone, Debug)]
pub struct Page {
    pub rows: Vec<Message>,
    pub older: Option<Value>,
    pub newer: Option<Value>,
    pub running: bool,
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
    let body = if role == "user" {
        v["text"].as_str().ok_or("invalid native user text")?.into()
    } else {
        crate::content::text_body(&parts)
    };
    Ok(Message {
        id: id.into(),
        role: role.into(),
        completed: role == "user" || !v["time"]["completed"].is_null(),
        body,
        parts,
    })
}
fn cursor(v: &Value, kind: &str) -> Result<Option<Value>> {
    if v.is_null() {
        return Ok(None);
    }
    if v["kind"] != kind || !v["messageID"].as_str().is_some_and(valid_id) {
        return Err("invalid history cursor".into());
    }
    Ok(Some(v.clone()))
}
pub fn decode(v: Value) -> Result<Page> {
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
    let rows = native
        .iter()
        .map(decode_message)
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
    let newer = cursor(&v["newer"], "after")?;
    if v["latest"].as_bool() != Some(newer.is_none()) {
        return Err("inconsistent latest marker".into());
    }
    Ok(Page {
        rows,
        older: cursor(&v["older"], "before")?,
        newer,
        running,
    })
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
pub fn check(rows: &[Message]) -> Result<()> {
    let mut ids = HashSet::new();
    if rows.len() > MAX_ROWS
        || rows
            .iter()
            .map(|r| {
                r.body.len() + crate::content::bytes(&r.parts)
                    - crate::content::attachment_bytes(&r.parts)
            })
            .sum::<usize>()
            > MAX_BYTES
    {
        return Err("resident history limit reached".into());
    }
    if rows
        .iter()
        .map(|r| crate::content::attachment_bytes(&r.parts))
        .sum::<usize>()
        > WINDOW_BYTES
    {
        return Err("resident attachments exceed their bound".into());
    }
    if rows.iter().any(|row| !ids.insert(&row.id)) {
        return Err("duplicate native row".into());
    }
    Ok(())
}
/// The server's ordered overlap is the continuity proof; IDs never determine ordering.
pub fn join(left: &[Message], right: &[Message]) -> Result<Vec<Message>> {
    if left.is_empty() {
        check(right)?;
        return Ok(right.to_vec());
    }
    if right.is_empty() {
        check(left)?;
        return Ok(left.to_vec());
    }
    let overlap = (1..=left.len().min(right.len()))
        .rev()
        .find(|&n| {
            left[left.len() - n..]
                .iter()
                .zip(&right[..n])
                .all(|(a, b)| a.id == b.id)
        })
        .ok_or("history windows lost their overlap")?;
    let mut rows = left[..left.len() - overlap].to_vec();
    rows.extend_from_slice(right);
    check(&rows)?;
    Ok(rows)
}

pub(crate) fn previous_page(page: &Page, shown: &[Message]) -> Result<()> {
    check(&page.rows)?;
    if !shown.is_empty()
        && !page.rows.is_empty()
        && !page
            .rows
            .iter()
            .any(|row| shown.first().is_some_and(|first| first.id == row.id))
    {
        return Err("history windows lost their overlap".into());
    }
    Ok(())
}
