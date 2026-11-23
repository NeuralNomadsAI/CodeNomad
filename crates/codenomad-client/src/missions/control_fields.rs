use super::{
    DetailRead, DirectoryChanged, LifecycleAction, MapHeader, Window,
    directory::{PageRead, Source, panel_id},
};
use crate::{backend::Backend, history::Result};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashSet;

#[derive(Clone, Copy, Eq, PartialEq)]
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
                let mut rows = Vec::new();
                for text in page.rows {
                    let (session, known) = match part {
                        ControlPart::Pending => (serde_json::from_str(&text)?, false),
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
                            if !panel_id(&receipt.receipt_id) {
                                return Err("invalid Mission receipt ID".into());
                            }
                            (receipt.session_id, known)
                        }
                    };
                    if !panel_id(&session) || !seen.insert(session.clone()) {
                        return Err("invalid Mission control session".into());
                    }
                    rows.push(ControlRow { session, known });
                }
                Ok(ControlPage { window, rows })
            }),
        })
    }
}
