//! Parity tests for `/api/speech/*` routes: capabilities, direction resolution,
//! desktop engine & consent profile stores, transcription fallback/redaction/cancellation,
//! binary streaming synthesis cancellation, and Remote Control admission.
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Request, State},
    http::{Method, StatusCode as Status, header},
    middleware::from_fn_with_state,
    response::{IntoResponse, Response},
    routing::any,
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::{
    App, Shared,
    auth::{Principal, devices, remote, tls},
    opencode::Native,
    settings::{Settings, document::Location, profile},
    speech,
};

struct Harness {
    dir: PathBuf,
    app: Shared,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Harness {
    fn new(label: &str, config_yaml: Option<&str>, ingress: bool) -> Self {
        let dir = crate::shared::test_dir(label);
        let config_path = dir.join("config.yaml");
        if let Some(yaml) = config_yaml {
            std::fs::write(&config_path, yaml).unwrap();
        }
        let auth = crate::auth::Auth::new(crate::auth::Settings {
            username: "fixture".into(),
            password: None,
            file: None,
            cookie: "fixture".into(),
            token: false,
            managed_local: false,
            skip: true,
            idle: Duration::from_secs(60),
            absolute: Duration::from_secs(60),
        })
        .unwrap();
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let settings = Settings::new(Location::resolve(config_path.to_str().unwrap()));
        // Isolate desktop voice and speech env from host environment variables by default.
        settings.set_desktop_voice_env_for_test(None, "stable".into());
        settings.set_speech_env_for_test(None, None);
        let dev = if ingress {
            devices::open_ingress_for_test(&dir, "https://10.0.0.5:9898".into())
        } else {
            devices::open_for_test(&dir, "https://10.0.0.5:9898".into(), vec!["https://10.0.0.5:9898".into()])
        };
        let app = Arc::new(App::new(
            auth,
            0,
            dir.clone(),
            dir.clone(),
            false,
            settings,
            Value::Null,
            Native::connect("opencode").unwrap(),
            PathBuf::new(),
            Some(dev),
            crate::files::watch::Watches::new(tx),
            None,
        ));
        Self { dir, app }
    }

    fn local_router(&self, cancel: CancellationToken) -> Router {
        speech::routes()
            .layer(axum::middleware::from_fn(move |mut req: Request, next: axum::middleware::Next| {
                let c = cancel.clone();
                async move {
                    req.extensions_mut().insert(Principal(c));
                    next.run(req).await
                }
            }))
            .with_state(self.app.clone())
    }

    async fn serve_local(&self, cancel: CancellationToken) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let router = self.local_router(cancel);
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        (format!("http://{addr}"), task)
    }
}

fn test_client() -> reqwest::Client {
    reqwest::Client::builder().no_proxy().build().unwrap()
}

