//! Authoritative blank-session cleanup fence and route (`routes/session-cleanup.ts`).
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

use axum::{
    Extension, Json,
    extract::{Path, State},
    http::{Method, StatusCode as Status},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};

use crate::{
    App, Shared, Workspace,
    auth::Principal,
    opencode::{Endpoint, proxy::guards, read_json, session_record_at},
};

#[derive(Default)]
struct FenceInner {
    cleaning: HashSet<String>,
    cleaning_deleted: HashSet<String>,
    mutations: HashMap<String, usize>,
    uncertain: HashSet<String>,
}

const MAX_UNCERTAIN: usize = 1024;
const MAX_CONCURRENT_CLEANUPS: usize = 4;

/// Mutual exclusion between blank-session cleanup and addressed session mutations across tabs.
#[derive(Clone)]
pub struct Fence {
    inner: Arc<Mutex<FenceInner>>,
    slots: Arc<tokio::sync::Semaphore>,
}

impl Default for Fence {
    fn default() -> Self {
        Self { inner: Arc::default(), slots: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_CLEANUPS)) }
    }
}

pub struct CleanupGuard {
    inner: Arc<Mutex<FenceInner>>,
    id: String,
}

impl Drop for CleanupGuard {
    fn drop(&mut self) {
        let mut inner = self.inner.lock().unwrap();
        inner.cleaning.remove(&self.id);
        inner.cleaning_deleted.remove(&self.id);
    }
}

pub struct MutationGuard {
    inner: Arc<Mutex<FenceInner>>,
    id: String,
}

impl Drop for MutationGuard {
    fn drop(&mut self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(count) = inner.mutations.get_mut(&self.id) {
            if *count <= 1 {
                inner.mutations.remove(&self.id);
            } else {
                *count -= 1;
            }
        }
    }
}

impl Fence {
    pub fn enter_cleanup(&self, id: &str) -> Option<CleanupGuard> {
        let mut inner = self.inner.lock().unwrap();
        if inner.cleaning.contains(id)
            || inner.mutations.contains_key(id)
            || inner.uncertain.contains(id)
            || inner.uncertain.len() >= MAX_UNCERTAIN
        {
            return None;
        }
        inner.cleaning.insert(id.to_owned());
        Some(CleanupGuard { inner: self.inner.clone(), id: id.to_owned() })
    }

    pub fn enter_mutation(&self, id: &str) -> Option<MutationGuard> {
        let mut inner = self.inner.lock().unwrap();
        if inner.cleaning.contains(id) || inner.uncertain.contains(id) {
            return None;
        }
        *inner.mutations.entry(id.to_owned()).or_insert(0) += 1;
        Some(MutationGuard { inner: self.inner.clone(), id: id.to_owned() })
    }

    pub fn mark_uncertain(&self, id: &str) {
        self.inner.lock().unwrap().uncertain.insert(id.to_owned());
    }

    pub fn mark_uncertain_unless_absent(&self, id: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        if inner.cleaning_deleted.contains(id) {
            return false;
        }
        inner.uncertain.insert(id.to_owned());
        true
    }

    pub fn observe_absent(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.uncertain.remove(id);
        if inner.cleaning.contains(id) {
            inner.cleaning_deleted.insert(id.to_owned());
        }
    }

    pub fn has_uncertain(&self, id: &str) -> bool {
        self.inner.lock().unwrap().uncertain.contains(id)
    }
}

fn id_ok(id: &str) -> bool {
    id.starts_with("ses")
        && (4..=514).contains(&id.len())
        && id.bytes().all(|v| v.is_ascii_alphanumeric() || matches!(v, b'_' | b'-'))
}

fn is_empty_page(value: &Value) -> bool {
    let Some(data) = value.get("data").and_then(Value::as_array) else {
        return false;
    };
    if !data.is_empty() {
        return false;
    }
    let Some(cursor) = value.get("cursor").and_then(Value::as_object) else {
        return false;
    };
    cursor.get("next").is_none_or(Value::is_null) && cursor.get("previous").is_none_or(Value::is_null)
}

