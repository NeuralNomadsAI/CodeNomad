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
    hold_all: AtomicBool,
    hold_once: AtomicBool,
    waiting_open: AtomicBool,
    entered: Notify,
    release: Notify,
    entries: AtomicUsize,
    armed_at: AtomicUsize,
}

impl Gate {
    fn new() -> Self {
        Self {
            hold_all: AtomicBool::new(false),
            hold_once: AtomicBool::new(false),
            waiting_open: AtomicBool::new(false),
            entered: Notify::new(),
            release: Notify::new(),
            entries: AtomicUsize::new(0),
            armed_at: AtomicUsize::new(0),
        }
    }

    fn arm(&self) {
        self.armed_at.store(self.entries.load(Ordering::SeqCst), Ordering::SeqCst);
        self.hold_once.store(false, Ordering::SeqCst);
        self.waiting_open.store(true, Ordering::SeqCst);
        self.hold_all.store(true, Ordering::SeqCst);
    }

    /// Block only the first caller that reaches `pass()`; subsequent callers proceed immediately.
    fn arm_once(&self) {
        self.armed_at.store(self.entries.load(Ordering::SeqCst), Ordering::SeqCst);
        self.hold_all.store(false, Ordering::SeqCst);
        self.waiting_open.store(true, Ordering::SeqCst);
        self.hold_once.store(true, Ordering::SeqCst);
    }

    fn open(&self) {
        self.hold_once.store(false, Ordering::SeqCst);
        self.hold_all.store(false, Ordering::SeqCst);
        self.waiting_open.store(false, Ordering::SeqCst);
        self.release.notify_waiters();
    }

    async fn pass(&self) {
        if self.hold_once.swap(false, Ordering::SeqCst) || self.hold_all.load(Ordering::SeqCst) {
            self.entries.fetch_add(1, Ordering::SeqCst);
            self.entered.notify_waiters();
            while self.waiting_open.load(Ordering::SeqCst) {
                self.release.notified().await;
            }
        }
    }

    async fn wait_entered(&self) {
        let baseline = self.armed_at.load(Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(10), async {
            while self.entries.load(Ordering::SeqCst) <= baseline {
                self.entered.notified().await;
            }
        })
        .await
        .expect("timed out waiting for gate entry");
    }
}

async fn wait_for(label: &str, mut cond: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !cond() {
        assert!(Instant::now() < deadline, "timed out waiting for {label}");
        tokio::task::yield_now().await;
    }
}

struct FakeNative {
    root: PathBuf,
    extra: Mutex<Vec<PathBuf>>,
    fail_worktree: AtomicBool,
    worktree_gets: AtomicUsize,
    worktree_refreshes: AtomicUsize,
    gate: Gate,
    post_get_gate: Gate,
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
            // Capture rows before passing `post_get_gate` so tests can mutate `extra` after a
            // flight has already observed the older snapshot.
            f.post_get_gate.pass().await;
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
            post_get_gate: Gate::new(),
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
            temporary: None,
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
    let hit = http_read(&h.app, &h.ws, ReadMode::Validated).await.unwrap();
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
    let validated = tokio::spawn(async move { http_read(&app_for_val, &ws_for_val, ReadMode::Validated).await });
    wait_for("Validated join", || h.app.linked_events.lock().unwrap().test_joins > 0).await;
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
    let after_lazy = http_read(&h.app, &h.ws, ReadMode::Validated).await.unwrap();
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

    // 1. Concurrent cold reads deterministically enter Step::Join and share one native scan.
    h.native.gate.arm();
    let (a1, w1) = (h.app.clone(), h.ws.clone());
    let r1 = tokio::spawn(async move { http_list(&a1, &w1, ReadMode::Cached).await });
    h.native.gate.wait_entered().await;
    let (a2, w2) = (h.app.clone(), h.ws.clone());
    let (a3, w3) = (h.app.clone(), h.ws.clone());
    let r2 = tokio::spawn(async move { http_read(&a2, &w2, ReadMode::Validated).await });
    let r3 = tokio::spawn(async move { http_read(&a3, &w3, ReadMode::Validated).await });
    wait_for("concurrent Join count", || h.app.linked_events.lock().unwrap().test_joins >= 2).await;
    h.native.gate.open();
    assert!(r1.await.unwrap().is_ok());
    assert!(r2.await.unwrap().is_ok());
    assert!(r3.await.unwrap().is_ok());
    assert_eq!(h.gets(), 1, "concurrent cold reads must share one scan");

