use crate::posix_date::{civil, fixed_zone, offset_name, offset_seconds};
use std::{
    env, fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

pub fn local_time_zone() -> Option<String> {
    if let Ok(zone) = env::var("TZ") {
        let value = zone.strip_prefix(':').unwrap_or(&zone);
        return fixed_zone(value)
            .or_else(|| known_zone(value))
            .or_else(current_offset);
    }
    known_zone("/etc/localtime")
        .or_else(|| {
            fs::read_to_string("/etc/timezone")
                .ok()
                .and_then(|zone| known_zone(zone.trim()))
        })
        .or_else(current_offset)
}

fn known_zone(value: &str) -> Option<String> {
    let name = if Path::new(value).is_absolute() {
        let file = fs::canonicalize(value).ok()?;
        zone_name(file.to_str()?)?
    } else {
        zone_name(value)?
    };
    if let Some(fixed) = fixed_zone(&name) {
        return Some(fixed);
    }
    let rooted = env::var_os("TZDIR")
        .into_iter()
        .map(std::path::PathBuf::from);
    rooted
        .chain(
            [
                "/usr/share/zoneinfo",
                "/var/db/timezone/zoneinfo",
                "/usr/share/lib/zoneinfo",
            ]
            .map(Into::into),
        )
        .any(|dir| dir.join(&name).is_file())
        .then_some(name)
}

fn zone_name(zone: &str) -> Option<String> {
    let zone = zone.rsplit_once("zoneinfo/").map_or(zone, |(_, tail)| tail);
    let zone = zone.strip_prefix("posix/").unwrap_or(zone);
    let normal = Path::new(zone)
        .components()
        .all(|c| matches!(c, std::path::Component::Normal(_)));
    (normal
        && !zone.is_empty()
        && zone.len() <= 100
        && zone
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/_+-".contains(&c)))
    .then(|| zone.to_owned())
}

fn clock(seconds: i64, utc: bool) -> Option<libc::tm> {
    let seconds = libc::time_t::try_from(seconds).ok()?;
    let mut out = std::mem::MaybeUninit::uninit();
    // Both calls initialize the caller-owned result on success.
    unsafe {
        let result = if utc {
            libc::gmtime_r(&seconds, out.as_mut_ptr())
        } else {
            libc::localtime_r(&seconds, out.as_mut_ptr())
        };
        (!result.is_null()).then(|| out.assume_init())
    }
}

fn current_offset() -> Option<String> {
    let seconds =
        i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs()).ok()?;
    offset_name(clock(seconds, false)?.tm_gmtoff as i64)
}

pub fn local_date_time(millis: u64, locale: &str, zone: &str) -> Option<String> {
    let seconds = i64::try_from(millis / 1000).ok()?;
    let offset = offset_seconds(zone);
    let time = clock(seconds.checked_add(offset.unwrap_or(0))?, offset.is_some())?;
    Some(civil(
        [
            time.tm_year + 1900,
            time.tm_mon + 1,
            time.tm_mday,
            time.tm_hour,
            time.tm_min,
            time.tm_sec,
        ],
        locale,
    ))
}

#[cfg(test)]
#[test]
fn host_symlinks_keep_the_iana_name() {
    assert_eq!(
        zone_name("/var/db/timezone/zoneinfo/Europe/Paris").as_deref(),
        Some("Europe/Paris")
    );
    assert_eq!(
        zone_name("/usr/share/zoneinfo/posix/America/New_York").as_deref(),
        Some("America/New_York")
    );
    assert_eq!(zone_name("/etc/localtime"), None);
    assert_eq!(zone_name("../Europe/Paris"), None);
}
