use crate::{
    device_speech::{DeviceSpeech, MicrophonePurpose, Request, SpeechError},
    local_windows::LocalWindows,
    preferences_window, AppState,
};
use serde_json::{json, Value};
use tauri::{Manager, State, Webview};

#[cfg(target_os = "linux")]
#[path = "device_speech_remote_microphone.rs"]
pub(crate) mod remote_microphone;

fn is_preferences(label: &str, window_label: &str, registered: bool) -> Result<bool, &'static str> {
    if label != window_label || (label != preferences_window::LABEL && !registered) {
        return Err("Device speech requires a registered local application webview");
    }
    Ok(label == preferences_window::LABEL)
}

fn authorize_action(preferences: bool, sheet: bool, request: &Request) -> Result<(), &'static str> {
    if preferences && matches!(request, Request::Start { .. }) {
        return Err("Dictation requires a local composer window");
    }
    if !preferences && matches!(request, Request::Select { .. } | Request::Prepare { .. }) {
        return Err("Device speech settings require the Preferences window");
    }
    if let Request::ClaimMicrophone { purpose, .. } = request {
        if preferences && *purpose != MicrophonePurpose::Test
            || sheet && *purpose != MicrophonePurpose::Dictation
        {
            return Err("Microphone purpose is unavailable in this window");
        }
    }
    Ok(())
}

pub(crate) fn is_microphone_document(url: &url::Url) -> bool {
    matches!(url.path(), "/" | "/index.html")
}

#[cfg(target_os = "linux")]
pub(crate) fn bind_microphone(window: &tauri::WebviewWindow, remote: bool) {
    use webkit2gtk::{
        glib::object::Cast, PermissionRequestExt, SettingsExt, UserMediaPermissionRequest,
        UserMediaPermissionRequestExt, WebViewExt,
    };
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    let _ = window.with_webview(move |platform| {
        let webview = platform.inner();
        if let Some(settings) = webview.settings() {
            settings.set_enable_media_stream(!remote);
        }
        webview.connect_permission_request(move |view, request| {
            let Some(media) = request.downcast_ref::<UserMediaPermissionRequest>() else {
                return false;
            };
            if remote {
                request.deny();
                return true;
            }
            let trusted = view
                .uri()
                .and_then(|uri| url::Url::parse(uri.as_str()).ok());
            let speech = app.state::<DeviceSpeech>();
            let allowed = media.is_for_audio_device()
                && !media.is_for_video_device()
                && trusted.is_some_and(|url| {
                    crate::shutdown::with_navigation_authority(&app, || {
                        if crate::remote_dictation::is_sheet(&owner) {
                            crate::remote_dictation::with_trusted_sheet(
                                &app,
                                &owner,
                                &url,
                                false,
                                || speech.claim_hex_microphone(&owner),
                            ) == Some(true)
                        } else {
                            is_microphone_document(&url)
                                && crate::is_allowed_local_origin(
                                    &url,
                                    app.state::<AppState>().manager.status().url.as_deref(),
                                )
                                && (owner == preferences_window::LABEL
                                    || app.state::<LocalWindows>().record(&owner).is_some())
                                && speech.claim_local_microphone(&owner, &url)
                        }
                    }) == Some(true)
                });
            if allowed {
                request.allow();
            } else {
                request.deny();
            }
            true
        });
    });
}