fn current(app: &App, workspace: &Workspace, endpoint: &Arc<Endpoint>, principal: &Principal) -> bool {
    principal.live().is_ok()
        && app.native.current(endpoint)
        && crate::sessions::permission_mode::workspace_current(app, workspace)
}

async fn native_get(
    app: &App,
    endpoint: &Endpoint,
    segments: &[&str],
    query: &[(&str, &str)],
    timeout: Duration,
) -> Result<Value, Status> {
    let mut url = endpoint.url.clone();
    url.path_segments_mut().map_err(|_| Status::BAD_GATEWAY)?.clear().extend(segments);
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (k, v) in query {
            pairs.append_pair(k, v);
        }
    }
    let response = app
        .native
        .client
        .get(url)
        .basic_auth("opencode", Some(&endpoint.password))
        .timeout(timeout)
        .send()
        .await
        .map_err(|_| Status::BAD_GATEWAY)?;
    let status = response.status();
    if !status.is_success() {
        return Err(status);
    }
    read_json(response, 2 * 1024 * 1024).await.map_err(|_| Status::BAD_GATEWAY)
}

async fn verify_owned(app: &Shared, workspace: &Workspace, session: &Value) -> Option<String> {
    if session["location"].get("workspaceID").is_some() {
        return None;
    }
    let dir = session["location"]["directory"].as_str()?;
    crate::worktrees::placement_verified(app, workspace, &session["location"]).await.ok()?;
    Some(dir.to_owned())
}

