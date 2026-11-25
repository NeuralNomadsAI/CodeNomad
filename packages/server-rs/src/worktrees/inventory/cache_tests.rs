use super::*;
use crate::{
    App, Workspace,
    opencode::Native,
    worktrees::{Input, list, owns},
};
use axum::{
    Json, Router,
    extract::{Path, Query, Request, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{
    path::{Path as StdPath, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::Notify;
use uuid::Uuid;

struct Gate {
    hold: AtomicBool,
    entered: Notify,
    release: Notify,
    waiting: AtomicUsize,
}

impl Gate {
    fn new() -> Self {
        Self {
            hold: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            waiting: AtomicUsize::new(0),
        }
    }

    fn arm(&self) {
        self.hold.store(true, Ordering::SeqCst);
    }

    fn open(&self) {
        self.hold.store(false, Ordering::SeqCst);
        self.release.notify_waiters();
    }

    async fn pass(&self) {
        if self.hold.load(Ordering::SeqCst) {
            self.waiting.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_waiters();
            while self.hold.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
            self.waiting.fetch_sub(1, Ordering::SeqCst);
        }
    }

    async fn wait_entered(&self) {
        while self.waiting.load(Ordering::SeqCst) == 0 {
            self.entered.notified().await;
        }
    }
}

struct FakeNative {
    root: PathBuf,
    extra: Mutex<Vec<PathBuf>>,
    fail_worktree: AtomicBool,
    worktree_gets: AtomicUsize,
    worktree_refreshes: AtomicUsize,
    gate: Gate,
}

async fn fake_native(State(f): State<Arc<FakeNative>>, request: Request) -> Response {
    match (request.method().clone(), request.uri().path()) {
        (Method::GET, "/api/location") => {
            let requested = reqwest::Url::parse(&format!("http://localhost{}", request.uri()))
                .ok()
                .and_then(|url| {
                    url.query_pairs().find(|(k, _)| k == "location[directory]").map(|(_, v)| v.into_owned())
                })
                .unwrap_or_else(|| f.root.to_string_lossy().into_owned());
            Json(json!({
                "directory": requested,
                "project": {"id": "project_cache", "directory": f.root, "canonical": f.root}
            }))
            .into_response()
        }
        (Method::POST, "/api/worktree/refresh") => {
            f.worktree_refreshes.fetch_add(1, Ordering::SeqCst);
            f.gate.pass().await;
            if f.fail_worktree.load(Ordering::SeqCst) {
                return Status::INTERNAL_SERVER_ERROR.into_response();
            }
            Status::NO_CONTENT.into_response()
        }
        (Method::GET, "/api/worktree") => {
            f.worktree_gets.fetch_add(1, Ordering::SeqCst);
            if f.fail_worktree.load(Ordering::SeqCst) {
                return Status::INTERNAL_SERVER_ERROR.into_response();
            }
            let mut rows = vec![json!({"directory": f.root})];
            for dir in f.extra.lock().unwrap().iter() {
                rows.push(json!({"directory": dir}));
            }
            Json(json!(rows)).into_response()
        }
        _ => Status::NOT_IMPLEMENTED.into_response(),
    }
}

struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Harness {
    _dir: TempDir,
    root: PathBuf,
    native: Arc<FakeNative>,
    app: Shared,
    id: Uuid,
    ws: Workspace,
    events: Arc<crate::events::Sub>,
    http: tokio::task::JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.http.abort();
    }
}

async fn git_ok(path: &StdPath, args: &[&str]) {
    let out = crate::git::command(path, args).output().await.unwrap();
    assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
}

impl Harness {
    async fn new(label: &str) -> Self {
        let dir = TempDir(crate::shared::test_dir(label));
        let root = dir.0.join("repo");
        std::fs::create_dir(&root).unwrap();
        git_ok(&root, &["init", "--quiet"]).await;
        git_ok(
            &root,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@invalid",
                "commit",
                "--quiet",
                "--allow-empty",
                "-m",
                "init",
            ],
        )
        .await;
        let native_state = Arc::new(FakeNative {
            root: root.clone(),
            extra: Mutex::new(Vec::new()),
            fail_worktree: AtomicBool::new(false),
            worktree_gets: AtomicUsize::new(0),
            worktree_refreshes: AtomicUsize::new(0),
            gate: Gate::new(),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let native = Native::test_connection(listener.local_addr().unwrap());
        let state_for_srv = Arc::clone(&native_state);
        let http = tokio::spawn(async move {
            axum::serve(listener, Router::new().fallback(any(fake_native)).with_state(state_for_srv)).await.unwrap()
        });
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
        let settings = crate::settings::Settings::new(crate::settings::document::Location::resolve(
            dir.0.join("config.yaml").to_str().unwrap(),
        ));
        let app = Arc::new(App::new(
            auth,
            0,
            dir.0.clone(),
            dir.0.clone(),
            false,
            settings,
            Value::Null,
            native,
            PathBuf::new(),
            None,
            crate::files::watch::Watches::new(tx),
            None,
        ));
        let events = app.events.subscribe();
        let id = Uuid::new_v4();
        let canon_root = dunce::canonicalize(&root).unwrap();
        let ws = Workspace {
            id,
            request_id: None,
            path: canon_root.clone(),
            name: None,
            status: "running",
            proxy_path: format!("/workspaces/{id}/instance"),
            binary_id: PathBuf::new(),
            binary_label: String::new(),
            created_at: String::new(),
            updated_at: String::new(),
            location: json!({"directory": canon_root}),
        };
        app.inner.lock().unwrap().workspaces.push(ws.clone());
        Self { _dir: dir, root: canon_root, native: native_state, app, id, ws, events, http }
    }

    async fn add_linked(&self, name: &str) -> PathBuf {
        let linked = self._dir.0.join(name);
        git_ok(&self.root, &["worktree", "add", "--quiet", "--detach", linked.to_str().unwrap()]).await;
        let canon = dunce::canonicalize(&linked).unwrap();
        self.native.extra.lock().unwrap().push(canon.clone());
        canon
    }

    async fn list_json(&self, fresh: Option<&str>) -> Value {
        let res = list(
            State(self.app.clone()),
            Path(self.id.to_string()),
            Ok(Query(Input { fresh: fresh.map(str::to_owned) })),
        )
        .await
        .unwrap();
        assert_eq!(res.status(), Status::OK);
        let bytes = axum::body::to_bytes(res.into_body(), 128 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn drain_worktrees_changed(&mut self) -> usize {
        let mut count = 0;
        while let crate::events::Next::Frame(text) = self.app.events.pop(&self.events) {
            if let Ok(ev) = serde_json::from_str::<Value>(&text)
                && ev["type"] == "workspace.worktreesChanged"
            {
                count += 1;
            }
        }
        count
    }

    fn gets(&self) -> usize {
        self.native.worktree_gets.load(Ordering::SeqCst)
    }

    fn refreshes(&self) -> usize {
        self.native.worktree_refreshes.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn http_cache_hits_within_ttl_and_lazy_refreshes_after_expiry() {
    let _git = crate::git::test_git_serial().await;
    let mut h = Harness::new("inv-ttl").await;

    // Cold GET /worktrees populates the 10 s cache once.
    let first = h.list_json(None).await;
    assert_eq!(first["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(h.gets(), 1);
    assert_eq!(h.refreshes(), 1);
    assert_eq!(h.drain_worktrees_changed(), 0);

    // Subsequent Cached, Validated, and git::repo reads inside the 10 s TTL hit cache (0 new scans).
    let second = h.list_json(None).await;
    assert_eq!(second, first);
    let _ = crate::git::repo(&h.app, &h.id.to_string(), "root").await.unwrap();
    let hit = http_read(&h.app, &h.ws, ReadMode::Validated, false).await.unwrap();
    assert!(hit.from_cache);
    assert_eq!(h.gets(), 1);
    assert_eq!(h.refreshes(), 1);

    // Add a linked worktree and expire the 10 s TTL.
    let _linked = h.add_linked("wt-after-ttl").await;
    h.app.linked_events.lock().unwrap().advance_for_test(Duration::from_secs(11));

    // Hold the background refresh to prove Cached returns immediately while Validated waits.
    h.native.gate.arm();
    let stale_display = h.list_json(None).await;
    assert_eq!(stale_display["worktrees"].as_array().unwrap().len(), 1);
    h.native.gate.wait_entered().await;
    assert_eq!(h.refreshes(), 2, "expired Cached read starts one background refresh");

    let app_for_val = h.app.clone();
    let ws_for_val = h.ws.clone();
    let validated = tokio::spawn(async move { http_read(&app_for_val, &ws_for_val, ReadMode::Validated, false).await });
    tokio::task::yield_now().await;
    assert!(!validated.is_finished(), "Validated must wait for the in-flight refresh, not return expired data");

    h.native.gate.open();
    let val_res = validated.await.unwrap().unwrap();
    assert_eq!(val_res.snapshot.catalogue().unwrap().trees.len(), 2);
    assert_eq!(h.gets(), 2, "Validated joined the background refresh without spawning a duplicate scan");
    assert_eq!(h.drain_worktrees_changed(), 1, "changed snapshot emits workspace.worktreesChanged once");

    // An explicit ?fresh=true that sees the same snapshot must NOT re-emit workspace.worktreesChanged.
    let fresh = h.list_json(Some("true")).await;
    assert_eq!(fresh["worktrees"].as_array().unwrap().len(), 2);
    assert_eq!(h.gets(), 3);
    assert_eq!(h.drain_worktrees_changed(), 0, "unchanged scan must not cause an SSE reload loop");
}

#[tokio::test]
async fn lazy_invalidation_keeps_display_snapshot_while_blocking_invalidation_waits() {
    let _git = crate::git::test_git_serial().await;
    let mut h = Harness::new("inv-lazy-blocking").await;

    let initial = h.list_json(None).await;
    assert_eq!(initial["worktrees"].as_array().unwrap().len(), 1);
    assert_eq!(h.gets(), 1);

    // Lazy invalidation (`worktree.updated`): Cached returns the retained snapshot immediately
    // while triggering one background scan.
    let _wt1 = h.add_linked("wt-lazy").await;
    invalidate(&h.app);
    h.native.gate.arm();
    let cached_after_lazy = h.list_json(None).await;
    assert_eq!(cached_after_lazy["worktrees"].as_array().unwrap().len(), 1);
    h.native.gate.wait_entered().await;
    h.native.gate.open();
    // Wait for background scan to settle via Validated.
    let after_lazy = http_read(&h.app, &h.ws, ReadMode::Validated, false).await.unwrap();
    assert_eq!(after_lazy.snapshot.catalogue().unwrap().trees.len(), 2);
    assert_eq!(h.drain_worktrees_changed(), 1);

    // Blocking invalidation (`create`/`remove`/`place`/`git-init`): even Cached waits for the
    // post-mutation scan instead of returning the pre-mutation display snapshot.
    let _wt2 = h.add_linked("wt-blocking").await;
    invalidate_blocking(&h.app);
    h.native.gate.arm();
    let app_clone = h.app.clone();
    let id_str = h.id.to_string();
    let blocked_cached = tokio::spawn(async move {
        let res = list(State(app_clone), Path(id_str), Ok(Query(Input { fresh: None }))).await.unwrap();
        let bytes = axum::body::to_bytes(res.into_body(), 128 * 1024).await.unwrap();
        serde_json::from_slice::<Value>(&bytes).unwrap()
    });
    h.native.gate.wait_entered().await;
    assert!(!blocked_cached.is_finished(), "blocking invalidation must hold even Cached display reads");
    h.native.gate.open();
    let post_mutation = blocked_cached.await.unwrap();
    assert_eq!(post_mutation["worktrees"].as_array().unwrap().len(), 3);
    assert_eq!(h.drain_worktrees_changed(), 1);
}

#[tokio::test]
async fn coalesces_concurrent_reads_fences_invalidated_flight_and_respects_forget() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("inv-coalesce-fence").await;

    // 1. Concurrent cold reads coalesce into a single native scan.
    h.native.gate.arm();
    let (a1, w1) = (h.app.clone(), h.ws.clone());
    let (a2, w2) = (h.app.clone(), h.ws.clone());
    let (a3, w3) = (h.app.clone(), h.ws.clone());
    let r1 = tokio::spawn(async move { http_list(&a1, &w1, ReadMode::Cached).await });
    let r2 = tokio::spawn(async move { http_read(&a2, &w2, ReadMode::Validated, false).await });
    let r3 = tokio::spawn(async move { http_read(&a3, &w3, ReadMode::Validated, false).await });
    h.native.gate.wait_entered().await;
    h.native.gate.open();
    assert!(r1.await.unwrap().is_ok());
    assert!(r2.await.unwrap().is_ok());
    assert!(r3.await.unwrap().is_ok());
    assert_eq!(h.gets(), 1, "concurrent cold reads must share one scan");

    // 2. An invalidation mid-flight fences the stale scan and serializes one trailing scan.
    h.native.gate.arm();
    let (af, wf) = (h.app.clone(), h.ws.clone());
    let fresh_task = tokio::spawn(async move { http_list(&af, &wf, ReadMode::Fresh).await });
    h.native.gate.wait_entered().await;
    let _wt = h.add_linked("wt-midflight").await;
    invalidate(&h.app);
    h.native.gate.open();
    let fresh_snap = fresh_task.await.unwrap().unwrap();
    assert_eq!(fresh_snap.catalogue().unwrap().trees.len(), 2, "must not return the overtaken pre-invalidation scan");
    assert_eq!(h.gets(), 3, "initial + overtaken + trailing validated scan");

    // 3. forget() while a scan is in flight prevents post-disposal publication.
    h.native.gate.arm();
    let (ad, wd) = (h.app.clone(), h.ws.clone());
    let disposed_task = tokio::spawn(async move { http_list(&ad, &wd, ReadMode::Fresh).await });
    h.native.gate.wait_entered().await;
    h.app.inner.lock().unwrap().workspaces.retain(|w| w.id != h.id);
    forget(&h.app, h.id);
    h.native.gate.open();
    let err = match disposed_task.await.unwrap() {
        Err(err) => err,
        Ok(_) => panic!("disposed workspace read must fail"),
    };
    assert_eq!(err.0, Status::NOT_FOUND);
    assert!(!h.app.linked_events.lock().unwrap().http_entries.contains_key(&h.id));
}

#[tokio::test]
async fn backoff_retains_last_display_snapshot_and_sse_cache_stays_isolated() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("inv-backoff-sse").await;

    // Seed HTTP cache and verify SSE cache stays empty (strict separation).
    let first = h.list_json(None).await;
    assert_eq!(first["worktrees"].as_array().unwrap().len(), 1);
    assert!(
        !h.app.linked_events.lock().unwrap().sse_entries.contains_key(&h.id),
        "HTTP scans must never populate the non-refresh SSE cache"
    );

    // Seed SSE cache independently (no /api/worktree/refresh call).
    let refreshes_before_sse = h.refreshes();
    let sse = event_catalogue(&h.app, &h.ws).await.expect("SSE catalogue");
    assert_eq!(sse.trees.len(), 1);
    assert_eq!(h.refreshes(), refreshes_before_sse, "SSE scan must never call /api/worktree/refresh");

    // Expire HTTP cache and make native fail: Cached retains the last good snapshot with 10 s backoff.
    h.app.linked_events.lock().unwrap().advance_for_test(Duration::from_secs(11));
    h.native.fail_worktree.store(true, Ordering::SeqCst);
    let retained = h.list_json(None).await;
    assert_eq!(retained, first);
    // Validated joins or sees the failure and sets retry_at backoff.
    let val_err = http_read(&h.app, &h.ws, ReadMode::Validated, false).await;
    assert!(val_err.is_err());
    let refreshes_after_fail = h.refreshes();
    // Cached inside the 10 s backoff window returns the last good snapshot without hammering native.
    let retained_again = h.list_json(None).await;
    assert_eq!(retained_again, first);
    tokio::time::sleep(Duration::from_millis(25)).await;
    assert_eq!(h.refreshes(), refreshes_after_fail, "Cached must respect the 10 s failure retry backoff");

    // Advance past backoff and recover with a new worktree -> also invalidates SSE cache.
    h.native.fail_worktree.store(false, Ordering::SeqCst);
    let _wt = h.add_linked("wt-recovered").await;
    h.app.linked_events.lock().unwrap().advance_for_test(Duration::from_secs(11));
    let recovered = http_read(&h.app, &h.ws, ReadMode::Validated, false).await.unwrap();
    assert_eq!(recovered.snapshot.catalogue().unwrap().trees.len(), 2);
    assert!(
        !h.app.linked_events.lock().unwrap().sse_entries.contains_key(&h.id),
        "HTTP snapshot change must invalidate the stale SSE entry"
    );
}

#[tokio::test]
async fn refreshed_on_miss_runs_once_per_ttl_and_local_live_check_detects_removed_checkout() {
    let _git = crate::git::test_git_serial().await;
    let h = Harness::new("inv-miss-live").await;
    let linked = h.add_linked("wt-live").await;
    let foreign1 = h._dir.0.join("foreign-1");
    let foreign2 = h._dir.0.join("foreign-2");
    std::fs::create_dir(&foreign1).unwrap();
    std::fs::create_dir(&foreign2).unwrap();

    // Warm HTTP cache with root + linked.
    assert!(owns(&h.app, &h.ws, linked.to_str().unwrap()).await);
    assert_eq!(h.gets(), 1);

    // First foreign miss triggers at most one refresh for this cache lifetime.
    assert!(!owns(&h.app, &h.ws, foreign1.to_str().unwrap()).await);
    assert_eq!(h.gets(), 2, "first miss refreshes once");

    // Second foreign miss within the same 10 s TTL does NOT trigger another refresh.
    assert!(!owns(&h.app, &h.ws, foreign2.to_str().unwrap()).await);
    assert_eq!(h.gets(), 2, "sequential misses within one TTL must not repeat scans");

    // Corrupting the linked checkout's .git file on disk is caught immediately by local live()
    // checks even while the 10 s cache entry is still warm.
    std::fs::remove_file(linked.join(".git")).unwrap();
    assert!(!owns(&h.app, &h.ws, linked.to_str().unwrap()).await);
}
