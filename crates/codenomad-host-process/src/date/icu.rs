//! Windows 10 1903+ ships ICU in System32. Resolve exports at runtime for older hosts.
use std::{
    ffi::{CString, c_void},
    ptr::{null, null_mut},
    sync::OnceLock,
};
use windows_sys::Win32::{
    Foundation::FreeLibrary,
    Globalization::{UDAT_PATTERN, UErrorCode, UFieldPosition},
    System::LibraryLoader::{GetProcAddress, LOAD_LIBRARY_SEARCH_SYSTEM32, LoadLibraryExW},
};

type Handle = *mut *mut c_void;
type Close = unsafe extern "C" fn(Handle);
type DefaultZone = unsafe extern "C" fn(*mut u16, i32, *mut UErrorCode) -> i32;
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
    default_zone: Option<DefaultZone>,
}

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
                    default_zone: get(c"ucal_getDefaultTimeZone")
                        .map(|symbol| std::mem::transmute::<_, DefaultZone>(symbol)),
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

static ICU: OnceLock<Option<Icu>> = OnceLock::new();

pub(super) fn timezone() -> Option<String> {
    let query = ICU.get_or_init(Icu::load).as_ref()?.default_zone?;
    let mut text = [0; 128];
    let mut status = 0;
    // ICU writes at most the advertised capacity; the returned length excludes the terminator.
    let len = unsafe { query(text.as_mut_ptr(), text.len() as i32, &mut status) };
    (status <= 0 && len > 0)
        .then(|| String::from_utf16(text.get(..len as usize)?).ok())
        .flatten()
}

pub(super) fn month_day(millis: f64, locale: &str) -> Option<String> {
    format(millis, locale, "MMMd", None)
}

pub(super) fn format(
    millis: f64,
    locale: &str,
    skeleton: &str,
    zone: Option<&str>,
) -> Option<String> {
    let icu = ICU.get_or_init(Icu::load).as_ref()?;
    let locale = CString::new(locale).ok()?;
    let locale = locale.as_ptr().cast();
    let skeleton = skeleton.encode_utf16().collect::<Vec<_>>();
    let zone = zone.map(|zone| zone.encode_utf16().collect::<Vec<_>>());
    let mut pattern = [0; 128];
    let mut text = [0; 128];
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
        status = 0;
        let format = (icu.open_date)(
            UDAT_PATTERN,
            UDAT_PATTERN,
            locale,
            zone.as_ref().map_or(null(), Vec::as_ptr),
            zone.as_ref().map_or(0, |zone| zone.len() as i32),
            pattern.as_ptr(),
            len,
            &mut status,
        );
        if format.is_null() {
            return None;
        }
        let len = (icu.format_date)(
            format.cast(),
            millis,
            text.as_mut_ptr(),
            text.len() as i32,
            null_mut(),
            &mut status,
        );
        (icu.close_date)(format);
        if status > 0 || len <= 0 {
            return None;
        }
        String::from_utf16(text.get(..len as usize)?).ok()
    }
}
