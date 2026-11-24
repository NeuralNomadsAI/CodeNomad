//! Incremental streaming JSON object filter for large Mission HTTP responses.
//!
//! Skips non-selected fields (such as full task lists, histories, reports, or bodies)
//! in O(1) memory while retaining only explicitly allowed root and nested `mission`
//! fields within a strict kept-byte ceiling.

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
enum Container {
    Object,
    Array,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ValueMode {
    CaptureRoot,
    CaptureMission,
    Skip,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    ExpectRootOpen,
    ObjectKeyOrClose,
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
    },
    ValuePrimitive {
        mode: ValueMode,
    },
    ObjectCommaOrClose,
    Done,
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
    composite_stack: Vec<Container>,
    root_fields: Vec<(String, Vec<u8>)>,
    mission_fields: Vec<(String, Vec<u8>)>,
    saw_mission_object: bool,
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
            composite_stack: Vec::new(),
            root_fields: Vec::new(),
            mission_fields: Vec::new(),
            saw_mission_object: false,
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
                        self.state = State::ObjectKeyOrClose;
                        i += 1;
                    } else {
                        return Err("expected JSON object".into());
                    }
                }
                State::ObjectKeyOrClose => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b'}' {
                        self.close_filtered_object();
                        i += 1;
                    } else if b == b'"' {
                        self.key_raw.clear();
                        self.key_raw.push(b'"');
                        self.key_overflow = false;
                        self.state = State::ReadKey { escaped: false };
                        i += 1;
                    } else {
                        return Err("expected object key or '}'".into());
                    }
                }
                State::ReadKey { escaped } => {
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
                            serde_json::from_slice::<String>(&self.key_raw).ok()
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
                        self.saw_mission_object = true;
                        self.mission_fields.clear();
                        self.current_key = None;
                        self.state = State::ObjectKeyOrClose;
                        i += 1;
                    } else {
                        // Non-object `mission` value (e.g. `null`): skip it.
                        self.current_key = None;
                        self.start_value(ValueMode::Skip, b)?;
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
                } => {
                    self.capture_byte(mode, b)?;
                    if in_string {
                        if escaped {
                            self.state = State::ValueComposite {
                                mode,
                                in_string: true,
                                escaped: false,
                            };
                        } else if b == b'\\' {
                            self.state = State::ValueComposite {
                                mode,
                                in_string: true,
                                escaped: true,
                            };
                        } else if b == b'"' {
                            self.state = State::ValueComposite {
                                mode,
                                in_string: false,
                                escaped: false,
                            };
                        }
                    } else {
                        match b {
                            b'"' => {
                                self.state = State::ValueComposite {
                                    mode,
                                    in_string: true,
                                    escaped: false,
                                };
                            }
                            b'{' => {
                                if self.composite_stack.len() >= MAX_NESTING {
                                    return Err("JSON nesting depth exceeded".into());
                                }
                                self.composite_stack.push(Container::Object);
                            }
                            b'[' => {
                                if self.composite_stack.len() >= MAX_NESTING {
                                    return Err("JSON nesting depth exceeded".into());
                                }
                                self.composite_stack.push(Container::Array);
                            }
                            b'}' => {
                                if self.composite_stack.pop() != Some(Container::Object) {
                                    return Err("mismatched '}' in JSON value".into());
                                }
                                if self.composite_stack.is_empty() {
                                    self.finish_value(mode)?;
                                }
                            }
                            b']' => {
                                if self.composite_stack.pop() != Some(Container::Array) {
                                    return Err("mismatched ']' in JSON value".into());
                                }
                                if self.composite_stack.is_empty() {
                                    self.finish_value(mode)?;
                                }
                            }
                            _ => {}
                        }
                    }
                    i += 1;
                }
                State::ValuePrimitive { mode } => {
                    if is_ws(b) || b == b',' || b == b'}' {
                        self.finish_value(mode)?;
                        // Re-process delimiter in ObjectCommaOrClose without advancing `i`.
                    } else {
                        self.capture_byte(mode, b)?;
                        i += 1;
                    }
                }
                State::ObjectCommaOrClose => {
                    if is_ws(b) {
                        i += 1;
                    } else if b == b',' {
                        self.state = State::ObjectKeyOrClose;
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

    fn start_value(&mut self, mode: ValueMode, first: u8) -> Result<()> {
        self.current_buf.clear();
        self.composite_stack.clear();
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
                self.composite_stack.push(Container::Object);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    escaped: false,
                };
            }
            b'[' => {
                self.capture_byte(mode, first)?;
                self.composite_stack.push(Container::Array);
                self.state = State::ValueComposite {
                    mode,
                    in_string: false,
                    escaped: false,
                };
            }
            b't' | b'f' | b'n' | b'-' | b'0'..=b'9' => {
                self.capture_byte(mode, first)?;
                self.state = State::ValuePrimitive { mode };
            }
            _ => return Err("unexpected JSON value token".into()),
        }
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
                    upsert_field(&mut self.mission_fields, key, val);
                }
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
        if self.saw_mission_object {
            if !first {
                out.push(b',');
            }
            out.extend_from_slice(b"\"mission\":{");
            for (idx, (key, val)) in self.mission_fields.iter().enumerate() {
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
        out.push(b'}');
        Ok(out)
    }
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
        // Stream 66 MiB of unselected task brief text in 64 KiB chunks.
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
}
