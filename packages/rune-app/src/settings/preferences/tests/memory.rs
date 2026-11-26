use super::*;
use crate::settings::memory::action;

#[test]
fn memory_settings_are_demanded_and_failed_writes_only_read_back() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert!(!prefs.poll());
        prefs.memory.show(true);
        assert!(prefs.poll());
        let initial = request(&listener).await;
        assert_eq!(initial.first, "GET /api/memory/settings HTTP/1.1");
        prefs.memory.invalidate();
        prefs.memory.invalidate();
        initial.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        let trailing = request(&listener).await;
        assert_eq!(trailing.first, "GET /api/memory/settings HTTP/1.1");
        trailing.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        action(&mut prefs, Some(true));
        assert!(prefs.poll());
        let put = request(&listener).await;
        assert_eq!(put.first, "PUT /api/memory/settings HTTP/1.1");
        assert_eq!(put.body, json!({"enabled":true}));
        prefs.memory.show(false);
        put.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(readback.first, "GET /api/memory/settings HTTP/1.1");
        readback.reply(200, json!({"enabled":true})).await;
        wait_until(|| prefs.poll()).await;
        prefs.memory.invalidate();
        assert!(!prefs.poll());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn failed_memory_reads_keep_the_last_confirmed_switch_value() {
    fn view(prefs: &Preferences, _: &mut rune::Cx<Preferences>) -> rune::El {
        let help = crate::settings::ExternalLink::default();
        crate::strings::with_locale("en", || {
            crate::settings::memory::view::<Preferences>(
                prefs,
                &help,
                |_, _| {},
                |_| None,
                |_, _| {},
                |_, _| {},
            )
        })
    }

    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.memory.show(true);
        assert!(prefs.poll());
        request(&listener)
            .await
            .reply(200, json!({"enabled":true}))
            .await;
        wait_until(|| prefs.poll()).await;
        prefs.memory.invalidate();
        assert!(prefs.poll());
        request(&listener).await.reply(503, json!({})).await;
        wait_until(|| prefs.poll()).await;
        let mut rt = rune::Runtime::new(prefs, view, (600.0, 340.0), rune::Env::new(false, 1.0));
        rt.frame(0.02);
        let tree = rt.accessibility_json();
        let find = |name| find_name(&tree, name);
        let switch = find("Memory").expect("memory setting");
        assert_eq!(switch["role"], "switch");
        assert!(
            switch["states"]
                .as_array()
                .is_some_and(|states| states.contains(&json!("checked")))
        );
        assert!(find("Memory is unavailable.").is_some());
        assert!(find("Try again").is_some());
    });
}

