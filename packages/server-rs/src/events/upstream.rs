//! SSE `data:` lines join with newlines; blank lines end a block. Raw frames have a 32 MiB bound.
//! Every chunk, including a keepalive, signals activity.

use std::collections::VecDeque;
use std::fmt;

use bytes::Bytes;
use futures_util::{Stream, StreamExt};
use serde::de::DeserializeOwned;

/// The native inbox can contain all 20 MiB of admitted uploads in base64.
const MAX_EVENT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    /// Reading the body failed. Displays as the TypeScript `ClientError` does: `Transport: <cause>`.
    #[error("Transport: {0}")]
    Transport(String),
    /// A `data:` payload is not valid JSON for the event type.
    #[error("MalformedResponse: {0}")]
    MalformedResponse(String),
    #[error("SseEventTooLarge")]
    EventTooLarge,
}

/// Buffers bytes until a complete line is available, so a UTF-8 code point split across chunks is decoded only once.
#[derive(Default)]
pub struct Decoder {
    /// Bytes of the unterminated last line.
    line: Vec<u8>,
    /// `data:` values of the open block, joined with newlines.
    data: String,
    /// Whether the open block has a `data:` line, so an empty value still adds a newline.
    has_data: bool,
    /// Length of the open block's complete lines, newlines included, in bytes.
    block_bytes: usize,
    /// A trailing CR held back because the next chunk may start with LF.
    carriage_return: bool,
    started: bool,
}

impl Decoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a chunk and appends the payloads of the blocks it completes to `payloads`.
    pub fn push(&mut self, chunk: &[u8], payloads: &mut VecDeque<String>) -> Result<(), Error> {
        let mut rest = chunk;
        if self.carriage_return && !rest.is_empty() {
            self.carriage_return = false;
            let crlf = rest.starts_with(b"\n");
            self.check_bytes(1 + usize::from(crlf))?;
            rest = rest.strip_prefix(b"\n").unwrap_or(rest);
            self.end_line(&[], payloads);
            if crlf && self.block_bytes != 0 {
                self.block_bytes += 1;
            }
        }
        while let Some(index) = memchr::memchr2(b'\n', b'\r', rest) {
            if rest[index] == b'\r' && index + 1 == rest.len() {
                self.check_bytes(index + 1)?;
                self.line.extend_from_slice(&rest[..index]);
                self.carriage_return = true;
                return Ok(());
            }
            let crlf = rest[index] == b'\r' && rest[index + 1] == b'\n';
            self.check_bytes(index + 1 + usize::from(crlf))?;
            self.end_line(&rest[..index], payloads);
            if crlf && self.block_bytes != 0 {
                self.block_bytes += 1;
            }
            rest = &rest[index + 1 + usize::from(crlf)..];
        }
        self.check_bytes(rest.len())?;
        self.line.extend_from_slice(rest);
        Ok(())
    }

    fn check_bytes(&self, additional: usize) -> Result<(), Error> {
        if self.block_bytes + self.line.len() + additional > MAX_EVENT_BYTES {
            Err(Error::EventTooLarge)
        } else {
            Ok(())
        }
    }

    /// Ends the stream: an unterminated last block still counts, as in the TypeScript reader.
    pub fn finish(&mut self, payloads: &mut VecDeque<String>) {
        if std::mem::take(&mut self.carriage_return) || !self.line.is_empty() {
            self.end_line(&[], payloads);
        }
        self.dispatch(payloads);
    }

    /// Ends the line made of the buffered bytes and `tail`, keeping the buffer's capacity.
    fn end_line(&mut self, tail: &[u8], payloads: &mut VecDeque<String>) {
        if self.line.is_empty() {
            return self.decode_line(tail, payloads);
        }
        let mut line = std::mem::take(&mut self.line);
        line.extend_from_slice(tail);
        self.decode_line(&line, payloads);
        line.clear();
        self.line = line;
    }

    /// Decodes a complete line: an empty one ends the block, a `data:` line adds to it.
    fn decode_line(&mut self, line: &[u8], payloads: &mut VecDeque<String>) {
        let mut bytes = line;
        if !std::mem::replace(&mut self.started, true) {
            bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
        }
        if bytes.is_empty() {
            self.dispatch(payloads);
            return;
        }
        self.block_bytes += line.len() + 1;
        // The prefix is ASCII, so decoding only the value gives the same text as decoding the whole line.
        if let Some(value) = bytes.strip_prefix(b"data:") {
            let value = String::from_utf8_lossy(value);
            if std::mem::replace(&mut self.has_data, true) {
                self.data.push('\n');
            }
            self.data.push_str(value.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}'));
        }
    }

    fn dispatch(&mut self, payloads: &mut VecDeque<String>) {
        self.block_bytes = 0;
        self.has_data = false;
        if !self.data.is_empty() {
            payloads.push_back(std::mem::take(&mut self.data));
        }
    }
}

