use super::*;
mod advanced;
mod appearance;
mod behavior;
mod conversation;
mod custom_palettes;
mod events;
mod info;
mod memory;
mod missions;
mod missions_regressions;
mod missions_regressions_depth;
mod missions_regressions_events;
mod missions_regressions_lifecycle;
mod notifications;
mod opencode;
mod providers;
mod shortcuts;
mod speech;
mod tab_shortcuts;
mod transcript;
use codenomad_client::bounded;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

fn is_inbox_read(first: &str) -> bool {
    first.starts_with("GET /workspaces/") && first.ends_with("/inbox HTTP/1.1")
}

async fn poll_next_request(prefs: &mut Preferences, listener: &TcpListener) -> Request {
    timeout(Duration::from_secs(5), async {
        loop {
            prefs.poll();
            if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                let Some(req) = try_read_request(socket, Duration::from_secs(3)).await else {
                    continue;
                };
                if is_inbox_read(&req.first) {
                    req.reply(200, json!({"data":[]})).await;
                    continue;
                }
                return req;
            }
        }
    })
    .await
    .expect("timed out waiting for expected preferences HTTP request")
}

#[test]
fn settings_direct_chat_uses_the_authenticated_conversation_backend() {
    platform::block_on(async {
        let (listener, mut fixture) = fixture().await;
        let mut backend = fixture.backend.take().unwrap();
        backend.workspace = "direct-project".into();
        backend.session = "direct-session".into();
        let mut root = crate::init();
        let (events, incoming) = bounded(4);
        root.incoming = Some(incoming);
        assert!(root.screen.launcher().is_none());
        assert!(
            events
                .try_send(crate::transport::Event::Connected(backend))
                .is_ok()
        );
        assert!(crate::poll_chat(&mut root, 4));
        super::super::poll(&mut root, &mut rune::Tx::default());
        let (mut config, mut state, mut global) = (false, false, false);
        for _ in 0..7 {
            let read = request(&listener).await;
            let data = match read.first.as_str() {
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                    assert!(!config);
                    config = true;
                    json!({"settings":{"locale":"he"}})
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    assert!(!state);
                    state = true;
                    json!({"appearancePreferences":{"mode":"dark"}})
                }
                "GET /workspaces/direct-project/instance/api/session/direct-session HTTP/1.1" => {
                    json!({"data":{}})
                }
                "GET /workspaces/direct-project/instance/api/session/direct-session/permission HTTP/1.1"
                | "GET /workspaces/direct-project/instance/api/session/direct-session/form HTTP/1.1" =>
                {
                    json!({"data":[]})
                }
                "GET /api/workspaces/direct-project/worktrees HTTP/1.1" => {
                    json!({"worktrees":[{"directory":"/private"}]})
                }
                other
                    if other
                        .starts_with("GET /api/workspaces/direct-project/pending-requests?") =>
                {
                    global = true;
                    json!({"supported":true,"directories":[]})
                }
                other => panic!("unexpected direct chat request: {other}"),
            };
            read.reply(200, data).await;
        }
        assert!(config && state && global);
        wait_until(|| {
            super::super::poll(&mut root, &mut rune::Tx::default());
            let prefs = root.settings.shared.borrow();
            prefs.locale_ready() && prefs.palette_ready()
        })
        .await;
        {
            let prefs = root.settings.shared.borrow();
            assert_eq!(prefs.locale(), Some("he"));
            assert_eq!(prefs.mode(), "dark");
            assert!(prefs.stream.is_none(), "use the conversation event stream");
        }
        let mut runtime = rune::Runtime::new(
            root,
            crate::view,
            (1100.0, 760.0),
            rune::Env::new(false, 1.0),
        );
        runtime.state.draft = rune::TextEdit::new("keep editing");
        runtime.frame(0.0);
        assert!(runtime.find("open-preferences").is_some());
        let has_label = |rt: &rune::Runtime<crate::State>, locale| {
            let label = crate::strings::with_locale(locale, || crate::strings::t("settings.title"));
            rt.accessibility_json().to_string().contains(label)
        };
        assert!(has_label(&runtime, "he"));
        runtime.update(|s, _| s.settings.shared.borrow_mut().set_locale("en"));
        super::super::poll(&mut runtime.state, &mut rune::Tx::default());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(write.body, json!({"settings":{"locale":"en"}}));
        write.reply(200, json!({"settings":{"locale":"en"}})).await;
        wait_until(|| {
            runtime.update_if(super::super::poll);
            runtime.frame(0.02);
            has_label(&runtime, "en")
        })
        .await;
        assert_eq!(runtime.state.draft.text, "keep editing");
    });
}

