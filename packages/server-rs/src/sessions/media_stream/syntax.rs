//! Streaming RFC 8259 JSON syntax validator with bounded nesting depth.

const MAX_SYNTAX_DEPTH: usize = 1024;

#[derive(Clone, Copy)]
enum Esc {
    None,
    Slash,
    Hex(u8),
}

#[derive(Clone, Copy)]
enum NumState {
    Sign,
    Zero,
    Int,
    DotStart,
    Frac,
    ExpSign,
    ExpStart,
    Exp,
}

#[derive(Clone, Copy)]
enum SyntaxState {
    ExpectValue,
    AfterValue,
    ObjKeyOrEnd,
    ObjKey,
    ObjColon,
    ArrValueOrEnd,
    String { in_key: bool, esc: Esc, utf8_rem: u8, utf8_min: u8, utf8_max: u8 },
    Number(NumState),
    Keyword(&'static [u8], usize),
    Invalid,
}

/// Streaming RFC 8259 JSON syntax validator with bounded stack (`<= 1 KiB`) so `finish()`
/// restores the unmodified upstream bytes whenever the full document is not valid JSON
/// (matching TS `proxy.ts:91` `JSON.parse` fallback).
pub(super) struct JsonSyntax {
    state: SyntaxState,
    stack: Vec<u8>,
}

impl JsonSyntax {
    pub(super) fn new() -> Self {
        Self { state: SyntaxState::ExpectValue, stack: Vec::new() }
    }

    pub(super) fn feed(&mut self, bytes: &[u8]) {
        for &b in bytes {
            if matches!(self.state, SyntaxState::Invalid) {
                return;
            }
            self.step(b);
        }
    }

