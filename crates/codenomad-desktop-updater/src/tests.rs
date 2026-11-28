use std::{
    collections::BTreeMap,
    fs,
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair as _},
};
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::TcpListener,
};

fn run_async<F: std::future::Future<Output = ()>>(future: F) {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build updater test runtime")
        .block_on(future);
}

use super::{
    GithubRelease, InstallLaunchOptions, MinisignAlgorithm, PreviewOrdering, UpdateCheckOutcome,
    UpdateError, UpdateFeed, UpdaterConfig, acquire_update_lease, build_installer_args,
    check_for_update, cleanup_staged, download_and_verify, launch_installer,
    minisign::{Blake2b512, encode_lower_hex},
    select_release_candidate, sha256_hex_lowercase, validate_update_url, verify_minisign,
};

struct TestKeypair {
    key_id: [u8; 8],
    pair: Ed25519KeyPair,
    public_key_encoded: String,
}

impl TestKeypair {
    fn generate(key_id: [u8; 8]) -> Self {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate test Ed25519 key");
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse test Ed25519 key");
        let mut packet = Vec::with_capacity(42);
        packet.extend_from_slice(b"Ed");
        packet.extend_from_slice(&key_id);
        packet.extend_from_slice(pair.public_key().as_ref());
        let text = format!(
            "untrusted comment: minisign public key: test\n{}\n",
            BASE64.encode(&packet)
        );
        Self {
            key_id,
            pair,
            public_key_encoded: BASE64.encode(text.as_bytes()),
        }
    }

    fn sign(&self, bytes: &[u8], algorithm: MinisignAlgorithm, trusted_comment: &str) -> String {
        let (tag, data_sig) = match algorithm {
            MinisignAlgorithm::PrehashedBlake2b512 => {
                let mut hasher = Blake2b512::new();
                hasher.update(bytes);
                let digest = hasher.finalize();
                (b"ED", self.pair.sign(&digest))
            }
            MinisignAlgorithm::LegacyRawEd25519 => (b"Ed", self.pair.sign(bytes)),
        };
        let mut packet = Vec::with_capacity(74);
        packet.extend_from_slice(tag);
        packet.extend_from_slice(&self.key_id);
        packet.extend_from_slice(data_sig.as_ref());

        let mut global_msg = Vec::with_capacity(64 + trusted_comment.len());
        global_msg.extend_from_slice(data_sig.as_ref());
        global_msg.extend_from_slice(trusted_comment.as_bytes());
        let global_sig = self.pair.sign(&global_msg);

        let text = format!(
            "untrusted comment: signature from test\n{}\ntrusted comment: {trusted_comment}\n{}\n",
            BASE64.encode(&packet),
            BASE64.encode(global_sig.as_ref()),
        );
        BASE64.encode(text.as_bytes())
    }
}

#[derive(Clone)]
struct HttpFixtureResponse {
    status: &'static str,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl HttpFixtureResponse {
    fn ok(body: impl Into<Vec<u8>>) -> Self {
        Self {
            status: "200 OK",
            headers: Vec::new(),
            body: body.into(),
        }
    }

    fn redirect(location: impl Into<String>) -> Self {
        Self {
            status: "302 Found",
            headers: vec![("Location".into(), location.into())],
            body: Vec::new(),
        }
    }
}

struct LoopbackServer {
    base_url: String,
    handle: tokio::task::JoinHandle<()>,
}

