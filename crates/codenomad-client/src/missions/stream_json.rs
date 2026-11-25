//! Incremental streaming JSON object filter for large Mission HTTP responses.
//!
//! Skips non-selected fields (such as full task lists, histories, reports, or bodies)
//! in O(1) memory while validating JSON structure and retaining only explicitly allowed
//! root and nested `mission` fields within a strict kept-byte ceiling.

use crate::history::Result;
use futures_lite::StreamExt;
use reqwest::Response;
use serde::de::DeserializeOwned;

mod scanner;
mod values;

use scanner::{StringScanner, is_ws, validate_primitive};
use values::CompositeExpect;

const MAX_NESTING: usize = 128;
const MAX_KEY_BYTES: usize = 128;
const MAX_TOTAL_BYTES: usize = 128 * 1024 * 1024 + 256;
const ACTOR_FILTER_KEYS: &[&str] = &["kind", "sessionId", "location"];
const ACTOR_FIELD_LIMIT: usize = 64 * 1024;
const CONTROL_SCALAR_KEYS: &[&str] = &[
    "missionID",
    "requestID",
    "expectedRevision",
    "action",
    "graceful",
    "completedRevision",
    "unconfirmedReceipts",
];
const CONTROL_FIELD_LIMIT: usize = 64 * 1024;

pub(crate) async fn read_filtered_json<T: DeserializeOwned>(
    response: Response,
    root_keys: &[&str],
    mission_keys: &[&str],
    kept_limit: usize,
) -> Result<T> {
    read_filtered_json_for_coordinator(response, root_keys, mission_keys, None, kept_limit).await
}

pub(crate) async fn read_filtered_json_for_coordinator<T: DeserializeOwned>(
    response: Response,
    root_keys: &[&str],
    mission_keys: &[&str],
    coordinator_session_id: Option<&str>,
    kept_limit: usize,
) -> Result<T> {
    let mut parser = FilterParser::new(root_keys, mission_keys, kept_limit)
        .with_actor_filter(coordinator_session_id);
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        parser.feed(&chunk)?;
    }
    let assembled = parser.finish()?;
    Ok(serde_json::from_slice(&assembled)?)
}

pub(crate) async fn read_filtered_json_for_lifecycle<T: DeserializeOwned>(
    response: Response,
    root_keys: &[&str],
    mission_keys: &[&str],
    coordinator_session_id: Option<&str>,
    kept_limit: usize,
) -> Result<T> {
    let mut parser = FilterParser::new(root_keys, mission_keys, kept_limit)
        .with_actor_filter(coordinator_session_id)
        .with_control_summary();
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        parser.feed(&chunk)?;
    }
    let assembled = parser.finish()?;
    Ok(serde_json::from_slice(&assembled)?)
}

#[derive(serde::Deserialize)]
struct ActorFilterProbe {
    kind: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValueMode {
    CaptureRoot,
    CaptureMission,
    CaptureMissionRaw,
    CaptureActor,
    CaptureControl,
    CaptureReceiptAckState,
    SkipActorElem,
    SkipPendingElem,
    SkipReceiptElem,
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    ExpectRootOpen,
    ObjectStart,
    ObjectAfterComma,
    ReadKey,
    ExpectColon,
    ExpectValue,
    MissionValueStart,
    MissionActorsStart,
    ActorsArrayStart,
    ActorsArrayValue,
    ActorsArrayCommaOrEnd,
    MissionControlStart,
    ControlPendingStart,
    ControlPendingArrayStart,
    ControlPendingArrayValue,
    ControlPendingArrayCommaOrEnd,
    ControlReceiptsStart,
    ControlReceiptsArrayStart,
    ControlReceiptsArrayValue,
    ControlReceiptsArrayCommaOrEnd,
    ReceiptNativeAckStart,
    ValueString {
        mode: ValueMode,
    },
    ValueComposite {
        mode: ValueMode,
        in_string: bool,
        in_primitive: bool,
    },
    ValuePrimitive {
        mode: ValueMode,
    },
    ObjectCommaOrClose,
    Done,
}

enum MissionField {
    Absent,
    Object(Vec<(String, Vec<u8>)>),
    Raw(Vec<u8>),
}

struct FilterParser<'a> {
    root_keys: &'a [&'a str],
    mission_keys: &'a [&'a str],
    actor_filter: Option<&'a str>,
    summarize_control: bool,
    kept_limit: usize,
    kept_bytes: usize,
    total_limit: usize,
    total_bytes: usize,
    state: State,
    in_mission: bool,
    in_actor: bool,
    in_control: bool,
    in_receipt: bool,
    key_raw: Vec<u8>,
    key_overflow: bool,
    current_key: Option<String>,
    current_buf: Vec<u8>,
    prim_buf: Vec<u8>,
    string_scanner: StringScanner,
    composite_stack: Vec<CompositeExpect>,
    root_fields: Vec<(String, Vec<u8>)>,
    mission: MissionField,
    actors_out: Vec<u8>,
    actors_has_any: bool,
    actor_fields: Vec<(String, Vec<u8>)>,
    actor_kept_bytes: usize,
    control_fields: Vec<(String, Vec<u8>)>,
    control_kept_bytes: usize,
    pending_has_any: bool,
    receipts_has_any: bool,
    receipts_all_valid: bool,
    receipt_ack_known: bool,
    receipt_native_obj: bool,
}

