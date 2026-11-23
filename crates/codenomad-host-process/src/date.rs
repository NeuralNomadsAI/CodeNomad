//! Safe interface to Windows locale and local civil time.
use windows::{
    Win32::{
        Foundation::{FILETIME, SYSTEMTIME},
        Globalization::{
            ENUM_DATE_FORMATS_FLAGS, GetDateFormatEx, GetLocaleInfoEx, LOCALE_SMONTHDAY,
        },
        System::Time::{
            FileTimeToSystemTime, SystemTimeToFileTime, SystemTimeToTzSpecificLocalTimeEx,
        },
    },
    core::{HSTRING, PCWSTR},
};

/// Localize Git's ISO-8601 strict author time using the application's locale.
pub fn local_month_day(stamp: &str, locale: &str) -> Option<String> {
    let (time, offset_minutes) = parse(stamp)?;
    let mut file = FILETIME::default();
    let mut utc = SYSTEMTIME::default();
    let mut local = SYSTEMTIME::default();
    let locale = HSTRING::from(locale);
    let mut pattern = [0; 128];
    let mut output = [0; 128];
    // The API writes only to the supplied buffers; None chooses the user's current time zone.
    unsafe {
        SystemTimeToFileTime(&time, &mut file).ok()?;
        let ticks = u64::from(file.dwHighDateTime) << 32 | u64::from(file.dwLowDateTime);
        let ticks = ticks.checked_add_signed(-i64::from(offset_minutes) * 60 * 10_000_000)?;
        let file = FILETIME {
            dwHighDateTime: (ticks >> 32) as u32,
            dwLowDateTime: ticks as u32,
        };
        FileTimeToSystemTime(&file, &mut utc).ok()?;
        SystemTimeToTzSpecificLocalTimeEx(None, &utc, &mut local).ok()?;
        let len = GetLocaleInfoEx(&locale, LOCALE_SMONTHDAY, Some(&mut pattern));
        let pattern = without_nul(&pattern, len)?;
        // Keep the locale's order, separators and numeric month patterns (e.g. Japanese).
        let pattern = HSTRING::from(pattern.replace("MMMM", "MMM").replace("dd", "d"));
        let len = GetDateFormatEx(
            &locale,
            ENUM_DATE_FORMATS_FLAGS(0),
            Some(&local),
            &pattern,
            Some(&mut output),
            PCWSTR::null(),
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
