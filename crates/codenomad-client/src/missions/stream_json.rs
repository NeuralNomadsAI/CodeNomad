//! Incremental streaming JSON object filter for large Mission HTTP responses.
//!
//! Skips non-selected fields (such as full task lists, histories, reports, or bodies)
//! in O(1) memory while validating JSON structure and retaining only explicitly allowed
//! root and nested `mission` fields within a strict kept-byte ceiling.

use crate::history::Result;
use futures_lite::StreamExt;
use reqwest::Response;
use serde::de::DeserializeOwned;

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
enum CompositeExpect {
    ArrayStart,
    ArrayValue,
    ArrayCommaOrEnd,
    ObjectStart,
    ObjectKeyAfterComma,
    ObjectColon,
    ObjectValue,
    ObjectCommaOrEnd,
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
enum StrEscape {
    None,
    Backslash,
    Unicode { digits: u8, value: u16 },
    NeedLowBackslash,
    NeedLowU,
    NeedLowHex { digits: u8, value: u16 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct StringScanner {
    escape: StrEscape,
    utf8_need: u8,
    utf8_min_next: u8,
    utf8_max_next: u8,
}

impl StringScanner {
    const fn new() -> Self {
        Self {
            escape: StrEscape::None,
            utf8_need: 0,
            utf8_min_next: 0x80,
            utf8_max_next: 0xBF,
        }
    }

    /// Feeds one byte of a JSON string body (after the opening `"`).
    /// Returns `Ok(true)` if `b` is the closing unescaped `"`, `Ok(false)` otherwise.
    fn step(&mut self, b: u8) -> Result<bool> {
        if self.utf8_need > 0 {
            if b < self.utf8_min_next || b > self.utf8_max_next {
                return Err("invalid UTF-8 sequence in JSON string".into());
            }
            self.utf8_need -= 1;
            self.utf8_min_next = 0x80;
            self.utf8_max_next = 0xBF;
            return Ok(false);
        }
        match self.escape {
            StrEscape::None => {
                if b < 0x20 {
                    return Err("unescaped control character in JSON string".into());
                }
                if b == b'"' {
                    return Ok(true);
                }
                if b == b'\\' {
                    self.escape = StrEscape::Backslash;
                    return Ok(false);
                }
                if b >= 0x80 {
                    self.start_utf8(b)?;
                }
                Ok(false)
            }
            StrEscape::Backslash => match b {
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                    self.escape = StrEscape::None;
                    Ok(false)
                }
                b'u' => {
                    self.escape = StrEscape::Unicode {
                        digits: 0,
                        value: 0,
                    };
                    Ok(false)
                }
                _ => Err("invalid JSON escape sequence".into()),
            },
            StrEscape::Unicode { digits, value } => {
                let hex = hex_nibble(b)?;
                let next_val = (value << 4) | u16::from(hex);
                if digits + 1 < 4 {
                    self.escape = StrEscape::Unicode {
                        digits: digits + 1,
                        value: next_val,
                    };
                } else if (0xD800..=0xDBFF).contains(&next_val) {
                    self.escape = StrEscape::NeedLowBackslash;
                } else if (0xDC00..=0xDFFF).contains(&next_val) {
                    return Err("unpaired low surrogate in JSON string".into());
                } else {
                    self.escape = StrEscape::None;
                }
                Ok(false)
            }
            StrEscape::NeedLowBackslash => {
                if b == b'\\' {
                    self.escape = StrEscape::NeedLowU;
                    Ok(false)
                } else {
                    Err("unpaired high surrogate in JSON string".into())
                }
            }
            StrEscape::NeedLowU => {
                if b == b'u' {
                    self.escape = StrEscape::NeedLowHex {
                        digits: 0,
                        value: 0,
                    };
                    Ok(false)
                } else {
                    Err("unpaired high surrogate in JSON string".into())
                }
            }
            StrEscape::NeedLowHex { digits, value } => {
                let hex = hex_nibble(b)?;
                let next_val = (value << 4) | u16::from(hex);
                if digits + 1 < 4 {
                    self.escape = StrEscape::NeedLowHex {
                        digits: digits + 1,
                        value: next_val,
                    };
                } else if (0xDC00..=0xDFFF).contains(&next_val) {
                    self.escape = StrEscape::None;
                } else {
                    return Err("invalid low surrogate in JSON string".into());
                }
                Ok(false)
            }
        }
    }

    fn start_utf8(&mut self, b: u8) -> Result<()> {
        match b {
            0xC2..=0xDF => {
                self.utf8_need = 1;
                self.utf8_min_next = 0x80;
                self.utf8_max_next = 0xBF;
            }
            0xE0 => {
                self.utf8_need = 2;
                self.utf8_min_next = 0xA0;
                self.utf8_max_next = 0xBF;
            }
            0xE1..=0xEC | 0xEE..=0xEF => {
                self.utf8_need = 2;
                self.utf8_min_next = 0x80;
                self.utf8_max_next = 0xBF;
            }
            0xED => {
                self.utf8_need = 2;
                self.utf8_min_next = 0x80;
                self.utf8_max_next = 0x9F;
            }
            0xF0 => {
                self.utf8_need = 3;
                self.utf8_min_next = 0x90;
                self.utf8_max_next = 0xBF;
            }
            0xF1..=0xF3 => {
                self.utf8_need = 3;
                self.utf8_min_next = 0x80;
                self.utf8_max_next = 0xBF;
            }
            0xF4 => {
                self.utf8_need = 3;
                self.utf8_min_next = 0x80;
                self.utf8_max_next = 0x8F;
            }
            _ => return Err("invalid UTF-8 lead byte in JSON string".into()),
        }
        Ok(())
    }
}

fn hex_nibble(b: u8) -> Result<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err("invalid unicode escape hex digit in JSON string".into()),
    }
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

