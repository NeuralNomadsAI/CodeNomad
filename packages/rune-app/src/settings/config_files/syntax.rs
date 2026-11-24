/// JSONC extends serde_json's grammar with comments and trailing commas.
/// Replace those tokens with whitespace so serde_json still reports the draft's line.
pub(super) fn error_line(text: &str, jsonc: bool) -> Option<usize> {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    if text.trim().is_empty() {
        return None;
    }
    if !jsonc {
        return serde_json::from_str::<serde_json::Value>(text)
            .err()
            .map(|e| e.line());
    }
    let input = text.as_bytes();
    let mut out = input.to_vec();
    let mut i = 0;
    let mut token = None;
    let mut trailing = None;
    while i < input.len() {
        match input[i] {
            b'/' if input.get(i + 1) == Some(&b'/') => {
                while i < input.len() && !matches!(input[i], b'\n' | b'\r') {
                    out[i] = b' ';
                    i += 1;
                }
                continue;
            }
            b'/' if input.get(i + 1) == Some(&b'*') => {
                let start = i;
                i += 2;
                while i + 1 < input.len() && &input[i..i + 2] != b"*/" {
                    i += 1;
                }
                if i + 1 >= input.len() {
                    return Some(1 + input[..start].iter().filter(|&&b| b == b'\n').count());
                }
                i += 2;
                for byte in &mut out[start..i] {
                    if !matches!(*byte, b'\n' | b'\r') {
                        *byte = b' ';
                    }
                }
                continue;
            }
            b'"' => {
                token = Some(b'"');
                trailing = None;
                i += 1;
                while i < input.len() {
                    let byte = input[i];
                    i += 1;
                    match byte {
                        b'"' => break,
                        b'\\' => i += 1,
                        _ => {}
                    }
                }
                continue;
            }
            b' ' | b'\t' | b'\n' | b'\r' => {}
            byte => {
                if matches!(byte, b'}' | b']')
                    && let Some(comma) = trailing
                {
                    out[comma] = b' ';
                }
                trailing = (byte == b',' && !matches!(token, None | Some(b',' | b'{' | b'[')))
                    .then_some(i);
                token = Some(byte);
            }
        }
        i += 1;
    }
    serde_json::from_slice::<serde_json::Value>(&out)
        .err()
        .map(|e| e.line())
}

#[test]
fn jsonc_diagnostics_preserve_lines_and_strings() {
    let valid = "{\n  /* comment */ \"url\": \"https://example.test/\", // note\n}";
    assert_eq!(error_line(valid, true), None);
    assert_eq!(error_line(valid, false), Some(2));
    assert_eq!(
        error_line("{\n  /* note\n  */ \"a\": truX\n}", true),
        Some(3)
    );
    assert_eq!(error_line("{\n/* never closed", true), Some(2));
    assert_eq!(error_line("[,]", true), Some(1));
    assert_eq!(error_line("[1,,]", true), Some(1));
    assert_eq!(error_line(r#"{"escaped":"\" // /*"}"#, true), None);
}
