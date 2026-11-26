use super::*;
use crate::settings::view;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::Arc,
};

fn make_window(prefs: Preferences) -> (Rc<RefCell<Preferences>>, rune::Runtime<view::Window>) {
    let root = crate::init();
    let shared = root.settings.shared.clone();
    *shared.borrow_mut() = prefs;
    shared.borrow_mut().window_wake = Some(Arc::new(|| {}));
    let window = view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
    let rt = rune::Runtime::new(
        window,
        view::view,
        (1100.0, 900.0),
        rune::Env::new(false, 1.0),
    );
    (shared, rt)
}

fn click(rt: &mut rune::Runtime<view::Window>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing key {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
}

fn tick(rt: &mut rune::Runtime<view::Window>) {
    rt.update(|s, tx| {
        view::spec().poll.unwrap()(s, 0.0, tx);
    });
    rt.frame(0.02);
}

async fn settle_meta(listener: &TcpListener, rt: &mut rune::Runtime<view::Window>) {
    tick(rt);
    let meta = request(listener).await;
    assert_eq!(meta.first, "GET /api/meta HTTP/1.1");
    meta.reply(200, json!({"capabilities":[]})).await;
    tick(rt);
}

fn click_option(rt: &mut rune::Runtime<view::Window>, text: &str) {
    let a11y = rt.accessibility_json();
    fn find_by_name(node: &serde_json::Value, name: &str) -> Option<String> {
        if node["role"] == "list-box-option" && node["name"] == name {
            return node["key"].as_str().map(str::to_owned);
        }
        node["children"]
            .as_array()
            .into_iter()
            .flatten()
            .find_map(|child| find_by_name(child, name))
    }
    let key = find_by_name(&a11y, text)
        .unwrap_or_else(|| panic!("missing list-box option {text:?} in {a11y}"));
    click(rt, &key);
}

async fn next_request(listener: &TcpListener, rt: &mut rune::Runtime<view::Window>) -> Request {
    timeout(Duration::from_secs(5), async {
        loop {
            tick(rt);
            if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                return read_request(socket, Duration::from_secs(3)).await;
            }
        }
    })
    .await
    .expect("timed out waiting for expected speech HTTP request")
}

