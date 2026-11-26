//! Session binding and targeted absence verification.
use super::{
    Backend, Project, Result, Session, SessionAbsence, SessionMissing, read_json, session_at,
    valid_id,
};

impl Backend {
    pub async fn bind(&self, project: &Project, id: &str, fresh: bool) -> Result<Self> {
        Ok(self.bind_session(project, id, fresh).await?.0)
    }
    // A session can move across a live cursor without leaving the workspace.
    pub async fn confirm_missing_sessions(
        &self,
        project: &Project,
        ids: Vec<String>,
        missing: async_channel::Sender<(String, crate::runtime::Instant, SessionAbsence)>,
        notify: impl Fn(),
    ) {
        futures_lite::future::race(
            async {
                for id in ids {
                    let started = crate::runtime::Instant::now();
                    let confirmed = futures_lite::future::race(
                        async {
                            self.bind_session(project, &id, false)
                                .await
                                .err()
                                .and_then(|error| {
                                    error.downcast_ref::<SessionMissing>().map(|m| m.absence())
                                })
                        },
                        async {
                            crate::runtime::sleep(std::time::Duration::from_secs(1)).await;
                            None
                        },
                    )
                    .await;
                    if let Some(absence) = confirmed {
                        if missing.send((id, started, absence)).await.is_err() {
                            return;
                        }
                        notify();
                    }
                }
            },
            missing.closed(),
        )
        .await;
    }
    /// Probes one session ID for confirmed presence (`Some(None)`), confirmed 404/403 absence
    /// (`Some(Some(absence))`), or transient error/timeout (`None`).
    pub async fn probe_session_absence(
        &self,
        project: &Project,
        id: &str,
    ) -> Option<Option<SessionAbsence>> {
        futures_lite::future::race(
            async {
                match self.bind_session(project, id, false).await {
                    Ok(_) => Some(None),
                    Err(error) => error
                        .downcast_ref::<SessionMissing>()
                        .map(|missing| Some(missing.absence())),
                }
            },
            async {
                crate::runtime::sleep(std::time::Duration::from_secs(1)).await;
                None
            },
        )
        .await
    }
    pub async fn bind_session(
        &self,
        project: &Project,
        id: &str,
        fresh: bool,
    ) -> Result<(Self, Session)> {
        let (backend, session, _) = self.bind_session_placed(project, id, fresh).await?;
        Ok((backend, session))
    }
    pub async fn bind_at(
        &self,
        project: &Project,
        id: &str,
        expected: Option<&str>,
        fresh: bool,
    ) -> Result<(Self, Session)> {
        let (backend, session, _) = self
            .bind_at_placed(project, id, expected, fresh, true, false, false)
            .await?;
        Ok((backend, session))
    }

    pub async fn bind_session_placed(
        &self,
        project: &Project,
        id: &str,
        fresh: bool,
    ) -> Result<(Self, Session, String)> {
        self.bind_at_placed(project, id, None, fresh, false, false, false)
            .await
    }

    pub async fn bind_created_session(
        &self,
        project: &Project,
        id: &str,
        expected_directory: &str,
    ) -> Result<(Self, Session, String)> {
        self.bind_at_placed(
            project,
            id,
            Some(expected_directory),
            true,
            true,
            false,
            true,
        )
        .await
    }

    pub async fn session_directory(&self, project: &Project, id: &str) -> Result<String> {
        if !valid_id(id) || id.starts_with("ses_cn_schedule_") {
            return Err("invalid session".into());
        }
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{id}",
                self.base, project.id
            ))
            .header("x-codenomad-session-placement", "1")
            .send()
            .await?;
        let data = read_json(response.error_for_status()?).await?;
        let row = &data["data"];
        let directory = row["location"]["directory"]
            .as_str()
            .filter(|dir| crate::server_path::absolute(dir))
            .ok_or("missing session directory")?;
        let placement = row["listWorktreeSlug"]
            .as_str()
            .filter(|slug| valid_id(slug));
        if !crate::server_path::same(&project.path, directory)
            && !placement.is_some_and(|slug| slug != "root")
            && !self
                .session_directories(project)
                .await?
                .iter()
                .any(|dir| crate::server_path::same(dir, directory))
        {
            return Err("foreign session location".into());
        }
        Ok(directory.into())
    }

    pub(crate) async fn bind_root_session(&self, project: &Project, id: &str) -> Result<Session> {
        let (_, session, _) = self
            .bind_at_placed(project, id, None, false, false, true, false)
            .await?;
        Ok(session)
    }

    #[allow(clippy::too_many_arguments)]
    async fn bind_at_placed(
        &self,
        project: &Project,
        id: &str,
        expected: Option<&str>,
        fresh: bool,
        verify_directory: bool,
        require_root: bool,
        allow_linked_fresh: bool,
    ) -> Result<(Self, Session, String)> {
        if !valid_id(id) || id.starts_with("ses_cn_schedule_") {
            return Err("invalid session".into());
        }
        let response = self
            .client
            .get(format!(
                "{}workspaces/{}/instance/api/session/{id}",
                self.base, project.id
            ))
            .header("x-codenomad-session-placement", "1")
            .send()
            .await?;
        let status = response.status();
        if matches!(
            status,
            reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::FORBIDDEN
        ) {
            let data = crate::backend::read_json_limited(response, 4096).await?;
            let absent = status == reqwest::StatusCode::NOT_FOUND
                && data["_tag"] == "SessionNotFoundError"
                && data["sessionID"] == id;
            let moved = status == reqwest::StatusCode::FORBIDDEN
                && data["reason"] == "session_located_elsewhere";
            return Err(if absent {
                SessionMissing::not_found().into()
            } else if moved {
                SessionMissing::located_elsewhere().into()
            } else {
                "session request unavailable".into()
            });
        }
        let data = read_json(response.error_for_status()?).await?;
        let row = &data["data"];
        if require_root && !row["parentID"].is_null() {
            return Err("not a root conversation".into());
        }
        let directory = row["location"]["directory"]
            .as_str()
            .ok_or("missing session directory")?;
        let placement = row["listWorktreeSlug"]
            .as_str()
            .filter(|slug| valid_id(slug));
        let linked = !crate::server_path::same(&project.path, directory);
        if expected.is_some_and(|d| !crate::server_path::same(d, directory))
            || !allow_linked_fresh && linked && fresh
        {
            return Err("foreign session location".into());
        }
        if linked {
            let owned = if allow_linked_fresh {
                placement.is_some_and(|slug| slug != "root")
                    || self
                        .session_directories(project)
                        .await?
                        .iter()
                        .any(|d| crate::server_path::same(d, directory))
            } else if verify_directory {
                self.session_directories(project)
                    .await?
                    .iter()
                    .any(|d| crate::server_path::same(d, directory))
            } else {
                placement.is_some_and(|slug| slug != "root")
            };
            if !owned {
                return Err("foreign session location".into());
            }
        }
        let info = session_at(row, directory)?;
        if info.id != id {
            return Err("session response identity mismatch".into());
        }
        let mut backend = self.clone();
        backend.workspace = project.id.clone();
        backend.session = id.into();
        backend.session_directory = Some(directory.into());
        backend.fresh_mode = fresh;
        backend.client_id = crate::http::client_id()?;
        Ok((backend, info, placement.unwrap_or("root").into()))
    }
}