#[tokio::test]
async fn capabilities_and_direction_resolution_match_ts_contracts() {
    // 1. Shared mode configured.
    let h = Harness::new(
        "speech-caps-shared",
        Some(
            "server:\n  speech:\n    apiKey: sk-shared\n    baseUrl: https://api.openai.com/v1\n    sttModel: whisper-1\n    ttsModel: tts-1\n",
        ),
        false,
    );
    let caps = super::config::capabilities_json(&h.app.settings, true).unwrap();
    assert_eq!(caps["available"], true);
    assert_eq!(caps["configured"], true);
    assert_eq!(caps["separateProviders"], false);
    assert_eq!(caps["sttConfigured"], true);
    assert_eq!(caps["ttsConfigured"], true);
    assert_eq!(caps["provider"], "openai-compatible");
    assert_eq!(caps["baseUrl"], "https://api.openai.com/v1");
    assert_eq!(caps["sttModel"], "whisper-1");
    assert_eq!(caps["ttsModel"], "tts-1");
    assert_eq!(caps["ttsVoice"], "alloy");
    assert!(caps.get("sttBaseUrl").is_none());
    assert!(caps.get("ttsBaseUrl").is_none());
    assert_eq!(caps["desktopVoiceConversationEngine"], false);
    assert!(caps.get("desktopLiveVoiceConsent").is_none());

    // 2. Separate mode: complete pairs, partial pair, incomplete pair (key without URL / foreign URL without key),
    //    matching shared URL + directional key, and voiceConversation strict capability projection.
    let h_sep = Harness::new(
        "speech-caps-sep",
        Some(concat!(
            "server:\n",
            "  speech:\n",
            "    apiKey: sk-shared\n",
            "    baseUrl: https://api.openai.com/v1\n",
            "    sttModel: shared-stt\n",
            "    ttsModel: shared-tts\n",
            "    separateProviders: true\n",
            "    stt:\n",
            "      apiKey: sk-groq\n",
            "      baseUrl: https://api.groq.com/openai/v1\n",
            "      model: whisper-large-v3\n",
            "    tts:\n",
            "      apiKey: sk-incomplete\n",
            "  voiceConversation:\n",
            "    geminiLive:\n",
            "      apiKey: secret-gemini\n",
            "      model: models/gemini-fixture\n",
            "      voice: Kore\n",
            "    openaiRealtime:\n",
            "      model: realtime-fixture\n",
        )),
        false,
    );
    let caps = super::config::capabilities_json(&h_sep.app.settings, true).unwrap();
    assert_eq!(caps["separateProviders"], true);
    assert_eq!(caps["sttConfigured"], true);
    assert_eq!(caps["ttsConfigured"], false, "directional key without URL must not combine with shared URL");
    assert_eq!(caps["configured"], false, "separate mode requires both directions for legacy configured flag");
    assert!(caps.get("baseUrl").is_none());
    assert_eq!(caps["sttBaseUrl"], "https://api.groq.com/openai/v1");
    assert_eq!(caps["sttModel"], "whisper-large-v3");
    assert_eq!(caps["ttsModel"], "shared-tts");
    assert!(
        caps.get("voiceConversation").is_none(),
        "voiceConversation must stay omitted while /api/speech/conversation/live is not served"
    );

    // 2b. Process OPENAI_API_KEY applies without YAML baseUrl, or when YAML baseUrl matches OpenAI's
    //     default URL or the host's OPENAI_BASE_URL; foreign YAML baseUrls never receive the env key.
    let h_env_default = Harness::new("speech-env-default", Some("server:\n  speech: {}\n"), false);
    h_env_default.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), None);
    let caps_env = super::config::capabilities_json(&h_env_default.app.settings, true).unwrap();
    assert_eq!(caps_env["configured"], true);
    assert_eq!(caps_env["sttConfigured"], true);
    assert_eq!(caps_env["ttsConfigured"], true);

    let h_env_openai_url = Harness::new(
        "speech-env-openai-url",
        Some("server:\n  speech:\n    baseUrl: https://api.openai.com/v1/\n"),
        false,
    );
    h_env_openai_url.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), None);
    assert_eq!(
        super::config::resolve_stt_settings(&h_env_openai_url.app.settings).unwrap().api_key.as_deref(),
        Some("sk-host-env-secret")
    );
    // When OPENAI_BASE_URL points to a host-configured endpoint, matching YAML baseUrl keeps the key,
    // while pointing to a different URL (even api.openai.com) refuses the host key.
    h_env_openai_url.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), Some("https://corp.internal/v1"));
    assert!(super::config::resolve_stt_settings(&h_env_openai_url.app.settings).unwrap().api_key.is_none());

    let h_env_corp_url =
        Harness::new("speech-env-corp-url", Some("server:\n  speech:\n    baseUrl: https://corp.internal/v1\n"), false);
    h_env_corp_url.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), Some("https://corp.internal/v1/"));
    assert_eq!(
        super::config::resolve_stt_settings(&h_env_corp_url.app.settings).unwrap().api_key.as_deref(),
        Some("sk-host-env-secret")
    );

    let h_env_custom_url = Harness::new(
        "speech-env-custom-url",
        Some("server:\n  speech:\n    baseUrl: https://attacker.invalid/v1\n"),
        false,
    );
    h_env_custom_url.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), None);
    let caps_blocked = super::config::capabilities_json(&h_env_custom_url.app.settings, true).unwrap();
    assert_eq!(caps_blocked["configured"], false);
    assert_eq!(caps_blocked["sttConfigured"], false);
    assert_eq!(caps_blocked["ttsConfigured"], false);
    assert!(super::config::resolve_stt_settings(&h_env_custom_url.app.settings).unwrap().api_key.is_none());
    assert!(super::config::resolve_tts_settings(&h_env_custom_url.app.settings).unwrap().api_key.is_none());

    let h_env_sep_custom = Harness::new(
        "speech-env-sep-custom",
        Some("server:\n  speech:\n    separateProviders: true\n    baseUrl: https://attacker.invalid/v1\n"),
        false,
    );
    h_env_sep_custom.app.settings.set_speech_env_for_test(Some("sk-host-env-secret"), None);
    assert!(super::config::resolve_stt_settings(&h_env_sep_custom.app.settings).unwrap().api_key.is_none());
    assert!(super::config::resolve_tts_settings(&h_env_sep_custom.app.settings).unwrap().api_key.is_none());

    // 3. Directional key with matching shared URL forms a complete pair; foreign URL without key does not.
    let h_pair = Harness::new(
        "speech-caps-pair",
        Some(concat!(
            "server:\n",
            "  speech:\n",
            "    apiKey: sk-shared\n",
            "    baseUrl: https://api.openai.com/v1\n",
            "    separateProviders: true\n",
            "    stt:\n",
            "      apiKey: sk-alt\n",
            "      baseUrl: https://api.openai.com/v1\n",
            "    tts:\n",
            "      baseUrl: https://foreign.example/v1\n",
        )),
        false,
    );
    let caps = super::config::capabilities_json(&h_pair.app.settings, true).unwrap();
    assert_eq!(caps["sttConfigured"], true);
    assert_eq!(caps["ttsConfigured"], false);

    // 4. Malformed classic settings keep schema diagnostics private (503, no secret leaked).
    let secret = "fixture-secret-malformed-format";
    let h_bad = Harness::new("speech-caps-bad", Some(&format!("server:\n  speech:\n    ttsFormat: {secret}\n")), false);
    let (base, server) = h_bad.serve_local(CancellationToken::new()).await;
    let resp = test_client().get(format!("{base}/api/speech/capabilities")).send().await.unwrap();
    assert_eq!(resp.status(), Status::SERVICE_UNAVAILABLE);
    let body = resp.text().await.unwrap();
    assert!(!body.contains(secret), "schema diagnostics must never echo config secrets: {body}");
    server.abort();
}