#[test]
fn speech_reads_lazily_toggles_prompt_voice_input_and_persists_playback_and_credentials() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.config.snapshot = Some(json!({
            "settings": { "locale": "en", "showPromptVoiceInput": true }
        }));
        prefs.state.snapshot = Some(json!({}));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;

        // Neither Owner::Server nor /api/speech/capabilities is fetched while on General.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err(),
            "speech must not read server config or capabilities before entering Voice"
        );

        click(&mut rt, "settings-voice");
        tick(&mut rt);

        let mut got_server = false;
        let mut got_caps = false;
        while !(got_server && got_caps) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/storage/config/server?authoritative=1" {
                got_server = true;
                req.reply(
                    200,
                    json!({
                        "logLevel": "INFO",
                        "speech": {
                            "hasApiKey": true,
                            "baseUrl": "https://old.speech.test/v1",
                            "sttModel": "whisper-1",
                            "ttsModel": "tts-1",
                            "ttsVoice": "alloy",
                            "playbackMode": "streaming",
                            "ttsFormat": "mp3",
                            "separateProviders": false
                        }
                    }),
                )
                .await;
            } else if url == "/api/speech/capabilities" {
                got_caps = true;
                req.reply(
                    200,
                    json!({
                        "available": true,
                        "configured": true,
                        "provider": "openai-compatible",
                        "supportsStt": true,
                        "supportsTts": true,
                        "supportsStreamingTts": true,
                        "baseUrl": "https://old.speech.test/v1",
                        "sttModel": "whisper-1",
                        "ttsModel": "tts-1",
                        "ttsVoice": "alloy",
                        "ttsFormats": ["mp3", "wav"],
                        "streamingTtsFormats": ["mp3"],
                        "separateProviders": false,
                        "sttConfigured": true,
                        "ttsConfigured": true
                    }),
                )
                .await;
            } else {
                panic!("unexpected initial Voice request: {}", req.first);
            }
        }
        wait_until(|| {
            tick(&mut rt);
            let a11y = rt.accessibility_json().to_string();
            a11y.contains("Configured") && a11y.contains("old.speech.test")
        })
        .await;

        // Toggle behavior.promptVoiceInput -> PATCH /api/storage/config/ui.
        click(&mut rt, "behavior-showPromptVoiceInput");
        let ui_patch = next_request(&listener, &mut rt).await;
        assert_eq!(ui_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            ui_patch.body["settings"]["showPromptVoiceInput"],
            json!(false)
        );
        ui_patch
            .reply(
                200,
                json!({"settings": {"locale": "en", "showPromptVoiceInput": false}}),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json().to_string().contains("\"Off\"")
        })
        .await;

        // Change playbackMode -> Buffered, ttsFormat -> WAV, open credentials, clear saved key, enable separateProviders, and Save.
        click(&mut rt, "speech-playback-mode-trigger");
        click_option(&mut rt, "Buffered");
        click(&mut rt, "speech-tts-format-trigger");
        click_option(&mut rt, "WAV");
        click(&mut rt, "speech-open-credentials");
        tick(&mut rt);
        click(&mut rt, "speech-separate-providers");
        click(&mut rt, "speech-shared-clear-key");
        tick(&mut rt);
        assert!(
            rt.accessibility_json()
                .to_string()
                .contains("The saved API key will be removed when you save.")
        );

        click(&mut rt, "speech-save");
        let patch_req = next_request(&listener, &mut rt).await;
        assert_eq!(patch_req.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(
            patch_req.body,
            json!({
                "speech": {
                    "playbackMode": "buffered",
                    "ttsFormat": "wav",
                    "separateProviders": true,
                    "apiKey": null,
                    "baseUrl": "https://old.speech.test/v1"
                }
            })
        );
        patch_req
            .reply(
                200,
                json!({
                    "logLevel": "INFO",
                    "speech": {
                        "hasApiKey": false,
                        "baseUrl": "https://old.speech.test/v1",
                        "sttModel": "whisper-1",
                        "ttsModel": "tts-1",
                        "ttsVoice": "alloy",
                        "playbackMode": "buffered",
                        "ttsFormat": "wav",
                        "separateProviders": true
                    }
                }),
            )
            .await;

        // Confirmed save refreshes /api/speech/capabilities once.
        let cap_refresh = next_request(&listener, &mut rt).await;
        assert_eq!(cap_refresh.first, "GET /api/speech/capabilities HTTP/1.1");
        cap_refresh
            .reply(
                200,
                json!({
                    "available": true,
                    "configured": false,
                    "provider": "openai-compatible",
                    "supportsStt": true,
                    "supportsTts": true,
                    "supportsStreamingTts": true,
                    "separateProviders": true,
                    "sttConfigured": false,
                    "ttsConfigured": false
                }),
            )
            .await;
        wait_until(|| {
            tick(&mut rt);
            let a11y = rt.accessibility_json().to_string();
            a11y.contains("Setup required")
                && shared.borrow().saved(Owner::Server).is_some_and(|doc| {
                    doc["logLevel"] == "INFO" && doc["speech"]["hasApiKey"] == false
                })
        })
        .await;
    });
}

