//! Revoke preview authority on native window transitions, including system controls.
use super::BrowserController;

pub(super) fn observe(window: &tauri::Window, controller: BrowserController) -> tauri::Result<()> {
    let owner = window.clone();
    window.run_on_main_thread(move || {
        let label = owner.label().to_owned();
        if let Err(error) = install(&owner, move || controller.revoke_window_visibility(&label)) {
            eprintln!("[browser] could not observe preview owner visibility: {error}");
        }
    })
}

#[cfg(target_os = "linux")]
fn install(window: &tauri::Window, revoke: impl Fn() + Clone + 'static) -> Result<(), String> {
    use gtk::{gdk::WindowState, prelude::WidgetExt};
    let window = window.gtk_window().map_err(|error| error.to_string())?;
    let hidden = revoke.clone();
    window.connect_hide(move |_| hidden());
    window.connect_window_state_event(move |_, event| {
        if event.changed_mask().contains(WindowState::ICONIFIED)
            && event.new_window_state().contains(WindowState::ICONIFIED)
        {
            revoke();
        }
        gtk::glib::Propagation::Proceed
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn install(window: &tauri::Window, revoke: impl Fn() + 'static) -> Result<(), String> {
    use std::ffi::c_void;
    extern "C" {
        fn cn_observe_owner_visibility(
            window: *mut c_void,
            callback: unsafe extern "C" fn(*mut c_void),
            release: unsafe extern "C" fn(*mut c_void),
            context: *mut c_void,
        );
    }
    unsafe extern "C" fn changed(context: *mut c_void) {
        unsafe { (&*context.cast::<Box<dyn Fn()>>())() };
    }
    unsafe extern "C" fn released(context: *mut c_void) {
        drop(unsafe { Box::from_raw(context.cast::<Box<dyn Fn()>>()) });
    }
    let window = window.ns_window().map_err(|error| error.to_string())?;
    let callback: Box<dyn Fn()> = Box::new(revoke);
    let context = Box::into_raw(Box::new(callback)).cast();
    unsafe { cn_observe_owner_visibility(window, changed, released, context) };
    Ok(())
}

#[cfg(windows)]
fn install(window: &tauri::Window, revoke: impl Fn() + 'static) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SIZE_MINIMIZED, WM_NCDESTROY, WM_SHOWWINDOW, WM_SIZE,
    };

    const SUBCLASS_ID: usize = 0x434E_4256;
    unsafe extern "system" fn observe(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        id: usize,
        ctx: usize,
    ) -> LRESULT {
        let context = ctx as *mut Box<dyn Fn()>;
        if message == WM_NCDESTROY {
            unsafe { RemoveWindowSubclass(window, Some(observe), id) };
            drop(unsafe { Box::from_raw(context) });
        } else if (message == WM_SHOWWINDOW && wparam == 0)
            || (message == WM_SIZE && wparam == SIZE_MINIMIZED as usize)
        {
            unsafe { (*context)() };
        }
        unsafe { DefSubclassProc(window, message, wparam, lparam) }
    }
    let window = window.hwnd().map_err(|error| error.to_string())?;
    let callback: Box<dyn Fn()> = Box::new(revoke);
    let context = Box::into_raw(Box::new(callback));
    if unsafe {
        SetWindowSubclass(window.0.cast(), Some(observe), SUBCLASS_ID, context as usize)
    } == 0
    {
        drop(unsafe { Box::from_raw(context) });
        return Err("Could not install preview owner visibility handler".into());
    }
    Ok(())
}
