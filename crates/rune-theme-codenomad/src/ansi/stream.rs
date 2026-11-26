//! Decode complete SGR controls and retain the unfinished tail of a running log.
use super::{Log, render};
use rune::El;

const ESCAPED: [&str; 5] = ["\\u001b", "\\u001B", "\\x1b", "\\x1B", "\\033"];

pub fn present(source: &str) -> bool {
    source.contains('\u{1b}') || ESCAPED.iter().any(|escape| source.contains(escape))
}

// Return the start of an incomplete escape, which a later chunk can finish.
fn feed(out: &mut Log, mut source: &str, streaming: bool) -> usize {
    let total = source.len();
    let mut parser = vte::Parser::new();
    // A transcript is a log, not a terminal. Feed only complete SGR to VTE;
    // unsupported or truncated escapes retain their printable text.
    while let Some(index) = source.find(['\u{1b}', '\\']) {
        out.literal(&source[..index]);
        if out.at_limit() {
            return total;
        }
        let rest = &source[index..];
        let escape_len = if rest.starts_with('\u{1b}') {
            1
        } else {
            ESCAPED
                .iter()
                .find(|escape| rest.starts_with(**escape))
                .map_or(1, |escape| escape.len())
        };
        let tail = &rest[escape_len..];
        let escaped = escape_len > 1 || rest.starts_with('\u{1b}');
        if streaming
            && (escaped && tail.is_empty()
                || ESCAPED
                    .iter()
                    .any(|escape| escape.starts_with(rest) && *escape != rest))
        {
            return total - rest.len();
        }
        if escaped && tail.starts_with('[') {
            let end = tail.as_bytes()[1..]
                .iter()
                .position(|&byte| !byte.is_ascii_digit() && !matches!(byte, b';' | b':'))
                .map(|index| index + 1);
            if streaming && end.is_none() {
                return total - rest.len();
            }
            if let Some(end) = end.filter(|&index| tail.as_bytes()[index] == b'm') {
                parser.advance(out, b"\x1b");
                parser.advance(out, &tail.as_bytes()[..=end]);
                source = &tail[end + 1..];
                continue;
            }
        }
        out.literal(&rest[..escape_len]);
        source = tail;
    }
    if !out.at_limit() {
        out.literal(source);
    }
    total
}

fn finish(mut out: Log, streaming: bool) -> Log {
    if !streaming && out.pending_cr {
        out.push('\n');
    }
    out.finish_run();
    out
}

pub(super) fn parse(source: &str) -> Log {
    parse_bounded(source, None)
}

pub(super) fn parse_bounded(source: &str, max_bytes: Option<usize>) -> Log {
    let mut out = Log {
        text_limit: max_bytes,
        ..Log::default()
    };
    feed(&mut out, source, false);
    finish(out, false)
}

/// Retains parsed style and text when a bounded preview grows by append.
#[derive(Default)]
pub struct Stream {
    source: String,
    consumed: usize,
    log: Log,
}

impl Stream {
    fn update(&mut self, source: &str) -> Log {
        if !source.starts_with(&self.source) {
            *self = Self::default();
        }
        self.source.push_str(&source[self.source.len()..]);
        self.consumed += feed(&mut self.log, &source[self.consumed..], true);
        finish(self.log.clone(), true)
    }

    pub fn code(
        &mut self,
        source: &str,
        wrap: bool,
        query: Option<crate::timeline::search::Query<'_>>,
    ) -> El {
        render(self.update(source), wrap, query)
    }
}

#[cfg(test)]
#[test]
fn an_incremental_preview_keeps_sgr_across_chunks_and_resets_on_replacement() {
    use super::{rgb, styled};

    let mut stream = Stream::default();
    let (text, spans, _, _) = styled(stream.update("before \\x"));
    assert_eq!(text, "before ");
    assert!(spans.is_empty());
    let (text, spans, _, _) = styled(stream.update("before \\x1b[31"));
    assert_eq!(text, "before ");
    assert!(spans.is_empty());
    let (text, spans, _, _) = styled(stream.update("before \\x1b[31mRED"));
    assert_eq!(text, "before RED");
    assert_eq!(spans[0].color, Some(rgb(187, 0, 0)));
    let (text, spans, _, _) = styled(stream.update("before \\x1b[31mRED STILL\u{1b}[0m"));
    assert_eq!(text, "before RED STILL");
    assert_eq!(spans[0].end as usize, text.len());
    let (text, spans, _, _) = styled(stream.update("replaced"));
    assert_eq!(text, "replaced");
    assert!(spans.is_empty());

    // Long split SGR sequences (> 256 bytes) wait for their terminator just like batch parse.
    let prefix = format!("\u{1b}[{}8", "0".repeat(254));
    let full = format!("{prefix}mSECRET\u{1b}[0m ok");
    let mut split_stream = Stream::default();
    let (partial_text, _, _, _) = styled(split_stream.update(&prefix));
    assert!(partial_text.is_empty());
    let (final_text, _, _, _) = styled(split_stream.update(&full));
    let (batch_text, _, _, _) = styled(parse(&full));
    assert_eq!(final_text, batch_text);
    assert_eq!(final_text, "       ok");
    assert!(!final_text.contains("SECRET"));
}
