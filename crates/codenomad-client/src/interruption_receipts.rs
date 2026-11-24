//! Bounded, read-only transcript annotations owned by the CodeNomad backend.
use crate::{
    backend::{Backend, read_json_limited},
    history::{Result, valid_id},
};
use serde::Deserialize;
use std::collections::HashSet;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub request_id: String,
    session_id: String,
    pub action: Option<String>,
    pub resources: Vec<String>,
    pub request_message: Option<String>,
    source: Option<Source>,
    pub decision: Decision,
    pub origin: Origin,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Source {
    message_id: String,
    call_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Once,
    Always,
    Reject,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Codenomad,
    Yolo,
    Native,
}

#[derive(Debug, Deserialize)]
pub struct ReceiptPage {
    pub receipts: Vec<Receipt>,
    pub next: Option<String>,
}

fn short(value: &str, max: usize) -> bool {
    value.len() <= 4 * max && value.encode_utf16().take(max + 1).count() <= max
}

fn cursor(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
}

fn decode(value: serde_json::Value, session: &str, message: Option<&str>) -> Result<ReceiptPage> {
    let mut page: ReceiptPage = serde_json::from_value(value)?;
    if page.receipts.len() > 16 || page.next.as_deref().is_some_and(|v| !cursor(v)) {
        return Err("invalid permission receipt page".into());
    }
    let mut seen = HashSet::new();
    page.receipts.retain(|r| {
        r.session_id == session
            && r.source.as_ref().map(|s| s.message_id.as_str()) == message
            && valid_id(&r.request_id)
            && r.source.as_ref().is_none_or(|s| short(&s.call_id, 512))
            && [
                r.action.as_ref(),
                r.request_message.as_ref(),
                r.reason.as_ref(),
            ]
            .into_iter()
            .flatten()
            .all(|v| short(v, 4096))
            && r.resources.len() <= 64
            && r.resources.iter().all(|v| short(v, 4096))
            && seen.insert(r.request_id.clone())
    });
    Ok(page)
}

impl Backend {
    pub async fn permission_receipts(
        &self,
        message: Option<&str>,
        next: Option<&str>,
    ) -> Result<ReceiptPage> {
        if !valid_id(&self.workspace)
            || !valid_id(&self.session)
            || message.is_some_and(|id| !valid_id(id))
            || next.is_some_and(|v| !cursor(v))
        {
            return Err("invalid permission receipt scope".into());
        }
        let mut request = self
            .client
            .get(format!(
                "{}api/workspaces/{}/sessions/{}/permission-receipts",
                self.base, self.workspace, self.session,
            ))
            .query(&[("limit", "16")]);
        request = if let Some(id) = message {
            request.query(&[("messageId", id)])
        } else {
            request.query(&[("unanchored", "true")])
        };
        if let Some(next) = next {
            request = request.query(&[("cursor", next)]);
        }
        let response = request.send().await?.error_for_status()?;
        let page = decode(
            read_json_limited(response, 6 << 20).await?,
            &self.session,
            message,
        )?;
        if page.next.as_deref() == next && next.is_some() {
            return Err("permission receipt cursor did not advance".into());
        }
        Ok(page)
    }
}

#[cfg(test)]
#[test]
fn page_keeps_exact_scope_and_an_empty_page_can_continue() {
    use serde_json::json;
    let make = |request, session, source| {
        json!({
            "requestId":request, "sessionId":session, "source":source, "resources":[],
            "decision":"once","origin":"codenomad","reason":"Approved once"
        })
    };
    let source = |id| json!({"messageId":id,"callId":"call"});
    let entries = json!({"receipts":[make("one","ses_ours",source("m")),
        make("two","ses_other",source("m")),make("three","ses_ours",source("later")),
        make("four","ses_ours",serde_json::Value::Null)],"next":"abc.json"});
    let page = decode(entries.clone(), "ses_ours", Some("m")).unwrap();
    assert_eq!(page.receipts.len(), 1);
    assert_eq!(page.receipts[0].request_id, "one");
    assert_eq!(
        decode(entries.clone(), "ses_ours", None).unwrap().receipts[0].request_id,
        "four"
    );
    let empty = decode(entries, "ses_ours", Some("other")).unwrap();
    assert!(empty.receipts.is_empty() && empty.next.as_deref() == Some("abc.json"));
}