#[test]
fn settings_reattaching_the_same_address_keeps_newer_choices_and_does_not_replay_old_patches() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        attest(
            &listener,
            prefs.backend.as_ref().unwrap(),
            "fixture-profile",
        )
        .await;
        prefs.set_locale("fr");
        prefs.poll();
        let write = request(&listener).await;
        assert_eq!(write.body, json!({"settings":{"locale":"fr"}}));
        prefs.set_locale("de");
        let address = prefs.backend.as_ref().unwrap().base.clone();
        let next = Backend::connect(&address, "").await.unwrap();
        attest(&listener, &next, "fixture-profile").await;
        prefs.bind(Some(next));
        assert_eq!(prefs.locale_display(), Some("de"));
        prefs.poll();
        let state = request(&listener).await;
        assert!(state.first.starts_with("GET /api/storage/state/ui?"));
        state.reply(200, json!({})).await;
        wait_until(|| {
            prefs.poll();
            prefs.saved(Owner::State) == Some(&json!({}))
        })
        .await;
        write.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| prefs.poll()).await;
        let read = request(&listener).await;
        assert!(read.first.starts_with("GET /api/storage/config/ui?"));
        read.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| prefs.poll()).await;
        let queued = request(&listener).await;
        assert!(queued.first.starts_with("PATCH /api/storage/config/ui "));
        assert_eq!(queued.body, json!({"settings":{"locale":"de"}}));
        queued.reply(200, json!({"settings":{"locale":"de"}})).await;
        wait_until(|| {
            prefs.poll();
            prefs.locale() == Some("de")
        })
        .await;
        assert!(prefs.error().is_none());
    });
}

async fn attest(listener: &TcpListener, backend: &Backend, id: &str) {
    let (out, identity) = bounded(1);
    let backend = backend.clone();
    platform::spawn(async move {
        out.send(backend.attest_server().await).await.unwrap();
    });
    let request = request(listener).await;
    assert_eq!(request.first, "GET /api/meta HTTP/1.1");
    request
        .reply(200, json!({"apiContract":1,"serverId":id}))
        .await;
    assert_eq!(
        timeout(Duration::from_secs(3), identity.recv())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        id
    );
}

#[test]
fn settings_same_address_different_server_profile_does_not_inherit_unsent_writes() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let before = prefs.backend.as_ref().unwrap();
        attest(&listener, before, "profile-a").await;
        let after = Backend::connect(&before.base, "").await.unwrap();
        attest(&listener, &after, "profile-b").await;
        prefs.set_locale("fr");
        prefs.bind(Some(after));
        assert_eq!(prefs.locale_display(), None);
        assert_eq!(prefs.config.requested(Choice::Locale), None);
    });
}

#[test]
fn settings_uses_separate_owners_and_reads_back_an_uncertain_write_once() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences::default();
        let (wake, wakes) = bounded(8);
        prefs.main_wake = Some(std::sync::Arc::new(move || {
            let _ = wake.try_send(());
        }));
        prefs.bind(Some(backend));
        assert!(prefs.poll());
        for _ in 0..2 {
            let request = request(&listener).await;
            let data = match request.first.as_str() {
                "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                    json!({"settings":{"locale":"en"}})
                }
                "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                    json!({"appearancePreferences":{"mode":"system","light":{"scheme":{"id":"linen"}},"dark":{"scheme":{"id":"slate"}}}})
                }
                other => panic!("unexpected initial request {other}"),
            };
            request.reply(200, data).await;
        }
        for _ in 0..2 {
            timeout(Duration::from_secs(3), wakes.recv())
                .await
                .unwrap()
                .unwrap();
        }
        assert!(prefs.poll());
        assert_eq!(prefs.locale(), Some("en"));
        assert_eq!(prefs.palette(false).map(|p| p.id), Some("linen"));
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("slate"));
        prefs.set_mode("dark");
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/state/ui HTTP/1.1");
        assert_eq!(write.body, json!({"appearancePreferences":{"mode":"dark"}}));
        write.reply(503, json!({})).await;
        let read = request(&listener).await;
        assert_eq!(
            read.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        read.reply(503, json!({})).await;
        timeout(Duration::from_secs(3), wakes.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.error(), Some("settings.preferenceSaveFailed"));
        assert_eq!(prefs.mode(), "system");
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("slate"));
        assert!(!prefs.palette_ready());
        prefs.set_locale("he");
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(write.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(write.body, json!({"settings":{"locale":"he"}}));
        write.reply(200, json!({"settings":{"locale":"he"}})).await;
        timeout(Duration::from_secs(3), wakes.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert_eq!(prefs.locale(), Some("he"));
        assert!(!prefs.poll());
    });
}

