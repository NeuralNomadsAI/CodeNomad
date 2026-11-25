use crate::history::Result;

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
pub(super) struct StringScanner {
    escape: StrEscape,
    utf8_need: u8,
    utf8_min_next: u8,
    utf8_max_next: u8,
}

impl StringScanner {
    pub(super) const fn new() -> Self {
        Self {
            escape: StrEscape::None,
            utf8_need: 0,
            utf8_min_next: 0x80,
            utf8_max_next: 0xBF,
        }
    }

    /// Feeds one byte of a JSON string body (after the opening `"`).
    /// Returns `Ok(true)` if `b` is the closing unescaped `"`, `Ok(false)` otherwise.
    pub(super) fn step(&mut self, b: u8) -> Result<bool> {
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

pub(super) fn validate_primitive(bytes: &[u8]) -> Result<()> {
    if matches!(bytes, b"true" | b"false" | b"null") {
        return Ok(());
    }
    serde_json::from_slice::<serde_json::Number>(bytes)
        .map(|_| ())
        .map_err(|_| "invalid JSON primitive".into())
}

pub(super) fn upsert_field(fields: &mut Vec<(String, Vec<u8>)>, key: String, value: Vec<u8>) {
    if let Some(existing) = fields.iter_mut().find(|(k, _)| k == &key) {
        existing.1 = value;
    } else {
        fields.push((key, value));
    }
}

pub(super) fn is_ws(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\r' | b'\n')
}
