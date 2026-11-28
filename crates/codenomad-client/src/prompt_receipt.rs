use crate::{history::Result, prompt::PromptError};
use futures_lite::StreamExt;
use serde_json::Value;

const MAX_WIRE: usize = 64 * 1024 * 1024;
const MAX_RECEIPT: usize = 64 * 1024;

pub(crate) async fn read(response: reqwest::Response) -> Result<Value> {
    #[cfg(not(target_arch = "wasm32"))]
    let idle = Some(crate::http::REQUEST_TIMEOUT);
    #[cfg(target_arch = "wasm32")]
    let idle = None;
    read_with_idle_timeout(response, idle).await
}

pub(crate) async fn read_with_idle_timeout(
    response: reqwest::Response,
    idle_timeout: Option<std::time::Duration>,
) -> Result<Value> {
    let mut projection = Projection::default();
    let mut chunks = response.bytes_stream();
    let mut wire = 0;
    loop {
        #[cfg(not(target_arch = "wasm32"))]
        let next = match idle_timeout {
            Some(limit) => tokio::time::timeout(limit, chunks.next())
                .await
                .map_err(|_| PromptError::Unconfirmed)?,
            None => chunks.next().await,
        };
        #[cfg(target_arch = "wasm32")]
        let next = {
            let _ = idle_timeout;
            chunks.next().await
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk?;
        wire += chunk.len();
        if wire > MAX_WIRE {
            return Err(PromptError::Unconfirmed.into());
        }
        projection.push(&chunk)?;
    }
    projection.finish()
}

#[derive(Default)]
struct Projection {
    // Identity fields may follow the payload; track its framing without copying its bytes.
    receipt: Vec<u8>,
    stack: Vec<u8>,
    in_string: bool,
    escaped: bool,
    string_start: usize,
    string_end: usize,
    awaiting_payload: bool,
    payload_depth: Option<usize>,
}

impl Projection {
    fn push(&mut self, chunk: &[u8]) -> Result<()> {
        for &byte in chunk {
            if self.awaiting_payload && !byte.is_ascii_whitespace() {
                self.awaiting_payload = false;
                if byte != b'{' {
                    return Err("invalid native receipt payload".into());
                }
                if self.receipt.len() > MAX_RECEIPT - 4 {
                    return Err("prompt receipt metadata exceeds its bound".into());
                }
                self.receipt.extend_from_slice(b"null");
                self.payload_depth = Some(self.stack.len());
            }
            if self.payload_depth.is_none() {
                if self.receipt.len() == MAX_RECEIPT {
                    return Err("prompt receipt metadata exceeds its bound".into());
                }
                self.receipt.push(byte);
            }
            if self.in_string {
                if self.escaped {
                    self.escaped = false;
                } else if byte == b'\\' {
                    self.escaped = true;
                } else if byte == b'"' {
                    self.in_string = false;
                    self.string_end = self.receipt.len();
                } else if byte < 0x20 {
                    return Err("invalid control byte in receipt".into());
                }
                continue;
            }
            match byte {
                b'"' => {
                    self.in_string = true;
                    self.string_start = self.receipt.len().saturating_sub(1);
                }
                b'{' | b'[' if self.stack.len() < 128 => {
                    self.stack.push(if byte == b'{' { b'}' } else { b']' });
                }
                b'{' | b'[' => return Err("prompt receipt nesting exceeds its bound".into()),
                b'}' | b']' => {
                    if self.stack.pop() != Some(byte) {
                        return Err("invalid prompt receipt framing".into());
                    }
                    if self.payload_depth == Some(self.stack.len()) {
                        self.payload_depth = None;
                    }
                }
                b':' if self.payload_depth.is_none() && self.stack.len() <= 2 => {
                    let before_colon = self.receipt.get(self.string_end..self.receipt.len() - 1);
                    self.awaiting_payload = before_colon
                        .is_some_and(|gap| gap.iter().all(u8::is_ascii_whitespace))
                        && self.receipt.get(self.string_start..self.string_end)
                            == Some(b"\"payload\"");
                }
                _ => {}
            }
        }
        Ok(())
    }

    fn finish(self) -> Result<Value> {
        if self.payload_depth.is_some() || self.in_string || !self.stack.is_empty() {
            return Err("incomplete prompt receipt".into());
        }
        Ok(serde_json::from_slice(&self.receipt)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn streams_opaque_payload_between_identity_fields_with_bounded_metadata() {
        let mut projection = Projection::default();
        projection
            .push(br#"{"data":{"payload":{"files":[{"data":""#)
            .unwrap();
        let chunk = [b'A'; 4096];
        for _ in 0..8540 {
            projection.push(&chunk).unwrap();
        }
        for byte in br#"\\"}],"text":"\uabcd\"}]","id":"not-the-receipt"},"id":"right","sessionID":"session"}}"# {
            projection.push(&[*byte]).unwrap();
        }
        assert!(projection.receipt.len() < 80);
        assert_eq!(
            projection.finish().unwrap(),
            json!({
                "data":{"payload":null,"id":"right","sessionID":"session"}
            })
        );
    }

    #[test]
    fn truncated_payload_and_excessive_metadata_cannot_confirm() {
        let mut projection = Projection::default();
        projection
            .push(br#"{"id":"attempt","payload":{"files":["cut"#)
            .unwrap();
        assert!(projection.finish().is_err());
        let mut projection = Projection::default();
        assert!(projection.push(&[b' '; MAX_RECEIPT + 1]).is_err());
    }
}