    // 2. An invalidation mid-flight puts a late reader into Step::WaitPrevious and serializes
    //    one trailing validated scan after the overtaken flight completes.
    h.native.gate.arm();
    let (af, wf) = (h.app.clone(), h.ws.clone());
    let fresh_task = tokio::spawn(async move { http_list(&af, &wf, ReadMode::Fresh).await });
    h.native.gate.wait_entered().await;
    let _wt = h.add_linked("wt-midflight").await;
    invalidate_blocking(&h.app);
    let (aw, ww) = (h.app.clone(), h.ws.clone());
    let wait_prev_task = tokio::spawn(async move { http_read(&aw, &ww, ReadMode::Validated).await });
    wait_for("WaitPrevious count", || h.app.linked_events.lock().unwrap().test_wait_previous >= 1).await;
    h.native.gate.open();
    let fresh_snap = fresh_task.await.unwrap().unwrap();
    let waited_snap = wait_prev_task.await.unwrap().unwrap();
    assert_eq!(fresh_snap.catalogue().unwrap().trees.len(), 2, "must not return the overtaken pre-invalidation scan");
    assert_eq!(waited_snap.snapshot.catalogue().unwrap().trees.len(), 2);
    assert_eq!(h.gets(), 3, "initial + overtaken + trailing validated scan");

    // 3. Aborting the inline leader clears `loading` via HttpFlightGuard so a joined follower
    //    recovers and completes the scan on its own.
    let joins_before_abort = h.app.linked_events.lock().unwrap().test_joins;
    h.native.gate.arm();
    let (al, wl) = (h.app.clone(), h.ws.clone());
    let leader = tokio::spawn(async move { http_read(&al, &wl, ReadMode::Fresh).await });
    h.native.gate.wait_entered().await;
    let (aj, wj) = (h.app.clone(), h.ws.clone());
    let follower = tokio::spawn(async move { http_read(&aj, &wj, ReadMode::Fresh).await });
    wait_for("follower Join before abort", || h.app.linked_events.lock().unwrap().test_joins > joins_before_abort)
        .await;
    leader.abort();
    let _ = leader.await;
    h.native.gate.open();
    let recovered = follower.await.unwrap().unwrap();
    assert_eq!(recovered.snapshot.catalogue().unwrap().trees.len(), 2);

    // 4. forget() while a scan is in flight prevents post-disposal publication.
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
    let val_err = http_read(&h.app, &h.ws, ReadMode::Validated).await;
    assert!(val_err.is_err());
    {
        let cache = h.app.linked_events.lock().unwrap();
        let entry = cache.http_entries.get(&h.id).expect("retained display entry");
        assert!(entry.loading.is_none());
        assert!(entry.retry_at.is_some(), "failed scan must arm 10 s backoff");
    }
    let refreshes_after_fail = h.refreshes();
    // Cached inside the 10 s backoff window returns the last good snapshot without starting a flight.
    let retained_again = h.list_json(None).await;
    assert_eq!(retained_again, first);
    assert!(
        h.app.linked_events.lock().unwrap().http_entries.get(&h.id).is_some_and(|e| e.loading.is_none()),
        "Cached inside backoff must not spawn a background flight"
    );
    assert_eq!(h.refreshes(), refreshes_after_fail, "Cached must respect the 10 s failure retry backoff");

