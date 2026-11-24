use super::{
    DetailRead, DirectoryChanged, LifecycleAction, MapHeader, Window,
    directory::{PageRead, Source, panel_id},
};
use crate::{backend::Backend, history::Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ControlPart {
    Receipts,
    Pending,
}

pub struct ControlPage {
    pub window: Window,
    pub rows: Vec<ControlRow>,
}

pub struct ControlRow {
    pub session: String,
    pub known: bool,
    pub receipt: Option<ReceiptContent>,
}

pub struct ReceiptContent {
    pub id: String,
    pub json: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    #[serde(rename = "receiptID")]
    receipt_id: String,
    #[serde(rename = "sessionID")]
    session_id: String,
    acknowledgement_state: String,
    native_acknowledgement: Option<Value>,
}

impl Backend {
    pub fn mission_control_page(
        &self,
        header: &MapHeader,
        part: ControlPart,
        offset: u64,
        order: Option<&str>,
    ) -> Result<DetailRead<ControlPage>> {
        let control = header.control.as_ref().ok_or("missing Mission control")?;
        let (name, total) = match part {
            ControlPart::Receipts => ("receipts", control.receipts),
            ControlPart::Pending => ("pending", control.pending),
        };
        let revision = header.root.revision;
        let target = header.lifecycle_target();
        let operation = control.id.clone();
        let action = control.action;
        let read = PageRead::new(
            self,
            Some(&target.project),
            Source::Mission,
            Some(&target.mission),
            offset,
            order,
            false,
            json!({"source":"mission","missionID":target.mission,"field":"control","part":name}),
        )?;
        Ok(DetailRead {
            read,
            decode: Box::new(move |page| {
                if page.revision != Some(revision) {
                    return Err(DirectoryChanged.into());
                }
                let window = page.window.ok_or("missing control window")?;
                if window.total != total {
                    return Err("invalid control count".into());
                }
                let mut seen = HashSet::new();
                let mut receipt_ids = HashSet::new();
                let mut rows = Vec::new();
                for text in page.rows {
                    let (session, known, receipt) = match part {
                        ControlPart::Pending => (serde_json::from_str(&text)?, false, None),
                        ControlPart::Receipts => {
                            let receipt: Receipt = serde_json::from_str(&text)?;
                            let known = match (
                                receipt.acknowledgement_state.as_str(),
                                receipt.native_acknowledgement,
                            ) {
                                ("unknown", None) => false,
                                ("known", Some(ack))
                                    if ack["missionID"] == target.mission
                                        && ack["operationID"] == operation
                                        && ack["sessionID"] == receipt.session_id
                                        && serde_json::from_value::<LifecycleAction>(
                                            ack["action"].clone(),
                                        )
                                        .ok()
                                            == Some(action) =>
                                {
                                    true
                                }
                                _ => return Err("invalid Mission control receipt".into()),
                            };
                            if !panel_id(&receipt.receipt_id)
                                || !receipt_ids.insert(receipt.receipt_id.clone())
                            {
                                return Err("invalid Mission receipt ID".into());
                            }
                            (
                                receipt.session_id,
                                known,
                                Some(ReceiptContent {
                                    id: receipt.receipt_id,
                                    json: text,
                                }),
                            )
                        }
                    };
                    if !panel_id(&session) || !seen.insert(session.clone()) {
                        return Err("invalid Mission control session".into());
                    }
                    rows.push(ControlRow {
                        session,
                        known,
                        receipt,
                    });
                }
                Ok(ControlPage { window, rows })
            }),
        })
    }
}

#[cfg(test)]
#[test]
fn receipt_read_preserves_nested_native_evidence_exactly() {
    use super::codec::digest;
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "workspace".into();
    let header = serde_json::from_value(json!({
        "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
            "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
            "revision":8,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
        "collections":{},"tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
            "pins":[],"reportPins":[],"version":""},
        "control":{"id":"operation","requestID":"request","action":"pause","expectedRevision":7,
            "pending":0,"receipts":1,"unconfirmedReceipts":0,"partialDescendants":1}
    })).unwrap();
    let evidence = r#"{"receiptID":"receipt","sessionID":"actor","acknowledgementState":"known","nativeAcknowledgement":{"missionID":"mission","operationID":"operation","sessionID":"actor","action":"pause","disposition":"interrupt-observed","descendants":{"complete":false,"unconfirmed":1,"sessions":["child-🦀"]}}}"#;
    let digest = digest(&[evidence.into()]);
    let envelope = json!({"available":true,"version":1,"projectID":"project","source":"mission","missionID":"mission",
        "revision":8,"field":"control","part":"receipts","discardedEvents":0,"controlUnavailable":false,
        "notificationUnavailable":false,"cleanupUnavailable":false,"window":{"order":digest,"offset":0,"end":1,"total":1},
        "page":{"digest":digest,"total":1,"pieces":[{"index":0,"offset":0,"characters":evidence.encode_utf16().count(),"text":evidence}]}});
    let mut read = backend
        .mission_control_page(&header, ControlPart::Receipts, 0, None)
        .unwrap();
    let page = read.accept(envelope.clone()).unwrap().unwrap();
    assert!(page.rows[0].known);
    assert_eq!(page.rows[0].receipt.as_ref().unwrap().json, evidence);
    let mut modified = envelope;
    modified["page"]["pieces"][0]["text"] = json!(evidence.replace("child-", "wrong-"));
    let mut read = backend
        .mission_control_page(&header, ControlPart::Receipts, 0, None)
        .unwrap();
    assert!(read.accept(modified).is_err());
}

#[cfg(test)]
#[test]
fn receipt_read_rejects_duplicate_receipt_ids() {
    use super::codec::digest;
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = "workspace".into();
    let header = serde_json::from_value(json!({
        "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
            "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
            "revision":8,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
        "collections":{},"tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
            "pins":[],"reportPins":[],"version":""},
        "control":{"id":"operation","requestID":"request","action":"pause","expectedRevision":7,
            "pending":0,"receipts":2,"unconfirmedReceipts":2,"partialDescendants":0}
    })).unwrap();
    let first = r#"{"receiptID":"dup","sessionID":"actor-a","acknowledgementState":"unknown"}"#;
    let second = r#"{"receiptID":"dup","sessionID":"actor-b","acknowledgementState":"unknown"}"#;
    let digest = digest(&[first.into(), second.into()]);
    let envelope = json!({"available":true,"version":1,"projectID":"project","source":"mission","missionID":"mission",
    "revision":8,"field":"control","part":"receipts","discardedEvents":0,"controlUnavailable":false,
    "notificationUnavailable":false,"cleanupUnavailable":false,"window":{"order":digest,"offset":0,"end":2,"total":2},
    "page":{"digest":digest,"total":2,"pieces":[
        {"index":0,"offset":0,"characters":first.encode_utf16().count(),"text":first},
        {"index":1,"offset":0,"characters":second.encode_utf16().count(),"text":second}
    ]}});
    let mut read = backend
        .mission_control_page(&header, ControlPart::Receipts, 0, None)
        .unwrap();
    assert!(read.accept(envelope).is_err());
}