pub async fn route(
    State(app): State<Shared>,
    Extension(principal): Extension<Principal>,
    Path((id, session_id)): Path<(String, String)>,
) -> Response {
    if !id_ok(&session_id) {
        return Status::BAD_REQUEST.into_response();
    }
    let Ok(workspace) = app.workspace(&id) else {
        return Status::NOT_FOUND.into_response();
    };
    let Some(endpoint) = app.native.endpoint() else {
        return Status::SERVICE_UNAVAILABLE.into_response();
    };
    let skipped = || Json(json!({"deleted": false})).into_response();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    let Ok(slot) = app.session_cleanup.slots.clone().try_acquire_owned() else {
        return skipped();
    };
    let preflight = async {
        if !current(&app, &workspace, &endpoint, &principal) {
            return None;
        }
        let initial = match session_record_at(&app, &endpoint, &session_id).await {
            Ok(row) => row,
            Err((Status::NOT_FOUND, body)) => {
                if body.0.get("_tag").and_then(Value::as_str) == Some("SessionNotFoundError")
                    && body.0.get("sessionID").and_then(Value::as_str) == Some(session_id.as_str())
                    && app.session_cleanup.has_uncertain(&session_id)
                    && current(&app, &workspace, &endpoint, &principal)
                {
                    app.session_cleanup.observe_absent(&session_id);
                }
                return None;
            }
            Err(_) => return None,
        };
        let initial_project = initial["projectID"].as_str().filter(|s| !s.is_empty())?;
        if initial["id"].as_str() != Some(session_id.as_str()) {
            return None;
        }
        let initial_dir = verify_owned(&app, &workspace, &initial).await?;
        if !current(&app, &workspace, &endpoint, &principal) {
            return None;
        }
        let cleanup_guard = app.session_cleanup.enter_cleanup(&session_id)?;
        if super::favorites::is_protected(&app, &session_id) {
            return None;
        }
        let session = session_record_at(&app, &endpoint, &session_id).await.ok()?;
        let session_dir = verify_owned(&app, &workspace, &session).await?;
        if session["id"].as_str() != Some(session_id.as_str())
            || session["projectID"].as_str() != Some(initial_project)
            || session_dir != initial_dir
        {
            return None;
        }
        let owned = crate::worktrees::ownership::resolve(&app, &workspace, &session_dir).await?;
        let worktree_guard = crate::worktrees::fence::enter(&[
            crate::worktrees::fence::identity(&owned.checkout),
            crate::worktrees::fence::session(&session_id),
        ])?;
        guards::verify_mutation_at(&app, &endpoint, &session_id, &session_dir, &session).await.ok()?;
        // Omit `project` so children moved to another project are still detected before recursive DELETE.
        let children = native_get(
            &app,
            &endpoint,
            &["api", "session"],
            &[("parentID", &session_id), ("limit", "1")],
            Duration::from_secs(4),
        )
        .await
        .ok()?;
        if !is_empty_page(&children) {
            return None;
        }
        let latest = session_record_at(&app, &endpoint, &session_id).await.ok()?;
        let latest_dir = verify_owned(&app, &workspace, &latest).await?;
        let updated = latest["time"]["updated"].as_f64().filter(|v| v.is_finite())?;
        let session_updated = session["time"]["updated"].as_f64().filter(|v| v.is_finite())?;
        if latest["id"].as_str() != Some(session_id.as_str())
            || latest["projectID"].as_str() != Some(initial_project)
            || latest["parentID"] != session["parentID"]
            || latest_dir != session_dir
            || updated != session_updated
            || latest["time"].get("archived").is_some_and(|v| !v.is_null())
            || latest.get("revert").is_some_and(|v| !v.is_null())
            || latest.get("fork").is_some_and(|v| !v.is_null())
            || latest.as_object().is_some_and(guards::schedule_input)
        {
            return None;
        }
        let forms = native_get(&app, &endpoint, &["api", "session", &session_id, "form"], &[], Duration::from_secs(4))
            .await
            .ok()?;
        let forms = forms.get("data").unwrap_or(&forms).as_array()?;
        if !forms.is_empty() {
            return None;
        }
        let permissions = native_get(
            &app,
            &endpoint,
            &["api", "permission", "request"],
            &[("location[directory]", &latest_dir)],
            Duration::from_secs(4),
        )
        .await
        .ok()?;
        let perm_dir = permissions["location"]["directory"].as_str()?;
        let perm_rows = permissions["data"].as_array()?;
        if perm_dir != latest_dir
            || perm_rows.iter().any(|row| row["sessionID"].as_str().is_none_or(|sid| sid == session_id))
        {
            return None;
        }
        let inbox = native_get(&app, &endpoint, &["api", "session", &session_id, "inbox"], &[], Duration::from_secs(4))
            .await
            .ok()?;
        let inbox = inbox.get("data").unwrap_or(&inbox).as_array()?;
        if !inbox.is_empty() {
            return None;
        }
        let active =
            native_get(&app, &endpoint, &["api", "session", "active"], &[], Duration::from_secs(4)).await.ok()?;
        let active = active.get("data").unwrap_or(&active).as_object()?;
        if active.contains_key(&session_id) {
            return None;
        }
        let messages = native_get(
            &app,
            &endpoint,
            &["api", "session", &session_id, "message"],
            &[("limit", "1")],
            Duration::from_secs(4),
        )
        .await
        .ok()?;
        if !is_empty_page(&messages)
            || super::favorites::is_protected(&app, &session_id)
            || !current(&app, &workspace, &endpoint, &principal)
        {
            return None;
        }
        Some((cleanup_guard, worktree_guard))
    };
    let guards = tokio::select! {
        biased;
        _ = principal.0.cancelled() => return Status::UNAUTHORIZED.into_response(),
        result = tokio::time::timeout_at(deadline, preflight) => match result {
            Ok(Some(guards)) => guards,
            _ => return skipped(),
        }
    };
    let mut url = endpoint.url.clone();
    if url
        .path_segments_mut()
        .map(|mut s| {
            s.clear().extend(["api", "session", &session_id]);
        })
        .is_err()
    {
        return skipped();
    }
    let app_check = app.clone();
    let ws_check = workspace.clone();
    let ep_check = endpoint.clone();
    let principal_check = Principal(principal.0.clone());
    settle_delete(
        app.native.client.clone(),
        app.session_cleanup.clone(),
        endpoint.password.clone(),
        session_id,
        url,
        guards,
        Some(slot),
        &principal,
        move || current(&app_check, &ws_check, &ep_check, &principal_check),
    )
    .await
}

pub fn deleted(app: &App, event: &Value) {
    if event["type"] != "session.deleted" {
        return;
    }
    let Some(target) = event["data"]["sessionID"].as_str().filter(|s| id_ok(s)) else { return };
    app.session_cleanup.observe_absent(target);
}

enum SettleOutcome {
    Deleted,
    Skipped,
    Uncertain,
}

