use super::scanner::{StringScanner, is_ws, upsert_field, validate_primitive};
use super::{
    ACTOR_FIELD_LIMIT, ActorFilterProbe, CONTROL_FIELD_LIMIT, FilterParser, MAX_NESTING,
    MissionField, State, ValueMode,
};
use crate::history::Result;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CompositeExpect {
    ArrayStart,
    ArrayValue,
    ArrayCommaOrEnd,
    ObjectStart,
    ObjectKeyAfterComma,
    ObjectColon,
    ObjectValue,
    ObjectCommaOrEnd,
}

impl<'a> FilterParser<'a> {
    pub(super) fn begin_key(&mut self) {
        self.key_raw.clear();
        self.key_raw.push(b'"');
        self.key_overflow = false;
        self.string_scanner = StringScanner::new();
        self.state = State::ReadKey;
    }

    pub(super) fn step_composite(
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

    pub(super) fn start_value(&mut self, mode: ValueMode, first: u8) -> Result<()> {
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

    pub(super) fn push_prim(&mut self, b: u8) -> Result<()> {
        if self.prim_buf.len() >= 128 {
            return Err("oversized JSON primitive token".into());
        }
        self.prim_buf.push(b);
        Ok(())
    }

    pub(super) fn capture_byte(&mut self, mode: ValueMode, b: u8) -> Result<()> {
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

    pub(super) fn finish_value(&mut self, mode: ValueMode) -> Result<()> {
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

    pub(super) fn finish_control_pending(&mut self) {
        let summary = if self.pending_has_any {
            b"[\"_\"]".to_vec()
        } else {
            b"[]".to_vec()
        };
        upsert_field(&mut self.control_fields, "pending".to_owned(), summary);
        self.state = State::ObjectCommaOrClose;
    }

    pub(super) fn finish_control_receipts(&mut self) {
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

    pub(super) fn finish_actors_array(&mut self) -> Result<()> {
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

    pub(super) fn close_filtered_object(&mut self) -> Result<()> {
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

    pub(super) fn finish(self) -> Result<Vec<u8>> {
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
