use codenomad_client::prompt::Mention;
use std::ops::Range;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Query {
    Command(Range<usize>),
    Mention(Range<usize>),
}

// JS \s includes BOM and excludes NEXT LINE.
pub fn whitespace(c: char) -> bool {
    c == '\u{feff}' || (c != '\u{85}' && c.is_whitespace())
}

pub fn mention_start(text: &str, offset: usize) -> bool {
    !offset.checked_sub(1).is_some_and(|i| {
        let lead = text.as_bytes()[i];
        lead.is_ascii_alphanumeric() || b"_./\\:+~-".contains(&lead)
    })
}

pub fn query(text: &str, caret: usize) -> Option<Query> {
    let before = text.get(..caret)?;
    if let Some(command) = text.strip_prefix('/') {
        let end = command
            .find(whitespace)
            .map_or(text.len(), |first| first + 1);
        if (1..=end).contains(&caret) {
            return Some(Query::Command(0..caret));
        }
    }
    for (at, ch) in before.char_indices().rev() {
        if whitespace(ch) {
            break;
        }
        if ch == '@' && mention_start(before, at) {
            return Some(Query::Mention(at..caret));
        }
    }
    None
}

pub fn mention(text: &str, token: &str) -> Option<Mention> {
    if token.is_empty() {
        return None;
    }
    let at = text.find(token)?;
    let start = text[..at].encode_utf16().count();
    Some(Mention {
        start,
        end: start + token.encode_utf16().count(),
        text: token.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_ranges_are_utf8_and_prompt_mentions_are_utf16() {
        for text in ["packages/@scope/x", "user@example", "🦀 @files afterwards"] {
            assert_eq!(query(text, text.len()), None);
        }
        for (text, from, token) in [
            ("🦀 ask @rev", 9, "@rev"),
            ("请看@src", 6, "@src"),
            ("(@files", 1, "@files"),
            ("@packages/@scope/x", 0, "@packages/@scope/x"),
            ("a\u{feff}@f", 4, "@f"),
            ("a\u{85}@f", 3, "@f"),
        ] {
            let end = text.len();
            assert_eq!(query(text, end), Some(Query::Mention(from..end)));
            assert_eq!(&text[from..end], token);
        }
        assert_eq!(query("🦀 @x", 2), None);
        assert_eq!(query("/test @name", 5), Some(Query::Command(0..5)));
        assert_eq!(query("/test @name", 11), Some(Query::Mention(6..11)));
        assert_eq!(
            mention("🦀 Ask @reviewer now", "@reviewer"),
            Some(Mention {
                start: 7,
                end: 16,
                text: "@reviewer".into(),
            })
        );
    }
}
