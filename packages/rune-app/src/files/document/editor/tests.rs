use super::*;
use crate::files::test_http as http;
use crate::{files::Ui, platform::reads::Reads};
use http::{Http, Request};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

async fn poll(ui: &mut Ui, done: impl Fn(&Ui) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !done(ui) {
        assert!(Instant::now() < deadline, "document completion deadline");
        ui.poll(20.0);
        tokio::time::sleep(Duration::from_millis(2)).await;
    }
}
async fn request(ui: &mut Ui, http: &Http, method: &str, path: &str) -> Request {
    use std::{
        future::{Future, poll_fn},
        task::Poll,
    };
    let mut task = std::pin::pin!(http.request(method, path));
    let mut tick = tokio::time::interval(Duration::from_millis(2));
    poll_fn(|cx| {
        ui.poll(20.0);
        if let Poll::Ready(result) = task.as_mut().poll(cx) {
            return Poll::Ready(result);
        }
        if tick.poll_tick(cx).is_ready() {
            cx.waker().wake_by_ref();
        }
        Poll::Pending
    })
    .await
}
async fn open(ui: &mut Ui, http: &Http, path: &str, encoded: &str, text: &str) {
    ui.open(path.into());
    request(ui, http, "GET", path)
        .await
        .preview(path, encoded, Some("v1"))
        .await;
    poll(ui, |ui| {
        !ui.reader.busy() && ui.document.edit().text == text
    })
    .await;
}
fn edit(ui: &mut Ui, text: &str) {
    let scope = ui.document.scope();
    ui.document.input(scope).replace_text(text);
    ui.document.changed(scope);
}
fn save(ui: &mut Ui) {
    ui.save_document(ui.document.scope());
}

#[test]
fn closing_a_peer_reader_keeps_the_save_check_owned_by_the_requesting_reader() {
    platform::block_on(async {
        let http = Http::new().await;
        let store = Store::default();
        let mut first = http.ui(store.clone(), "first");
        let mut peer = http.ui(store, "peer");
        open(&mut first, &http, "first.txt", "YQ==", "a").await;
        peer.document.draft = first.document.draft.clone();
        edit(&mut first, "edited");
        save(&mut first);
        let check = request(&mut first, &http, "GET", "first.txt").await;
        peer.close_reader();
        assert!(first.document.pending());
        check.preview("first.txt", "YQ==", Some("v1")).await;
        let put = request(&mut first, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "edited");
        put.reply(204, serde_json::Value::Null).await;
        poll(&mut first, |ui| {
            !ui.document.pending() && !ui.document.dirty()
        })
        .await;
    });
}

#[test]
fn reopening_requires_a_fresh_native_project_identity_after_git_init() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "first");
        ui.document.set_project(Project {
            id: "owned".into(),
            path: "/private".into(),
            temporary: false,
        });
        for (project, expected) in [("global", None), ("initialized", Some("initialized"))] {
            ui.open("first.txt".into());
            assert!(!ui.document.editable());
            for _ in 0..2 {
                let request = http.accept().await;
                if request.header.contains("/instance/api/location") {
                    request.reply(200, serde_json::json!({"data": {"directory": "/private", "project": {"id": project}}})).await;
                } else {
                    assert!(request.header.contains("/files/preview"));
                    request.preview("first.txt", "YQ==", Some("v1")).await;
                }
                ui.poll(20.0);
            }
            poll(&mut ui, |ui| ui.document.editable()).await;
            assert_eq!(
                ui.document.key().unwrap().native_project.as_deref(),
                expected
            );
            ui.close_reader();
        }
    });
}

#[test]
fn a_detached_save_updates_the_fingerprint_of_edits_made_during_the_put() {
    platform::block_on(async {
        let http = Http::new().await;
        let store = Store::default();
        let mut ui = http.ui(store.clone(), "first");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        let key = ui.document.key.clone().unwrap();
        let durable = SavedKey {
            server: "installation".into(),
            project: "/private".into(),
            native_project: None,
            directory: key.directory.clone(),
            path: key.path.clone(),
        };
        ui.document.saved_key = Some(durable.clone());
        edit(&mut ui, "b");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v1"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        edit(&mut ui, "c");
        let shared = ui.document.draft.clone().unwrap();
        ui.close_reader();
        let fingerprint = format!("\"{}\"", "b".repeat(64));
        put.send(
            &format!("HTTP/1.1 204 No Content\r\nETag: {fingerprint}\r\nConnection: close\r\n\r\n"),
            b"",
        )
        .await;
        poll(&mut ui, |_| lock(&shared).pending.is_none()).await;
        let (_, bytes) = store.file_draft_snapshot(0).unwrap();
        let reopened = Store::default();
        assert!(reopened.hydrate_file_drafts(&bytes));
        let draft = reopened.open_saved(&key, Some(&durable));
        assert_eq!(lock(&draft).version.as_deref(), Some(fingerprint.as_str()));
        assert_eq!(lock(&draft).text, "c");
        for (etag, contents, conflict) in
            [(fingerprint.as_str(), "Yg==", false), ("v1", "YQ==", true)]
        {
            let fresh = Store::default();
            assert!(fresh.hydrate_file_drafts(&bytes));
            let mut editor = http.ui(fresh.clone(), "reopened");
            editor.open("first.txt".into());
            editor.document.draft = Some(fresh.open_saved(&key, Some(&durable)));
            request(&mut editor, &http, "GET", "first.txt")
                .await
                .preview("first.txt", contents, Some(etag))
                .await;
            poll(&mut editor, |ui| ui.reader.receipt().1 && !ui.reader.busy()).await;
            assert_eq!(
                editor.document.error() == Some(Error::Conflict(None)),
                conflict
            );
            assert!(editor.document.dirty());
        }
    });
}

