use super::*;
mod advanced;
mod appearance;
mod behavior;
mod conversation;
mod events;
mod info;
mod memory;
mod notifications;
mod opencode;
mod providers;
mod shortcuts;
mod tab_shortcuts;
mod transcript;
use codenomad_client::bounded;
use std::time::Duration;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    time::timeout,
};

async fn poll_next_request(prefs: &mut Preferences, listener: &TcpListener) -> Request {
    timeout(Duration::from_secs(5), async {
        loop {
            prefs.poll();
            if let Ok(accepted) = timeout(Duration::from_millis(20), listener.accept()).await {
                let (socket, _) = accepted.unwrap();
                return read_request(socket, Duration::from_secs(3)).await;
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
        let (mut config, mut state) = (false, false);
        for _ in 0..5 {
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
                other => panic!("unexpected direct chat request: {other}"),
            };
            read.reply(200, data).await;
        }
        assert!(config && state);
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
fn settings_window_close_is_non_blocking_and_warns_only_if_the_choice_is_unconfirmed() {
    use std::{
        cell::{Cell, RefCell},
        rc::Rc,
        time::Instant,
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
            platform::sleep(Duration::from_millis(80)).await;
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
        let started = Instant::now();
        let mut warned = None;
        window.close(|locale| warned = Some(locale));
        assert!(
            started.elapsed() < Duration::from_millis(50),
            "closing Preferences must never block the UI thread"
        );
        assert!(
            shared.try_borrow_mut().is_ok(),
            "closing Preferences must release the shared RefCell immediately"
        );
        assert!(shared.borrow().has_close_drain());
        assert_eq!(warned, None);
        platform::block_on(wait_until(|| {
            let mut prefs = shared.borrow_mut();
            prefs.poll();
            if let Some(locale) = prefs.take_save_warning() {
                warned = Some(locale);
            }
            !prefs.has_close_drain()
        }));
        assert!(
            receipt.try_recv().is_ok(),
            "background close drain must wait for settlement before clearing"
        );
        assert_eq!(warned, (!saved).then_some("en"));
        assert!(
            !shared.borrow_mut().take_notification_failure(),
            "failed close drain must not emit a duplicate generic toast"
        );
        assert_eq!(
            shared.borrow().locale(),
            Some(if saved { "he" } else { "en" })
        );
        assert_eq!(shared.borrow().locale_display(), Some("he"));
    }

    // With a completely silent server, closing returns immediately without blocking or holding
    // RefCell, wakes via the cancellable deadline timer (without polling), and emits the warning.
    let (silent_listener, mut silent_prefs) = platform::block_on(fixture());
    let (wake_tx, wake_rx) = bounded(8);
    silent_prefs.main_wake = Some(std::sync::Arc::new(move || {
        let _ = wake_tx.try_send(());
    }));
    silent_prefs.set_drain_budgets(Duration::from_millis(60), Duration::from_millis(120));
    silent_prefs.set_locale("he");
    let shared_silent = Rc::new(RefCell::new(silent_prefs));
    let mut silent_window =
        crate::settings::view::Window::new(shared_silent.clone(), Rc::new(Cell::new(false)));
    let started = Instant::now();
    let mut immediate_warn = None;
    silent_window.close(|locale| immediate_warn = Some(locale));
    assert!(started.elapsed() < Duration::from_millis(50));
    assert_eq!(immediate_warn, None);
    assert!(shared_silent.try_borrow_mut().is_ok());
    assert!(shared_silent.borrow().has_close_drain());
    // Consume the initial begin_close_drain wake so the next wake must come from the deadline timer.
    while wake_rx.try_recv().is_ok() {}
    platform::block_on(async {
        let _held_patch = request(&silent_listener).await;
        let mut warning = None;
        timeout(Duration::from_secs(2), async {
            while shared_silent.borrow().has_close_drain() {
                wake_rx
                    .recv()
                    .await
                    .expect("deadline timer must wake UI without fallback polling");
                let mut prefs = shared_silent.borrow_mut();
                prefs.poll();
                if let Some(locale) = prefs.take_save_warning() {
                    warning = Some(locale);
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(warning, Some("en"));
        assert!(!shared_silent.borrow_mut().take_notification_failure());
    });

    // Reopening Preferences cancels any active close drain without firing a stale warning.
    let (_reopen_listener, mut reopen_prefs) = platform::block_on(fixture());
    reopen_prefs.set_drain_budgets(Duration::from_millis(60), Duration::from_millis(120));
    reopen_prefs.set_locale("he");
    let shared_reopen = Rc::new(RefCell::new(reopen_prefs));
    let mut reopen_window =
        crate::settings::view::Window::new(shared_reopen.clone(), Rc::new(Cell::new(false)));
    reopen_window.close(|_| panic!("should not warn immediately while draining"));
    assert!(shared_reopen.borrow().has_close_drain());
    shared_reopen.borrow_mut().cancel_close_drain();
    assert!(!shared_reopen.borrow().has_close_drain());
    assert_eq!(shared_reopen.borrow_mut().take_save_warning(), None);

    // An HTTP PATCH already in flight before a CloseDrainWindow attaches its own waker still
    // wakes the new drain waker immediately upon completion instead of waiting for stall_budget.
    let (handoff_listener, mut handoff_prefs) = platform::block_on(fixture());
    handoff_prefs.set_drain_budgets(Duration::from_secs(10), Duration::from_secs(20));
    handoff_prefs.set_locale("he");
    handoff_prefs.poll();
    assert_eq!(
        handoff_prefs.begin_close_drain(true),
        crate::settings::preferences::CloseOutcome::Draining
    );
    let (drain_wake_tx, drain_wake_rx) = bounded(8);
    handoff_prefs.attach_close_drain_wake(std::sync::Arc::new(move || {
        let _ = drain_wake_tx.try_send(());
    }));
    // Consume the initial attach wake so the next wake must come from the in-flight PATCH.
    assert!(drain_wake_rx.try_recv().is_ok());
    platform::block_on(async {
        let write = request(&handoff_listener).await;
        assert_eq!(write.body, json!({"settings":{"locale":"he"}}));
        write.reply(200, json!({"settings":{"locale":"he"}})).await;
        timeout(Duration::from_millis(500), drain_wake_rx.recv())
            .await
            .expect("in-flight PATCH must wake the newly attached close-drain waker")
            .unwrap();
        handoff_prefs.poll();
        assert!(!handoff_prefs.has_close_drain());
        assert_eq!(handoff_prefs.take_save_warning(), None);
        assert_eq!(handoff_prefs.locale(), Some("he"));
    });

    // A delayed wake past the stall deadline (while the total deadline is still active) must NOT
    // revive the expired drain or dispatch a newly queued PATCH before failing.
    let (expired_listener, mut expired_prefs) = platform::block_on(fixture());
    expired_prefs.set_drain_budgets(Duration::from_millis(50), Duration::from_secs(5));
    expired_prefs.set_locale("he");
    expired_prefs.poll();
    platform::block_on(async {
        let first_write = request(&expired_listener).await;
        assert_eq!(first_write.body, json!({"settings":{"locale":"he"}}));
        // Queue a second Config write while the first PATCH is still in flight.
        expired_prefs.set_locale("fr");
        assert_eq!(
            expired_prefs.begin_close_drain(true),
            crate::settings::preferences::CloseOutcome::Draining
        );
        platform::sleep(Duration::from_millis(75)).await;
        // Reply 200 to the first PATCH after the stall budget expired but well before total budget:
        // poll() may settle the arrived reply, must NOT revive last_progress, and must NOT send "fr".
        first_write
            .reply(200, json!({"settings":{"locale":"he"}}))
            .await;
        platform::sleep(Duration::from_millis(20)).await;
        expired_prefs.poll();
        assert!(!expired_prefs.has_close_drain());
        assert_eq!(expired_prefs.take_save_warning(), Some("he"));
        assert!(!expired_prefs.documents_draining());
        assert!(expired_prefs.config.write_failed());
        // Subsequent polls must not resume the abandoned queue or emit a second failure toast.
        expired_prefs.poll();
        assert!(!expired_prefs.take_notification_failure());
        assert!(
            timeout(Duration::from_millis(80), expired_listener.accept())
                .await
                .is_err(),
            "expired close drain must not dispatch a follow-up PATCH"
        );
    });

    // After a Preferences-only timeout, a late rejection on the timed-out PATCH must NOT trigger a
    // second toast or resume the remaining queued edits on the main window's ordinary poll.
    let (pref_timeout_listener, mut pref_timeout_prefs) = platform::block_on(fixture());
    pref_timeout_prefs.set_drain_budgets(Duration::from_millis(45), Duration::from_secs(5));
    pref_timeout_prefs.set_locale("he");
    pref_timeout_prefs.poll();
    platform::block_on(async {
        let held_write = request(&pref_timeout_listener).await;
        assert_eq!(held_write.body, json!({"settings":{"locale":"he"}}));
        pref_timeout_prefs.set_locale("fr");
        assert_eq!(
            pref_timeout_prefs.begin_close_drain(false),
            crate::settings::preferences::CloseOutcome::Draining
        );
        platform::sleep(Duration::from_millis(70)).await;
        pref_timeout_prefs.poll();
        assert!(!pref_timeout_prefs.has_close_drain());
        assert_eq!(pref_timeout_prefs.take_save_warning(), Some("en"));
        assert!(!pref_timeout_prefs.documents_draining());
        assert!(pref_timeout_prefs.config.write_failed());
        assert_eq!(pref_timeout_prefs.locale_display(), Some("fr"));
        held_write.reply(500, json!({"error":"boom"})).await;
        platform::sleep(Duration::from_millis(25)).await;
        pref_timeout_prefs.poll();
        assert!(!pref_timeout_prefs.take_notification_failure());
        assert!(
            timeout(Duration::from_millis(80), pref_timeout_listener.accept())
                .await
                .is_err(),
            "ordinary poll after Preferences-only drain timeout must not resume abandoned writes"
        );
    });

    // Reaching the 16-operation cap during settlement must fail before dispatching a 17th operation.
    let (cap_listener, mut cap_prefs) = platform::block_on(fixture());
    cap_prefs.set_drain_budgets(Duration::from_secs(5), Duration::from_secs(10));
    cap_prefs.set_locale("he");
    cap_prefs.poll();
    platform::block_on(async {
        let op16 = request(&cap_listener).await;
        assert_eq!(op16.body, json!({"settings":{"locale":"he"}}));
        cap_prefs.set_locale("fr");
        assert_eq!(
            cap_prefs.begin_close_drain(true),
            crate::settings::preferences::CloseOutcome::Draining
        );
        cap_prefs.set_close_drain_settled_ops(15);
        op16.reply(200, json!({"settings":{"locale":"he"}})).await;
        wait_until(|| {
            cap_prefs.poll();
            !cap_prefs.has_close_drain()
        })
        .await;
        assert_eq!(cap_prefs.take_save_warning(), Some("he"));
        assert!(!cap_prefs.documents_draining());
        assert!(cap_prefs.config.write_failed());
        assert!(
            timeout(Duration::from_millis(80), cap_listener.accept())
                .await
                .is_err(),
            "settling the 16th operation must not dispatch a 17th PATCH inline"
        );
    });

    // A worker held before PATCH admission must never send a PATCH after the drain expires.
    let (gated_listener, mut gated_prefs) = platform::block_on(fixture());
    gated_prefs.set_drain_budgets(Duration::from_millis(45), Duration::from_secs(5));
    let (gate_tx, gate_rx) = bounded(1);
    gated_prefs.config.set_pre_patch_gate(gate_rx);
    gated_prefs.set_locale("he");
    assert_eq!(
        gated_prefs.begin_close_drain(false),
        crate::settings::preferences::CloseOutcome::Draining
    );
    platform::block_on(async {
        platform::sleep(Duration::from_millis(70)).await;
        gated_prefs.poll();
        assert!(!gated_prefs.has_close_drain());
        assert_eq!(gated_prefs.take_save_warning(), Some("en"));
        gate_tx.send(()).await.unwrap();
        assert!(
            timeout(Duration::from_millis(80), gated_listener.accept())
                .await
                .is_err(),
            "abandoned pre-patch flight must not transmit a PATCH after expiry"
        );
    });

    // Abandoning an ordered transcript queue (row edit, then preset) must not invert their order on Retry.
    let (order_listener, mut order_prefs) = platform::block_on(fixture());
    order_prefs.set_drain_budgets(Duration::from_millis(45), Duration::from_secs(5));
    order_prefs.set_locale("he");
    order_prefs.poll();
    platform::block_on(async {
        let held_locale = request(&order_listener).await;
        order_prefs.set_transcript(
            Some(crate::settings::transcript_preset::Row::Diagnostics),
            "hidden",
        );
        order_prefs.set_transcript(None, "everything");
        assert_eq!(
            order_prefs.begin_close_drain(false),
            crate::settings::preferences::CloseOutcome::Draining
        );
        platform::sleep(Duration::from_millis(70)).await;
        order_prefs.poll();
        assert!(!order_prefs.has_close_drain());
        assert_eq!(order_prefs.take_save_warning(), Some("en"));
        drop(held_locale);
        order_prefs.retry_transcript();
        order_prefs.poll();
        let retry_read = request(&order_listener).await;
        assert!(retry_read.first.starts_with("GET "));
        retry_read
            .reply(200, json!({"settings":{"locale":"en"}}))
            .await;
        let retry_patch = poll_next_request(&mut order_prefs, &order_listener).await;
        assert_eq!(retry_patch.first, "PATCH /api/storage/config/ui HTTP/1.1");
        assert_eq!(
            retry_patch.body["settings"]["diagnosticsExpansion"],
            json!("expanded"),
            "Retry after row-then-preset timeout must apply preset (expanded), not earlier hidden row: {}",
            retry_patch.body
        );
        let saved = retry_patch.body["settings"].clone();
        retry_patch.reply(200, json!({"settings": saved})).await;
    });

    // Admission budget across multiple owners: at 15 settled ops with 2 ready owners, admit at most 1.
    let (multi_listener, mut multi_prefs) = platform::block_on(fixture());
    multi_prefs.set_drain_budgets(Duration::from_secs(5), Duration::from_secs(10));
    multi_prefs.set_locale("he");
    multi_prefs.poll();
    platform::block_on(async {
        let first_config = request(&multi_listener).await;
        assert_eq!(
            multi_prefs.begin_close_drain(true),
            crate::settings::preferences::CloseOutcome::Draining
        );
        // Settle Config as op #15 while State and Server are both ready to write.
        multi_prefs.set_close_drain_settled_ops(14);
        multi_prefs
            .doc_mut(Owner::State)
            .stage(Choice::Mode, "dark");
        multi_prefs
            .doc_mut(Owner::Server)
            .stage(Choice::LogLevel, "WARN");
        first_config
            .reply(200, json!({"settings":{"locale":"he"}}))
            .await;
        let admitted_one = poll_next_request(&mut multi_prefs, &multi_listener).await;
        assert!(
            timeout(Duration::from_millis(80), multi_listener.accept())
                .await
                .is_err(),
            "at 15 settled ops, admission budget must allow at most 1 new owner flight, not 2"
        );
        drop(admitted_one);
    });

    // Fixed total deadline: successive settlements refresh stall budget but cannot extend total budget.
    let (total_listener, mut total_prefs) = platform::block_on(fixture());
    total_prefs.set_drain_budgets(Duration::from_millis(120), Duration::from_millis(90));
    total_prefs.set_locale("he");
    total_prefs.poll();
    platform::block_on(async {
        let first = request(&total_listener).await;
        total_prefs.set_locale("fr");
        assert_eq!(
            total_prefs.begin_close_drain(true),
            crate::settings::preferences::CloseOutcome::Draining
        );
        platform::sleep(Duration::from_millis(55)).await;
        first.reply(200, json!({"settings":{"locale":"he"}})).await;
        let second = poll_next_request(&mut total_prefs, &total_listener).await;
        total_prefs.set_locale("de");
        platform::sleep(Duration::from_millis(55)).await;
        second.reply(200, json!({"settings":{"locale":"fr"}})).await;
        platform::sleep(Duration::from_millis(15)).await;
        total_prefs.poll();
        assert!(!total_prefs.has_close_drain());
        assert_eq!(total_prefs.take_save_warning(), Some("fr"));
        assert!(
            timeout(Duration::from_millis(80), total_listener.accept())
                .await
                .is_err(),
            "fixed total deadline must expire even after successive stall-refreshing settlements"
        );
    });

    // A non-shutdown Preferences close drain on Config still allows unrelated State SSE refreshes.
    let (idle_listener, mut idle_prefs) = platform::block_on(fixture());
    idle_prefs.set_drain_budgets(Duration::from_secs(5), Duration::from_secs(10));
    idle_prefs.set_locale("he");
    assert_eq!(
        idle_prefs.begin_close_drain(false),
        crate::settings::preferences::CloseOutcome::Draining
    );
    platform::block_on(async {
        let held_config_patch = request(&idle_listener).await;
        assert_eq!(
            held_config_patch.first,
            "PATCH /api/storage/config/ui HTTP/1.1"
        );
        idle_prefs.invalidate_from_sse(Owner::State);
        idle_prefs.poll();
        let state_read = request(&idle_listener).await;
        assert_eq!(
            state_read.first,
            "GET /api/storage/state/ui?authoritative=1 HTTP/1.1"
        );
        state_read
            .reply(200, json!({"appearancePreferences":{"mode":"dark"}}))
            .await;
        wait_until(|| {
            idle_prefs.poll();
            idle_prefs.mode() == "dark"
        })
        .await;
        assert!(idle_prefs.has_close_drain());
        held_config_patch
            .reply(200, json!({"settings":{"locale":"he"}}))
            .await;
        wait_until(|| {
            idle_prefs.poll();
            !idle_prefs.has_close_drain()
        })
        .await;
        assert_eq!(idle_prefs.take_save_warning(), None);
        assert_eq!(idle_prefs.locale(), Some("he"));
    });

    // Explicit app quit (flush_on_quit) drains both an in-flight PATCH and a queued follow-up edit.
    let (quit_listener, mut quit_prefs) = platform::block_on(fixture());
    quit_prefs.set_locale("he");
    quit_prefs.poll();
    let (quit_done, quit_rx) = bounded(1);
    platform::spawn(async move {
        let first = request(&quit_listener).await;
        assert_eq!(first.body, json!({"settings":{"locale":"he"}}));
        platform::sleep(Duration::from_millis(40)).await;
        first.reply(200, json!({"settings":{"locale":"he"}})).await;
        let second = request(&quit_listener).await;
        assert_eq!(second.body, json!({"settings":{"locale":"fr"}}));
        second.reply(200, json!({"settings":{"locale":"fr"}})).await;
        quit_done.send(()).await.unwrap();
    });
    quit_prefs.set_locale("fr");
    assert!(quit_prefs.flush_on_quit());
    assert!(quit_rx.try_recv().is_ok());
    assert_eq!(quit_prefs.locale(), Some("fr"));
}

async fn request(listener: &TcpListener) -> Request {
    request_with_timeout(listener, Duration::from_secs(3)).await
}

async fn request_with_timeout(listener: &TcpListener, deadline: Duration) -> Request {
    let (socket, _) = timeout(deadline, listener.accept()).await.unwrap().unwrap();
    read_request(socket, deadline).await
}

async fn read_request(mut socket: tokio::net::TcpStream, deadline: Duration) -> Request {
    timeout(deadline, async {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
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
        Request {
            socket,
            first: header.lines().next().unwrap().into(),
            headers: header,
            body: if length == 0 {
                Value::Null
            } else {
                serde_json::from_slice(&body).unwrap()
            },
        }
    })
    .await
    .unwrap()
}

impl Request {
    async fn reply(mut self, status: u16, data: Value) {
        self.reply_with_headers(status, data, "").await;
    }

    async fn reply_with_headers(&mut self, status: u16, data: Value, headers: &str) {
        let body = data.to_string();
        self.socket.write_all(format!(
            "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n{headers}\r\n{body}",
            body.len()
        ).as_bytes()).await.unwrap();
    }
}
