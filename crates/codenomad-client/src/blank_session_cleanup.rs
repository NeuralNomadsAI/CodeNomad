//! Bounded HTTP adapter for manual blank-session preflight verification and server cleanup.
use crate::{
    backend::{Backend, read_json_limited},
    catalog::Project,
    history::valid_id,
};
use serde_json::Value;
use std::fmt;

const MAX_PREFLIGHT_BYTES: usize = 256 * 1024;
const MAX_CLEANUP_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlankCleanupError {
    /// The server requires re-authentication (HTTP 401).
    Unauthorized,
    /// The server does not expose the cleanup route or the workspace is absent (404/405/501).
    RouteUnavailable,
    /// Transport/network failure or server 5xx outage (abort remaining sweep instead of looping).
    Unavailable(String),
    /// Any other HTTP or contract error (treated as unknown, never empty).
    Other(String),
}

impl BlankCleanupError {
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Unauthorized)
    }

    pub fn is_route_unavailable(&self) -> bool {
        matches!(self, Self::RouteUnavailable)
    }

    pub fn is_unavailable(&self) -> bool {
        matches!(self, Self::RouteUnavailable | Self::Unavailable(_))
    }
}

impl fmt::Display for BlankCleanupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unauthorized => f.write_str("authentication required"),
            Self::RouteUnavailable => f.write_str("blank session cleanup route unavailable"),
            Self::Unavailable(message) | Self::Other(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for BlankCleanupError {}

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
    cursor.get("next").is_none_or(Value::is_null)
        && cursor.get("previous").is_none_or(Value::is_null)
}

fn unwrap_data(value: &Value) -> &Value {
    value.get("data").unwrap_or(value)
}

fn map_preflight_status(status: reqwest::StatusCode) -> Result<(), BlankCleanupError> {
    if status == reqwest::StatusCode::UNAUTHORIZED {
        Err(BlankCleanupError::Unauthorized)
    } else if status.is_success() {
        Ok(())
    } else if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND
            | reqwest::StatusCode::METHOD_NOT_ALLOWED
            | reqwest::StatusCode::NOT_IMPLEMENTED
    ) {
        Err(BlankCleanupError::RouteUnavailable)
    } else if status.is_server_error() {
        Err(BlankCleanupError::Unavailable(format!(
            "HTTP {}",
            status.as_u16()
        )))
    } else {
        Err(BlankCleanupError::Other(format!(
            "HTTP {}",
            status.as_u16()
        )))
    }
}

async fn check_session_preflight_status(
    response: reqwest::Response,
    session_id: &str,
) -> Result<reqwest::Response, BlankCleanupError> {
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        let is_missing_session = crate::backend::read_json_limited(response, 4096)
            .await
            .ok()
            .is_some_and(|data| {
                (data["_tag"] == "SessionNotFoundError" && data["sessionID"] == session_id)
                    || (data["name"] == "SessionNotFoundError"
                        && data["sessionID"]
                            .as_str()
                            .is_none_or(|sid| sid == session_id))
            });
        return Err(if is_missing_session {
            BlankCleanupError::Other("SessionNotFoundError".into())
        } else {
            BlankCleanupError::RouteUnavailable
        });
    }
    map_preflight_status(status)?;
    Ok(response)
}

async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
) -> Result<Value, BlankCleanupError> {
    read_json_limited(response, limit).await.map_err(|err| {
        if err.is::<reqwest::Error>() {
            BlankCleanupError::Unavailable(err.to_string())
        } else {
            BlankCleanupError::Other(err.to_string())
        }
    })
}

