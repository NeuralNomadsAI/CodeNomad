//! Explicit "Request an update" briefing admission and coordinator steering.
//! Two-step design matching `packages/server/src/missions/briefing-request.ts` and
//! `packages/ui/src/lib/mission-coordinator-message.ts`:
//! 1. `mission_briefing_admission` performs the cancellable authoritative `GET .../admission`.
//! 2. `send_mission_briefing_prompt` commits the `POST .../prompt` (`delivery: "steer"`,
//!    native profile preserved) through the shared `Backend` HTTP client.
use super::{directory::panel_id, lifecycle::request_id_valid};
use crate::{
    Receiver,
    backend::{Backend, read_json_limited},
    history::valid_id,
    prompt::{Delivery, Prompt, PromptError, message_id},
    runtime::timeout,
};
use futures_lite::future::race;
use serde_json::Value;
use std::time::Duration;

const ADMISSION_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_ADMISSION_BYTES: usize = 4 * 1024 * 1024;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct BriefingTarget {
    pub mission: String,
    pub project: String,
    pub canonical: String,
    pub coordinator: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BriefingAdmissionOutcome {
    Admitted,
    Error { auth_expired: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BriefingSendState {
    Admitted { message_id: String },
    Uncertain,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BriefingSendOutcome {
    pub state: BriefingSendState,
    pub auth_expired: bool,
}

impl BriefingSendOutcome {
    fn uncertain(auth_expired: bool) -> Self {
        Self {
            state: BriefingSendState::Uncertain,
            auth_expired,
        }
    }
}

/// Fixed application-authored request text. Objective and notes stay native data,
/// never interpolated instructions. Matches `packages/server/src/missions/briefing-request.ts`.
pub fn briefing_request_text(mission_id: &str, request_id: &str, locale: &str) -> String {
    format!(
        "CodeNomad project briefing request.\n\
Mission ID: {mission_id}\n\
Request ID: {request_id}\n\
Response language: {locale}\n\
\n\
Make a short user-facing assessment of the whole project, including every requested workstream. Inspect this exact mission's current map and use actual returned results and existing evidence. Do not perform new tests, run or replay tasks, restart the mission, change its plan or priorities, install anything, or publish anything in order to answer this request. This request grants no additional execution or human-consent authority.\n\
\n\
Publish through mission.briefing with this exact requestID and missionID, and the freshly inspected revision as basedOnRevision. Provide a plain-language summary (what is usable versus still unverified) and up to three concise entries in each section: achieved, ongoing, obstacles, next. Entries have text and exact live source taskKeys (an empty array if no task supports the statement). Preserve distinctions between past obstacles and current ones, preparation and delivery, conversation activity and task execution. State uncertainty instead of inventing progress, percentages, completion or human approval. Include the next step towards the user's objective; use native Forms/permissions for any actual question, not a fabricated response alert.\n\
\n\
This is an on-demand readout, not a request for periodic updates or a report after every task. If the map revision changes before publication, inspect again and update the readout; never replay work. If the briefing tool is unavailable, explain that in the conversation; do not create a substitute task or claim that the Missions panel has been updated."
    )
}

/// Matches `missionAcceptsCoordinatorMessage` in `packages/server/src/missions/briefing-request.ts`.
pub fn accepts_coordinator_message_value(mission: &Value) -> bool {
    mission["status"] == "active"
        && mission
            .get("runState")
            .is_none_or(|value| value.is_null() || value == "running")
        && mission
            .get("control")
            .and_then(|control| control.get("pending"))
            .is_none_or(|pending| {
                pending.is_null() || pending.as_array().is_some_and(Vec::is_empty)
            })
        && mission.get("controlUnavailable") != Some(&Value::Bool(true))
}

async fn until_cancelled<T>(
    cancelled: &Receiver<()>,
    task: impl std::future::Future<Output = T>,
) -> Option<T> {
    if cancelled.is_closed() {
        return None;
    }
    race(async { Some(task.await) }, async {
        let _ = cancelled.recv().await;
        None
    })
    .await
}

impl Backend {
    /// Step 1 (cancellable): authoritative `GET .../missions/{id}/admission`.
    /// Never posts any prompt. Returns `Admitted` only when the fresh mission record
    /// matches `target` and accepts coordinator messages.
    pub async fn mission_briefing_admission(
        &self,
        target: &BriefingTarget,
        cancelled: &Receiver<()>,
    ) -> BriefingAdmissionOutcome {
        let err = |auth_expired| BriefingAdmissionOutcome::Error { auth_expired };
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || target.mission.encode_utf16().count() > 100
            || !panel_id(&target.project)
            || target.canonical.is_empty()
            || !valid_id(&target.coordinator)
            || cancelled.is_closed()
        {
            return err(false);
        }
        let Ok(base) = reqwest::Url::parse(&self.base) else {
            return err(false);
        };
        let Ok(mut url) = base.join("api/workspaces/") else {
            return err(false);
        };
        {
            let Ok(mut segments) = url.path_segments_mut() else {
                return err(false);
            };
            segments.pop_if_empty().extend([
                self.workspace.as_str(),
                "missions",
                target.mission.as_str(),
                "admission",
            ]);
        }
        let Some(Some(Ok(response))) = until_cancelled(
            cancelled,
            timeout(ADMISSION_TIMEOUT, self.client.get(url).send()),
        )
        .await
        else {
            return err(false);
        };
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return err(true);
        }
        if !response.status().is_success() {
            return err(false);
        }
        let Some(Some(Ok(read))) = until_cancelled(
            cancelled,
            timeout(
                ADMISSION_TIMEOUT,
                read_json_limited(response, MAX_ADMISSION_BYTES),
            ),
        )
        .await
        else {
            return err(false);
        };
        if read["available"] != true || read.get("controlUnavailable") == Some(&Value::Bool(true)) {
            return err(false);
        }
        let Some(fresh) = read.get("mission").filter(|mission| mission.is_object()) else {
            return err(false);
        };
        if fresh["id"] != target.mission
            || fresh["projectID"] != target.project
            || fresh["projectCanonical"] != target.canonical
            || fresh["coordinatorSessionId"] != target.coordinator
            || !accepts_coordinator_message_value(fresh)
        {
            return err(false);
        }
        BriefingAdmissionOutcome::Admitted
    }

    /// Step 2 (committed): sends the fixed briefing prompt (`delivery: "steer"`,
    /// native profile preserved) once through the shared `Backend` client.
    /// Every error or timeout returns `BriefingSendState::Uncertain`; never retries.
    pub async fn send_mission_briefing_prompt(
        &self,
        target: &BriefingTarget,
        request_id: &str,
        locale: &str,
    ) -> BriefingSendOutcome {
        if !valid_id(&self.workspace)
            || !panel_id(&target.mission)
            || !valid_id(&target.coordinator)
            || !request_id_valid(request_id)
        {
            return BriefingSendOutcome::uncertain(false);
        }
        let text = briefing_request_text(&target.mission, request_id, locale);
        let Ok(msg_id) = message_id() else {
            return BriefingSendOutcome::uncertain(false);
        };
        let prompt = Prompt {
            id: Some(msg_id),
            text,
            delivery: Some(Delivery::Steer),
            ..Default::default()
        };
        let mut prompt_backend = self.clone();
        prompt_backend.session.clone_from(&target.coordinator);
        prompt_backend.session_directory = None;
        match timeout(SEND_TIMEOUT, prompt_backend.prompt(&prompt)).await {
            Some(Ok(ack)) => BriefingSendOutcome {
                state: BriefingSendState::Admitted { message_id: ack.id },
                auth_expired: false,
            },
            Some(Err(err)) => {
                let auth_expired = if matches!(
                    err.downcast_ref::<PromptError>(),
                    Some(PromptError::AuthenticationRequired { .. })
                ) {
                    !matches!(
                        timeout(
                            Duration::from_secs(5),
                            prompt_backend.authentication_status(),
                        )
                        .await,
                        Some(Ok(true))
                    )
                } else {
                    false
                };
                BriefingSendOutcome::uncertain(auth_expired)
            }
            None => BriefingSendOutcome::uncertain(false),
        }
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use crate::bounded;
    use serde_json::json;
    use std::sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn run<F: std::future::Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    async fn spawn_server(
        handler: impl Fn(String, String, String) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let handler = Arc::new(handler);
        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let handler = handler.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let mut header_end = None;
                    let mut content_len = 0usize;
                    while let Ok(n) = socket.read(&mut chunk).await {
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if header_end.is_none()
                            && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
                        {
                            header_end = Some(pos + 4);
                            let head = String::from_utf8_lossy(&buf[..pos]);
                            for line in head.lines() {
                                if let Some((k, v)) = line.split_once(':')
                                    && k.eq_ignore_ascii_case("content-length")
                                {
                                    content_len = v.trim().parse().unwrap_or(0);
                                }
                            }
                        }
                        if let Some(end) = header_end
                            && buf.len() >= end + content_len
                        {
                            break;
                        }
                    }
                    let head_end = header_end.unwrap_or(buf.len());
                    let head = String::from_utf8_lossy(&buf[..head_end]).into_owned();
                    let first = head.lines().next().unwrap_or_default();
                    let target = first
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned();
                    let body = String::from_utf8_lossy(&buf[head_end..]).into_owned();
                    let (status, resp_body) = handler(target, head, body);
                    let reason = match status {
                        200 => "OK",
                        401 => "Unauthorized",
                        500 => "Internal Server Error",
                        _ => "Error",
                    };
                    let raw = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp_body}",
                        resp_body.len()
                    );
                    let _ = socket.write_all(raw.as_bytes()).await;
                    let _ = socket.shutdown().await;
                });
            }
        });
        (format!("http://{addr}/"), handle)
    }

    fn target() -> BriefingTarget {
        BriefingTarget {
            mission: "msn-1".into(),
            project: "proj-1".into(),
            canonical: "/repo".into(),
            coordinator: "ses_coord".into(),
        }
    }

    fn admission_ok() -> Value {
        json!({
            "available": true,
            "version": 1,
            "projectID": "proj-1",
            "generatedAt": 1,
            "cleanups": [],
            "mission": {
                "id": "msn-1",
                "projectID": "proj-1",
                "projectCanonical": "/repo",
                "coordinatorSessionId": "ses_coord",
                "status": "active",
                "runState": "running"
            }
        })
    }

    #[test]
    fn admission_then_steer_prompt_admits_once_with_exact_text() {
        run(async {
            let posted = Arc::new(Mutex::new(Vec::<(String, String, Value)>::new()));
            let seen = posted.clone();
            let (base, server) = spawn_server(move |path, head, body| {
                if path == "/api/workspaces/ws-1/missions/msn-1/admission" {
                    return (200, admission_ok().to_string());
                }
                let parsed: Value = serde_json::from_str(&body).unwrap();
                seen.lock().unwrap().push((path, head, parsed));
                (
                    200,
                    json!({"data": {"id": "msg_ack_1", "sessionID": "ses_coord"}}).to_string(),
                )
            })
            .await;
            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            backend.session = "ses_conversation".into();
            backend.session_directory = Some("/other-worktree".into());
            let (_cancel, cancelled) = bounded(1);

            let adm = backend
                .mission_briefing_admission(&target(), &cancelled)
                .await;
            assert_eq!(adm, BriefingAdmissionOutcome::Admitted);
            assert!(posted.lock().unwrap().is_empty());

            let outcome = backend
                .send_mission_briefing_prompt(&target(), "req-42", "fr")
                .await;
            server.abort();
            assert_eq!(
                outcome,
                BriefingSendOutcome {
                    state: BriefingSendState::Admitted {
                        message_id: "msg_ack_1".into()
                    },
                    auth_expired: false,
                }
            );
            let requests = posted.lock().unwrap();
            assert_eq!(requests.len(), 1);
            assert_eq!(
                requests[0].0,
                "/workspaces/ws-1/instance/api/session/ses_coord/prompt"
            );
            assert!(
                !requests[0]
                    .1
                    .to_ascii_lowercase()
                    .contains("x-codenomad-session-directory"),
                "briefing prompt must not inherit another conversation's directory header"
            );
            assert_eq!(requests[0].2["delivery"], "steer");
            assert_eq!(
                requests[0].2["text"],
                briefing_request_text("msn-1", "req-42", "fr")
            );
            assert!(requests[0].2.get("agent").is_none());
            assert!(requests[0].2.get("model").is_none());
        });
    }

    #[test]
    fn admission_rejection_and_401_return_error_without_sending_prompt() {
        run(async {
            let mode = Arc::new(AtomicUsize::new(0));
            let current = mode.clone();
            let (base, server) =
                spawn_server(move |_, _, _| match current.load(Ordering::SeqCst) {
                    0 => (401, "{}".into()),
                    1 => {
                        let mut v = admission_ok();
                        v["controlUnavailable"] = json!(true);
                        (200, v.to_string())
                    }
                    2 => {
                        let mut v = admission_ok();
                        v["mission"]["control"] = json!({"pending": ["ses_1"]});
                        (200, v.to_string())
                    }
                    3 => {
                        let mut v = admission_ok();
                        v["mission"]["coordinatorSessionId"] = json!("ses_other");
                        (200, v.to_string())
                    }
                    _ => {
                        let mut v = admission_ok();
                        v["mission"]["projectCanonical"] = json!("/other-repo");
                        (200, v.to_string())
                    }
                })
                .await;
            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            let (_cancel, cancelled) = bounded(1);

            for (case, expect_auth) in [(0, true), (1, false), (2, false), (3, false), (4, false)] {
                mode.store(case, Ordering::SeqCst);
                let outcome = backend
                    .mission_briefing_admission(&target(), &cancelled)
                    .await;
                assert_eq!(
                    outcome,
                    BriefingAdmissionOutcome::Error {
                        auth_expired: expect_auth
                    },
                    "case {case}"
                );
            }
            server.abort();
        });
    }

    #[test]
    fn prompt_failure_is_always_uncertain_and_never_retries() {
        run(async {
            let prompts = Arc::new(AtomicUsize::new(0));
            let count = prompts.clone();
            let status_code = Arc::new(AtomicUsize::new(500));
            let code = status_code.clone();
            let auth_live = Arc::new(std::sync::atomic::AtomicBool::new(false));
            let live = auth_live.clone();
            let (base, server) = spawn_server(move |path, _, _| {
                if path == "/api/auth/status" {
                    return (
                        200,
                        json!({"authenticated": live.load(Ordering::SeqCst)}).to_string(),
                    );
                }
                count.fetch_add(1, Ordering::SeqCst);
                (code.load(Ordering::SeqCst) as u16, "{}".into())
            })
            .await;
            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();

            for (http, authenticated, expect_auth) in [
                (500, true, false),
                (400, true, false),
                (401, true, false),
                (401, false, true),
            ] {
                status_code.store(http, Ordering::SeqCst);
                auth_live.store(authenticated, Ordering::SeqCst);
                let outcome = backend
                    .send_mission_briefing_prompt(&target(), "req-uncertain", "en")
                    .await;
                assert_eq!(
                    outcome,
                    BriefingSendOutcome::uncertain(expect_auth),
                    "http {http} authenticated={authenticated}"
                );
            }
            server.abort();
            assert_eq!(prompts.load(Ordering::SeqCst), 4);
        });
    }

    #[test]
    fn cancelled_admission_returns_error_without_http() {
        run(async {
            let hits = Arc::new(AtomicUsize::new(0));
            let count = hits.clone();
            let (base, server) = spawn_server(move |_, _, _| {
                count.fetch_add(1, Ordering::SeqCst);
                (200, admission_ok().to_string())
            })
            .await;
            let mut backend = Backend::unauthenticated(&base).unwrap();
            backend.workspace = "ws-1".into();
            let (cancel, cancelled) = bounded(1);
            cancel.close();
            let outcome = backend
                .mission_briefing_admission(&target(), &cancelled)
                .await;
            server.abort();
            assert_eq!(
                outcome,
                BriefingAdmissionOutcome::Error {
                    auth_expired: false
                }
            );
            assert_eq!(hits.load(Ordering::SeqCst), 0);
        });
    }
}
