//! Incremental SSE decoding for the native byte transport.
use super::{Result, limits::FRAME_LIMIT};

#[derive(Debug, PartialEq)]
pub(super) enum Parsed {
    Data(String, String),
    Skipped,
}

#[derive(Default)]
pub(super) struct Parser {
    line: Vec<u8>,
    data: String,
    kind: String,
    skipping: bool,
    nonempty: bool,
}
impl Parser {
    pub(super) fn byte(&mut self, byte: u8) -> Result<Option<Parsed>> {
        if self.skipping {
            if byte == b'\n' {
                if !std::mem::take(&mut self.nonempty) {
                    self.skipping = false;
                    return Ok(Some(Parsed::Skipped));
                }
            } else if byte != b'\r' {
                self.nonempty = true;
            }
            return Ok(None);
        }
        if byte != b'\n' {
            if self.line.len() >= FRAME_LIMIT + b"data: \r".len() {
                *self = Self {
                    skipping: true,
                    nonempty: true,
                    ..Self::default()
                };
            } else {
                self.line.push(byte);
            }
            return Ok(None);
        }
        let bytes = std::mem::take(&mut self.line);
        let line = std::str::from_utf8(&bytes)?.trim_end_matches('\r');
        if line.is_empty() {
            self.data.pop();
            return Ok(Some(Parsed::Data(
                std::mem::take(&mut self.kind),
                std::mem::take(&mut self.data),
            )));
        }
        if let Some(kind) = line.strip_prefix("event:") {
            self.kind = kind.trim().into();
        } else if let Some(data) = line.strip_prefix("data:") {
            let data = data.strip_prefix(' ').unwrap_or(data);
            if self.data.len() + data.len() > FRAME_LIMIT {
                *self = Self {
                    skipping: true,
                    ..Self::default()
                };
                return Ok(None);
            }
            self.data.push_str(data);
            self.data.push('\n');
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(not(target_arch = "wasm32"))]
    use crate::stream::{Backend, Input, State, dispatch};
    #[cfg(not(target_arch = "wasm32"))]
    use serde_json::json;
    #[test]
    fn split_unicode_crlf_and_multiline_event_preserve_named_ping_and_data() {
        let mut parser = Parser::default();
        let input = "event: codenomad.client.ping\r\ndata: été 🦀\r\ndata: next\r\n\r\n";
        let frames = input
            .bytes()
            .filter_map(|b| parser.byte(b).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            frames,
            [Parsed::Data(
                "codenomad.client.ping".into(),
                "été 🦀\nnext".into()
            )]
        );
    }
    #[test]
    fn oversized_line_and_event_drain_to_the_next_blank_line() {
        let mut parser = Parser::default();
        for _ in 0..FRAME_LIMIT + b"data: \r".len() + 10 {
            assert!(parser.byte(b'x').unwrap().is_none());
        }
        assert!(parser.line.is_empty());
        let tail = "\r\ndata: ignored\r\n\r\ndata: ok\n\n";
        assert_eq!(
            tail.bytes()
                .filter_map(|b| parser.byte(b).unwrap())
                .collect::<Vec<_>>(),
            [Parsed::Skipped, Parsed::Data(String::new(), "ok".into())],
        );
        let mut parser = Parser {
            data: "x".repeat(FRAME_LIMIT),
            ..Default::default()
        };
        for b in b"data: x" {
            parser.byte(*b).unwrap();
        }
        assert_eq!(parser.byte(b'\n').unwrap(), None);
        assert_eq!(parser.byte(b'\n').unwrap(), Some(Parsed::Skipped));
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[test]
    fn large_owner_invalidation_does_not_close_the_conversation_stream() {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async {
            let backend = Backend::connect("http://127.0.0.1:9/", "").await.unwrap();
            let (out, recovery) = crate::bounded(4);
            let state = State::default();
            let body = json!({"owner":"ui","type":"storage.stateChanged","value":{"serviceUsage":"x".repeat(1024*1024)}}).to_string();
            let mut parser = Parser::default();
            let wire = format!("data: {body}\n\ndata: {{\"type\":\"ignored\"}}\n\n");
            for frame in wire.bytes().filter_map(|byte| parser.byte(byte).unwrap()) {
                if let Parsed::Data(kind, data) = frame {
                    dispatch(&backend, 1, &out, &state, "test", &kind, &data).await.unwrap();
                }
            }
            assert!(matches!(recovery.try_recv(), Ok(Input::Preferences(crate::settings::Owner::State))));
            assert!(recovery.is_empty());
        });
    }
}
