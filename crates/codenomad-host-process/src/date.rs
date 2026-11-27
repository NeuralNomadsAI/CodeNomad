//! Safe interface to Windows locale and local civil time.
mod icu;

pub fn local_time_zone() -> Option<String> {
    icu::timezone()
}

pub fn local_date_time(millis: u64, locale: &str, zone: &str) -> Option<String> {
    icu::format(
        millis as f64,
        locale,
        "yMdjms",
        (zone == "UTC").then_some("UTC"),
    )
}

use std::ptr::null;
use windows_sys::Win32::{
    Foundation::{FILETIME, SYSTEMTIME},
    Globalization::{GetDateFormatEx, GetLocaleInfoEx, LOCALE_SMONTHDAY},
    System::Time::{FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTimeEx},
};

/// Localize Git's ISO-8601 strict author time using the application's locale.
pub fn local_month_day(stamp: &str, locale: &str) -> Option<String> {
    let (time, offset_minutes) = parse(stamp)?;
    let mut file = FILETIME::default();
    // A valid calendar time is required before converting the UTC offset.
    if unsafe { SystemTimeToFileTime(&time, &mut file) } == 0 {
        return None;
    }
    let ticks = u64::from(file.dwHighDateTime) << 32 | u64::from(file.dwLowDateTime);
    let ticks = ticks.checked_add_signed(-i64::from(offset_minutes) * 60 * 10_000_000)?;
    // FILETIME is in 100 ns ticks from 1601; ICU takes milliseconds from 1970.
    let millis = ((i128::from(ticks) - 116_444_736_000_000_000) / 10_000) as f64;
    icu::month_day(millis, locale).or_else(|| win32_month_day(ticks, locale))
}

pub fn local_clock(seconds: i64) -> Option<(i32, i32, i32, i32, i32)> {
    let (y, m, d, h, min, _) = local_clock_seconds(seconds)?;
    Some((y, m, d, h, min))
}

pub fn local_clock_seconds(seconds: i64) -> Option<(i32, i32, i32, i32, i32, i32)> {
    let ticks = u64::try_from((i128::from(seconds) + 11_644_473_600) * 10_000_000).ok()?;
    let local = local_time(ticks)?;
    Some((
        local.wYear.into(),
        local.wMonth.into(),
        local.wDay.into(),
        local.wHour.into(),
        local.wMinute.into(),
        local.wSecond.into(),
    ))
}

fn local_time(ticks: u64) -> Option<SYSTEMTIME> {
    let file = FILETIME {
        dwHighDateTime: (ticks >> 32) as u32,
        dwLowDateTime: ticks as u32,
    };
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    // A null zone selects the user's current one.
    unsafe {
        if FileTimeToSystemTime(&file, &mut utc) == 0
            || SystemTimeToTzSpecificLocalTimeEx(null(), &utc, &mut local) == 0
        {
            return None;
        }
    }
    Some(local)
}

fn win32_month_day(ticks: u64, locale: &str) -> Option<String> {
    let local = local_time(ticks)?;
    let locale: Vec<_> = locale.encode_utf16().chain([0]).collect();
    let mut pattern = [0; 128];
    let mut output = [0; 128];
    // The buffers have the advertised sizes and the locale and pattern are NUL-terminated.
    unsafe {
        let len = GetLocaleInfoEx(
            locale.as_ptr(),
            LOCALE_SMONTHDAY,
            pattern.as_mut_ptr(),
            pattern.len() as i32,
        );
        let pattern = without_nul(&pattern, len)?;
        // Keep the locale's order, separators and numeric month patterns (e.g. Japanese).
        let pattern: Vec<_> = pattern
            .replace("MMMM", "MMM")
            .replace("dd", "d")
            .encode_utf16()
            .chain([0])
            .collect();
        let len = GetDateFormatEx(
            locale.as_ptr(),
            0,
            &local,
            pattern.as_ptr(),
            output.as_mut_ptr(),
            output.len() as i32,
            null(),
        );
        without_nul(&output, len)
    }
}

fn without_nul(buffer: &[u16], len: i32) -> Option<String> {
    let len = usize::try_from(len).ok()?.checked_sub(1)?;
    String::from_utf16(buffer.get(..len)?)
        .ok()
        .filter(|s| !s.is_empty())
}

fn parse(stamp: &str) -> Option<(SYSTEMTIME, i32)> {
    let number = |a, b| {
        let digits = stamp.get(a..b)?;
        digits
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then_some(digits)?
            .parse::<u16>()
            .ok()
    };
    let bytes = stamp.as_bytes();
    if [4, 7, 10, 13, 16].map(|i| bytes.get(i).copied()) != b"--T::".map(Some) {
        return None;
    }
    let offset = match stamp.get(19..)? {
        "Z" => 0,
        suffix if suffix.len() == 6 && bytes.get(22) == Some(&b':') => {
            let hours = number(20, 22)?;
            let minutes = number(23, 25)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let sign = match bytes[19] {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            sign * i32::from(hours * 60 + minutes)
        }
        _ => return None,
    };
    Some((
        SYSTEMTIME {
            wYear: number(0, 4)?,
            wMonth: number(5, 7)?,
            wDay: number(8, 10)?,
            wHour: number(11, 13)?,
            wMinute: number(14, 16)?,
            wSecond: number(17, 19)?,
            ..Default::default()
        },
        offset,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gets_the_same_local_day_from_equivalent_instants_and_uses_the_app_language() {
        let utc = "2026-09-25T22:10:00Z";
        let fr = local_month_day(utc, "fr").unwrap();
        assert_eq!(
            local_month_day("2026-09-26T00:10:00+02:00", "fr").as_deref(),
            Some(fr.as_str())
        );
        assert_ne!(local_month_day(utc, "en").unwrap(), fr);
        assert!(local_month_day("2026-02-30T12:34:56Z", "fr").is_none());
        assert!(local_month_day(" malformed ", "fr").is_none());
    }
}