struct Request {
    socket: tokio::net::TcpStream,
    first: String,
    headers: String,
    body: Value,
}

#[test]
fn settings_shutdown_flushes_the_last_queued_palette_and_observes_a_lost_receipt() {
    let (listener, backend) = platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        (listener, backend)
    });
    let mut prefs = Preferences {
        backend: Some(backend),
        ..Preferences::default()
    };
    prefs.fixture();
    let palette = |id| built_in().iter().find(|p| p.id == id).unwrap();
    prefs.set_palette(palette("slate"));
    assert!(prefs.poll());
    prefs.set_palette(palette("basalt"));
    let (done, receipt) = bounded(1);
    platform::spawn(async move {
        let first = request(&listener).await;
        assert_eq!(
            first.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "slate"
        );
        // The old five-second drain would abandon Basalt here.
        tokio::time::sleep(Duration::from_millis(5400)).await;
        first
            .reply(
                200,
                json!({"appearancePreferences":{"dark":{"scheme":{"id":"slate","appearance":"dark"}}}}),
            )
            .await;
        let second = request(&listener).await;
        assert_eq!(
            second.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "basalt"
        );
        drop(second);
        let reconciliation = request(&listener).await;
        assert_eq!(
            reconciliation.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        reconciliation
            .reply(
                200,
                json!({"appearancePreferences":{"dark":{
            "scheme":{"id":"basalt","appearance":"dark"}}},"unrelated":true}),
            )
            .await;
        done.send(()).await.unwrap();
    });
    assert!(prefs.flush());
    assert!(receipt.try_recv().is_ok());
    assert_eq!(prefs.palette(true).map(|p| p.id), Some("basalt"));
    assert!(prefs.error().is_none());
}

#[test]
fn settings_failed_readback_keeps_the_unsent_palette_parked_until_fresh_authority() {
    platform::block_on(async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
            .await
            .unwrap();
        let mut prefs = Preferences {
            backend: Some(backend),
            ..Preferences::default()
        };
        prefs.fixture();
        let palette = |id| built_in().iter().find(|p| p.id == id).unwrap();
        let (signal, completed) = bounded(4);
        prefs.main_wake = Some(std::sync::Arc::new(move || {
            let _ = signal.try_send(());
        }));
        prefs.set_palette(palette("slate"));
        prefs.poll();
        let patch = request(&listener).await;
        assert_eq!(
            patch.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "slate"
        );
        prefs.set_palette(palette("basalt"));
        drop(patch);
        let read = request(&listener).await;
        assert!(read.first.starts_with("GET "));
        read.reply(503, json!({})).await;
        timeout(Duration::from_secs(3), completed.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        assert!(prefs.state.read_failed());
        assert!(
            !prefs.state.write_failed(),
            "the failed write belongs to the superseded palette"
        );
        assert!(
            timeout(Duration::from_millis(60), listener.accept())
                .await
                .is_err(),
            "do not replay the uncertain or dispatch the queued PATCH"
        );
        assert_eq!(prefs.palette_display(true).map(|p| p.id), Some("basalt"));
        prefs.invalidate(Owner::State);
        prefs.poll();
        let read = request(&listener).await;
        assert!(read.first.starts_with("GET "));
        read.reply(
            200,
            json!({"appearancePreferences":{"mode":"system","dark":{"scheme":{"id":"slate"}}}}),
        )
        .await;
        timeout(Duration::from_secs(3), completed.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(prefs.poll());
        let queued = request(&listener).await;
        assert!(queued.first.starts_with("PATCH "));
        assert_eq!(
            queued.body["appearancePreferences"]["dark"]["scheme"]["id"],
            "basalt"
        );
        queued
            .reply(
                200,
                json!({"appearancePreferences":{"dark":{"scheme":{"id":"basalt","appearance":"dark"}}}}),
            )
            .await;
        timeout(Duration::from_secs(3), completed.recv())
            .await
            .unwrap()
            .unwrap();
        prefs.poll();
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("basalt"));
        assert_eq!(prefs.state.requested(Choice::Palette(true)), None);
    });
}

