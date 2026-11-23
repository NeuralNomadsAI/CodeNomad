//! Windows 10 1903+ ships ICU in System32. Resolve exports at runtime for older hosts.
use std::{
    ffi::{CString, c_void},
    ptr::{null, null_mut},
    sync::OnceLock,
};
use windows_sys::Win32::{
    Foundation::FreeLibrary,
    Globalization::{UDAT_PATTERN, UDAT_SHORT, UErrorCode, UFieldPosition},
    System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW},
};

type Handle = *mut *mut c_void;
type Close = unsafe extern "C" fn(Handle);
type PatternOpen = unsafe extern "C" fn(*const u8, *mut UErrorCode) -> Handle;
type PatternBest =
    unsafe extern "C" fn(Handle, *const u16, i32, *mut u16, i32, *mut UErrorCode) -> i32;
type DateOpen = unsafe extern "C" fn(
    i32,
    i32,
    *const u8,
    *const u16,
    i32,
    *const u16,
    i32,
    *mut UErrorCode,
) -> Handle;
type DateFormat = unsafe extern "C" fn(
    *const *const c_void,
    f64,
    *mut u16,
    i32,
    *mut UFieldPosition,
    *mut UErrorCode,
) -> i32;

struct Icu {
    open_pattern: PatternOpen,
    best_pattern: PatternBest,
    close_pattern: Close,
    open_date: DateOpen,
    format_date: DateFormat,
    close_date: Close,
}

static ICU: OnceLock<Option<Icu>> = OnceLock::new();

impl Icu {
    fn load() -> Option<Self> {
        // Only system exports are loaded. Signatures match Win32::Globalization's ICU ABI.
        unsafe {
            let module = LoadLibraryExW(
                windows_sys::w!("icu.dll"),
                null_mut(),
                LOAD_LIBRARY_SEARCH_SYSTEM32,
            );
            if module.is_null() {
                return None;
            }
            let loaded = (|| {
                let get = |name: &std::ffi::CStr| GetProcAddress(module, name.as_ptr().cast());
                Some(Self {
                    open_pattern: std::mem::transmute::<_, PatternOpen>(get(c"udatpg_open")?),
                    best_pattern: std::mem::transmute::<_, PatternBest>(get(
                        c"udatpg_getBestPattern",
                    )?),
                    close_pattern: std::mem::transmute::<_, Close>(get(c"udatpg_close")?),
                    open_date: std::mem::transmute::<_, DateOpen>(get(c"udat_open")?),
                    format_date: std::mem::transmute::<_, DateFormat>(get(c"udat_format")?),
                    close_date: std::mem::transmute::<_, Close>(get(c"udat_close")?),
                })
            })();
            if loaded.is_none() {
                FreeLibrary(module);
            }
            // A successful load owns one module reference for the cached function pointers.
            loaded
        }
    }
}

pub(super) fn month_day(millis: f64, locale: &str) -> Option<String> {
    let icu = ICU.get_or_init(Icu::load).as_ref()?;
    let locale = CString::new(locale).ok()?;
    let locale = locale.as_ptr().cast();
    let skeleton = [b'M' as u16, b'M' as u16, b'M' as u16, b'd' as u16];
    let mut pattern = [0; 128];
    let mut status = 0;
    // Each handle belongs to this call. The null zone asks ICU for the user's default zone.
    unsafe {
        let generator = (icu.open_pattern)(locale, &mut status);
        if generator.is_null() {
            return None;
        }
        let len = (icu.best_pattern)(
            generator,
            skeleton.as_ptr(),
            skeleton.len() as i32,
            pattern.as_mut_ptr(),
            pattern.len() as i32,
            &mut status,
        );
        (icu.close_pattern)(generator);
        if status > 0 || len <= 0 || len as usize >= pattern.len() {
            return None;
        }
        icu.format(millis, locale, UDAT_PATTERN, &pattern[..len as usize])
    }
}

pub(super) fn short_date_time(millis: f64, locale: &str) -> Option<String> {
    let icu = ICU.get_or_init(Icu::load).as_ref()?;
    let locale = CString::new(locale).ok()?;
    icu.format(millis, locale.as_ptr().cast(), UDAT_SHORT, &[])
}

impl Icu {
    fn format(
        &self,
        millis: f64,
        locale: *const u8,
        style: i32,
        pattern: &[u16],
    ) -> Option<String> {
        let mut status = 0;
        let mut text = [0; 128];
        // ICU owns the formatter until it is closed here; a null zone uses the local timezone.
        unsafe {
            let format = (self.open_date)(
                style,
                style,
                locale,
                null(),
                0,
                pattern.as_ptr(),
                pattern.len() as i32,
                &mut status,
            );
            if format.is_null() {
                return None;
            }
            let len = (self.format_date)(
                format.cast(),
                millis,
                text.as_mut_ptr(),
                text.len() as i32,
                null_mut(),
                &mut status,
            );
            (self.close_date)(format);
            if status > 0 || len <= 0 {
                return None;
            }
            String::from_utf16(text.get(..len as usize)?).ok()
        }
    }
}
