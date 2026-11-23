use std::{env, fs, path::Path};

pub fn local_iana_timezone() -> Option<String> {
    if let Ok(zone) = env::var("TZ") {
        return zone_name(zone.strip_prefix(':').unwrap_or(&zone));
    }
    fs::read_link("/etc/localtime")
        .ok()
        .and_then(|path| zone_name(path.to_str()?))
        .or_else(|| {
            fs::read_to_string("/etc/timezone")
                .ok()
                .and_then(|zone| zone_name(zone.trim()))
        })
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

pub fn local_date_time(millis: u64) -> Option<String> {
    let seconds = libc::time_t::try_from(millis / 1000).ok()?;
    let mut out = std::mem::MaybeUninit::uninit();
    // localtime_r initializes the caller-owned result when it returns a non-null pointer.
    let time = unsafe { libc::localtime_r(&seconds, out.as_mut_ptr()).as_ref()? };
    Some(format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        time.tm_year + 1900,
        time.tm_mon + 1,
        time.tm_mday,
        time.tm_hour,
        time.tm_min,
        time.tm_sec
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