#[tauri::command]
pub(crate) fn device_speech_request(
    webview: Webview,
    state: State<'_, AppState>,
    speech: State<'_, DeviceSpeech>,
    request: Request,
) -> Result<Value, String> {
    let label = webview.label();
    let sheet = crate::remote_dictation::is_sheet(label);
    let registered = webview
        .app_handle()
        .state::<LocalWindows>()
        .record(label)
        .is_some();
    let preferences = is_preferences(label, webview.window().label(), registered || sheet)?;
    let current = webview.url().map_err(|error| error.to_string())?;
    if !sheet && !crate::is_allowed_local_origin(&current, state.manager.status().url.as_deref()) {
        return Err("Device speech requires a trusted local renderer origin".into());
    }
    if !request.valid() {
        return Err("Invalid device speech request".into());
    }
    authorize_action(preferences, sheet, &request)?;
    if matches!(
        request,
        Request::ClaimMicrophone { .. } | Request::ReleaseMicrophone { .. }
    ) && !is_microphone_document(&current)
    {
        return Err("Microphone requires the application document".into());
    }
    #[cfg(target_os = "linux")]
    let api_action = matches!(
        request,
        Request::AuthorizeApiMicrophone { .. } | Request::RevokeApiMicrophone { .. }
    );
    #[cfg(target_os = "linux")]
    if api_action && (sheet || !is_microphone_document(&current)) {
        return Err("API microphone requires the application or Preferences document".into());
    }
    #[cfg(target_os = "linux")]
    if matches!(request, Request::AuthorizeApiMicrophone { .. })
        && !webview.window().is_focused().unwrap_or(false)
    {
        return Err("Focus the application window to start recording".into());
    }
    if sheet
        && matches!(request, Request::Start { .. })
        && !webview.window().is_focused().unwrap_or(false)
    {
        return Err("Focus the local dictation sheet to start".into());
    }
    let result = crate::shutdown::with_navigation_authority(webview.app_handle(), || {
        if sheet {
            crate::remote_dictation::with_trusted_sheet(
                webview.app_handle(),
                label,
                &current,
                matches!(request, Request::Read {}),
                || speech.request(label, request),
            )
        } else {
            Some(match request {
                #[cfg(target_os = "linux")]
                Request::AuthorizeApiMicrophone { id } => {
                    speech.authorize_api_microphone(label, &current, id, preferences)
                }
                #[cfg(target_os = "linux")]
                Request::RevokeApiMicrophone { id } => {
                    speech.revoke_api_microphone(label, &id);
                    Ok(Value::Null)
                }
                request => speech.request(label, request),
            })
        }
    })
    .ok_or("Application is shutting down")?
    .ok_or("Device speech requires the registered local dictation sheet")?;
    Ok(speech_response(result))
}

pub(crate) fn speech_response(result: Result<Value, SpeechError>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_speech::Engine;

    #[test]
    fn labels_must_identify_the_registered_primary_webview() {
        let local = "local-54b30afc-3da3-4e1a-87e1-ae3b8bf142dd";
        assert_eq!(is_preferences(local, local, true), Ok(false));
        assert_eq!(
            is_preferences("preferences", "preferences", false),
            Ok(true)
        );
        assert!(is_preferences(local, local, false).is_err());
        assert!(is_preferences("remote-x", "remote-x", false).is_err());
        assert!(is_preferences("guest-x", local, false).is_err());
        assert!(is_preferences("preferences", local, false).is_err());
    }

    #[test]
    fn only_application_entry_paths_are_microphone_documents() {
        let url = |path| url::Url::parse(&format!("http://127.0.0.1:8100{path}")).unwrap();
        assert!(is_microphone_document(&url("/")));
        assert!(is_microphone_document(&url("/?preferences=speech")));
        assert!(is_microphone_document(&url("/index.html")));
        for path in [
            "/loading.html",
            "/remote-pair",
            "/preview/app",
            "/sidecars/content",
        ] {
            assert!(!is_microphone_document(&url(path)));
        }
    }

    #[test]
    fn only_preferences_changes_engine_and_only_composers_start_dictation() {
        for request in [
            Request::Select {
                engine: Engine::Api,
            },
            Request::Prepare {
                plan_id: "fresh".into(),
            },
        ] {
            assert!(authorize_action(true, false, &request).is_ok());
            assert!(authorize_action(false, false, &request).is_err());
        }
        let start = Request::Start {
            locale: "fr-FR".into(),
            engine: None,
            microphone_lease_id: None,
        };
        assert!(authorize_action(false, false, &start).is_ok());
        assert!(authorize_action(true, false, &start).is_err());
    }

    #[test]
    fn microphone_purpose_is_limited_by_window_role() {
        for purpose in [
            MicrophonePurpose::Dictation,
            MicrophonePurpose::Test,
        ] {
            let request = Request::ClaimMicrophone {
                id: uuid::Uuid::new_v4().to_string(),
                purpose,
            };
            assert!(authorize_action(false, false, &request).is_ok());
            assert_eq!(
                authorize_action(true, false, &request).is_ok(),
                purpose == MicrophonePurpose::Test
            );
            assert_eq!(
                authorize_action(false, true, &request).is_ok(),
                purpose == MicrophonePurpose::Dictation
            );
        }
    }
}