impl<'a> FilterParser<'a> {
    fn new(root_keys: &'a [&'a str], mission_keys: &'a [&'a str], kept_limit: usize) -> Self {
        Self {
            root_keys,
            mission_keys,
            actor_filter: None,
            summarize_control: false,
            kept_limit,
            kept_bytes: 0,
            total_limit: MAX_TOTAL_BYTES,
            total_bytes: 0,
            state: State::ExpectRootOpen,
            in_mission: false,
            in_actor: false,
            in_control: false,
            in_receipt: false,
            key_raw: Vec::new(),
            key_overflow: false,
            current_key: None,
            current_buf: Vec::new(),
            prim_buf: Vec::new(),
            string_scanner: StringScanner::new(),
            composite_stack: Vec::new(),
            root_fields: Vec::new(),
            mission: MissionField::Absent,
            actors_out: Vec::new(),
            actors_has_any: false,
            actor_fields: Vec::new(),
            actor_kept_bytes: 0,
            control_fields: Vec::new(),
            control_kept_bytes: 0,
            pending_has_any: false,
            receipts_has_any: false,
            receipts_all_valid: true,
            receipt_ack_known: false,
            receipt_native_obj: false,
        }
    }

    fn with_actor_filter(mut self, coordinator_session_id: Option<&'a str>) -> Self {
        self.actor_filter = coordinator_session_id;
        self
    }

    fn with_control_summary(mut self) -> Self {
        self.summarize_control = true;
        self
    }

    #[cfg(test)]
    fn with_total_limit(mut self, total_limit: usize) -> Self {
        self.total_limit = total_limit;
        self
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<()> {
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        if self.total_bytes > self.total_limit {
            return Err("oversized Mission HTTP transfer".into());
        }
        let mut i = 0;
        while i < bytes.len() {
            let b = bytes[i];
            match self.state {
                State::ExpectRootOpen => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'{' {
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        return Err("expected JSON object".into());
                    }
                }
                State::ObjectStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'}' {
                        self.close_filtered_object()?;
                        i += 1;
                    } else if b == b'"' {
                        self.begin_key();
                        i += 1;
                    } else {
                        return Err("expected object key or '}'".into());
                    }
                }
                State::ObjectAfterComma => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'"' {
                        self.begin_key();
                        i += 1;
                    } else {
                        return Err("expected object key after ','".into());
                    }
                }
                State::ReadKey => {
                    if !self.key_overflow {
                        if self.key_raw.len() < MAX_KEY_BYTES {
                            self.key_raw.push(b);
                        } else {
                            self.key_overflow = true;
                        }
                    }
                    if self.string_scanner.step(b)? {
                        self.current_key = if self.key_overflow {
                            None
                        } else {
                            Some(
                                serde_json::from_slice::<String>(&self.key_raw)
                                    .map_err(|_| "invalid JSON key escape")?,
                            )
                        };
                        self.state = State::ExpectColon;
                    }
                    i += 1;
                }
                State::ExpectColon => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b':' {
                        if !self.in_mission
                            && !self.mission_keys.is_empty()
                            && self.current_key.as_deref() == Some("mission")
                        {
                            self.state = State::MissionValueStart;
                        } else if self.in_mission
                            && !self.in_actor
                            && !self.in_control
                            && !self.in_receipt
                            && self.actor_filter.is_some()
                            && self.current_key.as_deref() == Some("actors")
                        {
                            self.state = State::MissionActorsStart;
                        } else if self.in_mission
                            && !self.in_actor
                            && !self.in_control
                            && !self.in_receipt
                            && self.summarize_control
                            && self.current_key.as_deref() == Some("control")
                        {
                            self.state = State::MissionControlStart;
                        } else if self.in_control
                            && !self.in_receipt
                            && self.current_key.as_deref() == Some("pending")
                        {
                            self.state = State::ControlPendingStart;
                        } else if self.in_control
                            && !self.in_receipt
                            && self.current_key.as_deref() == Some("receipts")
                        {
                            self.state = State::ControlReceiptsStart;
                        } else if self.in_receipt
                            && self.current_key.as_deref() == Some("nativeAcknowledgement")
                        {
                            self.state = State::ReceiptNativeAckStart;
                        } else {
                            self.state = State::ExpectValue;
                        }
                        i += 1;
                    } else {
                        return Err("expected ':' after object key".into());
                    }
                }
                State::MissionValueStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'{' {
                        self.in_mission = true;
                        self.mission = MissionField::Object(Vec::new());
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        // Preserve non-object `mission` values (`null`, `[]`, primitives)
                        // so duplicate keys overwrite earlier objects and invalid types fail decode.
                        self.current_key = None;
                        self.start_value(ValueMode::CaptureMissionRaw, b)?;
                        i += 1;
                    }
                }
                State::MissionActorsStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'[' {
                        self.actors_out.clear();
                        self.actors_out.push(b'[');
                        self.actors_has_any = false;
                        self.current_key = None;
                        self.state = State::ActorsArrayStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::CaptureMission, b)?;
                        i += 1;
                    }
                }
                State::ActorsArrayStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b']' {
                        self.finish_actors_array()?;
                        i += 1;
                    } else if b == b'{' {
                        self.in_actor = true;
                        self.actor_fields.clear();
                        self.actor_kept_bytes = 0;
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::SkipActorElem, b)?;
                        i += 1;
                    }
                }
                State::ActorsArrayValue => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'{' {
                        self.in_actor = true;
                        self.actor_fields.clear();
                        self.actor_kept_bytes = 0;
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::SkipActorElem, b)?;
                        i += 1;
                    }
                }
                State::ActorsArrayCommaOrEnd => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b',' {
                        self.state = State::ActorsArrayValue;
                        i += 1;
                    } else if b == b']' {
                        self.finish_actors_array()?;
                        i += 1;
                    } else {
                        return Err("expected ',' or ']' in actors array".into());
                    }
                }
                State::MissionControlStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'{' {
                        self.in_control = true;
                        self.control_fields.clear();
                        self.control_kept_bytes = 0;
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::CaptureMission, b)?;
                        i += 1;
                    }
                }
                State::ControlPendingStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'[' {
                        self.pending_has_any = false;
                        self.current_key = None;
                        self.state = State::ControlPendingArrayStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::CaptureControl, b)?;
                        i += 1;
                    }
                }
                State::ControlPendingArrayStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b']' {
                        self.finish_control_pending();
                        i += 1;
                    } else {
                        self.pending_has_any = true;
                        self.start_value(ValueMode::SkipPendingElem, b)?;
                        i += 1;
                    }
                }
                State::ControlPendingArrayValue => {
                    if is_ws(b) {
                        i += 1;
                    } else {
                        self.pending_has_any = true;
                        self.start_value(ValueMode::SkipPendingElem, b)?;
                        i += 1;
                    }
                }
                State::ControlPendingArrayCommaOrEnd => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b',' {
                        self.state = State::ControlPendingArrayValue;
                        i += 1;
                    } else if b == b']' {
                        self.finish_control_pending();
                        i += 1;
                    } else {
                        return Err("expected ',' or ']' in control pending array".into());
                    }
                }
                State::ControlReceiptsStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'[' {
                        self.receipts_has_any = false;
                        self.receipts_all_valid = true;
                        self.current_key = None;
                        self.state = State::ControlReceiptsArrayStart;
                        i += 1;
                    } else {
                        self.start_value(ValueMode::CaptureControl, b)?;
                        i += 1;
                    }
                }
                State::ControlReceiptsArrayStart => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b']' {
                        self.finish_control_receipts();
                        i += 1;
                    } else if b == b'{' {
                        self.in_receipt = true;
                        self.receipt_ack_known = false;
                        self.receipt_native_obj = false;
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        self.receipts_has_any = true;
                        self.receipts_all_valid = false;
                        self.start_value(ValueMode::SkipReceiptElem, b)?;
                        i += 1;
                    }
                }
                State::ControlReceiptsArrayValue => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'{' {
                        self.in_receipt = true;
                        self.receipt_ack_known = false;
                        self.receipt_native_obj = false;
                        self.current_key = None;
                        self.state = State::ObjectStart;
                        i += 1;
                    } else {
                        self.receipts_has_any = true;
                        self.receipts_all_valid = false;
                        self.start_value(ValueMode::SkipReceiptElem, b)?;
                        i += 1;
                    }
                }
                State::ControlReceiptsArrayCommaOrEnd => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b',' {
                        self.state = State::ControlReceiptsArrayValue;
                        i += 1;
                    } else if b == b']' {
                        self.finish_control_receipts();
                        i += 1;
                    } else {
                        return Err("expected ',' or ']' in control receipts array".into());
                    }
                }
                State::ReceiptNativeAckStart => {
                    if is_ws(b) {
                        i += 1;
                    } else {
                        self.receipt_native_obj = b == b'{';
                        self.current_key = None;
                        self.start_value(ValueMode::Skip, b)?;
                        i += 1;
                    }
                }
                State::ExpectValue => {
                    if is_ws(b) {
                        i += 1;
                    } else {
                        let mode = if self.in_receipt {
                            match self.current_key.as_deref() {
                                Some("acknowledgementState") => ValueMode::CaptureReceiptAckState,
                                _ => ValueMode::Skip,
                            }
                        } else if self.in_control {
                            match self.current_key.as_deref() {
                                Some(k) if CONTROL_SCALAR_KEYS.contains(&k) => {
                                    ValueMode::CaptureControl
                                }
                                _ => ValueMode::Skip,
                            }
                        } else if self.in_actor {
                            match self.current_key.as_deref() {
                                Some(k) if ACTOR_FILTER_KEYS.contains(&k) => {
                                    ValueMode::CaptureActor
                                }
                                _ => ValueMode::Skip,
                            }
                        } else {
                            match (self.in_mission, self.current_key.as_deref()) {
                                (false, Some(k)) if self.root_keys.contains(&k) => {
                                    ValueMode::CaptureRoot
                                }
                                (true, Some(k)) if self.mission_keys.contains(&k) => {
                                    ValueMode::CaptureMission
                                }
                                _ => ValueMode::Skip,
                            }
                        };
                        self.start_value(mode, b)?;
                        i += 1;
                    }
                }
                State::ValueString { mode } => {
                    self.capture_byte(mode, b)?;
                    if self.string_scanner.step(b)? {
                        self.finish_value(mode)?;
                    }
                    i += 1;
                }
                State::ValueComposite {
                    mode,
                    in_string,
                    in_primitive,
                } => {
                    let advance = self.step_composite(mode, in_string, in_primitive, b)?;
                    if advance {
                        i += 1;
                    }
                }
                State::ValuePrimitive { mode } => {
                    let delim = if matches!(
                        mode,
                        ValueMode::SkipActorElem
                            | ValueMode::SkipPendingElem
                            | ValueMode::SkipReceiptElem
                    ) {
                        is_ws(b) || b == b',' || b == b']'
                    } else {
                        is_ws(b) || b == b',' || b == b'}'
                    };
                    if delim {
                        validate_primitive(&self.prim_buf)?;
                        self.prim_buf.clear();
                        self.finish_value(mode)?;
                        // Re-process delimiter without advancing `i`.
                    } else {
                        self.push_prim(b)?;
                        self.capture_byte(mode, b)?;
                        i += 1;
                    }
                }
                State::ObjectCommaOrClose => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b',' {
                        self.state = State::ObjectAfterComma;
                        i += 1;
                    } else if b == b'}' {
                        self.close_filtered_object()?;
                        i += 1;
                    } else {
                        return Err("expected ',' or '}' in JSON object".into());
                    }
                }
                State::Done => {
                    if is_ws(b) {
                        i += 1;
                    } else {
                        return Err("unexpected trailing bytes after JSON object".into());
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