#[test]
fn speech_404_capabilities_degrades_cleanly_while_keeping_config_editing_and_cancel_working() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.config.snapshot = Some(json!({ "settings": { "locale": "en" } }));
        prefs.state.snapshot = Some(json!({}));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;

        click(&mut rt, "settings-voice");
        tick(&mut rt);

        let mut got_server = false;
        let mut got_caps = false;
        while !(got_server && got_caps) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/storage/config/server?authoritative=1" {
                got_server = true;
                req.reply(
                    200,
                    json!({
                        "speech": {
                            "hasApiKey": false,
                            "playbackMode": "streaming",
                            "ttsFormat": "mp3",
                            "separateProviders": false
                        }
                    }),
                )
                .await;
            } else if url == "/api/speech/capabilities" {
                got_caps = true;
                req.reply(404, json!({"error": "Not Found"})).await;
            } else {
                panic!("unexpected request: {}", req.first);
            }
        }

        wait_until(|| {
            tick(&mut rt);
            rt.accessibility_json().to_string().contains("Unavailable")
                && shared.borrow().speech_server_ready()
        })
        .await;

        // 404 capabilities must never spin in a retry loop.
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );

        // Editing and cancelling restores clean state without any PATCH.
        click(&mut rt, "speech-playback-mode-trigger");
        click_option(&mut rt, "Buffered");
        tick(&mut rt);
        click(&mut rt, "speech-cancel");
        tick(&mut rt);
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );

        // Editing separateProviders + playbackMode still saves cleanly even though capabilities is 404.
        click(&mut rt, "speech-open-credentials");
        tick(&mut rt);
        click(&mut rt, "speech-separate-providers");
        click(&mut rt, "speech-playback-mode-trigger");
        click_option(&mut rt, "Buffered");
        tick(&mut rt);
        click(&mut rt, "speech-save");
        let patch_req = next_request(&listener, &mut rt).await;
        assert_eq!(patch_req.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(
            patch_req.body,
            json!({"speech": {"playbackMode": "buffered", "separateProviders": true}})
        );
        patch_req
            .reply(
                200,
                json!({
                    "speech": {
                        "hasApiKey": false,
                        "playbackMode": "buffered",
                        "ttsFormat": "mp3",
                        "separateProviders": true
                    }
                }),
            )
            .await;
        tick(&mut rt);

        // Unsupported capabilities stays quiet after save (no redundant GET /api/speech/capabilities).
        assert!(
            timeout(Duration::from_millis(80), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn speech_save_failure_preserves_draft_and_transport_drop_blocks_writes_and_cancels_reads() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.config.snapshot = Some(json!({ "settings": { "locale": "en" } }));
        prefs.state.snapshot = Some(json!({}));
        let (shared, mut rt) = make_window(prefs);
        rt.frame(0.0);
        settle_meta(&listener, &mut rt).await;

        click(&mut rt, "settings-voice");
        tick(&mut rt);

        // Hold /api/speech/capabilities in flight, switch away to Notifications, then reply: late reply must be ignored.
        let mut held_cap = None;
        let mut got_server = false;
        while !(got_server && held_cap.is_some()) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/storage/config/server?authoritative=1" {
                got_server = true;
                req.reply(200, json!({"speech": {"playbackMode": "streaming"}}))
                    .await;
            } else if url == "/api/speech/capabilities" {
                held_cap = Some(req);
            } else {
                panic!("unexpected request: {}", req.first);
            }
        }
        click(&mut rt, "settings-notifications");
        tick(&mut rt);
        held_cap
            .unwrap()
            .reply(
                200,
                json!({
                    "available": true,
                    "configured": true,
                    "provider": "stale-provider-name",
                    "supportsStt": true,
                    "supportsTts": true,
                    "supportsStreamingTts": true
                }),
            )
            .await;
        tick(&mut rt);

        // Return to Voice: fresh server + capabilities load cleanly with fresh provider.
        click(&mut rt, "settings-voice");
        tick(&mut rt);
        let mut reloaded_server = false;
        let mut reloaded_caps = false;
        while !(reloaded_server && reloaded_caps) {
            let req = next_request(&listener, &mut rt).await;
            let url = req.first.split_whitespace().nth(1).unwrap();
            if url == "/api/storage/config/server?authoritative=1" {
                reloaded_server = true;
                req.reply(200, json!({"speech": {"playbackMode": "streaming"}}))
                    .await;
            } else if url == "/api/speech/capabilities" {
                reloaded_caps = true;
                req.reply(
                    200,
                    json!({
                        "available": true,
                        "configured": true,
                        "provider": "fresh-provider",
                        "supportsStt": true,
                        "supportsTts": true,
                        "supportsStreamingTts": false
                    }),
                )
                .await;
            } else {
                panic!("unexpected return request: {}", req.first);
            }
        }
        wait_until(|| {
            tick(&mut rt);
            let a11y = rt.accessibility_json().to_string();
            a11y.contains("fresh-provider")
                && !a11y.contains("stale-provider-name")
                && a11y.contains("Streaming is unavailable for this provider. Choose Buffered.")
                && shared.borrow().speech_server_ready()
        })
        .await;

        // Failed PATCH preserves user's Buffered selection and triggers authoritative server reload.
        click(&mut rt, "speech-playback-mode-trigger");
        click_option(&mut rt, "Buffered");
        tick(&mut rt);
        click(&mut rt, "speech-save");
        let failed_patch = next_request(&listener, &mut rt).await;
        assert_eq!(
            failed_patch.first,
            "PATCH /api/storage/config/server HTTP/1.1"
        );
        failed_patch.reply(500, json!({"error": "boom"})).await;

        let reconcile = next_request(&listener, &mut rt).await;
        assert_eq!(
            reconcile.first,
            "GET /api/storage/config/server?authoritative=1 HTTP/1.1"
        );
        reconcile
            .reply(200, json!({"speech": {"playbackMode": "streaming"}}))
            .await;
        wait_until(|| {
            tick(&mut rt);
            let a11y = rt.accessibility_json().to_string();
            a11y.contains("Save failed") && a11y.contains("Buffered")
        })
        .await;

        // Losing transport disables writes completely (no PATCH sent).
        shared.borrow_mut().mark_transport_lost();
        tick(&mut rt);
        let wake: rune::Waker = Arc::new(|| {});
        let started = shared
            .borrow_mut()
            .start_speech_save(json!({"speech": {"playbackMode": "buffered"}}), &wake);
        assert!(!started, "transport_lost must refuse speech PATCH");
    });
}