#[cfg(feature = "test-support")]
#[test]
fn returning_to_sessions_keeps_the_file_draft_and_blocks_closing_its_tab() {
    use crate::workspace;
    let (mut s, http) = platform::block_on(async {
        let http = Http::new().await;
        let mut s = crate::init();
        crate::gallery::shell::fixture(&mut s);
        s.workspace = Some(workspace::Ui::new());
        workspace::connected(&mut s);
        let project = s.screen.launcher().unwrap().project.clone().unwrap();
        workspace::opened(&mut s, &project);
        let mut files = http.ui(s.documents.clone(), "tab-0");
        open(&mut files, &http, "first.txt", "YQ==", "a").await;
        edit(&mut files, "unsaved edit");
        s.files = Some(files);
        (s, http)
    });
    crate::launcher::back(&mut s);
    assert!(s.screen.is_launcher() && s.files.is_none());
    let mut rt = rune::Runtime::new(s, crate::view, (1000.0, 800.0), rune::Env::new(false, 1.0));
    rt.update(|s, tx| workspace::close(s, "tab-0", tx));
    assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), "tab-0");
    rt.update(|s, tx| workspace::new_tab(s, tx));
    rt.update(|s, tx| workspace::close(s, "tab-0", tx));
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().snapshot().tabs.len(),
        2
    );
    platform::block_on(async {
        let mut files = http.ui(rt.state.documents.clone(), "tab-0");
        open(&mut files, &http, "first.txt", "YQ==", "unsaved edit").await;
        edit(&mut files, "a");
    });
    rt.update(|s, tx| workspace::close(s, "tab-0", tx));
    assert_eq!(
        rt.state.workspace.as_ref().unwrap().snapshot().tabs.len(),
        1
    );
}
fn cached_listing(ui: &mut Ui) {
    use codenomad_client::files::{Entry, EntryKind};
    ui.tree.activate(true);
    let listing = ui.tree.load(".", false).unwrap();
    assert!(ui.tree.complete(
        listing,
        Ok(vec![Entry {
            name: "first.txt".into(),
            path: "first.txt".into(),
            kind: EntryKind::File,
            absolute_path: None,
            directory_identity: None,
            size: Some(1),
            modified_at: None,
        }]),
        Ok
    ));
    assert!(ui.tree.take_refresh().is_empty());
    ui.tree.activate(false);
}

#[test]
fn saved_document_invalidates_its_listing_without_a_watch_event() {
    platform::block_on(async {
        let http = Http::new().await;
        let store = Store::default();
        let mut ui = http.ui(store.clone(), "tab-a");
        let mut other = http.ui(store, "tab-b");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        for files in [&mut ui, &mut other] {
            cached_listing(files);
        }
        edit(&mut ui, "bbbb");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v1"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "bbbb");
        put.reply(204, serde_json::Value::Null).await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        ui.poll(20.0);
        other.poll(20.0);
        ui.tree.activate(true);
        other.tree.activate(true);
        assert!(!ui.tree.take_refresh().is_empty());
        assert!(other.tree.take_refresh().is_empty());
    });
}

#[test]
fn reconciled_content_invalidates_listing_without_replaying_a_write() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        cached_listing(&mut ui);
        edit(&mut ui, "bbbb");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YmJiYg==", Some("already-written"))
            .await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        ui.poll(20.0);
        assert!(!ui.document.dirty());
        ui.tree.activate(true);
        assert!(!ui.tree.take_refresh().is_empty());
        http.quiet().await;
    });
}

#[test]
fn reopening_during_write_waits_for_ack_before_admitting_a_fresh_read() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v1"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        ui.close_reader();
        ui.open("first.txt".into());
        ui.poll(20.0);
        http.quiet().await;
        assert!(ui.document.pending());
        assert_eq!(ui.document.edit().text, "b");
        put.reply(204, serde_json::Value::Null).await;
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v2"))
            .await;
        poll(&mut ui, |ui| !ui.reader.busy() && !ui.document.pending()).await;
        assert_eq!(ui.document.edit().text, "b");
        assert!(!ui.document.dirty());
    });
}