    fn begin_key(&mut self) {
        self.key_raw.clear();
        self.key_raw.push(b'"');
        self.key_overflow = false;
        self.string_scanner = StringScanner::new();
        self.state = State::ReadKey;
    }

    fn step_composite(
        &mut self,
        mode: ValueMode,
        in_string: bool,
        in_primitive: bool,
        b: u8,
    ) -> Result<bool> {
        if in_string {
            self.capture_byte(mode, b)?;
            if self.string_scanner.step(b)? {
                self.advance_composite_after_value();
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    in_primitive: false,
                };
            }
            return Ok(true);
        }
        if in_primitive {
            if is_ws(b) || matches!(b, b',' | b'}' | b']') {
                validate_primitive(&self.prim_buf)?;
                self.prim_buf.clear();
                self.advance_composite_after_value();
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    in_primitive: false,
                };
                return Ok(false);
            }
            self.push_prim(b)?;
            self.capture_byte(mode, b)?;
            return Ok(true);
        }
        if is_ws(b) {
            self.capture_byte(mode, b)?;
            return Ok(true);
        }
        let Some(&top) = self.composite_stack.last() else {
            return Err("invalid composite JSON state".into());
        };
        match top {
            CompositeExpect::ArrayStart => {
                if b == b']' {
                    self.capture_byte(mode, b)?;
                    self.pop_composite(mode)?;
                    return Ok(true);
                }
                self.begin_composite_value(mode, b)?;
                Ok(true)
            }
            CompositeExpect::ArrayValue | CompositeExpect::ObjectValue => {
                self.begin_composite_value(mode, b)?;
                Ok(true)
            }
            CompositeExpect::ArrayCommaOrEnd => {
                self.capture_byte(mode, b)?;
                if b == b',' {
                    if let Some(slot) = self.composite_stack.last_mut() {
                        *slot = CompositeExpect::ArrayValue;
                    }
                    Ok(true)
                } else if b == b']' {
                    self.pop_composite(mode)?;
                    Ok(true)
                } else {
                    Err("expected ',' or ']' in JSON array".into())
                }
            }
            CompositeExpect::ObjectStart => {
                if b == b'}' {
                    self.capture_byte(mode, b)?;
                    self.pop_composite(mode)?;
                    return Ok(true);
                }
                if b == b'"' {
                    self.capture_byte(mode, b)?;
                    self.string_scanner = StringScanner::new();
                    self.state = State::ValueComposite {
                        mode,
                        in_string: true,
                        in_primitive: false,
                    };
                    return Ok(true);
                }
                Err("expected object key or '}' in nested JSON object".into())
            }
            CompositeExpect::ObjectKeyAfterComma => {
                if b == b'"' {
                    self.capture_byte(mode, b)?;
                    self.string_scanner = StringScanner::new();
                    self.state = State::ValueComposite {
                        mode,
                        in_string: true,
                        in_primitive: false,
                    };
                    Ok(true)
                } else {
                    Err("expected object key after ',' in nested JSON object".into())
                }
            }
            CompositeExpect::ObjectColon => {
                if b == b':' {
                    self.capture_byte(mode, b)?;
                    if let Some(slot) = self.composite_stack.last_mut() {
                        *slot = CompositeExpect::ObjectValue;
                    }
                    Ok(true)
                } else {
                    Err("expected ':' in nested JSON object".into())
                }
            }
            CompositeExpect::ObjectCommaOrEnd => {
                self.capture_byte(mode, b)?;
                if b == b',' {
                    if let Some(slot) = self.composite_stack.last_mut() {
                        *slot = CompositeExpect::ObjectKeyAfterComma;
                    }
                    Ok(true)
                } else if b == b'}' {
                    self.pop_composite(mode)?;
                    Ok(true)
                } else {
                    Err("expected ',' or '}' in nested JSON object".into())
                }
            }
        }
    }

    fn begin_composite_value(&mut self, mode: ValueMode, b: u8) -> Result<()> {
        match b {
            b'"' => {
                self.capture_byte(mode, b)?;
                self.string_scanner = StringScanner::new();
                self.state = State::ValueComposite {
                    mode,
                    in_string: true,
                    in_primitive: false,
                };
            }
            b'{' => {
                if self.composite_stack.len() >= MAX_NESTING {
                    return Err("JSON nesting depth exceeded".into());
                }
                self.capture_byte(mode, b)?;
                self.composite_stack.push(CompositeExpect::ObjectStart);
            }
            b'[' => {
                if self.composite_stack.len() >= MAX_NESTING {
                    return Err("JSON nesting depth exceeded".into());
                }
                self.capture_byte(mode, b)?;
                self.composite_stack.push(CompositeExpect::ArrayStart);
            }
            b't' | b'f' | b'n' | b'-' | b'0'..=b'9' => {
                self.prim_buf.clear();
                self.push_prim(b)?;
                self.capture_byte(mode, b)?;
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    in_primitive: true,
                };
            }
            _ => return Err("unexpected JSON value token".into()),
        }
        Ok(())
    }

    fn advance_composite_after_value(&mut self) {
        if let Some(slot) = self.composite_stack.last_mut() {
            *slot = match *slot {
                CompositeExpect::ArrayStart | CompositeExpect::ArrayValue => {
                    CompositeExpect::ArrayCommaOrEnd
                }
                CompositeExpect::ObjectStart | CompositeExpect::ObjectKeyAfterComma => {
                    CompositeExpect::ObjectColon
                }
                CompositeExpect::ObjectValue => CompositeExpect::ObjectCommaOrEnd,
                other => other,
            };
        }
    }

    fn pop_composite(&mut self, mode: ValueMode) -> Result<()> {
        self.composite_stack.pop();
        if self.composite_stack.is_empty() {
            self.finish_value(mode)?;
        } else {
            self.advance_composite_after_value();
        }
        Ok(())
    }

    fn start_value(&mut self, mode: ValueMode, first: u8) -> Result<()> {
        self.current_buf.clear();
        self.composite_stack.clear();
        self.prim_buf.clear();
        match first {
            b'"' => {
                self.capture_byte(mode, first)?;
                self.string_scanner = StringScanner::new();
                self.state = State::ValueString { mode };
            }
            b'{' => {
                self.capture_byte(mode, first)?;
                self.composite_stack.push(CompositeExpect::ObjectStart);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    in_primitive: false,
                };
            }
            b'[' => {
                self.capture_byte(mode, first)?;
                self.composite_stack.push(CompositeExpect::ArrayStart);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    in_primitive: false,
                };
            }
            b't' | b'f' | b'n' | b'-' | b'0'..=b'9' => {
                self.push_prim(first)?;
                self.capture_byte(mode, first)?;
                self.state = State::ValuePrimitive { mode };
            }
            _ => return Err("unexpected JSON value token".into()),
        }
        Ok(())
    }

    fn push_prim(&mut self, b: u8) -> Result<()> {
        if self.prim_buf.len() >= 128 {
            return Err("oversized JSON primitive token".into());
        }
        self.prim_buf.push(b);
        Ok(())
    }

    fn capture_byte(&mut self, mode: ValueMode, b: u8) -> Result<()> {
        match mode {
            ValueMode::Skip
            | ValueMode::SkipActorElem
            | ValueMode::SkipPendingElem
            | ValueMode::SkipReceiptElem => return Ok(()),
            ValueMode::CaptureActor => {
                if self.actor_kept_bytes >= ACTOR_FIELD_LIMIT {
                    return Err("oversized actor fields in filtered JSON response".into());
                }
                self.actor_kept_bytes += 1;
                self.current_buf.push(b);
                return Ok(());
            }
            ValueMode::CaptureControl => {
                if self.control_kept_bytes >= CONTROL_FIELD_LIMIT {
                    return Err("oversized control fields in filtered JSON response".into());
                }
                self.control_kept_bytes += 1;
                self.current_buf.push(b);
                return Ok(());
            }
            ValueMode::CaptureReceiptAckState => {
                if self.current_buf.len() >= CONTROL_FIELD_LIMIT {
                    return Err("oversized receipt state in filtered JSON response".into());
                }
                self.current_buf.push(b);
                return Ok(());
            }
            ValueMode::CaptureRoot | ValueMode::CaptureMission | ValueMode::CaptureMissionRaw => {}
        }
        if self.kept_bytes >= self.kept_limit {
            return Err("oversized filtered JSON response".into());
        }
        self.kept_bytes += 1;
        self.current_buf.push(b);
        Ok(())
    }

    fn finish_value(&mut self, mode: ValueMode) -> Result<()> {
        match mode {
            ValueMode::CaptureRoot => {
                if let Some(key) = self.current_key.take() {
                    let val = std::mem::take(&mut self.current_buf);
                    upsert_field(&mut self.root_fields, key, val);
                }
            }
            ValueMode::CaptureMission => {
                if let Some(key) = self.current_key.take() {
                    let val = std::mem::take(&mut self.current_buf);
                    if let MissionField::Object(fields) = &mut self.mission {
                        upsert_field(fields, key, val);
                    }
                }
            }
            ValueMode::CaptureMissionRaw => {
                self.current_key = None;
                let val = std::mem::take(&mut self.current_buf);
                self.mission = MissionField::Raw(val);
            }
            ValueMode::CaptureActor => {
                if let Some(key) = self.current_key.take() {
                    let val = std::mem::take(&mut self.current_buf);
                    upsert_field(&mut self.actor_fields, key, val);
                }
            }
            ValueMode::CaptureControl => {
                if let Some(key) = self.current_key.take() {
                    let val = std::mem::take(&mut self.current_buf);
                    upsert_field(&mut self.control_fields, key, val);
                }
            }
            ValueMode::CaptureReceiptAckState => {
                self.current_key = None;
                let val = std::mem::take(&mut self.current_buf);
                self.receipt_ack_known =
                    serde_json::from_slice::<String>(&val).ok().as_deref() == Some("known");
            }
            ValueMode::SkipActorElem => {
                self.current_key = None;
                self.current_buf.clear();
                self.state = State::ActorsArrayCommaOrEnd;
                return Ok(());
            }
            ValueMode::SkipPendingElem => {
                self.current_key = None;
                self.current_buf.clear();
                self.state = State::ControlPendingArrayCommaOrEnd;
                return Ok(());
            }
            ValueMode::SkipReceiptElem => {
                self.current_key = None;
                self.current_buf.clear();
                self.state = State::ControlReceiptsArrayCommaOrEnd;
                return Ok(());
            }
            ValueMode::Skip => {
                self.current_key = None;
                self.current_buf.clear();
            }
        }
        self.state = State::ObjectCommaOrClose;
        Ok(())
    }

    fn finish_control_pending(&mut self) {
        let summary = if self.pending_has_any {
            b"[\"_\"]".to_vec()
        } else {
            b"[]".to_vec()
        };
        upsert_field(&mut self.control_fields, "pending".to_owned(), summary);
        self.state = State::ObjectCommaOrClose;
    }

    fn finish_control_receipts(&mut self) {
        let summary = if !self.receipts_has_any {
            b"[]".to_vec()
        } else if self.receipts_all_valid {
            b"[{\"acknowledgementState\":\"known\",\"nativeAcknowledgement\":{}}]".to_vec()
        } else {
            b"[{}]".to_vec()
        };
        upsert_field(&mut self.control_fields, "receipts".to_owned(), summary);
        self.state = State::ObjectCommaOrClose;
    }

    fn finish_actors_array(&mut self) -> Result<()> {
        self.actors_out.push(b']');
        if self.kept_bytes.saturating_add(2) > self.kept_limit {
            return Err("oversized filtered JSON response".into());
        }
        self.kept_bytes += 2;
        let val = std::mem::take(&mut self.actors_out);
        if let MissionField::Object(fields) = &mut self.mission {
            upsert_field(fields, "actors".to_owned(), val);
        }
        self.state = State::ObjectCommaOrClose;
        Ok(())
    }

    fn close_filtered_object(&mut self) -> Result<()> {
        if self.in_receipt {
            self.in_receipt = false;
            self.receipts_has_any = true;
            if !(self.receipt_ack_known && self.receipt_native_obj) {
                self.receipts_all_valid = false;
            }
            self.state = State::ControlReceiptsArrayCommaOrEnd;
        } else if self.in_control {
            self.in_control = false;
            let fields = std::mem::take(&mut self.control_fields);
            self.control_kept_bytes = 0;
            let mut elem = Vec::with_capacity(256);
            elem.push(b'{');
            for (idx, (key, val)) in fields.iter().enumerate() {
                if idx > 0 {
                    elem.push(b',');
                }
                elem.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| "invalid control key")?
                        .as_bytes(),
                );
                elem.push(b':');
                elem.extend_from_slice(val);
            }
            elem.push(b'}');
            if self.kept_bytes.saturating_add(elem.len()) > self.kept_limit {
                return Err("oversized filtered JSON response".into());
            }
            self.kept_bytes += elem.len();
            if let MissionField::Object(mission_fields) = &mut self.mission {
                upsert_field(mission_fields, "control".to_owned(), elem);
            }
            self.state = State::ObjectCommaOrClose;
        } else if self.in_actor {
            self.in_actor = false;
            let fields = std::mem::take(&mut self.actor_fields);
            self.actor_kept_bytes = 0;
            let mut elem = Vec::with_capacity(256);
            elem.push(b'{');
            for (idx, (key, val)) in fields.iter().enumerate() {
                if idx > 0 {
                    elem.push(b',');
                }
                elem.extend_from_slice(
                    serde_json::to_string(key)
                        .map_err(|_| "invalid actor key")?
                        .as_bytes(),
                );
                elem.push(b':');
                elem.extend_from_slice(val);
            }
            elem.push(b'}');
            if let Ok(probe) = serde_json::from_slice::<ActorFilterProbe>(&elem)
                && probe.kind.as_deref() == Some("coordinator")
                && probe.session_id.as_deref() == self.actor_filter
            {
                let added = elem.len() + usize::from(self.actors_has_any);
                if self.kept_bytes.saturating_add(added) > self.kept_limit {
                    return Err("oversized filtered JSON response".into());
                }
                self.kept_bytes += added;
                if self.actors_has_any {
                    self.actors_out.push(b',');
                }
                self.actors_out.extend_from_slice(&elem);
                self.actors_has_any = true;
            }
            self.state = State::ActorsArrayCommaOrEnd;
        } else if self.in_mission {
            self.in_mission = false;
            self.state = State::ObjectCommaOrClose;
        } else {
            self.state = State::Done;
        }
        Ok(())
    }

    fn finish(self) -> Result<Vec<u8>> {
        if self.state != State::Done {
            return Err("truncated JSON response".into());
        }
        let mut out = Vec::with_capacity(self.kept_bytes + 64);
        out.push(b'{');
        let mut first = true;
        for (key, val) in &self.root_fields {
            if !first {
                out.push(b',');
            }
            first = false;
            out.extend_from_slice(
                serde_json::to_string(key)
                    .map_err(|_| "invalid key")?
                    .as_bytes(),
            );
            out.push(b':');
            out.extend_from_slice(val);
        }
        match &self.mission {
            MissionField::Absent => {}
            MissionField::Raw(val) => {
                if !first {
                    out.push(b',');
                }
                out.extend_from_slice(b"\"mission\":");
                out.extend_from_slice(val);
            }
            MissionField::Object(fields) => {
                if !first {
                    out.push(b',');
                }
                out.extend_from_slice(b"\"mission\":{");
                for (idx, (key, val)) in fields.iter().enumerate() {
                    if idx > 0 {
                        out.push(b',');
                    }
                    out.extend_from_slice(
                        serde_json::to_string(key)
                            .map_err(|_| "invalid mission key")?
                            .as_bytes(),
                    );
                    out.push(b':');
                    out.extend_from_slice(val);
                }
                out.push(b'}');
            }
        }
        out.push(b'}');
        Ok(out)
    }
}