async fn fixture() -> (TcpListener, Preferences) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let backend = Backend::connect(&format!("http://{}", listener.local_addr().unwrap()), "")
        .await
        .unwrap();
    let mut prefs = Preferences {
        backend: Some(backend),
        ..Preferences::default()
    };
    prefs.fixture();
    (listener, prefs)
}

async fn fixture_atomic() -> (TcpListener, Preferences) {
    let (listener, prefs) = fixture().await;
    prefs
        .backend
        .as_ref()
        .unwrap()
        .client
        .observe_atomic_settings_patches(true);
    (listener, prefs)
}

#[test]
fn settings_a_read_started_before_a_gesture_cannot_consume_its_queued_write() {
    let (listener, mut prefs) = platform::block_on(fixture());
    prefs.invalidate(Owner::Config);
    assert!(prefs.poll());
    platform::block_on(async {
        let stale = request(&listener).await;
        assert!(stale.first.starts_with("GET "));
        prefs.invalidate(Owner::Config);
        prefs.set_locale("fr");
        stale.reply(200, json!({"settings":{"locale":"fr"}})).await;

        wait_until(|| prefs.poll()).await;
        let write = request(&listener).await;
        assert!(
            write.first.starts_with("PATCH "),
            "unexpected request: {}",
            write.first
        );
        assert_eq!(write.body, json!({"settings":{"locale":"fr"}}));
        write.reply(200, json!({"settings":{"locale":"fr"}})).await;

        wait_until(|| prefs.poll()).await;
        let fresh = request(&listener).await;
        assert!(fresh.first.starts_with("GET "));
        fresh.reply(200, json!({"settings":{"locale":"fr"}})).await;
        wait_until(|| prefs.poll()).await;
    });
    assert!(prefs.flush());
    assert_eq!(prefs.locale(), Some("fr"));
}

#[test]
fn settings_a_write_started_before_reselecting_its_value_cannot_consume_the_new_choice() {
    let (listener, mut prefs) = platform::block_on(fixture());
    prefs.set_locale("fr");
    assert!(prefs.poll());
    platform::block_on(async {
        let older = request(&listener).await;
        assert!(older.first.starts_with("PATCH "));
        assert_eq!(older.body, json!({"settings":{"locale":"fr"}}));
        prefs.set_locale("de");
        prefs.set_locale("fr");
        older.reply(200, json!({"settings":{"locale":"fr"}})).await;

        wait_until(|| prefs.poll()).await;
        let newer = request(&listener).await;
        assert!(newer.first.starts_with("PATCH "));
        assert_eq!(newer.body, json!({"settings":{"locale":"fr"}}));
        newer.reply(200, json!({"settings":{"locale":"fr"}})).await;
    });
    assert!(prefs.flush());
}

#[test]
fn settings_first_palette_slot_accepts_the_servers_explicit_nulls() {
    for lost_receipt in [false, true] {
        let (listener, mut prefs) = platform::block_on(fixture());
        prefs.state.snapshot = Some(json!({"appearancePreferences":{"mode":"dark"}}));
        prefs.set_palette(built_in().iter().find(|p| p.id == "basalt").unwrap());
        platform::spawn(async move {
            let write = request(&listener).await;
            assert!(write.first.starts_with("PATCH "));
            let mut saved = write.body.clone();
            assert_eq!(
                saved["appearancePreferences"]["dark"],
                json!({
                    "scheme":{"id":"basalt","appearance":"dark","colors":null},"presetId":null
                })
            );
            saved["appearancePreferences"]["mode"] = json!("dark");
            if lost_receipt {
                drop(write);
                let read = request(&listener).await;
                assert!(read.first.starts_with("GET "));
                read.reply(200, saved).await;
            } else {
                write.reply(200, saved).await;
            }
        });
        assert!(prefs.flush());
        assert_eq!(prefs.palette(true).map(|p| p.id), Some("basalt"));
        assert_eq!(prefs.state.requested(Choice::Palette(true)), None);
    }
}

