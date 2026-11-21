use super::{bind_termination, revoke, AppState, RemoteDictation};
use crate::cli_manager::{local_session_cookie, LocalCliAccess};
use tauri::{
    webview::{NewWindowResponse, PageLoadEvent},
    AppHandle, Manager, WebviewUrl, WebviewWindowBuilder,
};
use url::Url;

const CONTEXT: &str = "window.__CODENOMAD_RUNTIME_HOST__ = 'tauri'; window.__CODENOMAD_WINDOW_CONTEXT__ = 'dictation';";

fn sheet_navigation(app: &AppHandle, label: &str, url: &Url) -> bool {
    let allowed = app
        .state::<RemoteDictation>()
        .0
        .lock()
        .sheet
        .as_ref()
        .is_some_and(|sheet| {
            sheet.label == label
                && !sheet.started
                && (url.as_str() == "about:blank" || sheet_target_matches(&sheet.target, url))
        });
    if !allowed {
        revoke(app, Some(label));
    }
    allowed
}

fn sheet_loaded(app: &AppHandle, label: &str, event: PageLoadEvent, url: &Url) {
    if url.as_str() == "about:blank" {
        return;
    }
    let relay = app.state::<RemoteDictation>();
    let mut slot = relay.0.lock();
    let Some(sheet) = slot.sheet.as_mut().filter(|sheet| sheet.label == label) else {
        return;
    };
    if sheet_target_matches(&sheet.target, url) {
        match event {
            PageLoadEvent::Started if !sheet.started => {
                sheet.started = true;
                return;
            }
            PageLoadEvent::Finished if sheet.started && !sheet.ready => {
                sheet.ready = true;
                drop(slot);
                if let Some(window) = app.get_webview_window(label) {
                    if window.show().and_then(|_| window.set_focus()).is_err() {
                        revoke(app, Some(label));
                    }
                }
                return;
            }
            _ => (),
        }
    }
    drop(slot);
    revoke(app, Some(label));
}

pub(super) fn sheet_target_matches(target: &Url, actual: &Url) -> bool {
    // Native navigation events can omit the fragment, which never reaches
    // the server. The renderer itself gets it from the original navigate URL.
    target.origin() == actual.origin()
        && target.path() == actual.path()
        && target.query() == actual.query()
        && actual
            .fragment()
            .is_none_or(|fragment| Some(fragment) == target.fragment())
}

pub(super) fn open_sheet(
    app: &AppHandle,
    label: &str,
    target: Url,
    generation: u64,
    access: Option<LocalCliAccess>,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    if !state.manager.is_ready_generation(generation) {
        return Err("Local dictation backend changed".into());
    }
    let nav_app = app.clone();
    let nav_label = label.to_owned();
    let builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(Url::parse("about:blank").expect("valid blank URL")),
    )
    .data_directory(state.webview_data_directory.join("local"))
    .initialization_script(CONTEXT)
    .on_navigation(move |url| sheet_navigation(&nav_app, &nav_label, url))
    .on_page_load(|window, payload| {
        sheet_loaded(
            window.app_handle(),
            window.label(),
            payload.event(),
            payload.url(),
        );
    })
    .on_new_window(|_, _| NewWindowResponse::Deny)
    .title("CodeNomad")
    .inner_size(520.0, 420.0)
    .visible(false);
    #[cfg(windows)]
    let builder = match state.developer_browser_arguments.as_deref() {
        Some(arguments) => builder.additional_browser_args(arguments),
        None => builder,
    };
    #[cfg(target_os = "macos")]
    let builder = if state.scoped_profile {
        builder.data_store_identifier(crate::profile_identifier("local"))
    } else {
        builder
    };
    let window = builder.build().map_err(|error| error.to_string())?;
    bind_termination(window.as_ref(), None);
    crate::menu_bar::hide(&window.as_ref().window());
    #[cfg(target_os = "linux")]
    crate::device_speech_ipc::bind_microphone(&window, false);
    if let Some(access) = access {
        if !crate::same_origin(&target, Some(&access.base_url)) {
            return Err("Local dictation backend changed".into());
        }
        let cookie = local_session_cookie(
            &access.base_url,
            &access.cookie_name,
            &access.session_cookie,
        )
        .map_err(|error| error.to_string())?;
        window
            .set_cookie(cookie)
            .map_err(|error| error.to_string())?;
    }
    if !state.manager.is_ready_generation(generation)
        || !app
            .state::<RemoteDictation>()
            .0
            .lock()
            .sheet
            .as_ref()
            .is_some_and(|sheet| sheet.label == label)
    {
        // A queued cleanup may have run before window creation finished.
        let _ = window.destroy();
        return Err("Dictation request ended".into());
    }
    window.navigate(target).map_err(|error| error.to_string())
}
