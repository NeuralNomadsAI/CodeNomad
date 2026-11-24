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

pub(crate) async fn read_filtered_json<T: DeserializeOwned>(
    response: Response,
    root_keys: &[&str],
    mission_keys: &[&str],
    kept_limit: usize,
) -> Result<T> {
    let mut parser = FilterParser::new(root_keys, mission_keys, kept_limit);
    let mut chunks = response.bytes_stream();
    while let Some(chunk) = chunks.next().await {
        let chunk = chunk?;
        parser.feed(&chunk)?;
    }
    let assembled = parser.finish()?;
    Ok(serde_json::from_slice(&assembled)?)
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
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    ExpectRootOpen,
    ObjectStart,
    ObjectAfterComma,
    ReadKey {
        escaped: bool,
    },
    ExpectColon,
    ExpectValue,
    MissionValueStart,
    ValueString {
        mode: ValueMode,
        escaped: bool,
    },
    ValueComposite {
        mode: ValueMode,
        in_string: bool,
        escaped: bool,
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
    kept_limit: usize,
    kept_bytes: usize,
    state: State,
    in_mission: bool,
    key_raw: Vec<u8>,
    key_overflow: bool,
    current_key: Option<String>,
    current_buf: Vec<u8>,
    prim_buf: Vec<u8>,
    composite_stack: Vec<CompositeExpect>,
    root_fields: Vec<(String, Vec<u8>)>,
    mission: MissionField,
}

impl<'a> FilterParser<'a> {
    fn new(root_keys: &'a [&'a str], mission_keys: &'a [&'a str], kept_limit: usize) -> Self {
        Self {
            root_keys,
            mission_keys,
            kept_limit,
            kept_bytes: 0,
            state: State::ExpectRootOpen,
            in_mission: false,
            key_raw: Vec::new(),
            key_overflow: false,
            current_key: None,
            current_buf: Vec::new(),
            prim_buf: Vec::new(),
            composite_stack: Vec::new(),
            root_fields: Vec::new(),
            mission: MissionField::Absent,
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<()> {
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
                        self.close_filtered_object();
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
                State::ReadKey { escaped } => {
                    if b < 0x20 {
                        return Err("unescaped control character in JSON key".into());
                    }
                    if !self.key_overflow {
                        if self.key_raw.len() < MAX_KEY_BYTES {
                            self.key_raw.push(b);
                        } else {
                            self.key_overflow = true;
                        }
                    }
                    if escaped {
                        self.state = State::ReadKey { escaped: false };
                    } else if b == b'\\' {
                        self.state = State::ReadKey { escaped: true };
                    } else if b == b'"' {
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
                State::ExpectValue => {
                    if is_ws(b) {
                        i += 1;
                    } else {
                        let mode = match (self.in_mission, self.current_key.as_deref()) {
                            (false, Some(k)) if self.root_keys.contains(&k) => {
                                ValueMode::CaptureRoot
                            }
                            (true, Some(k)) if self.mission_keys.contains(&k) => {
                                ValueMode::CaptureMission
                            }
                            _ => ValueMode::Skip,
                        };
                        self.start_value(mode, b)?;
                        i += 1;
                    }
                }
                State::ValueString { mode, escaped } => {
                    if b < 0x20 {
                        return Err("unescaped control character in JSON string".into());
                    }
                    self.capture_byte(mode, b)?;
                    if escaped {
                        self.state = State::ValueString {
                            mode,
                            escaped: false,
                        };
                    } else if b == b'\\' {
                        self.state = State::ValueString {
                            mode,
                            escaped: true,
                        };
                    } else if b == b'"' {
                        self.finish_value(mode)?;
                    }
                    i += 1;
                }
                State::ValueComposite {
                    mode,
                    in_string,
                    escaped,
                    in_primitive,
                } => {
                    let advance = self.step_composite(mode, in_string, escaped, in_primitive, b)?;
                    if advance {
                        i += 1;
                    }
                }
                State::ValuePrimitive { mode } => {
                    if is_ws(b) || b == b',' || b == b'}' {
                        validate_primitive(&self.prim_buf)?;
                        self.prim_buf.clear();
                        self.finish_value(mode)?;
                        // Re-process delimiter in ObjectCommaOrClose without advancing `i`.
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
                        self.close_filtered_object();
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
        self.state = State::ReadKey { escaped: false };
    }

    fn step_composite(
        &mut self,
        mode: ValueMode,
        in_string: bool,
        escaped: bool,
        in_primitive: bool,
        b: u8,
    ) -> Result<bool> {
        if in_string {
            if b < 0x20 {
                return Err("unescaped control character in JSON string".into());
            }
            self.capture_byte(mode, b)?;
            if escaped {
                self.state = State::ValueComposite {
                    mode,
                    in_string: true,
                    escaped: false,
                    in_primitive: false,
                };
            } else if b == b'\\' {
                self.state = State::ValueComposite {
                    mode,
                    in_string: true,
                    escaped: true,
                    in_primitive: false,
                };
            } else if b == b'"' {
                self.advance_composite_after_value();
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    escaped: false,
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
                    escaped: false,
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
                    self.state = State::ValueComposite {
                        mode,
                        in_string: true,
                        escaped: false,
                        in_primitive: false,
                    };
                    return Ok(true);
                }
                Err("expected object key or '}' in nested JSON object".into())
            }
            CompositeExpect::ObjectKeyAfterComma => {
                if b == b'"' {
                    self.capture_byte(mode, b)?;
                    self.state = State::ValueComposite {
                        mode,
                        in_string: true,
                        escaped: false,
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
                self.state = State::ValueComposite {
                    mode,
                    in_string: true,
                    escaped: false,
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
                    escaped: false,
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
                self.state = State::ValueString {
                    mode,
                    escaped: false,
                };
            }
            b'{' => {
                self.capture_byte(mode, first)?;
                self.composite_stack.push(CompositeExpect::ObjectStart);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    escaped: false,
                    in_primitive: false,
                };
            }
            b'[' => {
                self.capture_byte(mode, first)?;
                self.composite_stack.push(CompositeExpect::ArrayStart);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    escaped: false,
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
        if mode == ValueMode::Skip {
            return Ok(());
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
            ValueMode::Skip => {
                self.current_key = None;
                self.current_buf.clear();
            }
        }
        self.state = State::ObjectCommaOrClose;
        Ok(())
    }

    fn close_filtered_object(&mut self) {
        if self.in_mission {
            self.in_mission = false;
            self.state = State::ObjectCommaOrClose;
        } else {
            self.state = State::Done;
        }
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
}