fn validate_primitive(bytes: &[u8]) -> Result<()> {
    if matches!(bytes, b"true" | b"false" | b"null") {
        return Ok(());
    }
    serde_json::from_slice::<serde_json::Number>(bytes)
        .map(|_| ())
        .map_err(|_| "invalid JSON primitive".into())
}

fn upsert_field(fields: &mut Vec<(String, Vec<u8>)>, key: String, value: Vec<u8>) {
    if let Some(existing) = fields.iter_mut().find(|(k, _)| k == &key) {
        existing.1 = value;
    } else {
        fields.push((key, value));
    }
}

fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn skips_over_64_mib_unselected_field_in_constant_memory() {
        let mut parser = FilterParser::new(
            &["admitted", "code"],
            &[
                "id",
                "projectID",
                "projectCanonical",
                "coordinatorSessionId",
                "revision",
                "actors",
            ],
            4 * 1024 * 1024,
        );
        parser
            .feed(
                br#"{"admitted":true,"mission":{"id":"msn-1","projectID":"proj","projectCanonical":"/repo","coordinatorSessionId":"ses_c","revision":7,"actors":[],"tasks":[{"brief":""#,
            )
            .unwrap();
        let chunk = vec![b'a'; 64 * 1024];
        for _ in 0..1056 {
            parser.feed(&chunk).unwrap();
        }
        parser
            .feed(br#"","escaped":"quote\"and\\brace}"}],"history":[1,2,3]}}"#)
            .unwrap();
        let bytes = parser.finish().unwrap();
        assert!(bytes.len() < 512, "kept bytes must remain tiny");
        let parsed: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            parsed,
            json!({
                "admitted": true,
                "mission": {
                    "id": "msn-1",
                    "projectID": "proj",
                    "projectCanonical": "/repo",
                    "coordinatorSessionId": "ses_c",
                    "revision": 7,
                    "actors": []
                }
            })
        );
    }

    #[test]
    fn enforces_kept_limit_and_handles_byte_by_byte_chunking() {
        let input = br#"{"available":true,"version":1,"projectID":"p","mission":{"id":"m","projectID":"p","revision":9,"tasks":[{"x":"ignored"}]},"cleanups":[]}"#;
        let mut parser = FilterParser::new(
            &["available", "version", "projectID", "cleanups"],
            &["id", "projectID", "revision"],
            4096,
        );
        for b in input {
            parser.feed(&[*b]).unwrap();
        }
        let parsed: Value = serde_json::from_slice(&parser.finish().unwrap()).unwrap();
        assert_eq!(parsed["mission"]["revision"], json!(9));
        assert_eq!(parsed["cleanups"], json!([]));

        let mut tight = FilterParser::new(&["big"], &[], 8);
        assert!(tight.feed(br#"{"big":"1234567890"}"#).is_err());
    }

    #[test]
    fn rejects_trailing_commas_and_preserves_duplicate_or_non_object_mission() {
        // Trailing comma in root object, mission object, or skipped array must be rejected.
        for bad in [
            br#"{"admitted":true,}"#.as_slice(),
            br#"{"admitted":true,"mission":{"id":"m",}}"#.as_slice(),
            br#"{"admitted":true,"mission":{"id":"m","tasks":[1,]}}"#.as_slice(),
            br#"{"admitted":true,"mission":{"id":"m","extra":{"a":1,}}}"#.as_slice(),
            br#"{"admitted":true,"extra":truex}"#.as_slice(),
        ] {
            let mut p = FilterParser::new(&["admitted"], &["id"], 4096);
            assert!(
                p.feed(bad).and_then(|()| p.finish()).is_err(),
                "expected invalid JSON to fail: {}",
                String::from_utf8_lossy(bad)
            );
        }

        // Duplicate `"mission": null` after `"mission": {...}` must overwrite the object.
        let mut dup = FilterParser::new(&["admitted"], &["id"], 4096);
        dup.feed(br#"{"admitted":true,"mission":{"id":"m"},"mission":null}"#)
            .unwrap();
        let dup_val: Value = serde_json::from_slice(&dup.finish().unwrap()).unwrap();
        assert_eq!(dup_val["mission"], Value::Null);

        // Non-object `"mission": []` must be preserved so callers reject it instead of treating it as absent.
        let mut arr = FilterParser::new(&["available", "cleanups"], &["id"], 4096);
        arr.feed(br#"{"available":true,"mission":[],"cleanups":[]}"#)
            .unwrap();
        let arr_val: Value = serde_json::from_slice(&arr.finish().unwrap()).unwrap();
        assert_eq!(arr_val["mission"], json!([]));
    }

    #[test]
    fn rejects_invalid_escapes_surrogates_and_utf8_in_skipped_strings_and_long_keys() {
        let long_bad_key = format!(
            r#"{{"{}":"\u0041","admitted":true}}"#,
            "k".repeat(140) + r"\q"
        );
        let bad_utf8: &[u8] = b"{\"admitted\":true,\"ignored\":\"\xFF\"}";
        let overlong_utf8: &[u8] = b"{\"admitted\":true,\"ignored\":\"\xC0\xAF\"}";
        for bad in [
            br#"{"admitted":true,"ignored":"\x"}"#.as_slice(),
            br#"{"admitted":true,"ignored":"\u123"}"#.as_slice(),
            br#"{"admitted":true,"ignored":"\u123G"}"#.as_slice(),
            br#"{"admitted":true,"ignored":"\uD800"}"#.as_slice(),
            br#"{"admitted":true,"ignored":"\uD800a"}"#.as_slice(),
            br#"{"admitted":true,"ignored":"\uDC00"}"#.as_slice(),
            br#"{"admitted":true,"tasks":[{"note":"\q"}]}"#.as_slice(),
            long_bad_key.as_bytes(),
            bad_utf8,
            overlong_utf8,
        ] {
            let mut p = FilterParser::new(&["admitted"], &["id"], 4096);
            assert!(
                p.feed(bad).and_then(|()| p.finish()).is_err(),
                "expected malformed string/key to fail: {:?}",
                bad
            );
        }

        // Valid surrogate pair and multibyte UTF-8 in skipped fields must succeed.
        let mut good = FilterParser::new(&["admitted"], &[], 4096);
        good.feed(
            "{\"admitted\":true,\"tasks\":[{\"note\":\"\\uD83E\\uDD80 🦀 \\\"ok\\\"\"}]}"
                .as_bytes(),
        )
        .unwrap();
        let val: Value = serde_json::from_slice(&good.finish().unwrap()).unwrap();
        assert_eq!(val, json!({"admitted": true}));
    }

    #[test]
    fn enforces_total_transfer_limit_across_skipped_fields_and_whitespace() {
        let mut skipped = FilterParser::new(&["admitted"], &[], 4096).with_total_limit(64);
        skipped.feed(br#"{"admitted":true,"ignored":""#).unwrap();
        assert!(skipped.feed(&vec![b'a'; 64]).is_err());

        let mut ws = FilterParser::new(&["admitted"], &[], 4096).with_total_limit(32);
        ws.feed(br#"{"admitted":true}"#).unwrap();
        assert!(ws.feed(&vec![b' '; 32]).is_err());
    }

    #[test]
    fn coordinator_actor_filter_streams_past_oversized_actors_in_constant_kept_memory() {
        let mut p = FilterParser::new(&["admitted"], &["id", "actors"], 4096)
            .with_actor_filter(Some("ses_coord"));
        p.feed(br#"{"admitted":true,"mission":{"id":"msn_1","actors":["#)
            .unwrap();
        let worker_blob = format!(
            r#"{{"kind":"specialist","sessionId":"ses_w","location":{{"directory":"/repo"}},"title":"{}"}},"#,
            "w".repeat(4096)
        );
        // Feed > 8 MiB of non-coordinator actors under a 4 KiB kept-byte ceiling.
        for _ in 0..2100 {
            p.feed(worker_blob.as_bytes()).unwrap();
        }
        let coord = format!(
            r#"{{"kind":"coordinator","sessionId":"ses_coord","location":{{"directory":"/repo"}},"title":"{}"}}"#,
            "c".repeat(16_384)
        );
        p.feed(coord.as_bytes()).unwrap();
        p.feed(br#"]}}"#).unwrap();
        let val: Value = serde_json::from_slice(&p.finish().unwrap()).unwrap();
        assert_eq!(val["admitted"], json!(true));
        assert_eq!(
            val["mission"]["actors"],
            json!([{"kind": "coordinator", "sessionId": "ses_coord", "location": {"directory": "/repo"}}])
        );
    }
}