impl Backend {
    async fn blank_empty_messages_page(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<bool, BlankCleanupError> {
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{session_id}/message",
                self.base, project.id
            ))
            .query(&[("limit", "1")])
            .send()
            .await
            .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
        let response = check_session_preflight_status(response, session_id).await?;
        let page = read_bounded(response, MAX_PREFLIGHT_BYTES).await?;
        Ok(is_empty_page(&page))
    }

    async fn blank_session_record(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<Value, BlankCleanupError> {
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{session_id}",
                self.base, project.id
            ))
            .send()
            .await
            .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
        let response = check_session_preflight_status(response, session_id).await?;
        let body = read_bounded(response, MAX_PREFLIGHT_BYTES).await?;
        Ok(unwrap_data(&body).clone())
    }

    /// Client-side native preflight matching Solid `stores/blank-session-cleanup.ts`.
    /// Any unavailable, malformed or non-empty response returns `Ok(false)` or `Err`.
    pub async fn verify_blank_session(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<bool, BlankCleanupError> {
        if !valid_id(&project.id)
            || !valid_id(session_id)
            || session_id.starts_with("ses_cn_schedule_")
        {
            return Ok(false);
        }
        if !self.blank_empty_messages_page(project, session_id).await? {
            return Ok(false);
        }
        let info = self.blank_session_record(project, session_id).await?;
        let Some(project_id) = info["projectID"].as_str().filter(|id| !id.is_empty()) else {
            return Ok(false);
        };
        let Some(directory) = info["location"]["directory"]
            .as_str()
            .filter(|dir| crate::absolute_server_path(dir))
        else {
            return Ok(false);
        };
        if info["id"].as_str() != Some(session_id)
            || info["location"]
                .get("workspaceID")
                .is_some_and(|v| !v.is_null())
            || info["time"].get("archived").is_some_and(|v| !v.is_null())
            || info.get("revert").is_some_and(|v| !v.is_null())
            || info.get("fork").is_some_and(|v| !v.is_null())
        {
            return Ok(false);
        }

        let inbox_req = async {
            let response = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{session_id}/inbox",
                    self.base, project.id
                ))
                .send()
                .await
                .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
            let response = check_session_preflight_status(response, session_id).await?;
            let body = read_bounded(response, MAX_PREFLIGHT_BYTES).await?;
            Ok::<bool, BlankCleanupError>(unwrap_data(&body).as_array().is_some_and(Vec::is_empty))
        };
        let children_query: [(&str, &str); 3] = if project_id == "global" {
            [
                ("parentID", session_id),
                ("directory", directory),
                ("limit", "1"),
            ]
        } else {
            [
                ("parentID", session_id),
                ("project", project_id),
                ("limit", "1"),
            ]
        };
        let children_req = async {
            let response = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session",
                    self.base, project.id
                ))
                .query(&children_query)
                .send()
                .await
                .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
            map_preflight_status(response.status())?;
            let body = read_bounded(response, MAX_PREFLIGHT_BYTES).await?;
            Ok::<bool, BlankCleanupError>(is_empty_page(&body))
        };
        let active_req = async {
            let response = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/active",
                    self.base, project.id
                ))
                .send()
                .await
                .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
            map_preflight_status(response.status())?;
            let body = read_bounded(response, MAX_PREFLIGHT_BYTES).await?;
            Ok::<bool, BlankCleanupError>(
                unwrap_data(&body)
                    .as_object()
                    .is_some_and(|map| !map.contains_key(session_id)),
            )
        };

        let ((inbox_empty, children_empty), not_active) = futures_lite::future::zip(
            futures_lite::future::zip(inbox_req, children_req),
            active_req,
        )
        .await;
        // Propagate 401 and server/transport unavailability before returning Ok(false)
        // so auth recovery and outages are never masked by a sibling non-empty response.
        for result in [&inbox_empty, &children_empty, &not_active] {
            if let Err(err) = result
                && err.is_unauthorized()
            {
                return Err(BlankCleanupError::Unauthorized);
            }
        }
        for result in [&inbox_empty, &children_empty, &not_active] {
            if let Err(err) = result
                && err.is_unavailable()
            {
                return Err(err.clone());
            }
        }
        if !inbox_empty? || !children_empty? || !not_active? {
            return Ok(false);
        }

        // Recheck native messages last so a prompt sent while ancillary reads ran aborts cleanup.
        self.blank_empty_messages_page(project, session_id).await
    }

    /// Dispatches the server-authoritative blank-session cleanup endpoint
    /// (`POST /api/workspaces/:id/session-cleanup/:sessionId`).
    pub async fn delete_blank_session(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<bool, BlankCleanupError> {
        if !valid_id(&project.id)
            || !valid_id(session_id)
            || session_id.starts_with("ses_cn_schedule_")
        {
            return Ok(false);
        }
        let response = self
            .client
            .post(format!(
                "{}api/workspaces/{}/session-cleanup/{session_id}",
                self.base, project.id
            ))
            .send()
            .await
            .map_err(|err| BlankCleanupError::Unavailable(err.to_string()))?;
        let status = response.status();
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(BlankCleanupError::Unauthorized);
        }
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND
                | reqwest::StatusCode::METHOD_NOT_ALLOWED
                | reqwest::StatusCode::NOT_IMPLEMENTED
        ) {
            return Err(BlankCleanupError::RouteUnavailable);
        }
        if !status.is_success() {
            let msg = format!("HTTP {}", status.as_u16());
            return Err(if status.is_server_error() {
                BlankCleanupError::Unavailable(msg)
            } else {
                BlankCleanupError::Other(msg)
            });
        }
        let body = read_bounded(response, MAX_CLEANUP_BYTES).await?;
        Ok(body["deleted"].as_bool() == Some(true))
    }

    /// Cancellable wrapper around [`Self::verify_blank_session`] that immediately drops
    /// the in-flight HTTP request when `cancelled` closes or receives a signal.
    pub async fn verify_blank_session_cancellable(
        &self,
        project: &Project,
        session_id: &str,
        cancelled: &crate::Receiver<()>,
    ) -> Option<Result<bool, BlankCleanupError>> {
        if cancelled.is_closed() {
            return None;
        }
        let abort = async {
            let _ = cancelled.recv().await;
            None
        };
        let work = async { Some(self.verify_blank_session(project, session_id).await) };
        futures_lite::future::or(abort, work).await
    }

    /// Cancellable wrapper around [`Self::delete_blank_session`] that immediately drops
    /// the in-flight HTTP request when `cancelled` closes or receives a signal.
    pub async fn delete_blank_session_cancellable(
        &self,
        project: &Project,
        session_id: &str,
        cancelled: &crate::Receiver<()>,
    ) -> Option<Result<bool, BlankCleanupError>> {
        if cancelled.is_closed() {
            return None;
        }
        let abort = async {
            let _ = cancelled.recv().await;
            None
        };
        let work = async { Some(self.delete_blank_session(project, session_id).await) };
        futures_lite::future::or(abort, work).await
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    fn test_project() -> Project {
        Project {
            id: "ws1".into(),
            path: "/repo".into(),
            temporary: false,
        }
    }

    async fn serve_once(listener: &TcpListener, status: u16, body: Value) -> String {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 4096];
        let n = socket.read(&mut buf).await.unwrap();
        let req = String::from_utf8_lossy(&buf[..n]);
        let first = req.lines().next().unwrap_or("").to_owned();
        let payload = body.to_string();
        let resp = format!(
            "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
            payload.len()
        );
        socket.write_all(resp.as_bytes()).await.unwrap();
        first
    }

    #[test]
    fn verify_rechecks_messages_after_ancillary_reads() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = test_project();
            let client = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.verify_blank_session(&project, "ses_old").await }
            });
            let mut msg_reads = 0usize;
            for _ in 0..6 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let body = if first.contains("/api/session/ses_old/message?") {
                    msg_reads += 1;
                    if msg_reads == 1 {
                        json!({"data": [], "cursor": {}})
                    } else {
                        json!({"data": [{"id": "m1"}], "cursor": {}})
                    }
                } else if first.starts_with("GET /workspaces/ws1/instance/api/session/ses_old HTTP/")
                {
                    json!({"data": {"id": "ses_old", "projectID": "proj1", "location": {"directory": "/repo"}, "time": {"updated": 1}}})
                } else if first.contains("/inbox") {
                    json!({"data": []})
                } else if first.contains("parentID=ses_old") {
                    json!({"data": [], "cursor": {}})
                } else if first.contains("/api/session/active") {
                    json!({"data": {}})
                } else {
                    panic!("unexpected request: {first}");
                };
                let payload = body.to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                socket.write_all(resp.as_bytes()).await.unwrap();
            }
            assert!(!client.await.unwrap().unwrap());
            assert_eq!(msg_reads, 2);
        });
    }

    #[test]
    fn verify_uses_directory_for_global_project_and_succeeds_when_empty() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = test_project();
            let client = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.verify_blank_session(&project, "ses_global").await }
            });
            let mut saw_directory_query = false;
            for _ in 0..6 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let body = if first.contains("/api/session/ses_global/message?") {
                    json!({"data": [], "cursor": {}})
                } else if first
                    .starts_with("GET /workspaces/ws1/instance/api/session/ses_global HTTP/")
                {
                    json!({"data": {"id": "ses_global", "projectID": "global", "location": {"directory": "/repo"}, "time": {"updated": 1}}})
                } else if first.contains("/inbox") {
                    json!({"data": []})
                } else if first.contains("parentID=ses_global") {
                    assert!(first.contains("directory=%2Frepo"), "got {first}");
                    assert!(!first.contains("project="), "got {first}");
                    saw_directory_query = true;
                    json!({"data": [], "cursor": {}})
                } else if first.contains("/api/session/active") {
                    json!({"data": {}})
                } else {
                    panic!("unexpected request: {first}");
                };
                let payload = body.to_string();
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                socket.write_all(resp.as_bytes()).await.unwrap();
            }
            assert!(client.await.unwrap().unwrap());
            assert!(saw_directory_query);
        });
    }

    #[test]
    fn delete_blank_session_maps_deleted_unauthorized_and_route_unavailable() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = test_project();

            // Schedule session short-circuits without any HTTP call.
            assert!(
                !backend
                    .delete_blank_session(&project, "ses_cn_schedule_1")
                    .await
                    .unwrap()
            );
            assert!(
                !backend
                    .verify_blank_session(&project, "ses_cn_schedule_1")
                    .await
                    .unwrap()
            );

            // 200 deleted: true
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.delete_blank_session(&project, "ses_old").await }
            });
            let first = serve_once(&listener, 200, json!({"deleted": true})).await;
            assert_eq!(
                first,
                "POST /api/workspaces/ws1/session-cleanup/ses_old HTTP/1.1"
            );
            assert!(task.await.unwrap().unwrap());

            // 200 deleted: false
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.delete_blank_session(&project, "ses_old").await }
            });
            let _ = serve_once(&listener, 200, json!({"deleted": false})).await;
            assert!(!task.await.unwrap().unwrap());

            // 401 -> Unauthorized
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.delete_blank_session(&project, "ses_old").await }
            });
            let _ = serve_once(&listener, 401, json!({"error": "auth"})).await;
            assert!(task.await.unwrap().unwrap_err().is_unauthorized());

            // 404 / 405 / 501 -> RouteUnavailable
            for status in [404u16, 405, 501] {
                let task = tokio::spawn({
                    let backend = backend.clone();
                    let project = project.clone();
                    async move { backend.delete_blank_session(&project, "ses_old").await }
                });
                let _ = serve_once(&listener, status, json!({})).await;
                assert!(task.await.unwrap().unwrap_err().is_route_unavailable());
            }

            // 503 -> Unavailable (not RouteUnavailable)
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.delete_blank_session(&project, "ses_old").await }
            });
            let _ = serve_once(&listener, 503, json!({})).await;
            let err = task.await.unwrap().unwrap_err();
            assert!(!err.is_unauthorized() && !err.is_route_unavailable() && err.is_unavailable());
        });
    }

    #[test]
    fn preflight_404_405_and_truncated_body_classify_as_unavailable() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = test_project();

            // A 404 carrying SessionNotFoundError for the candidate skips only that candidate.
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.verify_blank_session(&project, "ses_gone").await }
            });
            let _ = serve_once(
                &listener,
                404,
                json!({"_tag": "SessionNotFoundError", "sessionID": "ses_gone"}),
            )
            .await;
            let err = task.await.unwrap().unwrap_err();
            assert!(!err.is_route_unavailable() && !err.is_unavailable());

            // A 404 indicating workspace/route absence (not SessionNotFoundError) classifies as RouteUnavailable.
            for status in [404u16, 405, 501] {
                let task = tokio::spawn({
                    let backend = backend.clone();
                    let project = project.clone();
                    async move { backend.verify_blank_session(&project, "ses_old").await }
                });
                let _ = serve_once(&listener, status, json!({"error": "Not Found"})).await;
                let err = task.await.unwrap().unwrap_err();
                assert!(err.is_route_unavailable() && err.is_unavailable());
            }

            // Mid-body network drop classifies as Unavailable (not Other).
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.verify_blank_session(&project, "ses_old").await }
            });
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let _ = socket.read(&mut buf).await.unwrap();
            socket
                .write_all(
                    b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{\"da",
                )
                .await
                .unwrap();
            drop(socket);
            let err = task.await.unwrap().unwrap_err();
            assert!(!err.is_unauthorized() && !err.is_route_unavailable() && err.is_unavailable());
        });
    }

    #[test]
    fn parallel_preflight_propagates_unavailable_even_when_sibling_is_non_empty() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = test_project();
            let client = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.verify_blank_session(&project, "ses_old").await }
            });
            let mut saw_active_503 = false;
            for _ in 0..5 {
                let (mut socket, _) = tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    listener.accept(),
                )
                .await
                .expect("timed out waiting for preflight request")
                .unwrap();
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let (status, body) = if first.contains("/api/session/ses_old/message?") {
                    (200, json!({"data": [], "cursor": {}}))
                } else if first.starts_with("GET /workspaces/ws1/instance/api/session/ses_old HTTP/")
                {
                    (
                        200,
                        json!({"data": {"id": "ses_old", "projectID": "proj1", "location": {"directory": "/repo"}, "time": {"updated": 1}}}),
                    )
                } else if first.contains("/inbox") {
                    // Sibling returns non-empty (Ok(false)), which must NOT mask active's 503.
                    (200, json!({"data": [{"id": "queued-1"}]}))
                } else if first.contains("parentID=") {
                    (200, json!({"data": [], "cursor": {}}))
                } else if first.starts_with("GET /workspaces/ws1/instance/api/session/active HTTP/")
                {
                    saw_active_503 = true;
                    (503, json!({"error": "Unavailable"}))
                } else {
                    panic!("unexpected preflight request: {first}");
                };
                let payload = body.to_string();
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                socket.write_all(resp.as_bytes()).await.unwrap();
            }
            assert!(saw_active_503, "expected /api/session/active to receive 503");
            let err = client.await.unwrap().unwrap_err();
            assert!(!err.is_unauthorized() && err.is_unavailable());
        });
    }
}