    fn step(&mut self, b: u8) {
        let current = b;
        loop {
            match self.state {
                SyntaxState::Invalid => return,
                SyntaxState::String { in_key, esc, utf8_rem, utf8_min, utf8_max } => {
                    match esc {
                        Esc::None => {
                            if utf8_rem > 0 {
                                if current >= utf8_min && current <= utf8_max {
                                    self.state = SyntaxState::String {
                                        in_key,
                                        esc: Esc::None,
                                        utf8_rem: utf8_rem - 1,
                                        utf8_min: 0x80,
                                        utf8_max: 0xBF,
                                    };
                                } else {
                                    self.state = SyntaxState::Invalid;
                                }
                            } else {
                                match current {
                                    b'"' => {
                                        self.state =
                                            if in_key { SyntaxState::ObjColon } else { SyntaxState::AfterValue };
                                    }
                                    b'\\' => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::Slash,
                                            utf8_rem: 0,
                                            utf8_min: 0x80,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0x00..=0x1F => self.state = SyntaxState::Invalid,
                                    0x20..=0x7F => {}
                                    0xC2..=0xDF => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 1,
                                            utf8_min: 0x80,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0xE0 => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 2,
                                            utf8_min: 0xA0,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0xE1..=0xEC | 0xEE..=0xEF => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 2,
                                            utf8_min: 0x80,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0xED => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 2,
                                            utf8_min: 0x80,
                                            utf8_max: 0x9F,
                                        };
                                    }
                                    0xF0 => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 3,
                                            utf8_min: 0x90,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0xF1..=0xF3 => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 3,
                                            utf8_min: 0x80,
                                            utf8_max: 0xBF,
                                        };
                                    }
                                    0xF4 => {
                                        self.state = SyntaxState::String {
                                            in_key,
                                            esc: Esc::None,
                                            utf8_rem: 3,
                                            utf8_min: 0x80,
                                            utf8_max: 0x8F,
                                        };
                                    }
                                    _ => self.state = SyntaxState::Invalid,
                                }
                            }
                        }
                        Esc::Slash => match current {
                            b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => {
                                self.state = SyntaxState::String {
                                    in_key,
                                    esc: Esc::None,
                                    utf8_rem: 0,
                                    utf8_min: 0x80,
                                    utf8_max: 0xBF,
                                };
                            }
                            b'u' => {
                                self.state = SyntaxState::String {
                                    in_key,
                                    esc: Esc::Hex(4),
                                    utf8_rem: 0,
                                    utf8_min: 0x80,
                                    utf8_max: 0xBF,
                                };
                            }
                            _ => self.state = SyntaxState::Invalid,
                        },
                        Esc::Hex(rem) => {
                            if current.is_ascii_hexdigit() {
                                self.state = SyntaxState::String {
                                    in_key,
                                    esc: if rem <= 1 { Esc::None } else { Esc::Hex(rem - 1) },
                                    utf8_rem: 0,
                                    utf8_min: 0x80,
                                    utf8_max: 0xBF,
                                };
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                    }
                    return;
                }
                SyntaxState::Keyword(expected, idx) => {
                    if current == expected[idx] {
                        if idx + 1 == expected.len() {
                            self.state = SyntaxState::AfterValue;
                        } else {
                            self.state = SyntaxState::Keyword(expected, idx + 1);
                        }
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::Number(num) => {
                    match num {
                        NumState::Sign => match current {
                            b'0' => self.state = SyntaxState::Number(NumState::Zero),
                            b'1'..=b'9' => self.state = SyntaxState::Number(NumState::Int),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Zero => match current {
                            b'.' => self.state = SyntaxState::Number(NumState::DotStart),
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            b'0'..=b'9' => self.state = SyntaxState::Invalid,
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::Int => match current {
                            b'0'..=b'9' => {}
                            b'.' => self.state = SyntaxState::Number(NumState::DotStart),
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::DotStart => match current {
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Frac),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Frac => match current {
                            b'0'..=b'9' => {}
                            b'e' | b'E' => self.state = SyntaxState::Number(NumState::ExpSign),
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                        NumState::ExpSign => match current {
                            b'+' | b'-' => self.state = SyntaxState::Number(NumState::ExpStart),
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Exp),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::ExpStart => match current {
                            b'0'..=b'9' => self.state = SyntaxState::Number(NumState::Exp),
                            _ => self.state = SyntaxState::Invalid,
                        },
                        NumState::Exp => match current {
                            b'0'..=b'9' => {}
                            _ => {
                                self.state = SyntaxState::AfterValue;
                                continue;
                            }
                        },
                    }
                    return;
                }
                SyntaxState::ExpectValue | SyntaxState::ArrValueOrEnd => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if matches!(self.state, SyntaxState::ArrValueOrEnd) && current == b']' {
                        if self.stack.pop() == Some(b'[') {
                            self.state = SyntaxState::AfterValue;
                        } else {
                            self.state = SyntaxState::Invalid;
                        }
                        return;
                    }
                    match current {
                        b'{' => {
                            if self.stack.len() >= MAX_SYNTAX_DEPTH {
                                self.state = SyntaxState::Invalid;
                            } else {
                                self.stack.push(b'{');
                                self.state = SyntaxState::ObjKeyOrEnd;
                            }
                        }
                        b'[' => {
                            if self.stack.len() >= MAX_SYNTAX_DEPTH {
                                self.state = SyntaxState::Invalid;
                            } else {
                                self.stack.push(b'[');
                                self.state = SyntaxState::ArrValueOrEnd;
                            }
                        }
                        b'"' => {
                            self.state = SyntaxState::String {
                                in_key: false,
                                esc: Esc::None,
                                utf8_rem: 0,
                                utf8_min: 0x80,
                                utf8_max: 0xBF,
                            }
                        }
                        b'-' => self.state = SyntaxState::Number(NumState::Sign),
                        b'0' => self.state = SyntaxState::Number(NumState::Zero),
                        b'1'..=b'9' => self.state = SyntaxState::Number(NumState::Int),
                        b't' => self.state = SyntaxState::Keyword(b"rue", 0),
                        b'f' => self.state = SyntaxState::Keyword(b"alse", 0),
                        b'n' => self.state = SyntaxState::Keyword(b"ull", 0),
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
                SyntaxState::ObjKeyOrEnd => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    match current {
                        b'}' => {
                            if self.stack.pop() == Some(b'{') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        b'"' => {
                            self.state = SyntaxState::String {
                                in_key: true,
                                esc: Esc::None,
                                utf8_rem: 0,
                                utf8_min: 0x80,
                                utf8_max: 0xBF,
                            }
                        }
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
                SyntaxState::ObjKey => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if current == b'"' {
                        self.state = SyntaxState::String {
                            in_key: true,
                            esc: Esc::None,
                            utf8_rem: 0,
                            utf8_min: 0x80,
                            utf8_max: 0xBF,
                        };
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::ObjColon => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    if current == b':' {
                        self.state = SyntaxState::ExpectValue;
                    } else {
                        self.state = SyntaxState::Invalid;
                    }
                    return;
                }
                SyntaxState::AfterValue => {
                    if matches!(current, b' ' | b'\t' | b'\r' | b'\n') {
                        return;
                    }
                    match current {
                        b',' => match self.stack.last().copied() {
                            Some(b'{') => self.state = SyntaxState::ObjKey,
                            Some(b'[') => self.state = SyntaxState::ExpectValue,
                            _ => self.state = SyntaxState::Invalid,
                        },
                        b'}' => {
                            if self.stack.pop() == Some(b'{') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        b']' => {
                            if self.stack.pop() == Some(b'[') {
                                self.state = SyntaxState::AfterValue;
                            } else {
                                self.state = SyntaxState::Invalid;
                            }
                        }
                        _ => self.state = SyntaxState::Invalid,
                    }
                    return;
                }
            }
            #[allow(unreachable_code)]
            {
                current = b;
            }
        }
    }

    pub(super) fn is_valid_eof(&self) -> bool {
        self.stack.is_empty()
            && matches!(
                self.state,
                SyntaxState::AfterValue
                    | SyntaxState::Number(NumState::Zero | NumState::Int | NumState::Frac | NumState::Exp)
            )
    }
}

pub(crate) fn validate_json_syntax(raw: &[u8]) -> bool {
    let mut syntax = JsonSyntax::new();
    syntax.feed(raw);
    syntax.is_valid_eof()
}