    // Advance past backoff and recover with a new worktree -> also invalidates SSE cache.
    h.native.fail_worktree.store(false, Ordering::SeqCst);
    let _wt = h.add_linked("wt-recovered").await;
    h.app.linked_events.lock().unwrap().advance_for_test(Duration::from_secs(11));
    let recovered = http_read(&h.app, &h.ws, ReadMode::Validated).await.unwrap();
    assert_eq!(recovered.snapshot.catalogue().unwrap().trees.len(), 2);
    assert!(
        !h.app.linked_events.lock().unwrap().sse_entries.contains_key(&h.id),
        "HTTP snapshot change must invalidate the stale SSE entry"
    );

    // Cold HTTP/SSE race with empty HTTP cache: an in-flight SSE scan that captured 2 worktrees
    // before the first HTTP scan publishes 3 worktrees (with no prior HTTP snapshot to trigger
    // `http_changed`) must be revoked via the cold-loading SSE branch and never publish stale data.
    forget(&h.app, h.id);
    h.native.post_get_gate.arm_once();
    let (as_sse, ws_sse) = (h.app.clone(), h.ws.clone());
    let sse_task = tokio::spawn(async move { event_catalogue(&as_sse, &ws_sse).await });
    h.native.post_get_gate.wait_entered().await;
    let _wt_cold = h.add_linked("wt-cold-http-sse").await;
    let fresh_http = http_read(&h.app, &h.ws, ReadMode::Fresh).await.unwrap();
    assert_eq!(fresh_http.snapshot.catalogue().unwrap().trees.len(), 3);
    h.native.post_get_gate.open();
    let sse_after = sse_task.await.unwrap().expect("SSE catalogue retries after HTTP revocation");
    assert_eq!(
        sse_after.trees.len(),
        3,
        "revoked cold SSE flight must not return or publish the stale 2-worktree snapshot"
    );
}