#[test]
fn save_requires_a_post_gesture_read_and_retains_edits_after_departure() {
    platform::block_on(async {
        let http = Http::new().await;
        let store = Store::default();
        let mut ui = http.ui(store.clone(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        ui.reader.refresh();
        let old = request(&mut ui, &http, "GET", "first.txt").await;
        save(&mut ui);
        let fresh = request(&mut ui, &http, "GET", "first.txt").await;
        http.quiet().await;
        drop(old);
        fresh
            .preview("first.txt", "YQ==", Some("after-gesture"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(
            put.body,
            serde_json::json!({"contents":"b", "expectedVersion":"after-gesture"})
        );
        edit(&mut ui, "c");
        let first = ui.document.key().unwrap().clone();
        ui.close_reader();
        open(&mut ui, &http, "other.txt", "eA==", "x").await;
        put.reply(204, serde_json::Value::Null).await;
        let deadline = Instant::now() + Duration::from_secs(3);
        while lock(&store.open(&first)).pending.is_some() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(store.has_tab_edits("tab-a"));
        assert_eq!(ui.document.edit().text, "x");
        ui.close_reader();
        let mut another_session = http.backend.clone();
        another_session.session = "other-session".into();
        let mut resumed = Ui::new(
            another_session,
            "/private".into(),
            Reads::default(),
            Arc::new(|| {}),
        )
        .with_documents(store.clone(), "tab-a".into());
        resumed.online(true);
        resumed.open("first.txt".into());
        assert_eq!(resumed.document.edit().text, "c");
        assert_eq!(
            lock(resumed.document.draft.as_ref().unwrap())
                .original
                .as_ref()
                .map(|original| original.text.as_str()),
            Some("b")
        );
        request(&mut resumed, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v3"))
            .await;
        poll(&mut resumed, |ui| !ui.reader.busy()).await;
        assert_eq!(resumed.document.edit().text, "c");
        save(&mut resumed);
        request(&mut resumed, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v4"))
            .await;
        let put = request(&mut resumed, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "c");
        put.reply(204, serde_json::Value::Null).await;
        poll(&mut resumed, |ui| !ui.document.pending()).await;
        assert!(!resumed.document.dirty());
        // Closing the reader synchronizes the latest clean baseline in the registry.
        resumed.close_reader();
        assert!(!store.has_tab_edits("tab-a"));
        http.quiet().await;
    });
}

#[test]
fn overwrite_and_discard_decisions_are_scoped_and_writes_require_versions() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", None)
            .await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        assert_eq!(ui.document.error(), Some(Error::MissingVersion));
        http.quiet().await;
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "eA==", Some("v2"))
            .await;
        poll(&mut ui, |ui| ui.document.confirmation().is_some()).await;
        let old = ui.document.confirmation().unwrap();
        assert_eq!(old.decision, Decision::Overwrite);
        ui.confirm_document(old.id, false);
        assert!(ui.document.dirty());
        http.quiet().await;
        save(&mut ui);
        let checking = request(&mut ui, &http, "GET", "first.txt").await;
        edit(&mut ui, "c");
        checking.preview("first.txt", "eA==", Some("v3")).await;
        poll(&mut ui, |ui| ui.document.confirmation().is_some()).await;
        let current = ui.document.confirmation().unwrap();
        assert_ne!(old.id, current.id);
        ui.confirm_document(old.id, true);
        assert_eq!(ui.document.confirmation(), Some(current));
        ui.confirm_document(current.id, true);
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["expectedVersion"], "v3");
        assert_eq!(put.body["contents"], "b");
        put.reply(204, serde_json::Value::Null).await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        assert_eq!(ui.document.edit().text, "c");
        assert!(ui.document.dirty());
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v4"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "c");
        put.reply(409, serde_json::json!({})).await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        assert_eq!(ui.document.error(), Some(Error::Conflict(None)));
        http.quiet().await;
        ui.refresh_document(ui.document.scope());
        let discard = ui.document.confirmation().unwrap();
        assert_eq!(discard.decision, Decision::Discard);
        ui.confirm_document(discard.id, false);
        assert_eq!(ui.document.edit().text, "c");
        ui.refresh_document(ui.document.scope());
        let discard = ui.document.confirmation().unwrap();
        ui.confirm_document(discard.id, true);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "eA==", Some("v4"))
            .await;
        poll(&mut ui, |ui| ui.document.edit().text == "x").await;
        assert!(!ui.document.dirty());
    });
}