#[allow(clippy::too_many_arguments)]
async fn settle_delete(
    client: reqwest::Client,
    fence: Fence,
    password: String,
    session_id: String,
    url: reqwest::Url,
    guards: (CleanupGuard, crate::worktrees::fence::Entered),
    slot: Option<tokio::sync::OwnedSemaphorePermit>,
    principal: &Principal,
    still_current: impl FnOnce() -> bool + Send + 'static,
) -> Response {
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let (_cleanup_guard, _worktree_guard) = guards;
        let _slot = slot;
        if !still_current() {
            let _ = tx.send(SettleOutcome::Skipped);
            return;
        }
        let response = client
            .request(Method::DELETE, url)
            .basic_auth("opencode", Some(&password))
            .timeout(Duration::from_secs(60))
            .send()
            .await;
        let outcome = match response {
            Ok(resp) if matches!(resp.status(), Status::NO_CONTENT | Status::OK) => SettleOutcome::Deleted,
            _ => {
                if fence.mark_uncertain_unless_absent(&session_id) {
                    SettleOutcome::Uncertain
                } else {
                    SettleOutcome::Deleted
                }
            }
        };
        let _ = tx.send(outcome);
    });
    tokio::select! {
        biased;
        _ = principal.0.cancelled() => Status::UNAUTHORIZED.into_response(),
        outcome = rx => match outcome {
            Ok(SettleOutcome::Deleted) => Json(json!({"deleted": true})).into_response(),
            Ok(SettleOutcome::Skipped) => Json(json!({"deleted": false})).into_response(),
            _ => Status::SERVICE_UNAVAILABLE.into_response(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fence_blocks_overlapping_cleanup_and_mutations_and_retains_uncertain_hold() {
        let fence = Fence::default();
        let cleanup = fence.enter_cleanup("ses_a").expect("cleanup admitted");
        assert!(fence.enter_cleanup("ses_a").is_none(), "second cleanup blocked");
        assert!(fence.enter_mutation("ses_a").is_none(), "mutation blocked during cleanup");
        drop(cleanup);

        let m1 = fence.enter_mutation("ses_a").expect("mutation 1 admitted");
        let m2 = fence.enter_mutation("ses_a").expect("mutation 2 admitted");
        assert!(fence.enter_cleanup("ses_a").is_none(), "cleanup blocked during mutation");
        drop(m1);
        assert!(fence.enter_cleanup("ses_a").is_none(), "cleanup stays blocked while m2 held");
        drop(m2);

        fence.mark_uncertain("ses_a");
        assert!(fence.has_uncertain("ses_a"));
        assert!(fence.enter_cleanup("ses_a").is_none());
        assert!(fence.enter_mutation("ses_a").is_none());
        fence.observe_absent("ses_a");
        assert!(!fence.has_uncertain("ses_a"));
        assert!(fence.enter_cleanup("ses_a").is_some());
    }

    #[test]
    fn id_ok_matches_ts_session_id_pattern_including_schedule_ids() {
        assert!(id_ok("ses_abc123"));
        assert!(id_ok("ses_cn_schedule_abc"));
        assert!(!id_ok("bad_id"));
        assert!(!id_ok("ses"));
    }

    #[tokio::test]
    async fn detached_delete_holds_guards_and_marks_uncertain_after_observer_cancels() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
            sync::oneshot,
        };
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (received_tx, received_rx) = oneshot::channel();
        let (release_tx, release_rx) = oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = socket.read(&mut buf).await;
            let _ = received_tx.send(());
            let _ = release_rx.await;
            let _ = socket
                .write_all(b"HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
        });

        let fence = Fence::default();
        let sid = "ses_detach_test".to_owned();
        let keys = ["/cleanup-detach-test/checkout".to_owned(), crate::worktrees::fence::session(&sid)];
        let cleanup_guard = fence.enter_cleanup(&sid).unwrap();
        let worktree_guard = crate::worktrees::fence::enter(&keys).unwrap();
        let token = tokio_util::sync::CancellationToken::new();
        let principal = Principal(token.clone());
        let url = reqwest::Url::parse(&format!("http://{addr}/api/session/{sid}")).unwrap();
        let client = reqwest::Client::new();

        let call = tokio::spawn({
            let fence = fence.clone();
            async move {
                settle_delete(
                    client,
                    fence,
                    "pw".into(),
                    sid,
                    url,
                    (cleanup_guard, worktree_guard),
                    None,
                    &principal,
                    || true,
                )
                .await
            }
        });
        received_rx.await.unwrap();
        token.cancel();
        let response = call.await.unwrap();
        assert_eq!(response.status(), Status::UNAUTHORIZED);

        // Both guards remain held until OpenCode settles the detached DELETE.
        assert!(crate::worktrees::fence::try_block(&[crate::worktrees::fence::session("ses_detach_test")]).is_none());
        let _ = release_tx.send(());
        server.await.unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while crate::worktrees::fence::try_block(&[crate::worktrees::fence::session("ses_detach_test")]).is_none() {
            assert!(tokio::time::Instant::now() < deadline, "worktree guard was not released");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(fence.has_uncertain("ses_detach_test"));
        assert!(fence.enter_mutation("ses_detach_test").is_none());
    }

    #[tokio::test]
    async fn settle_delete_skips_when_authority_lost_and_rejects_202() {
        use tokio::{
            io::{AsyncReadExt, AsyncWriteExt},
            net::TcpListener,
        };
        let fence = Fence::default();
        let sid = "ses_skip_auth".to_owned();
        let keys = ["/cleanup-skip-test/checkout".to_owned(), crate::worktrees::fence::session(&sid)];
        let response = settle_delete(
            reqwest::Client::new(),
            fence.clone(),
            "pw".into(),
            sid.clone(),
            reqwest::Url::parse("http://127.0.0.1:1/api/session/ses_skip_auth").unwrap(),
            (fence.enter_cleanup(&sid).unwrap(), crate::worktrees::fence::enter(&keys).unwrap()),
            None,
            &Principal(tokio_util::sync::CancellationToken::new()),
            || false,
        )
        .await;
        assert_eq!(response.status(), Status::OK);
        assert!(!fence.has_uncertain(&sid));

        // 202 Accepted must not be treated as confirmed deletion.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 512];
            let _ = socket.read(&mut buf).await;
            let _ = socket.write_all(b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
        });
        let sid2 = "ses_accept_202".to_owned();
        let keys2 = ["/cleanup-202-test/checkout".to_owned(), crate::worktrees::fence::session(&sid2)];
        let resp2 = settle_delete(
            reqwest::Client::new(),
            fence.clone(),
            "pw".into(),
            sid2.clone(),
            reqwest::Url::parse(&format!("http://{addr}/api/session/{sid2}")).unwrap(),
            (fence.enter_cleanup(&sid2).unwrap(), crate::worktrees::fence::enter(&keys2).unwrap()),
            None,
            &Principal(tokio_util::sync::CancellationToken::new()),
            || true,
        )
        .await;
        server.await.unwrap();
        assert_eq!(resp2.status(), Status::SERVICE_UNAVAILABLE);
        assert!(fence.has_uncertain(&sid2));

        // Observing session.deleted while DELETE is in flight avoids poisoning uncertain on lost reply.
        let sid3 = "ses_deleted_early";
        let guard3 = fence.enter_cleanup(sid3).unwrap();
        fence.observe_absent(sid3);
        assert!(!fence.mark_uncertain_unless_absent(sid3));
        drop(guard3);
        assert!(!fence.has_uncertain(sid3));
    }

    #[test]
    fn empty_page_requires_empty_array_and_null_cursors() {
        assert!(is_empty_page(&json!({"data": [], "cursor": {}})));
        assert!(is_empty_page(&json!({"data": [], "cursor": {"next": null, "previous": null}})));
        assert!(!is_empty_page(&json!({"data": [], "cursor": {"next": "more"}})));
        assert!(!is_empty_page(&json!({"data": [], "cursor": {"previous": "prev"}})));
        assert!(!is_empty_page(&json!({"data": [{"id": "m1"}], "cursor": {}})));
        assert!(!is_empty_page(&json!({"data": []})));
        assert!(!is_empty_page(&json!({})));
    }
}
