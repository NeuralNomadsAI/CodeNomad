use crate::{
    device_speech::{DeviceSpeech, MicrophonePurpose, Request, SpeechAdmission, SpeechError},
    local_windows::LocalWindows,
    preferences_window, AppState,
};
use serde_json::{json, Value};
use tauri::{
    ipc::{Invoke, InvokeBody},
    Manager, Runtime, Webview,
};

type DocumentWitness = (std::sync::Arc<()>, u64);

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

pub(crate) fn with_document_ingress(
    fallback: impl Fn(Invoke<tauri::Wry>) -> bool,
) -> impl Fn(Invoke<tauri::Wry>) -> bool {
    with_request_handler(run_request, fallback)
}

fn with_request_handler<R: Runtime>(
    run: fn(Webview<R>, Request, DocumentWitness) -> Result<Value, String>,
    fallback: impl Fn(Invoke<R>) -> bool,
) -> impl Fn(Invoke<R>) -> bool {
    move |invoke| {
        if invoke.message.command() != "device_speech_request" {
            return fallback(invoke);
        }
        let webview = invoke.message.webview_ref().clone();
        // Bind the request to the sending document before handing it to any worker.
        let witness = webview.app_handle().state::<DeviceSpeech>().document_witness(webview.label());
        invoke.resolver.respond_async(async move {
            tauri::async_runtime::spawn_blocking(move || {
                #[derive(serde::Deserialize)]
                struct Arguments {
                    request: Request,
                }
                let InvokeBody::Json(body) = invoke.message.payload() else {
                    return Err("Invalid device speech request".to_string());
                };
                let args: Arguments = serde::Deserialize::deserialize(body)
                    .map_err(|error| format!("Invalid device speech request: {error}"))?;
                run(webview, args.request, witness)
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(Into::into)
        });
        true
    }
}

fn run_request(
    webview: Webview,
    request: Request,
    witness: DocumentWitness,
) -> Result<Value, String> {
    let app = webview.app_handle();
    let state = app.state::<AppState>();
    let speech = app.state::<DeviceSpeech>();
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
    let preflight = speech.preflight(witness, &request);
    let result = crate::shutdown::with_navigation_authority(app, || {
        if sheet {
            crate::remote_dictation::with_trusted_sheet(
                app,
                label,
                &current,
                matches!(request, Request::Read {}),
                || speech.admit(label, request, preflight, false),
            )
        } else {
            Some(match request {
                #[cfg(target_os = "linux")]
                Request::AuthorizeApiMicrophone { id } => speech
                    .authorize_api_microphone(label, &current, id, preferences, preflight)
                    .map(SpeechAdmission::Complete),
                #[cfg(target_os = "linux")]
                Request::RevokeApiMicrophone { id } => speech
                    .revoke_api_microphone(label, &id, preflight)
                    .map(SpeechAdmission::Complete),
                request => speech.admit(label, request, preflight, false),
            })
        }
    })
    .ok_or("Application is shutting down")?
    .ok_or("Device speech requires the registered local dictation sheet")?;
    Ok(speech_response(result.and_then(
        |admission| match admission {
            SpeechAdmission::Complete(value) => Ok(value),
            SpeechAdmission::Select(engine, caps, preflight) => {
                speech.finish_selection(label, engine, caps, preflight, |admit| {
                    crate::shutdown::with_navigation_authority(app, admit) == Some(true)
                })
            }
            SpeechAdmission::CancelCommit(control) => speech.finish_cancel(label, control),
        },
    )))
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
    fn delayed_ipc_cannot_admit_a_same_origin_successor_document() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use tauri::{ipc::CallbackFn, test, webview::InvokeRequest, WebviewUrl, WebviewWindowBuilder};

        let directory = tempfile::tempdir().unwrap();
        let app = test::mock_builder()
            .manage(DeviceSpeech::new(directory.path().join("speech.json"), None))
            .manage(AtomicBool::new(true))
            .invoke_handler(with_request_handler(|webview, request, witness| {
                let app = webview.app_handle();
                let speech = app.state::<DeviceSpeech>();
                let label = webview.label();
                // Model the navigation hook after ingress but before any work
                // on the request, with the same label and trusted origin.
                let _successor = app.state::<AtomicBool>().swap(false, Ordering::SeqCst).then(|| {
                    speech.revoke(Some(label));
                    speech.document_witness(label)
                });
                let preflight = speech.preflight(witness, &request);
                let result = speech.admit(label, request, preflight, false).map(|admission| {
                    let SpeechAdmission::Complete(value) = admission else { unreachable!() };
                    value
                });
                Ok(speech_response(result))
            }, |_| false))
            .build(crate::app_context())
            .unwrap();
        let url = url::Url::parse("http://127.0.0.1:8100/").unwrap();
        let window = WebviewWindowBuilder::new(&app, "dictation-test", WebviewUrl::External(url.clone()))
            .build()
            .unwrap();
        let request = || test::get_ipc_response(&window, InvokeRequest {
            cmd: "device_speech_request".into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: url.clone(),
            body: json!({"request": {
                "action": "claimMicrophone", "purpose": "dictation", "id": uuid::Uuid::new_v4()
            }}).into(),
            headers: Default::default(),
            invoke_key: test::INVOKE_KEY.to_owned(),
        }).unwrap().deserialize::<Value>().unwrap();
        assert_eq!(request(), speech_response(Err(SpeechError::NotOwned)));
        assert_eq!(request(), speech_response(Ok(json!({ "busy": null }))));
    }

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
            MicrophonePurpose::Conversation,
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
