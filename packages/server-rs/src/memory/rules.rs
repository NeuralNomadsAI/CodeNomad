//! `memory/rules.ts`: duplicate replacement, capacity and the review flag.

use super::model::{Code, Content, Entry, MemoryError, Result, Scope, fail};
use super::text;

pub fn flagged(e: &Entry) -> bool {
    text::suspicious(&e.title) || text::suspicious(&e.text)
}
pub fn for_agent(entries: &[Entry]) -> Vec<Entry> {
    entries.iter().filter(|e| !flagged(e)).cloned().collect()
}

/// JS `<` on strings: UTF-16 code unit order.
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `duplicate`: exact normalized titles win, then the best Jaccard text match ≥ 0.75.
/// Refused (`invalid`) when a text needed for the decision cannot be segmented like ICU.
fn duplicate<'a>(entries: &'a [Entry], content: &Content) -> Result<Option<&'a Entry>> {
    let mut ordered: Vec<&Entry> = entries.iter().collect();
    ordered.sort_by(|a, b| js_cmp(&a.id, &b.id));
    let title = text::normalize_title(&content.title);
    if let Some(exact) = ordered.iter().find(|e| text::normalize_title(&e.title) == title) {
        return Ok(Some(exact));
    }
    let unsupported = || fail(Code::Invalid, "Memory text cannot be compared");
    let incoming = text::words(&content.text).ok_or_else(unsupported)?;
    if incoming.len() < 4 {
        return Ok(None);
    }
    let (mut best, mut score) = (None, 0.0);
    for entry in ordered {
        let candidate = text::similarity(&incoming, &text::words(&entry.text).ok_or_else(unsupported)?);
        if candidate >= 0.75 && candidate > score {
            best = Some(entry);
            score = candidate;
        }
    }
    Ok(best)
}

/// `decideMemorySave`; `now` is `new Date().toISOString()`.
pub fn decide(
    scope: Scope,
    entries: &[Entry],
    input: &serde_json::Value,
    session: &str,
    id: Option<&str>,
    now: &str,
) -> Result<Entry> {
    let content = super::model::content(input)?;
    let found = duplicate(entries, &content)?;
    let existing = match id {
        None => found,
        Some(id) => entries.iter().find(|e| e.id == id),
    };
    if id.is_some() && existing.is_none() {
        return Err(fail(Code::Invalid, "Unknown memory entry"));
    }
    if let (Some(id), Some(m)) = (id, found)
        && m.id != id
    {
        return Err(fail(Code::Conflict, "Merge or delete the duplicate memory entry before retrying"));
    }
    if existing.is_none() && entries.len() >= scope.limit() {
        return Err(MemoryError {
            code: Code::Full,
            message: "Memory is full. Merge or delete entries before retrying.",
            titles: Some(entries.iter().map(|e| e.title.clone()).collect()),
        });
    }
    let entry = Entry {
        id: existing.map_or_else(|| uuid::Uuid::new_v4().to_string(), |e| e.id.clone()),
        title: content.title,
        kind: content.kind,
        text: content.text,
        created_at: existing.map_or_else(|| now.to_owned(), |e| e.created_at.clone()),
        updated_at: now.to_owned(),
        session_id: session.to_owned(),
    };
    super::model::validate(&entry, Code::Invalid)?;
    Ok(entry)
}