/// Decodes a response body into events. `activity` runs for every chunk, including keepalive comments
/// that yield no event. The stream ends after the first error.
pub fn events<T, S, E>(body: S, activity: impl FnMut() + Send + 'static) -> impl Stream<Item = Result<T, Error>> + Send
where
    T: DeserializeOwned + Send,
    S: Stream<Item = Result<Bytes, E>> + Send + Unpin,
    E: fmt::Display,
{
    struct State<S, A> {
        body: S,
        activity: A,
        decoder: Decoder,
        ready: VecDeque<String>,
        ended: bool,
    }
    let state = State { body, activity, decoder: Decoder::new(), ready: VecDeque::new(), ended: false };
    futures_util::stream::unfold(state, |mut state| async move {
        loop {
            if let Some(data) = state.ready.pop_front() {
                let item = serde_json::from_str(&data).map_err(|error| Error::MalformedResponse(error.to_string()));
                if item.is_err() {
                    state.ended = true;
                    state.ready.clear();
                }
                return Some((item, state));
            }
            if state.ended {
                return None;
            }
            let decoded = match state.body.next().await {
                Some(Ok(chunk)) => {
                    (state.activity)();
                    state.decoder.push(&chunk, &mut state.ready)
                }
                Some(Err(error)) => Err(Error::Transport(error.to_string())),
                None => {
                    state.ended = true;
                    state.decoder.finish(&mut state.ready);
                    Ok(())
                }
            };
            if let Err(error) = decoded {
                state.ended = true;
                return Some((Err(error), state));
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn body(chunks: Vec<Vec<u8>>) -> impl Stream<Item = Result<Bytes, String>> + Send + Unpin {
        futures_util::stream::iter(chunks.into_iter().map(|chunk| Ok(Bytes::from(chunk))))
    }

    fn frame(event: &Value) -> String {
        format!("data: {event}\n\n")
    }

    async fn collect(chunks: Vec<Vec<u8>>) -> Vec<Result<Value, Error>> {
        events(body(chunks), || {}).collect().await
    }

    fn connected(id: &str) -> Value {
        json!({ "id": id, "created": 1, "type": "server.connected", "data": {} })
    }

    #[tokio::test]
    async fn exposes_the_event_stream_wire_projection() {
        let selected = json!({ "id": "evt_model", "created": 1_717_171_717_000_i64, "type": "session.model.selected", "data": {} });
        let text = format!(": heartbeat\n\n{}{}", frame(&connected("evt_connected")), frame(&selected));
        let received = collect(vec![text.into_bytes()]).await;
        assert_eq!(received, vec![Ok(connected("evt_connected")), Ok(selected)]);
    }

    #[tokio::test]
    async fn delivers_every_event_from_one_chunk() {
        let events = (0..4).map(|index| connected(&format!("evt_burst_{index}"))).collect::<Vec<_>>();
        let text = events.iter().map(frame).collect::<String>();
        let received = collect(vec![text.into_bytes()]).await;
        assert_eq!(received, events.into_iter().map(Ok).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn parses_split_json_and_a_split_multibyte_code_point() {
        let event = json!({ "id": "evt_split", "created": 1, "type": "server.connected", "data": { "text": "split snowman \u{2603}\u{2603}\u{2603}" } });
        let encoded = frame(&event).into_bytes();
        let multibyte = encoded.iter().position(|byte| *byte == "\u{2603}".as_bytes()[0]).unwrap();
        let boundaries = [9, multibyte + 1, multibyte + 2, encoded.len()];
        let chunks = boundaries
            .iter()
            .enumerate()
            .map(|(index, end)| encoded[if index == 0 { 0 } else { boundaries[index - 1] }..*end].to_vec())
            .collect();
        assert_eq!(collect(chunks).await, vec![Ok(event)]);
    }

    #[tokio::test]
    async fn ignores_heartbeat_comments() {
        let text = format!(": heartbeat\n\n{}: heartbeat\n\n", frame(&connected("evt_sentinel")));
        assert_eq!(collect(vec![text.into_bytes()]).await, vec![Ok(connected("evt_sentinel"))]);
    }

    #[tokio::test]
    async fn reports_heartbeat_comments_as_activity() {
        let activity = Arc::new(AtomicUsize::new(0));
        let counter = activity.clone();
        let chunks = vec![
            b": heartbeat\n\n".to_vec(),
            frame(&connected("evt_sentinel")).into_bytes(),
            b": heartbeat\n\n".to_vec(),
        ];
        let received: Vec<Result<Value, Error>> = events(body(chunks), move || {
            counter.fetch_add(1, Ordering::SeqCst);
        })
        .collect()
        .await;
        assert_eq!(received, vec![Ok(connected("evt_sentinel"))]);
        assert_eq!(activity.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn terminates_on_malformed_data() {
        let received = collect(vec![b"data: {not-json}\n\ndata: {}\n\n".to_vec()]).await;
        assert_eq!(received.len(), 1);
        assert!(matches!(received[0], Err(Error::MalformedResponse(_))));
    }

    #[tokio::test]
    async fn accepts_a_fragmented_event_below_the_size_limit() {
        let event =
            json!({ "id": "evt_large", "type": "test.large", "data": { "output": "x".repeat(12 * 1024 * 1024) } });
        let encoded = frame(&event).into_bytes();
        let chunks = encoded.chunks(64 * 1024).map(<[u8]>::to_vec).collect();
        assert_eq!(collect(chunks).await, vec![Ok(event)]);
    }

    #[tokio::test]
    async fn rejects_an_event_above_the_size_limit() {
        let text = format!("data: {}", json!({ "output": "x".repeat(MAX_EVENT_BYTES) }));
        assert_eq!(collect(vec![text.into_bytes()]).await, vec![Err(Error::EventTooLarge)]);
    }

    #[tokio::test]
    async fn a_transport_failure_ends_the_stream() {
        let chunks = futures_util::stream::iter(vec![
            Ok(Bytes::from(frame(&connected("evt_1")))),
            Err("contract failure".to_owned()),
        ]);
        let received: Vec<Result<Value, Error>> = events(chunks, || {}).collect().await;
        assert_eq!(received, vec![Ok(connected("evt_1")), Err(Error::Transport("contract failure".into()))]);
        assert_eq!(received[1].as_ref().unwrap_err().to_string(), "Transport: contract failure");
    }

    fn push(decoder: &mut Decoder, chunk: &[u8]) -> Result<Vec<String>, Error> {
        let mut payloads = VecDeque::new();
        decoder.push(chunk, &mut payloads).map(|()| payloads.into())
    }

    fn finish(decoder: &mut Decoder) -> Vec<String> {
        let mut payloads = VecDeque::new();
        decoder.finish(&mut payloads);
        payloads.into()
    }

    // Volatile streams must not request replay via Last-Event-ID.
    #[test]
    fn ignores_fields_other_than_data() {
        let mut decoder = Decoder::new();
        let payloads = push(&mut decoder, b"id: timeline-event-7\nevent: x\nretry: 5\ndata: {}\n\n").unwrap();
        assert_eq!(payloads, vec!["{}"]);
    }

    #[test]
    fn normalizes_crlf_and_cr_across_chunks() {
        let mut decoder = Decoder::new();
        assert_eq!(push(&mut decoder, b"data: 1\r").unwrap(), Vec::<String>::new());
        assert_eq!(push(&mut decoder, b"\n\r").unwrap(), Vec::<String>::new());
        assert_eq!(push(&mut decoder, b"\ndata: 2\r\rdata: 3\n").unwrap(), vec!["1", "2"]);
        assert_eq!(finish(&mut decoder), vec!["3"]);
    }

    #[test]
    fn joins_data_lines_and_drops_a_leading_bom() {
        let mut decoder = Decoder::new();
        let payloads = push(&mut decoder, "\u{feff}data:a\ndata:  b\n\n".as_bytes()).unwrap();
        assert_eq!(payloads, vec!["a\nb"]);
    }

    #[test]
    fn a_buffer_ending_in_a_multibyte_character_takes_the_next_chunk() {
        let mut decoder = Decoder::new();
        assert_eq!(push(&mut decoder, "data: \u{2580}".as_bytes()).unwrap(), Vec::<String>::new());
        assert_eq!(push(&mut decoder, b"x\n\n").unwrap(), vec!["\u{2580}x"]);
    }

    #[test]
    fn every_split_of_a_multibyte_character_decodes_as_one_chunk() {
        let characters = [
            "\u{e9}",                     // 2 bytes
            "\u{2580}",                   // 3 bytes
            "\u{1f600}",                  // 4 bytes
            "\u{1f469}\u{200d}\u{1f4bb}", // ZWJ sequence
        ];
        let read = |chunks: &[&[u8]]| {
            let mut decoder = Decoder::new();
            let mut payloads = chunks.iter().flat_map(|chunk| push(&mut decoder, chunk).unwrap()).collect::<Vec<_>>();
            payloads.extend(finish(&mut decoder));
            payloads
        };
        for character in characters {
            let text = format!(
                "data: {{\"text\":\"{character}\"}}\n\ndata: a{character}\r\ndata: {character}{character}\r\n\r\ndata: {character}"
            );
            let bytes = text.as_bytes();
            let whole = read(&[bytes]);
            assert_eq!(whole.len(), 3, "{character}");
            for split in 1..bytes.len() {
                let (first, second) = bytes.split_at(split);
                assert_eq!(read(&[first, second]), whole, "{character} split at byte {split}");
            }
        }
    }

    #[test]
    fn invalid_utf8_becomes_a_replacement_character() {
        let mut decoder = Decoder::new();
        assert_eq!(push(&mut decoder, b"data: \xff\n\n").unwrap(), vec!["\u{fffd}"]);
        assert_eq!(push(&mut decoder, b"data: \xe2\x98").unwrap(), Vec::<String>::new());
        assert_eq!(finish(&mut decoder), vec!["\u{fffd}"]);
    }

    #[test]
    fn the_size_limit_counts_raw_bytes_of_the_open_event() {
        let mut decoder = Decoder::new();
        let emoji = "\u{1f600}".repeat(MAX_EVENT_BYTES / 4 - 2);
        assert!(push(&mut decoder, format!("data:{emoji}").as_bytes()).is_ok());
        assert_eq!(push(&mut decoder, b"xxxx"), Err(Error::EventTooLarge));
        // Completed blocks no longer count.
        let mut decoder = Decoder::new();
        let half = "x".repeat(MAX_EVENT_BYTES / 2);
        assert!(push(&mut decoder, format!("data:{half}\n\n").as_bytes()).is_ok());
        assert!(push(&mut decoder, format!("data:{half}\n\n").as_bytes()).is_ok());
    }

    #[test]
    fn a_chunk_that_reaches_the_limit_exactly_is_accepted() {
        // A complete line, an open line, and a held CR count; the CR brings the open event to the limit.
        let quarter = MAX_EVENT_BYTES / 4;
        let mut decoder = Decoder::new();
        assert!(push(&mut decoder, format!("data:{}\n", "x".repeat(quarter - 6)).as_bytes()).is_ok());
        assert!(push(&mut decoder, format!("data:{}", "x".repeat(MAX_EVENT_BYTES - quarter - 6)).as_bytes()).is_ok());
        assert_eq!(push(&mut decoder, b"\r"), Ok(Vec::new()));
        assert_eq!(push(&mut decoder, b"\n"), Err(Error::EventTooLarge));
    }

    #[test]
    fn a_fragment_can_end_one_bounded_frame_and_start_the_next() {
        let mut decoder = Decoder::new();
        let text = "x".repeat(MAX_EVENT_BYTES - 7);
        assert!(push(&mut decoder, format!("data:{text}").as_bytes()).unwrap().is_empty());
        assert_eq!(push(&mut decoder, b"\n\ndata:next\n\n").unwrap(), [text, "next".into()]);
    }
}
