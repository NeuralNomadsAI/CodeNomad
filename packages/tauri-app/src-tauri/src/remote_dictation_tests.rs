use super::*;
use serde_json::json;
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[test]
fn remote_ipc_is_closed_and_ids_are_canonical_v4() {
    let id = "7b4e0123-4961-420d-8f20-8db02360743e";
    assert!(request_id(id).is_ok());
    for invalid in [
        id.to_uppercase(),
        id.replace('-', ""),
        id.replace("420d", "120d"),
        id.replace("8f20", "1f20"),
    ] {
        assert!(request_id(&invalid).is_err());
    }
    for invalid in [
        json!({"request": {"action": "read", "probe": true}}),
        json!({"request": {"action": "start", "locale": "fr-FR"}}),
        json!({"request": {"action": "begin", "id": id, "locale": "fr-FR", "wav": "audio"}}),
        json!({"request": {"action": "cancel", "id": id}, "extra": true}),
        json!({"request": {"action": "claimMicrophone", "id": id, "purpose": "inputTest"}}),
        json!({"request": {"action": "releaseMicrophone", "id": id, "purpose": "test"}}),
    ] {
        assert!(serde_json::from_value::<Arguments<Request>>(invalid).is_err());
    }
    for purpose in ["dictation", "test", "conversation"] {
        assert!(matches!(
            serde_json::from_value::<Arguments<Request>>(json!({
                "request": {"action": "claimMicrophone", "id": id, "purpose": purpose}
            }))
            .unwrap()
            .request,
            Request::ClaimMicrophone { .. }
        ));
    }
    assert!(serde_json::from_value::<Arguments<Settlement>>(json!({
        "request": {"action": "settings", "project": "/private"}
    }))
    .is_err());
    assert!(serde_json::from_value::<Arguments<Settlement>>(json!({
        "request": {"action": "cancel", "text": ""}
    }))
    .is_err());
}

#[cfg(target_os = "linux")]
#[test]
fn remote_input_test_has_a_fixed_action_and_does_not_consult_dictation_engine() {
    let id = "7b4e0123-4961-420d-8f20-8db02360743e";
    let parse =
        |request| serde_json::from_value::<Arguments<Request>>(json!({ "request": request }));
    assert!(matches!(
        parse(json!({"action": "startApiInputTest", "id": id}))
            .unwrap()
            .request,
        Request::StartApiInputTest { .. }
    ));
    for action in [
        "startApiMicrophone",
        "startApiInputTest",
        "finishApiMicrophone",
    ] {
        for field in ["purpose", "label", "destination"] {
            let mut request = json!({"action": action, "id": id});
            request[field] = json!("inputTest");
            assert!(parse(request).is_err());
        }
    }
    assert!(ApiMicrophonePurpose::InputTest.allows_engine(|| panic!("consulted the device choice")));
    for engine in [Some(Engine::Hex), None, Some(Engine::Api)] {
        assert_eq!(
            ApiMicrophonePurpose::Dictation.allows_engine(|| engine == Some(Engine::Api)),
            engine == Some(Engine::Api)
        );
    }
}

#[test]
fn remote_microphone_keeps_the_secure_app_document_boundary() {
    for (origin, allowed) in [
        ("https://remote.example/", true),
        ("https://remote.example/index.html", true),
        ("https://remote.example/previews/index.html", false),
        ("https://remote.example/remote-pair", false),
        ("http://localhost:3000/", true),
        ("http://127.1.0.1/", true),
        ("http://[::1]:3000/", true),
        ("http://remote.example/", false),
        ("http://192.168.1.2/", false),
        ("file:///index.html", false),
    ] {
        assert_eq!(
            microphone_document_url(&Url::parse(origin).unwrap()),
            allowed
        );
    }

    let app = Url::parse("https://remote.example/").unwrap();
    let mut entry = crate::RemoteWindowMetadata {
        origin: app.origin().ascii_serialization(),
        dictation_destination: app.origin().ascii_serialization(),
        dictation_document: RemoteDocument::default(),
        title: String::new(),
        allow_linux_tls_certificate: false,
        generation: 1,
        window_generation: 1,
    };
    assert!(!is_microphone_document(&entry, &app));
    entry.dictation_document.ready = true;
    // Another finished page cannot qualify by changing its URL with history.
    assert!(!is_microphone_document(&entry, &app));
    entry.dictation_document.microphone_ready = true;
    assert!(is_microphone_document(&entry, &app));
    assert!(!is_microphone_document(
        &entry,
        &Url::parse("https://other.example/").unwrap()
    ));
    assert!(!is_microphone_document(
        &entry,
        &app.join("/previews/page").unwrap()
    ));
    entry.dictation_document = RemoteDocument::default();
    assert!(!is_microphone_document(&entry, &app));
}

