const BOM: char = '\u{feff}';

/// Keep disk bytes for exact conflict checks, separate from the LF text sent to the editor.
pub(super) struct Snapshot {
    pub text: String,
    pub wire: String,
    ending: &'static str,
}

impl Snapshot {
    pub fn loaded(wire: &str) -> Self {
        let text = wire.strip_prefix(BOM).unwrap_or(wire);
        Self {
            text: lf(text),
            wire: wire.into(),
            ending: eol(text),
        }
    }

    pub fn edited(&self, text: &str) -> Self {
        let text = lf(text);
        let mut wire = if self.ending == "\n" {
            text.clone()
        } else {
            text.replace('\n', self.ending)
        };
        if self.wire.starts_with(BOM) {
            wire.insert(0, BOM);
        }
        Self {
            text,
            wire,
            ending: self.ending,
        }
    }
}

fn eol(text: &str) -> &'static str {
    let mut crlf = 0;
    let mut lf_only = 0;
    let mut cr = 0;
    let mut previous_cr = false;
    for byte in text.bytes() {
        match byte {
            b'\n' if previous_cr => {
                crlf += 1;
                cr -= 1;
            }
            b'\n' => lf_only += 1,
            b'\r' => cr += 1,
            _ => {}
        }
        previous_cr = byte == b'\r';
    }
    if crlf > lf_only + cr {
        "\r\n"
    } else if cr > lf_only + crlf {
        "\r"
    } else {
        "\n"
    }
}

pub(super) fn lf(text: &str) -> String {
    if text.contains('\r') {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_retains_original_format_after_the_editor_normalizes_or_removes_lines() {
        for (wire, expected) in [
            ("\u{feff}a\r\nb\r\n", "\u{feff}a\r\nbx"),
            ("a\nb\n", "a\nbx"),
            ("a\rb\r", "a\rbx"),
        ] {
            let snapshot = Snapshot::loaded(wire);
            assert_eq!(snapshot.text, "a\nb\n");
            assert_eq!(snapshot.edited("a\nbx").wire, expected);
            assert_eq!(snapshot.edited("one").edited("a\nbx").wire, expected);
        }
        assert_eq!(Snapshot::loaded("a\r\nb\nc").edited("a\nb\ncx").wire, "a\nb\ncx");
    }
}
