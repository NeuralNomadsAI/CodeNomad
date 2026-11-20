//! xAI Grok usage: bounded gRPC-web frames and only the corroborated protobuf fields.
use super::shared::*;
use crate::shared::now_ms;
use serde_json::Value;

pub async fn read(http: &Http, auth: &Value) -> Quota {
    let entry = oauth(auth, &["xai", "grok"]);
    let token = access(entry).ok_or(MISSING)?;
    if stale(entry, token) {
        return Err(FAILED);
    }
    let response = http
        .send(
            "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
            &[
                ("Authorization", &format!("Bearer {token}")),
                ("Origin", "https://grok.com"),
                ("Referer", "https://grok.com/?_s=usage"),
                ("Content-Type", "application/grpc-web+proto"),
                ("x-grpc-web", "1"),
                ("x-user-agent", "connect-es/2.1.1"),
                ("User-Agent", "CodeNomad"),
            ],
            Some(vec![0; 5]),
            false,
        )
        .await?;
    if !(200..300).contains(&response.status)
        || response.headers.get("grpc-status").is_some_and(|s| s.to_str().ok().and_then(status) != Some(0))
    {
        return Err(FAILED);
    }
    let (used, reset) = parse(&response.bytes).ok_or(INVALID)?;
    Ok(Fields::from_iter([("billing_cycle".into(), window(Some(used), None, reset, None))]).into())
}

fn status(s: &str) -> Option<u64> {
    let s = s.trim();
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) { s.parse().ok() } else { None }
}
fn trailer(v: &[u8]) -> Option<u64> {
    let mut out = None;
    for line in std::str::from_utf8(v).ok()?.lines() {
        if line.is_empty() {
            continue;
        }
        let (k, v) = line.split_once(':')?;
        if k.is_empty() {
            return None;
        }
        if k.trim().eq_ignore_ascii_case("grpc-status") {
            if out.is_some() {
                return None;
            }
            out = Some(status(v)?);
        }
    }
    out
}
fn varint(bytes: &mut &[u8]) -> Option<u64> {
    let mut out = 0;
    for shift in (0..64).step_by(7) {
        let (b, rest) = bytes.split_first()?;
        *bytes = rest;
        if shift == 63 && b & 0x7e != 0 {
            return None;
        }
        out |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(out);
        }
    }
    None
}
#[derive(Default)]
struct QuotaScan {
    fixed: bool,
    percent: Option<(usize, usize, f64)>,
    reset: Option<u64>,
    preferred: Option<u64>,
    period: bool,
}
fn scan(mut bytes: &[u8], path: &mut Vec<u64>, out: &mut QuotaScan, order: &mut usize) -> Option<()> {
    let depth = path.len();
    while !bytes.is_empty() {
        let key = varint(&mut bytes)?;
        let n = key >> 3;
        if !(1..=0x1fffffff).contains(&n) {
            return None;
        }
        path.push(n);
        match key & 7 {
            0 => {
                let v = varint(&mut bytes)?;
                if (1_700_000_000..=2_100_000_000).contains(&v) && v * 1000 > now_ms() {
                    let set = |r: &mut Option<u64>| *r = Some(r.map_or(v, |n| n.min(v)));
                    set(&mut out.reset);
                    if *path == [1, 5, 1] {
                        set(&mut out.preferred);
                    }
                }
                out.period |= path.starts_with(&[1, 6]) || *path == [1, 8, 1] && (v == 1 || v == 2);
            }
            1 => bytes = bytes.get(8..)?,
            2 => {
                let n = usize::try_from(varint(&mut bytes)?).ok()?;
                let (desc, tail) = bytes.split_at_checked(n)?;
                bytes = tail;
                if depth < 4 {
                    scan(desc, path, out, order)?;
                } else if n != 0 {
                    return None;
                }
            }
            5 => {
                let (float, tail) = bytes.split_first_chunk::<4>()?;
                bytes = tail;
                let v = f32::from_le_bytes(*float);
                out.fixed = true;
                if (*path == [1] || *path == [1, 1])
                    && (0.0..=100.0).contains(&v)
                    && out.percent.is_none_or(|(len, prev, _)| (path.len(), *order) < (len, prev))
                {
                    out.percent = Some((path.len(), *order, f64::from(v)));
                }
                *order += 1;
            }
            _ => return None,
        }
        path.pop();
    }
    Some(())
}
fn parse(mut bytes: &[u8]) -> Option<(f64, Option<f64>)> {
    let mut out = QuotaScan::default();
    if bytes.len() >= 5 && bytes[0] & 0x7f == 0 {
        let mut trailers = false;
        while !bytes.is_empty() {
            let ([flags, a, b, c, d], rest) = bytes.split_first_chunk::<5>()?;
            let (part, rest) = rest.split_at_checked(u32::from_be_bytes([*a, *b, *c, *d]) as usize)?;
            bytes = rest;
            match flags {
                0 if !trailers => scan(part, &mut Vec::new(), &mut out, &mut 0)?,
                128 if trailer(part) == Some(0) => trailers = true,
                _ => return None,
            }
        }
    } else {
        scan(bytes, &mut Vec::new(), &mut out, &mut 0)?;
    }
    let reset = out.preferred.or(out.reset).map(|n| (n * 1000) as f64);
    let percent =
        out.percent.map(|(_, _, v)| v).or_else(|| (!out.fixed && reset.is_some() && out.period).then_some(0.0))?;
    Some((percent, reset))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_documented_paths_and_valid_frames() {
        let mut payload = vec![0x0d];
        payload.extend_from_slice(&37.5_f32.to_le_bytes());
        assert_eq!(parse(&payload), Some((37.5, None)));
        payload[0] = 0x15;
        assert_eq!(parse(&payload), None);
        assert_eq!(parse(&[0, 0, 0, 0, 1]), None);
    }
}