#[test]
fn cancel_before_begin_is_bound_to_one_document_and_bounded() {
    let id = Uuid::new_v4();
    let mut document = RemoteDocument::default();
    assert!(!document.allows(id));
    document.cancel(id);
    document.ready = true;
    assert!(!document.allows(id));
    assert!(document.allows(Uuid::new_v4()));
    let next_document = RemoteDocument {
        ready: true,
        ..RemoteDocument::default()
    };
    assert!(document.matches(&document.instance));
    assert!(!next_document.matches(&document.instance));
    assert!(next_document.allows(id));
    for _ in 0..MAX_CANCELLED_IDS * 2 {
        document.cancel(Uuid::new_v4());
    }
    assert_eq!(document.cancelled.len(), MAX_CANCELLED_IDS);
    assert!(!document.allows(id));
    assert!(!document.allows(Uuid::new_v4()));
}

#[test]
fn revocation_removes_the_matching_sheet_once() {
    let target = Url::parse("http://localhost:8100/?dictationLocale=fr-FR").unwrap();
    let (deadline, deadline_wait) = mpsc::channel();
    let (sender, receiver) = mpsc::channel();
    let id = Uuid::new_v4();
    let mut slot = Slot {
        sheet: Some(Sheet {
            originator: "remote-original".into(),
            id,
            label: "dictation-host-generated".into(),
            target: target.clone(),
            backend_generation: 1,
            remote_generation: 2,
            started: true,
            ready: true,
            reply: Box::new(move |text| sender.send(text).unwrap()),
            _deadline: deadline,
        }),
        retiring: None,
    };
    let label = "dictation-host-generated";
    let sheet = slot.sheet.as_mut().unwrap();
    sheet.ready = false;
    assert!(sheet_can_read_while_loading(sheet, label, &target, true));
    assert!(!sheet_matches(sheet, label, &target, true));
    assert!(!sheet_can_read_while_loading(
        sheet,
        "dictation-peer",
        &target,
        true
    ));
    sheet.ready = true;
    assert!(slot.take(|sheet| sheet.bound_to("remote-other")).is_none());
    assert!(slot
        .take(|sheet| sheet.originates_from("remote-original", Some(Uuid::new_v4())))
        .is_none());
    assert!(slot
        .take(|sheet| sheet_matches(sheet, label, &target, false))
        .is_none());
    let wrong = Url::parse("http://localhost:8101/?dictationLocale=fr-FR").unwrap();
    assert!(slot
        .take(|sheet| sheet_matches(sheet, label, &wrong, true))
        .is_none());
    assert!(slot
        .take(|sheet| sheet_matches(sheet, "remote-original", &target, true))
        .is_none());
    let revoked = slot
        .take(|sheet| sheet.bound_to("remote-original"))
        .unwrap();
    assert_eq!(slot.retiring.as_deref(), Some(label));
    assert!(slot
        .take(|sheet| sheet_matches(sheet, label, &target, true))
        .is_none());
    (revoked.reply)(None);
    drop(revoked._deadline);
    assert_eq!(receiver.recv().unwrap(), None);
    assert_eq!(
        deadline_wait.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    );
}