#[test]
fn reauthentication_on_same_server_keeps_open_memory_edit_saveable_and_different_profile_invalidates()
 {
    use crate::settings::memory::{
        editor::Editor,
        review::{Action, Fields},
        review_action,
    };

    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let rev = "a".repeat(64);
        let next_rev = "b".repeat(64);
        let before = prefs.backend.as_ref().unwrap().clone();
        attest(&listener, &before, "profile-a").await;
        prefs.memory.show(true);
        assert!(prefs.poll());
        let pre_settings_meta = request(&listener).await;
        assert_eq!(pre_settings_meta.first, "GET /api/meta HTTP/1.1");
        pre_settings_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        let settings_req = request(&listener).await;
        assert_eq!(settings_req.first, "GET /api/memory/settings HTTP/1.1");
        settings_req.reply(200, json!({"enabled": true})).await;
        let post_settings_meta = request(&listener).await;
        assert_eq!(post_settings_meta.first, "GET /api/meta HTTP/1.1");
        post_settings_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        wait_until(|| prefs.poll()).await;

        let pre_list_meta = request(&listener).await;
        assert_eq!(pre_list_meta.first, "GET /api/meta HTTP/1.1");
        pre_list_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        let list_req = request(&listener).await;
        assert_eq!(list_req.first, "POST /api/memory HTTP/1.1");
        assert_eq!(list_req.body["operation"]["action"], "list");
        let list_body = json!({
            "scope": "global",
            "scopeKey": "global",
            "observedAt": "2026-01-01T00:00:00Z",
            "entries": [{
                "id": "entry-1",
                "title": "Original",
                "type": "fact",
                "text": "Original text",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "revision": rev,
                "flagged": false
            }]
        });
        list_req.reply(200, list_body.clone()).await;
        let post_list_meta = request(&listener).await;
        assert_eq!(post_list_meta.first, "GET /api/meta HTTP/1.1");
        post_list_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        wait_until(|| prefs.poll()).await;

        let edit = prefs
            .memory
            .review_first_edit()
            .expect("loaded memory edit");
        assert!(prefs.memory.review_is_current(&edit));
        assert!(prefs.memory.review_writable(&edit));
        let mut editor = Editor::default();
        editor.open(edit.clone());
        editor.edit_text("Edited before reauth");
        assert!(
            !prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut editor)
        );
        assert!(editor.shown());
        assert_eq!(editor.draft_text(), "Edited before reauth");

        // Re-authenticate on the same server (new client_id, same base + server_identity).
        let reauthed = Backend::connect(&before.base, "").await.unwrap();
        attest(&listener, &reauthed, "profile-a").await;
        assert_ne!(reauthed.client_id, before.client_id);
        prefs.bind(Some(reauthed));
        assert!(prefs.poll());
        assert!(
            !prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut editor)
        );
        assert!(editor.shown());
        assert_eq!(editor.draft_text(), "Edited before reauth");
        // The open edit must remain current while the fresh list is in flight (no false conflict).
        assert!(prefs.memory.review_is_current(&edit));
        assert!(!prefs.memory.review_writable(&edit));

        let mut saw_list = false;
        let mut saw_settings = false;
        let mut saw_config = false;
        let mut saw_state = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !saw_list
            || !saw_settings
            || !saw_config
            || !saw_state
            || !prefs.memory.review_writable(&edit)
        {
            prefs.poll();
            if saw_list
                && saw_settings
                && saw_config
                && saw_state
                && prefs.memory.review_writable(&edit)
            {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "re-authentication did not settle in time: saw_list={saw_list}, saw_settings={saw_settings}, saw_config={saw_config}, saw_state={saw_state}, review_writable={}, transport_lost={}",
                prefs.memory.review_writable(&edit),
                prefs.transport_lost()
            );
            if let Ok(Ok((stream, _))) = timeout(Duration::from_millis(20), listener.accept()).await
            {
                let req = read_request(stream, Duration::from_secs(2)).await;
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => {
                        req.reply(
                            200,
                            json!({
                                "apiContract": 1,
                                "serverId": "profile-a",
                                "capabilities": ["settings-atomic-patches"]
                            }),
                        )
                        .await;
                    }
                    "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                        saw_config = true;
                        req.reply(200, json!({"settings":{"locale":"en"}})).await;
                    }
                    "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                        saw_state = true;
                        req.reply(200, json!({})).await;
                    }
                    "GET /api/memory/settings HTTP/1.1" => {
                        saw_settings = true;
                        req.reply(200, json!({"enabled": true})).await;
                    }
                    "POST /api/memory HTTP/1.1" if req.body["operation"]["action"] == "list" => {
                        saw_list = true;
                        req.reply(200, list_body.clone()).await;
                    }
                    other => panic!("unexpected request after re-auth: {other}"),
                }
            }
        }
        assert!(prefs.memory.review_writable(&edit));

        let admitted = review_action(
            &mut prefs,
            Action::Write(
                edit.clone(),
                Some(Fields {
                    title: "Updated".into(),
                    text: editor.draft_text().to_owned(),
                    kind: codenomad_client::settings::memory::Kind::Fact,
                }),
            ),
        );
        assert!(admitted);
        editor.mark_submitted();
        let pre_save_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(pre_save_meta.first, "GET /api/meta HTTP/1.1");
        pre_save_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        let save_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(save_req.first, "POST /api/memory HTTP/1.1");
        assert_eq!(save_req.body["operation"]["action"], "save");
        assert_eq!(save_req.body["operation"]["id"], "entry-1");
        assert_eq!(save_req.body["operation"]["revision"], rev);
        assert_eq!(
            save_req.body["operation"]["content"]["text"],
            "Edited before reauth"
        );
        save_req
            .reply(200, json!({"id": "entry-1", "revision": next_rev}))
            .await;
        let post_write_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(post_write_meta.first, "GET /api/meta HTTP/1.1");
        post_write_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        wait_until(|| {
            prefs.poll();
            prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut editor)
        })
        .await;
        assert!(!editor.shown());
        let post_save_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(post_save_meta.first, "GET /api/meta HTTP/1.1");
        post_save_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        let post_save_list = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(post_save_list.first, "POST /api/memory HTTP/1.1");
        assert_eq!(post_save_list.body["operation"]["action"], "list");
        let updated_list = json!({
            "scope": "global",
            "scopeKey": "global",
            "observedAt": "2026-01-01T00:01:00Z",
            "entries": [{
                "id": "entry-1",
                "title": "Updated",
                "type": "fact",
                "text": "Edited before reauth",
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:01:00Z",
                "revision": next_rev,
                "flagged": false
            }]
        });
        post_save_list.reply(200, updated_list).await;
        let post_save_list_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(post_save_list_meta.first, "GET /api/meta HTTP/1.1");
        post_save_list_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        let updated_edit = prefs
            .memory
            .review_first_edit()
            .expect("updated memory edit");
        assert!(prefs.memory.review_is_current(&updated_edit));
        assert!(prefs.memory.review_writable(&updated_edit));

        // Switching to a different server profile while a real HTTP save POST is in flight must
        // invalidate the review, close the stale editor, and ignore the late reply from profile A.
        let wake_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let wake_notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let count_signal = wake_count.clone();
        let wake_signal = wake_notify.clone();
        prefs.window_wake = Some(std::sync::Arc::new(move || {
            count_signal.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            wake_signal.notify_waiters();
        }));
        let mut inflight_editor = Editor::default();
        inflight_editor.open(updated_edit.clone());
        inflight_editor.edit_text("In-flight profile A edit");
        assert!(
            !prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut inflight_editor)
        );
        assert!(review_action(
            &mut prefs,
            Action::Write(
                updated_edit.clone(),
                Some(Fields {
                    title: "Stale".into(),
                    text: inflight_editor.draft_text().to_owned(),
                    kind: codenomad_client::settings::memory::Kind::Fact,
                }),
            ),
        ));
        inflight_editor.mark_submitted();
        let held_meta = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(held_meta.first, "GET /api/meta HTTP/1.1");
        held_meta
            .reply(
                200,
                json!({
                    "apiContract": 1,
                    "serverId": "profile-a",
                    "capabilities": ["settings-atomic-patches"]
                }),
            )
            .await;
        let held_save_req = poll_next_request(&mut prefs, &listener).await;
        assert_eq!(held_save_req.first, "POST /api/memory HTTP/1.1");
        assert_eq!(held_save_req.body["operation"]["action"], "save");
        let other = Backend::connect(&before.base, "").await.unwrap();
        attest(&listener, &other, "profile-b").await;
        prefs.bind(Some(other));
        assert!(!prefs.memory.review_is_current(&updated_edit));
        assert!(!prefs.memory.review_writable(&updated_edit));
        assert!(
            prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut inflight_editor)
        );
        assert!(!inflight_editor.shown());
        let before_reply = wake_count.load(std::sync::atomic::Ordering::SeqCst);
        held_save_req
            .reply(200, json!({"id": "entry-1", "revision": "c".repeat(64)}))
            .await;
        // Wait specifically for the post-write /api/meta and wake emitted after replying to
        // profile A's held POST while also serving any concurrent profile-B refresh reads.
        let mut saw_post_meta = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !saw_post_meta || wake_count.load(std::sync::atomic::Ordering::SeqCst) <= before_reply
        {
            assert!(
                std::time::Instant::now() < deadline,
                "late profile-A write task did not finish and notify wake: saw_post_meta={saw_post_meta}"
            );
            if let Ok(Ok((stream, _))) = timeout(Duration::from_millis(20), listener.accept()).await
            {
                let req = read_request(stream, Duration::from_secs(2)).await;
                match req.first.as_str() {
                    "GET /api/meta HTTP/1.1" => {
                        saw_post_meta = true;
                        req.reply(
                            200,
                            json!({
                                "apiContract": 1,
                                "serverId": "profile-b",
                                "capabilities": ["settings-atomic-patches"]
                            }),
                        )
                        .await;
                    }
                    "GET /api/storage/config/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({"settings":{"locale":"en"}})).await;
                    }
                    "GET /api/storage/state/ui?authoritative=1 HTTP/1.1" => {
                        req.reply(200, json!({})).await;
                    }
                    "GET /api/memory/settings HTTP/1.1" => {
                        req.reply(200, json!({"enabled": false})).await;
                    }
                    other => {
                        panic!("unexpected request while draining late profile-A write: {other}")
                    }
                }
            }
        }
        prefs.poll();
        assert!(
            !prefs
                .memory
                .poll_editor(prefs.backend.as_ref(), &mut inflight_editor)
        );
        assert!(!prefs.memory.review_is_current(&updated_edit));
        assert!(!inflight_editor.shown());
    });
}

fn find_name<'a>(tree: &'a Value, name: &str) -> Option<&'a Value> {
    if tree["name"] == name && matches!(tree["role"].as_str(), Some("switch" | "button" | "alert"))
    {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| find_name(child, name))
}
