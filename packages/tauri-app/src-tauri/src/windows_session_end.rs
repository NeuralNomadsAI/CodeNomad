//! Windows session-end subclass. CodeNomad's bounded state flush runs on
//! WM_QUERYENDSESSION/WM_ENDSESSION before default handling. Tao's hidden thread
//! event target exits the process on WM_ENDSESSION, so that window receives the
//! message only after the flush.
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumThreadWindows, GetClassNameW, WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION,
};

const SUBCLASS_ID: usize = 0x434E_5345;
/// Window class of the hidden target window Tao creates for each event loop.
pub(crate) const TAO_EVENT_TARGET_CLASS: &str = "Tao Thread Event Target";

pub(crate) struct SessionEndHandler {
    /// WM_QUERYENDSESSION: must return promptly.
    pub(crate) query: Box<dyn Fn()>,
    /// WM_ENDSESSION with whether the session really ends.
    pub(crate) end: Box<dyn Fn(bool)>,
    /// Pass WM_ENDSESSION on to the window after `end` instead of consuming it.
    pub(crate) forward_end: bool,
}

pub(crate) fn install(hwnd: HWND, handler: SessionEndHandler) -> Result<(), String> {
    let context = Box::into_raw(Box::new(handler));
    let installed = unsafe { SetWindowSubclass(hwnd, Some(session_end_proc), SUBCLASS_ID, context as usize) };
    if installed == 0 {
        unsafe { drop(Box::from_raw(context)) };
        return Err("failed to install Windows session-end handler".to_string());
    }
    Ok(())
}

unsafe extern "system" fn session_end_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    subclass_id: usize,
    reference_data: usize,
) -> LRESULT {
    if message == WM_NCDESTROY {
        RemoveWindowSubclass(hwnd, Some(session_end_proc), subclass_id);
        let result = DefSubclassProc(hwnd, message, wparam, lparam);
        drop(Box::from_raw(reference_data as *mut SessionEndHandler));
        return result;
    }
    let handler = &*(reference_data as *const SessionEndHandler);
    if message == WM_QUERYENDSESSION {
        (handler.query)();
        return 1;
    }
    if message == WM_ENDSESSION {
        (handler.end)(wparam != 0);
        if handler.forward_end {
            return DefSubclassProc(hwnd, message, wparam, lparam);
        }
        return 0;
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

/// The calling thread's first top-level window of `class`.
pub(crate) fn current_thread_window_of_class(class: &str) -> Option<HWND> {
    struct Search {
        class: Vec<u16>,
        found: HWND,
    }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> i32 {
        let search = &mut *(data as *mut Search);
        let mut name = [0u16; 128];
        let length = GetClassNameW(hwnd, name.as_mut_ptr(), name.len() as i32);
        if length > 0 && name[..length as usize] == search.class[..] {
            search.found = hwnd;
            return 0;
        }
        1
    }
    let mut search = Search { class: class.encode_utf16().collect(), found: std::ptr::null_mut() };
    unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(visit), &mut search as *mut Search as LPARAM) };
    (!search.found.is_null()).then_some(search.found)
}

#[cfg(test)]
#[path = "windows_session_end_tests.rs"]
mod tests;