impl LoopbackServer {
    async fn start(routes: BTreeMap<String, HttpFixtureResponse>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback test server");
        let addr = listener.local_addr().expect("local addr");
        let routes = Arc::new(routes);
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let routes = Arc::clone(&routes);
                tokio::spawn(async move {
                    let mut req_buf = [0u8; 4096];
                    let Ok(read) = socket.read(&mut req_buf).await else {
                        return;
                    };
                    if read == 0 {
                        return;
                    }
                    let req = String::from_utf8_lossy(&req_buf[..read]);
                    let path = req
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let reply = routes.get(path).cloned().unwrap_or(HttpFixtureResponse {
                        status: "404 Not Found",
                        headers: Vec::new(),
                        body: b"not found".to_vec(),
                    });
                    let mut head = format!(
                        "HTTP/1.1 {}\r\nContent-Length: {}\r\nConnection: close\r\n",
                        reply.status,
                        reply.body.len()
                    );
                    for (name, value) in &reply.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&reply.body).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        Self {
            base_url: format!("http://127.0.0.1:{}", addr.port()),
            handle,
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}

impl Drop for LoopbackServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

fn temp_test_dir(label: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let path = std::env::temp_dir().join(format!(
        "codenomad-updater-test-{label}-{}-{nanos}",
        std::process::id()
    ));
    fs::create_dir_all(&path).expect("create temp test dir");
    path
}

fn manifest_json(
    version: &str,
    target: &str,
    artifact_url: &str,
    signature: &str,
    sha256: Option<&str>,
) -> Vec<u8> {
    let mut entry = serde_json::Map::new();
    entry.insert("url".into(), serde_json::Value::String(artifact_url.into()));
    entry.insert(
        "signature".into(),
        serde_json::Value::String(signature.into()),
    );
    if let Some(hash) = sha256 {
        entry.insert("sha256".into(), serde_json::Value::String(hash.into()));
    }
    let mut platforms = serde_json::Map::new();
    platforms.insert(target.into(), serde_json::Value::Object(entry));
    let mut root = serde_json::Map::new();
    root.insert("version".into(), serde_json::Value::String(version.into()));
    root.insert("platforms".into(), serde_json::Value::Object(platforms));
    serde_json::to_vec(&serde_json::Value::Object(root)).expect("serialize manifest")
}

#[test]
fn blake2b_512_matches_rfc_7693_test_vectors() {
    // Empty input (RFC 7693 Appendix A / standard BLAKE2b-512 vector)
    let empty = Blake2b512::new().finalize();
    assert_eq!(
        encode_lower_hex(&empty),
        "786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce"
    );

    // "abc" (RFC 7693 Appendix A)
    let mut abc = Blake2b512::new();
    abc.update(b"abc");
    assert_eq!(
        encode_lower_hex(&abc.finalize()),
        "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923"
    );

    // Streaming split across the 128-byte block boundary must match single-shot hashing.
    let payload: Vec<u8> = (0..300u16).map(|n| (n % 251) as u8).collect();
    let mut whole = Blake2b512::new();
    whole.update(&payload);
    let mut chunked = Blake2b512::new();
    for part in payload.chunks(17) {
        chunked.update(part);
    }
    assert_eq!(whole.finalize(), chunked.finalize());
}

#[test]
fn url_policy_requires_https_and_rejects_credentials() {
    assert!(
        validate_update_url(
            "https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.2.1/latest.json",
            false
        )
        .is_ok()
    );
    assert!(validate_update_url("http://127.0.0.1:8080/latest.json", false).is_err());
    assert!(validate_update_url("http://example.com/latest.json", true).is_err());
    assert!(validate_update_url("file:///C:/Windows/cmd.exe", true).is_err());
    assert!(validate_update_url("https://user:pass@github.com/latest.json", false).is_err());
    assert!(validate_update_url("http://127.0.0.1:8080/latest.json", true).is_ok());
    assert!(validate_update_url("http://localhost:8080/latest.json", true).is_ok());
}

#[test]
fn preview_feed_selection_and_resolution_match_contract() {
    assert_eq!(UpdateFeed::resolve(None, "1.2.0"), UpdateFeed::Stable);
    assert_eq!(
        UpdateFeed::resolve(None, "1.2.0-dev.4"),
        UpdateFeed::Preview
    );
    assert_eq!(
        UpdateFeed::resolve(None, "1.2.0-dev-20261128"),
        UpdateFeed::Preview
    );
    assert_eq!(
        UpdateFeed::resolve(Some(UpdateFeed::Stable), "1.2.0-dev.4"),
        UpdateFeed::Stable
    );

    let installed = GithubRelease {
        tag_name: "v1.3.0-dev.1".into(),
        draft: false,
        prerelease: true,
        published_at: Some("2026-11-20T10:00:00Z".into()),
        asset_names: vec!["latest.json".into()],
    };
    let newer_preview = GithubRelease {
        tag_name: "v1.2.9-dev.2".into(),
        draft: false,
        prerelease: true,
        published_at: Some("2026-11-28T10:00:00Z".into()),
        asset_names: vec!["latest.json".into()],
    };
    let candidate = select_release_candidate(
        &[installed.clone(), newer_preview],
        Some(&installed),
        "1.3.0-dev.1",
        UpdateFeed::Preview,
    )
    .expect("newer preview publication should win");
    assert_eq!(candidate.version, "1.2.9-dev.2");
    assert!(candidate.preview_ordering.is_some());
    assert_eq!(
        candidate
            .manifest_url("NeuralNomadsAI/CodeNomad")
            .unwrap()
            .as_str(),
        "https://github.com/NeuralNomadsAI/CodeNomad/releases/download/v1.2.9-dev.2/latest.json"
    );
}

#[test]
fn check_for_update_handles_available_up_to_date_and_refuses_downgrade() {
    run_async(async {
        let key = TestKeypair::generate(*b"TESTKEY1");
        let payload = b"fake-signed-installer-payload";
        let sig_next = key.sign(
            payload,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1700000000\tfile:setup.exe\tversion:1.3.0",
        );
        let sig_same = key.sign(
            payload,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1700000000\tfile:setup.exe\tversion:1.2.0",
        );
        let sig_old = key.sign(
            payload,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1700000000\tfile:setup.exe\tversion:1.1.9",
        );

        let mut routes = BTreeMap::new();
        routes.insert(
            "/next.json".into(),
            HttpFixtureResponse::ok(manifest_json(
                "1.3.0",
                "windows-x86_64",
                "https://downloads.example.com/setup-1.3.0.exe",
                &sig_next,
                Some(&sha256_hex_lowercase(payload)),
            )),
        );
        routes.insert(
            "/same.json".into(),
            HttpFixtureResponse::ok(manifest_json(
                "1.2.0",
                "windows-x86_64",
                "https://downloads.example.com/setup-1.2.0.exe",
                &sig_same,
                None,
            )),
        );
        routes.insert(
            "/old.json".into(),
            HttpFixtureResponse::ok(manifest_json(
                "1.1.9",
                "windows-x86_64",
                "https://downloads.example.com/setup-1.1.9.exe",
                &sig_old,
                None,
            )),
        );
        let server = LoopbackServer::start(routes).await;

        let cfg = |path: &str| {
            UpdaterConfig::for_target(
                "1.2.0",
                server.url(path),
                &key.public_key_encoded,
                "windows-x86_64",
            )
            .with_loopback_http_for_tests()
        };

        match check_for_update(&cfg("/next.json"))
            .await
            .expect("available")
        {
            UpdateCheckOutcome::Available(info) => assert_eq!(info.version, "1.3.0"),
            other => panic!("expected Available, got {other:?}"),
        }

        assert_eq!(
            check_for_update(&cfg("/same.json"))
                .await
                .expect("up to date"),
            UpdateCheckOutcome::UpToDate {
                current_version: "1.2.0".into()
            }
        );

        assert_eq!(
            check_for_update(&cfg("/old.json")).await,
            Err(UpdateError::DowngradeRefused {
                current: "1.2.0".into(),
                candidate: "1.1.9".into()
            })
        );

        // Preview publication ordering allows a newer timestamp even when SemVer is lower.
        let mut preview_cfg = cfg("/old.json");
        preview_cfg.preview_ordering = Some(PreviewOrdering {
            installed_published_at: "2026-11-20T00:00:00Z".into(),
            candidate_published_at: "2026-11-28T00:00:00Z".into(),
        });
        assert!(matches!(
            check_for_update(&preview_cfg).await,
            Ok(UpdateCheckOutcome::Available(info)) if info.version == "1.1.9"
        ));
    });
}

#[test]
fn download_and_verify_end_to_end_succeeds_for_prehashed_and_legacy_signatures() {
    run_async(async {
        let key = TestKeypair::generate(*b"KEY_E2E!");
        let payload = vec![0x4du8; 64 * 1024 + 137];
        let hash = sha256_hex_lowercase(&payload);
        let sig_ed_prehash = key.sign(
            &payload,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1700000000\tfile:setup.exe\tversion:2.0.0",
        );
        let sig_ed_legacy = key.sign(
            &payload,
            MinisignAlgorithm::LegacyRawEd25519,
            "timestamp:1700000000\tfile:setup.exe\tversion:2.0.1",
        );

        let mut routes = BTreeMap::new();
        routes.insert(
            "/setup.exe".into(),
            HttpFixtureResponse::ok(payload.clone()),
        );
        let server = LoopbackServer::start(routes).await;

        let staging_root = temp_test_dir("e2e");

        for (version, sig) in [("2.0.0", sig_ed_prehash), ("2.0.1", sig_ed_legacy)] {
            let manifest = manifest_json(
                version,
                "windows-x86_64",
                &server.url("/setup.exe"),
                &sig,
                Some(&hash),
            );
            let mut m_routes = BTreeMap::new();
            m_routes.insert("/latest.json".into(), HttpFixtureResponse::ok(manifest));
            let m_server = LoopbackServer::start(m_routes).await;

            let cfg = UpdaterConfig::for_target(
                "1.9.0",
                m_server.url("/latest.json"),
                &key.public_key_encoded,
                "windows-x86_64",
            )
            .with_loopback_http_for_tests();

            let UpdateCheckOutcome::Available(info) =
                check_for_update(&cfg).await.expect("check succeeds")
            else {
                panic!("expected available update");
            };

            let staged = download_and_verify(&cfg, &info, &staging_root)
                .await
                .expect("verified download must succeed");
            assert_eq!(staged.sha256, hash);
            assert_eq!(staged.byte_len, payload.len() as u64);
            assert!(staged.artifact_path.exists());
            assert_eq!(fs::read(&staged.artifact_path).unwrap(), payload);
            assert!(!staged.stage_directory.join("payload.part").exists());
            cleanup_staged(&staged).expect("cleanup staged dir");
            assert!(!staged.stage_directory.exists());
        }

        let _ = fs::remove_dir_all(&staging_root);
    });
}

#[test]
fn tampered_forged_wrong_key_mismatched_version_hash_and_bad_redirects_are_refused() {
    run_async(async {
        let key_good = TestKeypair::generate(*b"GOODKEY1");
        let key_other = TestKeypair::generate(*b"OTHERKEY");
        let original = b"legitimate-installer-binary-content";
        let tampered = b"tampered---installer-binary-content";

        let valid_sig = key_good.sign(
            original,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1\tversion:2.0.0",
        );
        let wrong_key_sig = key_other.sign(
            original,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1\tversion:2.0.0",
        );
        let wrong_version_sig = key_good.sign(
            original,
            MinisignAlgorithm::PrehashedBlake2b512,
            "timestamp:1\tversion:1.9.9",
        );

        // Tamper the trusted comment after signing.
        let decoded_sig = String::from_utf8(BASE64.decode(&valid_sig).unwrap()).unwrap();
        let forged_comment_sig = BASE64.encode(
            decoded_sig
                .replace("version:2.0.0", "version:9.9.9")
                .as_bytes(),
        );

        assert!(verify_minisign(tampered, &valid_sig, &key_good.public_key_encoded).is_err());
        assert!(verify_minisign(original, &wrong_key_sig, &key_good.public_key_encoded).is_err());
        assert!(
            verify_minisign(original, &forged_comment_sig, &key_good.public_key_encoded).is_err()
        );
        assert!(
            verify_minisign(
                original,
                "not-valid-base64!!!",
                &key_good.public_key_encoded
            )
            .is_err()
        );

        let mut routes = BTreeMap::new();
        routes.insert(
            "/tampered.exe".into(),
            HttpFixtureResponse::ok(tampered.to_vec()),
        );
        routes.insert(
            "/original.exe".into(),
            HttpFixtureResponse::ok(original.to_vec()),
        );
        routes.insert(
            "/bad-redirect.exe".into(),
            HttpFixtureResponse::redirect("http://evil.example.com/payload.exe"),
        );
        let server = LoopbackServer::start(routes).await;
        let staging_root = temp_test_dir("refusals");

        let cfg = UpdaterConfig::for_target(
            "1.0.0",
            server.url("/latest.json"),
            &key_good.public_key_encoded,
            "windows-x86_64",
        )
        .with_loopback_http_for_tests();

        // 1. Tampered payload fails Ed25519 verification and leaves zero staged files behind.
        let tampered_info = super::UpdateInfo {
            version: "2.0.0".into(),
            target: "windows-x86_64".into(),
            url: server.url("/tampered.exe"),
            signature: valid_sig.clone(),
            sha256: None,
            notes: None,
            pub_date: None,
        };
        assert!(matches!(
            download_and_verify(&cfg, &tampered_info, &staging_root).await,
            Err(UpdateError::SignatureVerificationFailed { .. })
        ));
        assert_eq!(fs::read_dir(&staging_root).unwrap().count(), 0);

        // 2. Wrong signing key fails before download.
        let wrong_key_info = super::UpdateInfo {
            signature: wrong_key_sig,
            url: server.url("/original.exe"),
            ..tampered_info.clone()
        };
        assert!(matches!(
            download_and_verify(&cfg, &wrong_key_info, &staging_root).await,
            Err(UpdateError::SignatureVerificationFailed { .. })
        ));

        // 3. Signed version mismatch fails before download.
        let wrong_version_info = super::UpdateInfo {
            signature: wrong_version_sig,
            url: server.url("/original.exe"),
            ..tampered_info.clone()
        };
        assert!(matches!(
            download_and_verify(&cfg, &wrong_version_info, &staging_root).await,
            Err(UpdateError::SignedVersionMismatch { .. })
        ));

        // 4. SHA-256 mismatch fails and cleans staging directory.
        let bad_hash_info = super::UpdateInfo {
            url: server.url("/original.exe"),
            sha256: Some("0".repeat(64)),
            ..tampered_info.clone()
        };
        assert!(matches!(
            download_and_verify(&cfg, &bad_hash_info, &staging_root).await,
            Err(UpdateError::HashMismatch { .. })
        ));
        assert_eq!(fs::read_dir(&staging_root).unwrap().count(), 0);

        // 5. Redirect to non-loopback HTTP is rejected fail-closed.
        let redirect_info = super::UpdateInfo {
            url: server.url("/bad-redirect.exe"),
            ..tampered_info.clone()
        };
        assert!(matches!(
            download_and_verify(&cfg, &redirect_info, &staging_root).await,
            Err(UpdateError::Http { .. })
        ));
        assert_eq!(fs::read_dir(&staging_root).unwrap().count(), 0);

        // 6. Oversized payload is aborted and cleaned up.
        let mut tiny_cfg = cfg.clone();
        tiny_cfg.max_artifact_bytes = 8;
        let valid_url_info = super::UpdateInfo {
            url: server.url("/original.exe"),
            ..tampered_info
        };
        assert!(matches!(
            download_and_verify(&tiny_cfg, &valid_url_info, &staging_root).await,
            Err(UpdateError::PayloadTooLarge { .. })
        ));
        assert_eq!(fs::read_dir(&staging_root).unwrap().count(), 0);

        // 7. Production config (no loopback opt-in) rejects HTTP manifest URLs.
        let prod_cfg = UpdaterConfig::for_target(
            "1.0.0",
            server.url("/latest.json"),
            &key_good.public_key_encoded,
            "windows-x86_64",
        );
        assert!(matches!(
            check_for_update(&prod_cfg).await,
            Err(UpdateError::InvalidUrl { .. })
        ));

        let _ = fs::remove_dir_all(&staging_root);
    });
}

#[test]
fn installer_args_match_setup_contract_and_reject_unsafe_paths() {
    let abs = std::env::temp_dir().join("CodeNomad Rune");
    let log = std::env::temp_dir().join("setup.log");
    let mut opts = InstallLaunchOptions::silent_update("1.2.0");
    opts.install_root = Some(abs.clone());
    opts.log_path = Some(log.clone());

    let args = build_installer_args(&opts).expect("valid installer args");
    assert_eq!(
        args,
        vec![
            std::ffi::OsString::from("--silent"),
            std::ffi::OsString::from("--launch"),
            std::ffi::OsString::from("--dir"),
            abs.into_os_string(),
            std::ffi::OsString::from("--log"),
            log.into_os_string(),
        ]
    );

    opts.install_root = Some(PathBuf::from("relative/path"));
    assert!(matches!(
        build_installer_args(&opts),
        Err(UpdateError::InvalidInstallOption { .. })
    ));

    // Non-existent staged artifact must fail before attempting spawn.
    let missing = super::UpdateStageOutcome {
        info: super::UpdateInfo {
            version: "2.0.0".into(),
            target: "windows-x86_64".into(),
            url: "https://example.com/setup.exe".into(),
            signature: String::new(),
            sha256: None,
            notes: None,
            pub_date: None,
        },
        stage_directory: std::env::temp_dir(),
        artifact_path: std::env::temp_dir().join("does-not-exist-codenomad-setup.exe"),
        sha256: "0".repeat(64),
        byte_len: 0,
        trusted_comment: String::new(),
    };
    assert!(launch_installer(&missing, &InstallLaunchOptions::silent_update("1.2.0")).is_err());
    // A cargo test binary runs from target/deps, never a registered install root.
    assert!(!super::in_place_update_supported("0.1.0-test"));
}

#[test]
fn update_lease_serializes_concurrent_operations() {
    let first = acquire_update_lease().expect("first lease succeeds");
    assert_eq!(
        acquire_update_lease().unwrap_err(),
        UpdateError::OperationInProgress
    );
    drop(first);
    assert!(acquire_update_lease().is_ok());
}
