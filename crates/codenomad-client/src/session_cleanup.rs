//! Blank-session preflight verification, cleanup dispatch, and session parent lookup.
use crate::{
    backend::{Backend, read_json},
    catalog::Project,
    history::{Result, valid_id},
};
use serde_json::Value;

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

impl Backend {
    async fn empty_messages_page(&self, project: &Project, session_id: &str) -> Result<bool> {
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{session_id}/message",
                self.base, project.id
            ))
            .query(&[("limit", "1")])
            .send()
            .await?
            .error_for_status()?;
        let page = read_json(response).await?;
        Ok(is_empty_page(&page))
    }

    async fn session_record_raw(&self, project: &Project, session_id: &str) -> Result<Value> {
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{session_id}",
                self.base, project.id
            ))
            .send()
            .await?
            .error_for_status()?;
        let body = read_json(response).await?;
        Ok(unwrap_data(&body).clone())
    }

    /// Native preflight matching Solid `stores/blank-session-cleanup.ts`.
    /// Any unavailable, malformed or non-empty response returns `Ok(false)` / `Err`.
    pub async fn preflight_blank_session(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<bool> {
        if !valid_id(session_id) || session_id.starts_with("ses_cn_schedule_") {
            return Ok(false);
        }
        if !self.empty_messages_page(project, session_id).await? {
            return Ok(false);
        }
        let info = self.session_record_raw(project, session_id).await?;
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
            || info["location"].get("workspaceID").is_some()
            || info["time"].get("archived").is_some_and(|v| !v.is_null())
            || info.get("revert").is_some_and(|v| !v.is_null())
            || info.get("fork").is_some_and(|v| !v.is_null())
        {
            return Ok(false);
        }

        let inbox_req = async {
            let resp = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/{session_id}/inbox",
                    self.base, project.id
                ))
                .send()
                .await?
                .error_for_status()?;
            let body = read_json(resp).await?;
            Ok::<bool, Box<dyn std::error::Error + Send + Sync>>(
                unwrap_data(&body).as_array().is_some_and(Vec::is_empty),
            )
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
            let resp = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session",
                    self.base, project.id
                ))
                .query(&children_query)
                .send()
                .await?
                .error_for_status()?;
            let body = read_json(resp).await?;
            Ok::<bool, Box<dyn std::error::Error + Send + Sync>>(is_empty_page(&body))
        };
        let active_req = async {
            let resp = self
                .client
                .get(format!(
                    "{}workspaces/{}/instance/api/session/active",
                    self.base, project.id
                ))
                .send()
                .await?
                .error_for_status()?;
            let body = read_json(resp).await?;
            Ok::<bool, Box<dyn std::error::Error + Send + Sync>>(
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
        if !inbox_empty? || !children_empty? || !not_active? {
            return Ok(false);
        }

        // Recheck native messages last so a prompt sent while ancillary reads ran aborts cleanup.
        self.empty_messages_page(project, session_id).await
    }

    /// Dispatches the server-authoritative blank-session cleanup endpoint.
    pub async fn cleanup_blank_session(&self, project: &Project, session_id: &str) -> Result<bool> {
        if !valid_id(session_id) || session_id.starts_with("ses_cn_schedule_") {
            return Ok(false);
        }
        let response = self
            .client
            .post(format!(
                "{}api/workspaces/{}/session-cleanup/{session_id}",
                self.base, project.id
            ))
            .send()
            .await?
            .error_for_status()?;
        let body = read_json(response).await?;
        Ok(body["deleted"].as_bool() == Some(true))
    }

    /// Resolves whether a session in `project` is a root (`Some(None)`) or subagent (`Some(Some(parent_id))`).
    pub async fn session_parent(
        &self,
        project: &Project,
        session_id: &str,
    ) -> Result<Option<Option<String>>> {
        if !valid_id(session_id) || session_id.starts_with("ses_cn_schedule_") {
            return Ok(None);
        }
        let info = self.session_record_raw(project, session_id).await?;
        if info["id"].as_str() != Some(session_id)
            || info["location"].get("workspaceID").is_some()
            || !info["location"]["directory"]
                .as_str()
                .is_some_and(crate::absolute_server_path)
        {
            return Ok(None);
        }
        let parent = match &info["parentID"] {
            Value::Null => None,
            Value::String(id) if valid_id(id) => Some(id.clone()),
            _ => return Ok(None),
        };
        Ok(Some(parent))
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
    fn preflight_rechecks_messages_after_ancillary_reads() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = Project {
                id: "ws1".into(),
                path: "/repo".into(),
                temporary: false,
            };
            let client = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.preflight_blank_session(&project, "ses_old").await }
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
            assert_eq!(client.await.unwrap().unwrap(), false);
            assert_eq!(msg_reads, 2);
        });
    }

    #[test]
    fn cleanup_blank_session_posts_to_server_cleanup_route() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = Project {
                id: "ws1".into(),
                path: "/repo".into(),
                temporary: false,
            };
            let task = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.cleanup_blank_session(&project, "ses_old").await }
            });
            let first = serve_once(&listener, 200, json!({"deleted": true})).await;
            assert_eq!(
                first,
                "POST /api/workspaces/ws1/session-cleanup/ses_old HTTP/1.1"
            );
            assert!(task.await.unwrap().unwrap());
        });
    }

    #[test]
    fn preflight_uses_directory_for_global_project() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let backend = Backend::unauthenticated(&format!("http://{addr}/")).unwrap();
            let project = Project {
                id: "ws1".into(),
                path: "/plain".into(),
                temporary: false,
            };
            let client = tokio::spawn({
                let backend = backend.clone();
                let project = project.clone();
                async move { backend.preflight_blank_session(&project, "ses_plain").await }
            });
            let mut saw_directory_query = false;
            for _ in 0..6 {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]);
                let first = req.lines().next().unwrap_or("");
                let body = if first.contains("/api/session/ses_plain/message?") {
                    json!({"data": [], "cursor": {}})
                } else if first.starts_with("GET /workspaces/ws1/instance/api/session/ses_plain HTTP/")
                {
                    json!({"data": {"id": "ses_plain", "projectID": "global", "location": {"directory": "/plain"}, "time": {"updated": 1}}})
                } else if first.contains("/inbox") {
                    json!({"data": []})
                } else if first.contains("parentID=ses_plain") {
                    assert!(
                        !first.contains("project=global"),
                        "non-Git preflight must not query project=global: {first}"
                    );
                    assert!(
                        first.contains("directory=%2Fplain"),
                        "non-Git preflight must query directory: {first}"
                    );
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
}