#[tokio::test]
async fn desktop_engine_and_consent_isolate_by_profile_and_reject_remote() {
    let h = Harness::new("speech-desktop", None, false);
    let (base, server) = h.serve_local(CancellationToken::new()).await;
    let client = test_client();

    // Without profile identity, desktop routes return 404.
    assert_eq!(
        client.get(format!("{base}/api/speech/conversation/engine")).send().await.unwrap().status(),
        Status::NOT_FOUND
    );
    assert_eq!(
        client
            .patch(format!("{base}/api/speech/conversation/engine"))
            .json(&json!({"engine": "gemini-live"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );
    assert_eq!(
        client
            .put(format!("{base}/api/speech/conversation/consent"))
            .json(&json!({"engine": "gemini-live", "version": 2}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );

    // Enable profile identity for channel `voice-one`.
    let scope_one = profile::scope_for_test(&h.app.settings.location.config, "voice-one", None).unwrap();
    h.app.settings.set_desktop_voice_env_for_test(Some(scope_one.identity.clone()), "voice-one".into());

    let caps: Value = client.get(format!("{base}/api/speech/capabilities")).send().await.unwrap().json().await.unwrap();
    assert_eq!(caps["desktopVoiceConversationEngine"], true);
    assert_eq!(caps["desktopLiveVoiceConsent"], json!({}));

    let eng: Value =
        client.get(format!("{base}/api/speech/conversation/engine")).send().await.unwrap().json().await.unwrap();
    assert_eq!(eng, json!({"engine": "classic"}));

    // Invalid engine or extra keys -> 400 without echoing secret.
    let bad = client
        .patch(format!("{base}/api/speech/conversation/engine"))
        .json(&json!({"engine": "fixture-secret"}))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), Status::BAD_REQUEST);
    assert!(!bad.text().await.unwrap().contains("fixture-secret"));
    let extra = client
        .patch(format!("{base}/api/speech/conversation/engine"))
        .json(&json!({"engine": "classic", "extra": true}))
        .send()
        .await
        .unwrap();
    assert_eq!(extra.status(), Status::BAD_REQUEST);

    // Save gemini-live on voice-one, switch to voice-two (still classic), save openai-realtime, switch back.
    let saved: Value = client
        .patch(format!("{base}/api/speech/conversation/engine"))
        .json(&json!({"engine": "gemini-live"}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(saved, json!({"engine": "gemini-live"}));

    // Consent validation & isolation.
    assert_eq!(
        client
            .put(format!("{base}/api/speech/conversation/consent"))
            .json(&json!({"engine": "gemini-live", "version": 1}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::BAD_REQUEST
    );
    assert_eq!(
        client
            .put(format!("{base}/api/speech/conversation/consent"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(r#"{"engine":"gemini-live","version":2.0}"#)
            .send()
            .await
            .unwrap()
            .status(),
        Status::NO_CONTENT
    );
    let caps: Value = client.get(format!("{base}/api/speech/capabilities")).send().await.unwrap().json().await.unwrap();
    assert_eq!(caps["desktopLiveVoiceConsent"], json!({"gemini-live": 2}));

    // Switch channel to `voice-two`.
    h.app.settings.set_desktop_voice_env_for_test(Some(scope_one.identity.clone()), "voice-two".into());
    assert_eq!(
        client
            .get(format!("{base}/api/speech/conversation/engine"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap(),
        json!({"engine": "classic"})
    );
    let caps_two: Value =
        client.get(format!("{base}/api/speech/capabilities")).send().await.unwrap().json().await.unwrap();
    assert_eq!(caps_two["desktopLiveVoiceConsent"], json!({}));
    assert_eq!(
        client
            .patch(format!("{base}/api/speech/conversation/engine"))
            .json(&json!({"engine": "openai-realtime"}))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap(),
        json!({"engine": "openai-realtime"})
    );

    // Switch back to `voice-one`: choices remain isolated and config.yaml was never created.
    h.app.settings.set_desktop_voice_env_for_test(Some(scope_one.identity), "voice-one".into());
    assert_eq!(
        client
            .get(format!("{base}/api/speech/conversation/engine"))
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap(),
        json!({"engine": "gemini-live"})
    );
    assert!(!h.app.settings.location.config.exists(), "desktop voice stores must not touch config.yaml");
    server.abort();
}

type StallHook = Arc<Mutex<Option<(Arc<Notify>, Arc<Notify>)>>>;

struct DropSignal(Option<Arc<Notify>>);
impl Drop for DropSignal {
    fn drop(&mut self) {
        if let Some(n) = self.0.take() {
            n.notify_one();
        }
    }
}

#[tokio::test]
async fn transcribe_handles_multipart_fallback_validation_redaction_and_cancellation() {
    let secret = "speech-credential-sentinel-not-a-real-key";
    let bodies: Arc<Mutex<Vec<Vec<u8>>>> = Arc::new(Mutex::new(Vec::new()));
    let mode: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("fallback"));
    let stall: StallHook = Arc::new(Mutex::new(None));
    let disconnect_dropped: Arc<Mutex<Option<Arc<Notify>>>> = Arc::new(Mutex::new(None));
    let calls = Arc::new(AtomicUsize::new(0));
    let redirect_hits = Arc::new(AtomicUsize::new(0));

    let r_hits = redirect_hits.clone();
    let redirect_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_addr = redirect_listener.local_addr().unwrap();
    let redirect_task = tokio::spawn(async move {
        let router = Router::new().fallback(any(move || {
            let hits = r_hits.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                Status::OK
            }
        }));
        axum::serve(redirect_listener, router).await.unwrap();
    });

    let b_ref = bodies.clone();
    let m_ref = mode.clone();
    let s_ref = stall.clone();
    let d_ref = disconnect_dropped.clone();
    let c_ref = calls.clone();
    let redirect_target = format!("http://{redirect_addr}/steal");
    let upstream_router = Router::new().fallback(any(move |req: Request| {
        let bodies = b_ref.clone();
        let mode = m_ref.clone();
        let stall = s_ref.clone();
        let disconnect_dropped = d_ref.clone();
        let calls = c_ref.clone();
        let redirect_target = redirect_target.clone();
        async move {
            assert_eq!(req.uri().path(), "/v1/audio/transcriptions");
            let auth = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
            assert_eq!(auth, format!("Bearer {secret}"));
            let raw = axum::body::to_bytes(req.into_body(), 2 * 1024 * 1024).await.unwrap();
            let n = calls.fetch_add(1, Ordering::SeqCst) + 1;
            bodies.lock().unwrap().push(raw.to_vec());
            let cur_mode = *mode.lock().unwrap();
            if cur_mode == "url_safe_ok" {
                return (Status::OK, Json(json!({"text": "urlsafe"}))).into_response();
            }
            if cur_mode == "redirect" {
                return Response::builder()
                    .status(Status::TEMPORARY_REDIRECT)
                    .header(header::LOCATION, redirect_target)
                    .body(Body::empty())
                    .unwrap();
            }
            if cur_mode == "stall" {
                let _drop_guard = DropSignal(disconnect_dropped.lock().unwrap().clone());
                let hook = stall.lock().unwrap().clone();
                if let Some((entered, release)) = hook {
                    entered.notify_one();
                    release.notified().await;
                }
                return Status::OK.into_response();
            }
            if cur_mode == "echo_secret" {
                return (Status::FORBIDDEN, format!("Invalid credentials: {auth}")).into_response();
            }
            match n {
                1 => (Status::BAD_REQUEST, Json(json!({"error": {"message": "Unsupported response format"}})))
                    .into_response(),
                2 => (
                    Status::OK,
                    Json(json!({
                        "text": "transcript",
                        "language": "en",
                        "duration": 1.25,
                        "segments": [{"start": 0.1, "end": 1.2, "text": "transcript"}]
                    })),
                )
                    .into_response(),
                3 => (Status::SERVICE_UNAVAILABLE, Json(json!({"error": {"message": "Provider overloaded"}})))
                    .into_response(),
                _ => (Status::BAD_REQUEST, Json(json!({"error": {"message": "Provider rejected the request"}})))
                    .into_response(),
            }
        }
    }));
    let up_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    let up_task = tokio::spawn(async move { axum::serve(up_listener, upstream_router).await.unwrap() });

    let h = Harness::new(
        "speech-stt",
        Some(&format!(
            "server:\n  speech:\n    apiKey: {secret}\n    baseUrl: http://{up_addr}/v1\n    sttModel: test-transcriber\n"
        )),
        false,
    );
    let cancel = CancellationToken::new();
    let (base, server) = h.serve_local(cancel.clone()).await;
    let client = test_client();

    // 1. Format rejection falls back once without response_format; 503 and unrelated 400 are NOT retried.
    let res = client
        .post(format!("{base}/api/speech/transcribe"))
        .json(&json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), Status::OK);
    let json_res: Value = res.json().await.unwrap();
    assert_eq!(json_res["text"], "transcript");
    assert_eq!(json_res["language"], "en");
    assert_eq!(json_res["durationMs"], 1250);
    assert_eq!(json_res["segments"][0]["startMs"], 100);
    assert_eq!(json_res["segments"][0]["endMs"], 1200);
    {
        let recorded = bodies.lock().unwrap();
        assert_eq!(recorded.len(), 2);
        let first = String::from_utf8_lossy(&recorded[0]);
        let second = String::from_utf8_lossy(&recorded[1]);
        assert!(first.contains("verbose_json"));
        assert!(!second.contains("response_format"));
        for body in [&first, &second] {
            assert!(body.contains("filename=\"prompt-input.m4a\"\r\nContent-Type: audio/mp4"), "{body}");
        }
    }
    assert_eq!(
        client
            .post(format!("{base}/api/speech/transcribe"))
            .json(&json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::BAD_GATEWAY
    );
    assert_eq!(
        client
            .post(format!("{base}/api/speech/transcribe"))
            .json(&json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::BAD_GATEWAY
    );
    assert_eq!(calls.load(Ordering::SeqCst), 4);

    // 1b. URL-safe Base64 (without padding) decodes identically to Node Buffer.from(..., "base64").
    *mode.lock().unwrap() = "url_safe_ok";
    let urlsafe_res = client
        .post(format!("{base}/api/speech/transcribe"))
        .json(&json!({"audioBase64": "---_", "mimeType": "audio/wav"}))
        .send()
        .await
        .unwrap();
    assert_eq!(urlsafe_res.status(), Status::OK);
    assert_eq!(urlsafe_res.json::<Value>().await.unwrap()["text"], "urlsafe");
    assert!(
        bodies.lock().unwrap().last().unwrap().windows(3).any(|w| w == [0xfb, 0xef, 0xbf]),
        "URL-safe base64 payload bytes must match decoded audio"
    );

    // 1c. Cross-origin redirect returns 502 and never follows/leaks Authorization to another origin.
    *mode.lock().unwrap() = "redirect";
    assert_eq!(
        client
            .post(format!("{base}/api/speech/transcribe"))
            .json(&json!({"audioBase64": "AAA=", "mimeType": "audio/wav"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::BAD_GATEWAY
    );
    assert_eq!(redirect_hits.load(Ordering::SeqCst), 0, "cross-origin redirect must not be followed");

    // 2. Upstream credential echo is redacted from 502 response body.
    *mode.lock().unwrap() = "echo_secret";
    let err_res = client
        .post(format!("{base}/api/speech/transcribe"))
        .json(&json!({"audioBase64": "AAA=", "mimeType": "audio/wav"}))
        .send()
        .await
        .unwrap();
    assert_eq!(err_res.status(), Status::BAD_GATEWAY);
    let err_text = err_res.text().await.unwrap();
    assert!(!err_text.contains(secret), "502 response leaked secret: {err_text}");

    // 3. Validation (empty fields, control chars in mimeType, invalid base64, >1 MiB body limit).
    for payload in [
        json!({}),
        json!({"audioBase64": "", "mimeType": "audio/wav"}),
        json!({"audioBase64": "AAA=", "mimeType": "audio/wav\r\nX-Injected: 1"}),
        json!({"audioBase64": "!!!not-base64!!!", "mimeType": "audio/wav"}),
    ] {
        assert_eq!(
            client.post(format!("{base}/api/speech/transcribe")).json(&payload).send().await.unwrap().status(),
            Status::BAD_REQUEST,
            "payload {payload}"
        );
    }
    let big = "A".repeat(1024 * 1024 + 64);
    assert_eq!(
        client
            .post(format!("{base}/api/speech/transcribe"))
            .json(&json!({"audioBase64": big, "mimeType": "audio/wav"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::PAYLOAD_TOO_LARGE
    );

    // 4. Unconfigured provider returns 503 with exact reference message.
    let h_unconf = Harness::new("speech-stt-unconf", Some("server:\n  speech: {}\n"), false);
    let (unconf_base, unconf_server) = h_unconf.serve_local(CancellationToken::new()).await;
    let unconf_res = client
        .post(format!("{unconf_base}/api/speech/transcribe"))
        .json(&json!({"audioBase64": "AAA=", "mimeType": "audio/wav"}))
        .send()
        .await
        .unwrap();
    assert_eq!(unconf_res.status(), Status::SERVICE_UNAVAILABLE);
    assert_eq!(
        unconf_res.json::<Value>().await.unwrap()["error"],
        "Speech provider is not configured. Add an API key in Speech settings."
    );
    unconf_server.abort();

    // 5a. Client HTTP disconnect aborts the in-flight upstream STT request promptly without retrying.
    *mode.lock().unwrap() = "stall";
    let calls_before_dc = calls.load(Ordering::SeqCst);
    let (dc_entered, dc_release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    let dc_dropped = Arc::new(Notify::new());
    *stall.lock().unwrap() = Some((dc_entered.clone(), dc_release.clone()));
    *disconnect_dropped.lock().unwrap() = Some(dc_dropped.clone());
    let dc_client = client.clone();
    let dc_url = format!("{base}/api/speech/transcribe");
    let dc_task = tokio::spawn(async move {
        let _ = dc_client.post(dc_url).json(&json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"})).send().await;
    });
    tokio::time::timeout(Duration::from_secs(10), dc_entered.notified()).await.unwrap();
    dc_task.abort();
    tokio::time::timeout(Duration::from_secs(10), dc_dropped.notified()).await.unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), calls_before_dc + 1, "disconnected transcribe must not retry");
    *disconnect_dropped.lock().unwrap() = None;

    // 5b. Principal revocation aborts in-flight transcribe immediately with 401 and no retry.
    let calls_before = calls.load(Ordering::SeqCst);
    let (entered, release) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *stall.lock().unwrap() = Some((entered.clone(), release.clone()));
    let req_client = client.clone();
    let req_url = format!("{base}/api/speech/transcribe");
    let mut req_task = tokio::spawn(async move {
        req_client
            .post(req_url)
            .json(&json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"}))
            .send()
            .await
            .unwrap()
    });
    tokio::select! {
        res = &mut req_task => panic!("transcribe exited before upstream stall: {res:?}"),
        waited = tokio::time::timeout(Duration::from_secs(10), entered.notified()) => {
            waited.expect("timed out waiting for upstream transcribe stall");
        }
    }
    cancel.cancel();
    let resp = tokio::time::timeout(Duration::from_secs(10), req_task).await.unwrap().unwrap();
    assert_eq!(resp.status(), Status::UNAUTHORIZED);
    assert_eq!(calls.load(Ordering::SeqCst), calls_before + 1, "cancelled transcribe must not retry");
    release.notify_waiters();

    server.abort();
    up_task.abort();
    redirect_task.abort();
}

#[tokio::test]
async fn synthesize_stream_relays_binary_audio_redacts_errors_and_cancels_upstream() {
    let secret = "tts-credential-sentinel";
    let mode: Arc<Mutex<&'static str>> = Arc::new(Mutex::new("binary"));
    let entered_hook: Arc<Mutex<Option<Arc<Notify>>>> = Arc::new(Mutex::new(None));
    let dropped_hook: Arc<Mutex<Option<Arc<Notify>>>> = Arc::new(Mutex::new(None));
    let redirect_hits = Arc::new(AtomicUsize::new(0));

    let r_hits = redirect_hits.clone();
    let redirect_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let redirect_addr = redirect_listener.local_addr().unwrap();
    let redirect_task = tokio::spawn(async move {
        let router = Router::new().fallback(any(move || {
            let hits = r_hits.clone();
            async move {
                hits.fetch_add(1, Ordering::SeqCst);
                Status::OK
            }
        }));
        axum::serve(redirect_listener, router).await.unwrap();
    });

    let m_ref = mode.clone();
    let e_ref = entered_hook.clone();
    let d_ref = dropped_hook.clone();
    let redirect_target = format!("http://{redirect_addr}/steal");
    let upstream_router = Router::new().fallback(any(move |req: Request| {
        let mode = m_ref.clone();
        let entered_hook = e_ref.clone();
        let dropped_hook = d_ref.clone();
        let redirect_target = redirect_target.clone();
        async move {
            assert_eq!(req.uri().path(), "/v1/audio/speech");
            let auth = req.headers().get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
            assert_eq!(auth, format!("Bearer {secret}"));
            let _ = axum::body::to_bytes(req.into_body(), 64 * 1024).await.unwrap();
            let cur = *mode.lock().unwrap();
            match cur {
                "binary" => Response::builder()
                    .status(Status::OK)
                    .header(header::CONTENT_TYPE, "audio/wav")
                    .body(Body::from(vec![0u8, 128u8, 255u8]))
                    .unwrap(),
                "no_content" => Status::NO_CONTENT.into_response(),
                "reset_content" => Status::RESET_CONTENT.into_response(),
                "redirect" => Response::builder()
                    .status(Status::TEMPORARY_REDIRECT)
                    .header(header::LOCATION, redirect_target)
                    .body(Body::empty())
                    .unwrap(),
                "echo_secret" => (Status::BAD_REQUEST, Json(json!({"error": {"message": secret}}))).into_response(),
                "stall_before_headers" => {
                    let _drop_guard = DropSignal(dropped_hook.lock().unwrap().clone());
                    if let Some(n) = entered_hook.lock().unwrap().clone() {
                        n.notify_one();
                    }
                    std::future::pending::<()>().await;
                    Status::OK.into_response()
                }
                "partial_stream" => {
                    let drop_notify = dropped_hook.lock().unwrap().clone();
                    let body = Body::from_stream(async_stream::stream! {
                        let _drop_guard = DropSignal(drop_notify);
                        yield Ok::<_, std::io::Error>(axum::body::Bytes::from_static(b"audio"));
                        std::future::pending::<()>().await;
                    });
                    Response::builder()
                        .status(Status::OK)
                        .header(header::CONTENT_TYPE, "audio/mpeg")
                        .body(body)
                        .unwrap()
                }
                _ => Status::INTERNAL_SERVER_ERROR.into_response(),
            }
        }
    }));
    let up_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    let up_task = tokio::spawn(async move { axum::serve(up_listener, upstream_router).await.unwrap() });

    let h = Harness::new(
        "speech-tts",
        Some(&format!("server:\n  speech:\n    apiKey: {secret}\n    baseUrl: http://{up_addr}/v1\n")),
        false,
    );
    let cancel = CancellationToken::new();
    let (base, server) = h.serve_local(cancel.clone()).await;
    let client = test_client();

    // 1. Binary audio passthrough with provider Content-Type and Cache-Control: no-store.
    let res = client
        .post(format!("{base}/api/speech/synthesize/stream"))
        .json(&json!({"text": "Hello world", "format": "wav"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), Status::OK);
    assert_eq!(res.headers()[header::CONTENT_TYPE], "audio/wav");
    assert_eq!(res.headers()[header::CACHE_CONTROL], "no-store");
    assert_eq!(res.bytes().await.unwrap().as_ref(), &[0u8, 128u8, 255u8]);

    // 2. Removed `/api/speech/synthesize` returns 404.
    assert_eq!(
        client
            .post(format!("{base}/api/speech/synthesize"))
            .json(&json!({"text": "Hello"}))
            .send()
            .await
            .unwrap()
            .status(),
        Status::NOT_FOUND
    );

    // 3. Input validation (400) and credential redaction on upstream failure (502).
    for bad in [json!({"text": "   "}), json!({"text": "ok", "format": "flac"})] {
        assert_eq!(
            client.post(format!("{base}/api/speech/synthesize/stream")).json(&bad).send().await.unwrap().status(),
            Status::BAD_REQUEST
        );
    }
    *mode.lock().unwrap() = "echo_secret";
    let err_res = client
        .post(format!("{base}/api/speech/synthesize/stream"))
        .json(&json!({"text": "fixture"}))
        .send()
        .await
        .unwrap();
    assert_eq!(err_res.status(), Status::BAD_GATEWAY);
    assert!(!err_res.text().await.unwrap().contains(secret));

    // 3b. Upstream 204/205 empty-body responses and cross-origin redirects return 502.
    for upstream_mode in ["no_content", "reset_content", "redirect"] {
        *mode.lock().unwrap() = upstream_mode;
        assert_eq!(
            client
                .post(format!("{base}/api/speech/synthesize/stream"))
                .json(&json!({"text": "fixture"}))
                .send()
                .await
                .unwrap()
                .status(),
            Status::BAD_GATEWAY,
            "mode {upstream_mode}"
        );
    }
    assert_eq!(redirect_hits.load(Ordering::SeqCst), 0, "TTS cross-origin redirect must not be followed");

    // 4. Disconnecting before headers closes the upstream provider request.
    *mode.lock().unwrap() = "stall_before_headers";
    let (entered, dropped) = (Arc::new(Notify::new()), Arc::new(Notify::new()));
    *entered_hook.lock().unwrap() = Some(entered.clone());
    *dropped_hook.lock().unwrap() = Some(dropped.clone());
    let req_client = client.clone();
    let req_url = format!("{base}/api/speech/synthesize/stream");
    let req_task = tokio::spawn(async move {
        let _ = req_client.post(req_url).json(&json!({"text": "Classic summary"})).send().await;
    });
    tokio::time::timeout(Duration::from_secs(10), entered.notified()).await.unwrap();
    req_task.abort();
    tokio::time::timeout(Duration::from_secs(10), dropped.notified()).await.unwrap();

    // 5. Revoking principal mid-stream closes the upstream provider stream after the first chunk.
    *mode.lock().unwrap() = "partial_stream";
    let dropped_mid = Arc::new(Notify::new());
    *dropped_hook.lock().unwrap() = Some(dropped_mid.clone());
    let res = client
        .post(format!("{base}/api/speech/synthesize/stream"))
        .json(&json!({"text": "Streaming summary"}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), Status::OK);
    let mut stream = res.bytes_stream();
    let first = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.unwrap().unwrap().unwrap();
    assert_eq!(first.as_ref(), b"audio");
    cancel.cancel();
    // Next read fails or terminates because stream aborted, and upstream drops cleanly.
    let next_chunk = tokio::time::timeout(Duration::from_secs(10), stream.next()).await.unwrap();
    assert!(next_chunk.is_none() || next_chunk.unwrap().is_err());
    tokio::time::timeout(Duration::from_secs(10), dropped_mid.notified()).await.unwrap();

    server.abort();
    up_task.abort();
    redirect_task.abort();
}

#[tokio::test]
async fn remote_control_admits_speech_routes_and_blocks_local_only_and_removed_routes() {
    let upstream_router = Router::new().fallback(any(|req: Request| async move {
        match req.uri().path() {
            "/v1/audio/transcriptions" => Json(json!({"text": "remote transcript", "duration": 0.5})).into_response(),
            "/v1/audio/speech" => Response::builder()
                .status(Status::OK)
                .header(header::CONTENT_TYPE, "audio/mpeg")
                .body(Body::from(vec![1u8, 2u8, 3u8]))
                .unwrap(),
            _ => Status::NOT_FOUND.into_response(),
        }
    }));
    let up_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let up_addr = up_listener.local_addr().unwrap();
    let up_task = tokio::spawn(async move { axum::serve(up_listener, upstream_router).await.unwrap() });

    let cfg = format!("server:\n  speech:\n    apiKey: sk-remote-test\n    baseUrl: http://{up_addr}/v1\n");
    let direct = Harness::new("speech-remote-direct", Some(&cfg), false);
    let ingress_h = Harness::new("speech-remote-ingress", Some(&cfg), true);
    for h in [&direct, &ingress_h] {
        let scope = profile::scope_for_test(&h.app.settings.location.config, "stable", None).unwrap();
        h.app.settings.set_desktop_voice_env_for_test(Some(scope.identity), "stable".into());
    }

    let origin = "https://10.0.0.5:9898";
    let host = "10.0.0.5:9898";
    let client = test_client();

    for (ingress, is_server) in [(false, false), (false, true), (true, false), (true, true)] {
        let h = if ingress { &ingress_h } else { &direct };
        let payload = if ingress {
            axum::body::Bytes::new()
        } else {
            axum::body::Bytes::from(format!(r#"{{"origin":"{origin}"}}"#))
        };
        let issued = devices::issue(State(h.app.clone()), payload).await;
        assert_eq!(issued.status(), Status::OK);
        let link: Value =
            serde_json::from_slice(&axum::body::to_bytes(issued.into_body(), 4096).await.unwrap()).unwrap();
        let code = link["url"].as_str().unwrap().strip_prefix(&format!("{origin}/remote-pair#")).unwrap().to_owned();

        let channel = tls::Channel {
            origin: origin.to_owned(),
            origins: Arc::from([origin.to_owned()]),
            ingress,
            socket: CancellationToken::new(),
            principal: Arc::new(Mutex::new(None)),
        };
        let router = crate::auth::remote_routes()
            .merge(speech::routes())
            .layer(from_fn_with_state((h.app.clone(), None), remote::admit))
            .layer(Extension(channel))
            .with_state(h.app.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let base = format!("http://{addr}");

        let cookie = if is_server {
            let paired = client
                .post(format!("{base}/api/remote-control/server-pair"))
                .header(header::HOST, host)
                .header("x-codenomad-server-pairing", "1")
                .header(header::CONTENT_TYPE, "application/json")
                .body(json!({"code": code, "hostName": "peer-host"}).to_string())
                .send()
                .await
                .unwrap();
            assert_eq!(paired.status(), Status::OK);
            let cred = paired.json::<Value>().await.unwrap()["credential"].as_str().unwrap().to_owned();
            format!("{}={cred}", devices::COOKIE)
        } else {
            let paired = client
                .post(format!("{base}/api/remote-control/pair"))
                .header(header::HOST, host)
                .header(header::ORIGIN, origin)
                .json(&json!({"code": code}))
                .send()
                .await
                .unwrap();
            assert_eq!(paired.status(), Status::OK);
            paired.headers()[header::SET_COOKIE].to_str().unwrap().split(';').next().unwrap().to_owned()
        };

        let send = |method: Method, path: &str, body: Option<Value>| {
            let mut req = client
                .request(method, format!("{base}{path}"))
                .header(header::HOST, host)
                .header(header::COOKIE, &cookie);
            if is_server {
                req = req.header("x-codenomad-server-request", "1");
            } else {
                req = req.header(header::ORIGIN, origin);
            }
            if let Some(b) = body {
                req = req.json(&b);
            }
            req.send()
        };

        // Admitted routes: capabilities (desktopVoiceConversationEngine=false, no consent), transcribe, synthesize/stream.
        let caps_res = send(Method::GET, "/api/speech/capabilities", None).await.unwrap();
        assert_eq!(caps_res.status(), Status::OK);
        let caps: Value = caps_res.json().await.unwrap();
        assert_eq!(caps["desktopVoiceConversationEngine"], false);
        assert!(caps.get("desktopLiveVoiceConsent").is_none());

        let tr_res = send(
            Method::POST,
            "/api/speech/transcribe",
            Some(json!({"audioBase64": "YXVkaW8=", "mimeType": "audio/mp4"})),
        )
        .await
        .unwrap();
        assert_eq!(tr_res.status(), Status::OK);
        assert_eq!(tr_res.json::<Value>().await.unwrap()["text"], "remote transcript");

        let syn_res =
            send(Method::POST, "/api/speech/synthesize/stream", Some(json!({"text": "Hello"}))).await.unwrap();
        assert_eq!(syn_res.status(), Status::OK);
        assert_eq!(syn_res.headers()[header::CACHE_CONTROL], "no-store");
        assert_eq!(syn_res.bytes().await.unwrap().as_ref(), &[1u8, 2u8, 3u8]);

        // Local-only and removed routes return 404 remotely.
        for (method, path, body) in [
            (Method::GET, "/api/speech/conversation/engine", None),
            (Method::PATCH, "/api/speech/conversation/engine", Some(json!({"engine": "gemini-live"}))),
            (Method::PUT, "/api/speech/conversation/consent", Some(json!({"engine": "gemini-live", "version": 2}))),
            (Method::POST, "/api/speech/synthesize", Some(json!({"text": "Hello"}))),
        ] {
            let res = send(method.clone(), path, body).await.unwrap();
            assert_eq!(res.status(), Status::NOT_FOUND, "remote ({ingress}, {is_server}) {method} {path}");
        }

        server.abort();
    }

    up_task.abort();
}