#[test]
fn destination_fragment_is_origin_only_and_sheet_stays_on_its_local_target() {
    let base = "https://user:pass@remote.example:8999/a?token=x#sensitive";
    let remote = Url::parse(base).unwrap();
    let target = sheet_target(
        "http://127.0.0.1:8100/old?secret=bad#old",
        "fr-FR",
        &remote.origin().ascii_serialization(),
    )
    .unwrap();
    assert_eq!(
        target.as_str(),
        "http://127.0.0.1:8100/?dictationLocale=fr-FR#dictationDestination=https%3A%2F%2Fremote.example%3A8999"
    );
    assert!(sheet_target_matches(&target, &target));
    assert!(!sheet_target_matches(
        &target,
        &target.join("/login").unwrap()
    ));
    assert!(!sheet_target_matches(
        &target,
        &target.join("http://localhost:8100").unwrap()
    ));
    assert!(sheet_target("https://remote.example", "fr-FR", "").is_none());
    assert!(sheet_target("http://user@localhost:8100", "fr-FR", "").is_none());
    assert!(remote_origin_matches(
        "https://remote.example:8999",
        &remote
    ));
    assert!(!remote_origin_matches("https://remote.example", &remote));
}

#[test]
fn only_plain_bounded_utf8_is_released() {
    let text = "é".repeat(MAX_TEXT_BYTES / 2);
    assert_eq!(
        settle_text(Settlement::Complete { text: text.clone() }).unwrap(),
        (Some(text.clone()), false),
    );
    assert!(settle_text(Settlement::Complete { text: text + "!" }).is_err());
    assert_eq!(settle_text(Settlement::Cancel {}).unwrap(), (None, false));
    assert_eq!(settle_text(Settlement::Settings {}).unwrap(), (None, true));
}

#[test]
fn acl_separates_remote_request_and_trusted_capture() {
    let remote: Value =
        serde_json::from_str(include_str!("../capabilities/remote-window-dictation.json")).unwrap();
    let local: Value =
        serde_json::from_str(include_str!("../capabilities/dictation-sheet.json")).unwrap();
    assert_eq!(remote["webviews"], json!(["remote-*"]));
    assert_eq!(
        remote["permissions"],
        json!(["allow-remote-dictation-request"])
    );
    assert_eq!(local["webviews"], json!(["dictation-*"]));
    assert_eq!(
        local["permissions"],
        json!([
            "allow-device-speech-request",
            "allow-settle-remote-dictation"
        ])
    );
    assert_eq!(remote["local"], false);
    assert_eq!(local["local"], false);
}

#[test]
fn app_acl_filters_before_custom_invoke_handler() {
    use tauri::{ipc::CallbackFn, test, webview::InvokeRequest};

    let app = test::mock_builder()
        .invoke_handler(|invoke| {
            invoke.resolver.resolve(invoke.acl.is_some());
            true
        })
        .build(crate::app_context())
        .unwrap();
    let remote_url = Url::parse("https://remote.example:9443").unwrap();
    let local_url = Url::parse("http://127.0.0.1:8100").unwrap();
    let remote = WebviewWindowBuilder::new(
        &app,
        "remote-test",
        WebviewUrl::External(remote_url.clone()),
    )
    .build()
    .unwrap();
    let sheet = WebviewWindowBuilder::new(
        &app,
        "dictation-test",
        WebviewUrl::External(local_url.clone()),
    )
    .build()
    .unwrap();
    for (window, url, command, allowed) in [
        (&remote, &remote_url, "remote_dictation_request", true),
        (&remote, &remote_url, "device_speech_request", false),
        (&remote, &remote_url, "settle_remote_dictation", false),
        (&sheet, &local_url, "device_speech_request", true),
        (&sheet, &local_url, "settle_remote_dictation", true),
        (&sheet, &remote_url, "settle_remote_dictation", false),
        (&sheet, &local_url, "remote_dictation_request", false),
        (&sheet, &local_url, "open_preferences_window", false),
    ] {
        let response = test::get_ipc_response(
            window,
            InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: url.clone(),
                body: json!({"request": {"action": "read"}}).into(),
                headers: Default::default(),
                invoke_key: test::INVOKE_KEY.to_owned(),
            },
        );
        if allowed {
            assert!(response.unwrap().deserialize::<bool>().unwrap());
        } else {
            assert!(response.is_err(), "{command} reached the custom handler");
        }
    }
}