#[tokio::test]
async fn refreshed_on_miss_is_atomic_and_passive_refresh_retries_after_invalidation() {
    let _git = crate::git::test_git_serial().await;
    let mut h = Harness::new("inv-miss-passive").await;
    let linked = h.add_linked("wt-live").await;
    let foreign1 = h._dir.0.join("foreign-1");
    let foreign2 = h._dir.0.join("foreign-2");
    std::fs::create_dir(&foreign1).unwrap();
    std::fs::create_dir(&foreign2).unwrap();

    // Warm HTTP cache with root + linked.
    assert!(owns(&h.app, &h.ws, linked.to_str().unwrap()).await);
    assert_eq!(h.gets(), 1);
    let warm = http_read(&h.app, &h.ws, ReadMode::Validated).await.unwrap();
    assert!(warm.from_cache && !warm.refreshed_on_miss);
    let obs_gen = warm.generation;

    // 1. A RefreshOnMiss joining an in-flight ordinary Validated scan marks `refreshed_on_miss`
    //    atomically on publication, and concurrent RefreshOnMiss calls share one scan.
    let joins_before = h.app.linked_events.lock().unwrap().test_joins;
    h.native.gate.arm();
    let (a1, w1) = (h.app.clone(), h.ws.clone());
    let m1 = tokio::spawn(async move { http_read(&a1, &w1, ReadMode::Fresh).await });
    h.native.gate.wait_entered().await;
    let (a2, w2) = (h.app.clone(), h.ws.clone());
    let m2 = tokio::spawn(async move { http_read(&a2, &w2, ReadMode::RefreshOnMiss(obs_gen)).await });
    wait_for("RefreshOnMiss joining ordinary scan", || h.app.linked_events.lock().unwrap().test_joins > joins_before)
        .await;
    h.native.gate.open();
    let r1 = m1.await.unwrap().unwrap();
    let r2 = m2.await.unwrap().unwrap();
    assert_eq!(h.gets(), 2, "RefreshOnMiss joining an ordinary scan must share that scan");
    assert!(r1.refreshed_on_miss && r2.refreshed_on_miss);
    assert_eq!(r1.generation, r2.generation);
    assert_ne!(r1.generation, obs_gen);

    // Subsequent RefreshOnMiss with either the old or new generation must NOT scan again.
    let r3 = http_read(&h.app, &h.ws, ReadMode::RefreshOnMiss(obs_gen)).await.unwrap();
    assert!(r3.from_cache && r3.refreshed_on_miss);
    assert!(!owns(&h.app, &h.ws, foreign1.to_str().unwrap()).await);
    assert!(!owns(&h.app, &h.ws, foreign2.to_str().unwrap()).await);
    assert_eq!(h.gets(), 2, "repeated misses inside one TTL must not repeat scans");

    // 2. Passive refresh invalidated mid-flight AFTER capturing the older 2-worktree snapshot
    //    must discard the stale 2-worktree response and automatically run a follow-up scan
    //    that publishes 3 worktrees with no new caller.
    let gets_before_passive = h.gets();
    h.app.linked_events.lock().unwrap().advance_for_test(Duration::from_secs(11));
    h.native.post_get_gate.arm_once();
    let stale_display = h.list_json(None).await;
    assert_eq!(stale_display["worktrees"].as_array().unwrap().len(), 2);
    h.native.post_get_gate.wait_entered().await;
    let _wt3 = h.add_linked("wt-passive-retry").await;
    invalidate(&h.app);
    h.native.post_get_gate.open();
    // Wait for the background follow-up scan to publish the 3-worktree snapshot with no caller.
    // Acquire `app.inner` before `app.linked_events` so observing the published snapshot also
    // orders strictly after `finish_http_scan`'s `workspace.worktreesChanged` emission.
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let ready = {
            let _workspaces = h.app.inner.lock().unwrap();
            let cache = h.app.linked_events.lock().unwrap();
            cache.http_entries.get(&h.id).is_some_and(|e| {
                e.loading.is_none()
                    && !e.expired
                    && matches!(&e.value, Some(HttpSnapshot::Git(cat)) if cat.trees.len() == 3)
            })
        };
        if ready {
            break;
        }
        assert!(Instant::now() < deadline, "passive refresh did not follow up after mid-flight invalidation");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(h.gets(), gets_before_passive + 2, "must execute both the overtaken scan and the follow-up scan");
    assert_eq!(h.drain_worktrees_changed(), 1);

    // 3. Local live() check detects removed checkout AND invalid HEAD on the opened root even
    //    while the 10 s cache entry is still warm.
    std::fs::remove_file(linked.join(".git")).unwrap();
    assert!(!owns(&h.app, &h.ws, linked.to_str().unwrap()).await);

    // Corrupting HEAD on the root causes `Step::VerifyRoot` in `http_read(Validated)` to reject
    // the warm cached Git snapshot immediately (without manual invalidation), and replacing `.git`
    // with an incomplete directory leaves strict `resolve_checked` on an internal subfolder
    // returning `Err(())` (unverifiable) through the cached `NonGit` path rather than `Ok(None)`.
    let inside = h.ws.path.join("inside-sub");
    std::fs::create_dir(&inside).unwrap();
    std::fs::write(h.ws.path.join(".git").join("HEAD"), "not-a-valid-head\n").unwrap();
    let after_corrupt_head = http_read(&h.app, &h.ws, ReadMode::Validated).await;
    assert!(
        !matches!(&after_corrupt_head, Ok(hit) if hit.from_cache && matches!(hit.snapshot, HttpSnapshot::Git(_))),
        "Step::VerifyRoot must never serve a warm cached Git snapshot after root HEAD corruption"
    );
    std::fs::remove_dir_all(h.ws.path.join(".git")).unwrap();
    std::fs::create_dir(h.ws.path.join(".git")).unwrap();
    invalidate_blocking(&h.app);
    // Warm the cache with the display `NonGit` classification of the incomplete `.git` dir.
    let display = h.list_json(None).await;
    assert_eq!(display["isGitRepo"], false);
    assert!(
        crate::worktrees::ownership::resolve_checked(&h.app, &h.ws, inside.to_str().unwrap(), true).await.is_err(),
        "strict resolve_checked must treat a cached NonGit over an incomplete .git dir as unverifiable Err(())"
    );
}
