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
        .with_documents(store, "tab-a".into());
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