#[test]
fn lost_write_acknowledgement_reconciles_before_an_explicit_new_save() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v2"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "b");
        drop(put);
        poll(&mut ui, |ui| !ui.document.pending()).await;
        assert_eq!(ui.document.error(), Some(Error::Uncertain));
        http.quiet().await;
        edit(&mut ui, "c");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v3"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(
            put.body,
            serde_json::json!({"contents":"c", "expectedVersion":"v3"})
        );
        put.reply(204, serde_json::Value::Null).await;
        poll(&mut ui, |ui| !ui.document.pending()).await;
        assert!(!ui.document.dirty());
        http.quiet().await;
    });
}

#[test]
fn clean_undo_after_a_lost_acknowledgement_can_refresh_without_replaying() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        save(&mut ui);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v2"))
            .await;
        let put = request(&mut ui, &http, "PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "b");
        edit(&mut ui, "a");
        drop(put);
        http::wait(async {
            while ui.document.writing() {
                tokio::task::yield_now().await;
            }
        })
        .await;
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v3"))
            .await;
        poll(&mut ui, |ui| !ui.reader.busy()).await;
        assert_eq!(ui.reader.preview().unwrap().bytes.as_slice(), b"b");
        assert_eq!(ui.document.edit().text, "a");
        assert!(!ui.document.dirty());
        assert_eq!(ui.document.error(), Some(Error::Uncertain));
        http.quiet().await;
        ui.refresh_document(ui.document.scope());
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("v4"))
            .await;
        poll(&mut ui, |ui| !ui.reader.busy()).await;
        assert_eq!(ui.document.edit().text, "b");
        assert!(!ui.document.dirty());
        assert_eq!(ui.document.error(), None);
        http.quiet().await;
    });
}

#[test]
fn closing_and_suspending_fence_checks_edits_and_old_decisions() {
    platform::block_on(async {
        let http = Http::new().await;
        let store = Store::default();
        let mut ui = http.ui(store.clone(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        let departed = ui.document.scope();
        save(&mut ui);
        let held = request(&mut ui, &http, "GET", "first.txt").await;
        ui.activate(false);
        assert!(!ui.document.pending());
        drop(held);
        http.quiet().await;
        ui.activate(true);
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "YQ==", Some("v2"))
            .await;
        poll(&mut ui, |ui| !ui.reader.busy()).await;
        assert_eq!(ui.document.edit().text, "b");
        open(&mut ui, &http, "other.txt", "eA==", "x").await;
        ui.document.input(departed).replace_text("stale");
        ui.document.changed(departed);
        edit(&mut ui, "y");
        ui.save_document(departed);
        assert_eq!(ui.document.edit().text, "y");
        assert!(!ui.document.pending());
        http.quiet().await;
        let mut different_instance = http.ui(store, "tab-b");
        open(&mut different_instance, &http, "first.txt", "YQ==", "a").await;
        assert!(!different_instance.document.dirty());
    });
}

#[test]
fn trailing_read_is_fenced_at_write_admission_before_the_next_frame() {
    platform::block_on(async {
        let http = Http::new().await;
        let mut ui = http.ui(Store::default(), "tab-a");
        open(&mut ui, &http, "first.txt", "YQ==", "a").await;
        edit(&mut ui, "b");
        save(&mut ui);
        let preflight = request(&mut ui, &http, "GET", "first.txt").await;
        ui.reader.refresh();
        preflight
            .preview("first.txt", "YQ==", Some("before-write"))
            .await;
        let deadline = Instant::now() + Duration::from_secs(3);
        while ui.reader.receipt().0 < 2 {
            assert!(Instant::now() < deadline);
            ui.reader.poll(20.0);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        let stale = http.request("GET", "first.txt").await;
        ui.document.poll(&mut ui.reader);
        let put = http.request("PUT", "first.txt").await;
        assert_eq!(put.body["contents"], "b");
        let old = stale
            .try_reply(
                200,
                serde_json::json!({
                    "workspaceId":"owned", "relativePath":"first.txt", "encoding":"base64",
                    "contents":"YQ==", "version":"before-write"
                }),
            )
            .await;
        if let Err(error) = old {
            assert!(matches!(
                error.kind(),
                std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::NotConnected
            ));
        }
        put.reply(204, serde_json::Value::Null).await;
        let deadline = Instant::now() + Duration::from_secs(3);
        while ui.document.writing() {
            assert!(Instant::now() < deadline);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        ui.poll(20.0);
        assert_eq!(
            ui.document.edit().text,
            "b",
            "the old GET loses authority before PUT dispatch"
        );
        request(&mut ui, &http, "GET", "first.txt")
            .await
            .preview("first.txt", "Yg==", Some("after-write"))
            .await;
        poll(&mut ui, |ui| !ui.reader.busy()).await;
        assert_eq!(ui.document.edit().text, "b");
        assert!(!ui.document.dirty());
        http.quiet().await;
    });
}