async fn wait_until(mut check: impl FnMut() -> bool) {
    timeout(Duration::from_secs(3), async {
        while !check() {
            platform::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[test]
fn settings_closing_drains_the_other_owner_even_when_one_cannot_read_back() {
    for (broken, healthy) in [(Owner::Config, Owner::State), (Owner::State, Owner::Config)] {
        let (listener, mut prefs) = platform::block_on(fixture());
        prefs.doc_mut(broken).stage(choice(broken), desired(broken));
        prefs.poll();
        let first = platform::block_on(request(&listener));
        assert!(
            first
                .first
                .starts_with(&format!("PATCH /api/storage/{}/ui ", owner_path(broken)))
        );
        let fallback = if broken == Owner::Config {
            "ja"
        } else {
            "light"
        };
        prefs.doc_mut(broken).stage(choice(broken), fallback);
        prefs
            .doc_mut(healthy)
            .stage(choice(healthy), desired(healthy));
        let (done, receipt) = bounded(1);
        platform::spawn(async move {
            first.reply(503, json!({})).await;
            let mut healthy_write = None;
            for _ in 0..2 {
                let next = request(&listener).await;
                if next
                    .first
                    .starts_with(&format!("GET /api/storage/{}/ui?", owner_path(broken)))
                {
                    next.reply(503, json!({})).await;
                } else {
                    assert!(
                        next.first.starts_with(&format!(
                            "PATCH /api/storage/{}/ui ",
                            owner_path(healthy)
                        ))
                    );
                    healthy_write = Some(next);
                }
            }
            let write = healthy_write.unwrap();
            assert_eq!(write.body, desired_doc(healthy));
            platform::sleep(Duration::from_millis(60)).await;
            write.reply(200, desired_doc(healthy)).await;
            done.send(()).await.unwrap();
        });
        assert!(!prefs.flush());
        assert!(receipt.try_recv().is_ok());
        assert_eq!(prefs.doc(broken).requested(choice(broken)), Some(fallback));
        assert_eq!(prefs.doc(healthy).snapshot, Some(desired_doc(healthy)));
        assert_eq!(prefs.doc(healthy).requested(choice(healthy)), None);
    }
}

fn owner_path(owner: Owner) -> &'static str {
    match owner {
        Owner::Config => "config",
        Owner::State => "state",
        Owner::Server => "config",
    }
}

fn choice(owner: Owner) -> Choice {
    match owner {
        Owner::Config => Choice::Locale,
        Owner::State => Choice::Mode,
        Owner::Server => Choice::LogLevel,
    }
}

fn desired(owner: Owner) -> &'static str {
    match owner {
        Owner::Config => "he",
        Owner::State => "dark",
        Owner::Server => "WARN",
    }
}

fn desired_doc(owner: Owner) -> Value {
    match owner {
        Owner::Config => json!({"settings":{"locale":desired(owner)}}),
        Owner::State => json!({"appearancePreferences":{"mode":desired(owner)}}),
        Owner::Server => json!({"logLevel":desired(owner)}),
    }
}

#[test]
fn settings_passive_reads_never_retry_unconfirmed_writes_but_the_retry_action_does() {
    for confirmed_on_retry in [false, true] {
        let (listener, mut prefs) = platform::block_on(fixture());
        let before = json!({"settings":{"locale":"en"}});
        let after = json!({"settings":{"locale":"he"}});
        platform::block_on(async {
            prefs.set_locale("he");
            assert!(prefs.poll());
            let write = request(&listener).await;
            assert_eq!(write.body, after);
            write.reply(503, json!({})).await;
            request(&listener).await.reply(503, json!({})).await;
            wait_until(|| {
                prefs.poll();
                prefs.config.write_failed()
            })
            .await;

            prefs.invalidate(Owner::Config);
            assert!(prefs.poll());
            let read = request(&listener).await;
            assert!(read.first.starts_with("GET "));
            read.reply(200, before.clone()).await;
            wait_until(|| {
                prefs.poll();
                prefs.locale_ready()
            })
            .await;
            assert_eq!(prefs.error(), Some("settings.preferenceSaveFailed"));
            assert_eq!(prefs.locale_display(), Some("he"));
            assert_eq!(prefs.locale(), Some("en"));
            assert!(
                timeout(Duration::from_millis(60), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(
            !prefs.flush(),
            "a successful read of the old value is not success"
        );
        platform::block_on(async {
            prefs.retry_general();
            assert!(prefs.poll());
            let read = request(&listener).await;
            assert!(read.first.starts_with("GET "));
            read.reply(
                200,
                if confirmed_on_retry {
                    after.clone()
                } else {
                    before
                },
            )
            .await;
            if !confirmed_on_retry {
                wait_until(|| prefs.poll()).await;
                let retry = request(&listener).await;
                assert!(retry.first.starts_with("PATCH "));
                assert_eq!(retry.body, after);
                retry.reply(200, after).await;
            }
            wait_until(|| {
                prefs.poll();
                prefs.error().is_none()
            })
            .await;
            assert!(
                timeout(Duration::from_millis(60), listener.accept())
                    .await
                    .is_err()
            );
        });
        assert!(prefs.flush());
        assert_eq!(prefs.locale(), Some("he"));
    }
}

#[test]
fn settings_window_close_waits_and_warns_only_if_the_choice_is_unconfirmed() {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
    };
    for saved in [false, true] {
        let (listener, mut prefs) = platform::block_on(fixture());
        prefs.set_locale("he");
        let shared = Rc::new(RefCell::new(prefs));
        let mut window =
            crate::settings::view::Window::new(shared.clone(), Rc::new(Cell::new(false)));
        let (done, receipt) = bounded(1);
        platform::spawn(async move {
            let write = request(&listener).await;
            assert_eq!(write.body, json!({"settings":{"locale":"he"}}));
            platform::sleep(Duration::from_millis(60)).await;
            if saved {
                write.reply(200, json!({"settings":{"locale":"he"}})).await;
            } else {
                drop(write);
                let read = request(&listener).await;
                assert!(read.first.starts_with("GET "));
                read.reply(200, json!({"settings":{"locale":"en"}})).await;
            }
            done.send(()).await.unwrap();
        });
        let mut warned = None;
        window.close(|locale| warned = Some(locale));
        assert!(
            receipt.try_recv().is_ok(),
            "closing must wait for settlement"
        );
        assert_eq!(warned, (!saved).then_some("en"));
        assert_eq!(
            shared.borrow().locale(),
            Some(if saved { "he" } else { "en" })
        );
        assert_eq!(shared.borrow().locale_display(), Some("he"));
    }
}

async fn request(listener: &TcpListener) -> Request {
    request_with_timeout(listener, Duration::from_secs(3)).await
}

async fn request_raw(listener: &TcpListener) -> Request {
    let deadline = Duration::from_secs(3);
    timeout(deadline, async {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            if let Some(req) = try_read_request(socket, deadline).await {
                return req;
            }
        }
    })
    .await
    .unwrap()
}

async fn request_with_timeout(listener: &TcpListener, deadline: Duration) -> Request {
    timeout(deadline, async {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            let Some(req) = try_read_request(socket, deadline).await else {
                continue;
            };
            if is_inbox_read(&req.first) {
                req.reply(200, json!({"data":[]})).await;
                continue;
            }
            return req;
        }
    })
    .await
    .unwrap()
}

async fn read_request(socket: tokio::net::TcpStream, deadline: Duration) -> Request {
    try_read_request(socket, deadline)
        .await
        .expect("unexpected EOF reading request")
}

async fn try_read_request(
    mut socket: tokio::net::TcpStream,
    deadline: Duration,
) -> Option<Request> {
    timeout(deadline, async {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            match socket.read_u8().await {
                Ok(byte) => header.push(byte),
                Err(error)
                    if header.is_empty()
                        && matches!(
                            error.kind(),
                            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
                        ) =>
                {
                    return None;
                }
                Err(error) => panic!("read_request header failed: {error}"),
            }
            assert!(header.len() < 8192);
        }
        let header = String::from_utf8(header).unwrap();
        let length = header
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap_or_default();
        assert!(length <= 4096);
        let mut body = vec![0; length];
        socket.read_exact(&mut body).await.unwrap();
        Some(Request {
            socket,
            first: header.lines().next().unwrap().into(),
            headers: header,
            body: if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            },
        })
    })
    .await
    .unwrap()
}

impl Request {
    async fn reply(mut self, status: u16, data: Value) {
        self.reply_with_headers(status, data, "").await;
    }

    async fn reply_no_content(mut self) {
        self.socket
            .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
    }

    async fn reply_with_headers(&mut self, status: u16, data: Value, headers: &str) {
        let body = data.to_string();
        self.socket.write_all(format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        ).as_bytes()).await.unwrap();
    }
}
