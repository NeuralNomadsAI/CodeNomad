use super::{preview_owners::PreviewOwner, *};

#[derive(Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OwnershipAction {
    Ready {
        session_id: String,
        instance_id: String,
        #[serde(rename = "requestID")]
        request_id: String,
    },
    Used {
        session_id: String,
        instance_id: String,
    },
    Request {
        session_id: String,
        instance_id: String,
        revision: Option<u64>,
    },
    Focus {
        session_id: String,
        revision: u64,
    },
    Release {
        instance_id: String,
    },
}

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OpenResponse {
    Discover {
        instance_id: Option<String>,
    },
    Target {
        instance_id: String,
        registration_id: String,
    },
}

pub(super) struct OpenClaim {
    owner: String,
    renderer_version: u64,
    session_id: String,
    workspace_ids: Arc<[String]>,
    deadline: Instant,
    attach_deadline: Instant,
    fence: crate::native_request::RequestFence,
    discovery: Option<Option<String>>,
    instance_id: Option<String>,
    ownership: Option<PreviewOwner>,
    revoked: bool,
    successor_url: Option<String>,
    pub(super) load_sequence: Option<u64>,
    target: Option<Registration>,
}

impl OpenClaim {
    pub(super) fn belongs_to(&self, owner: &str) -> bool {
        self.owner == owner
    }

    pub(super) fn revoke(&mut self) {
        self.revoked = true;
    }

    fn current(&self, inner: &Inner) -> Result<(), String> {
        self.fence.check()?;
        let deadline = if self.target.is_some() {
            self.deadline
        } else {
            self.attach_deadline
        };
        if self.revoked
            || Instant::now() >= deadline
            || inner
                .renderer_versions
                .get(&self.owner)
                .copied()
                .unwrap_or(0)
                != self.renderer_version
            || self
                .ownership
                .as_ref()
                .is_some_and(|owner| inner.preview_owners.get(&self.session_id) != Some(owner))
        {
            return Err("Browser open target changed or timed out".into());
        }
        Ok(())
    }
}

impl Inner {
    pub(super) fn check_preview_owner(
        &self,
        session_id: &str,
        window: &str,
        occurrence: Option<&str>,
    ) -> Result<(), String> {
        if occurrence.is_some()
            && !self.preview_owners.get(session_id).is_some_and(|owner| {
                owner.window == window && Some(owner.instance_id.as_str()) == occurrence
            })
        {
            return Err("Browser preview belongs to another tab".into());
        }
        Ok(())
    }
}

fn ownership(
    session_id: &str,
    revision: u64,
    requester: &str,
    owner: Option<&PreviewOwner>,
) -> Value {
    json!({ "sessionId": session_id, "revision": revision, "owner": owner.map(|owner| json!({
        "instanceId": owner.instance_id, "sameWindow": owner.window == requester,
    })) })
}

impl BrowserController {
    pub(super) fn publish_preview_ownership<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        revision: u64,
        owner: Option<&PreviewOwner>,
    ) {
        for (label, view) in app.webviews() {
            if owner.is_none_or(|owner| owner.window != label)
                && label == view.window().label()
                && crate::identity::local_window_id(&label).is_ok()
            {
                let _ = app.emit_to(
                    tauri::EventTarget::webview(&label),
                    "browser-target:ownership",
                    ownership(session_id, revision, &label, owner),
                );
            }
        }
    }

    pub(crate) fn change_ownership(
        &self,
        app: &AppHandle,
        window: &str,
        input: OwnershipAction,
    ) -> Result<Option<Value>, String> {
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        match input {
            OwnershipAction::Ready {
                session_id,
                instance_id,
                request_id,
            } => {
                let Ok(claim) = current_claim(&inner, &request_id) else {
                    return Ok(None);
                };
                if !claim.belongs_to(window)
                    || claim.session_id != session_id
                    || claim.instance_id.as_ref() != Some(&instance_id)
                {
                    return Ok(None);
                }
                let changed = inner.preview_owners.get(&session_id).is_none();
                let (owner, _) =
                    inner
                        .preview_owners
                        .request(&session_id, window, &instance_id, None);
                if owner.window == window && owner.instance_id == instance_id {
                    inner.open_claims.get_mut(&request_id).unwrap().ownership = Some(owner.clone());
                }
                drop(inner);
                if changed {
                    self.inner.1.notify_all();
                    self.publish_preview_ownership(app, &session_id, owner.revision, Some(&owner));
                }
                Ok(Some(ownership(
                    &session_id,
                    owner.revision,
                    window,
                    Some(&owner),
                )))
            }
            OwnershipAction::Used {
                session_id,
                instance_id,
            } => {
                validate_id(&session_id, 256)?;
                validate_id(&instance_id, 256)?;
                inner.preview_owners.used(session_id, window, instance_id);
                Ok(None)
            }
            OwnershipAction::Request {
                session_id,
                instance_id,
                revision,
            } => {
                validate_id(&session_id, 256)?;
                validate_id(&instance_id, 256)?;
                let before = inner.preview_owners.get(&session_id).cloned();
                let (owner, previous) =
                    inner
                        .preview_owners
                        .request(&session_id, window, &instance_id, revision);
                if previous.is_some() {
                    let invalidated = inner
                        .registrations
                        .values_mut()
                        .filter_map(|registration| {
                            if registration.session_id != session_id
                                || registration.window_label != window
                                || registration.instance_id.is_none()
                            {
                                return None;
                            }
                            registration.instance_id = Some(instance_id.clone());
                            registration.visibility_version =
                                registration.visibility_version.wrapping_add(1);
                            registration.visible = false;
                            Some(registration.registration_id.clone())
                        })
                        .collect::<Vec<_>>();
                    inner.page_leases.retain(|_, lease| {
                        !invalidated.contains(&lease.registration.registration_id)
                    });
                }
                drop(inner);
                if before.as_ref() != Some(&owner) {
                    self.inner.1.notify_all();
                    self.publish_preview_ownership(app, &session_id, owner.revision, Some(&owner));
                }
                Ok(Some(ownership(
                    &session_id,
                    owner.revision,
                    window,
                    Some(&owner),
                )))
            }
            OwnershipAction::Focus {
                session_id,
                revision,
            } => {
                let owner = inner
                    .preview_owners
                    .get(&session_id)
                    .filter(|owner| owner.revision == revision)
                    .cloned();
                drop(inner);
                if let Some(owner) = owner {
                    if let Some(target) = app.get_window(&owner.window) {
                        target.unminimize().map_err(|error| error.to_string())?;
                        target.show().map_err(|error| error.to_string())?;
                        target.set_focus().map_err(|error| error.to_string())?;
                        app.emit_to(
                            tauri::EventTarget::webview(&owner.window),
                            "browser-target:focus-owner",
                            json!({ "sessionId": session_id, "instanceId": owner.instance_id }),
                        )
                        .map_err(|error| error.to_string())?;
                    }
                }
                Ok(None)
            }
            OwnershipAction::Release { instance_id } => {
                validate_id(&instance_id, 256)?;
                let released = inner.preview_owners.release(window, Some(&instance_id));
                let registrations = inner
                    .registrations
                    .values()
                    .filter(|registration| {
                        registration.window_label == window
                            && registration.instance_id.as_deref() == Some(&instance_id)
                    })
                    .map(|registration| {
                        (
                            registration.registration_id.clone(),
                            registration.generation,
                        )
                    })
                    .collect::<Vec<_>>();
                for (id, _) in &registrations {
                    if let Some(registration) = inner.registrations.get_mut(id) {
                        registration.visible = false;
                        registration.visibility_version =
                            registration.visibility_version.wrapping_add(1);
                    }
                }
                drop(inner);
                self.inner.1.notify_all();
                for (session_id, _, rev) in released {
                    self.publish_preview_ownership(app, &session_id, rev, None);
                }
                for (id, generation) in registrations {
                    let _ = self.unregister_generation(app, window, &id, Some(generation));
                }
                Ok(None)
            }
        }
    }

    pub(crate) fn claim_open(
        &self,
        owner: &str,
        request_id: &str,
        response: OpenResponse,
    ) -> Result<bool, String> {
        let (lock, ready) = &*self.inner;
        let mut inner = lock.lock().map_err(|error| error.to_string())?;
        let Ok(claim) = current_claim(&inner, request_id) else {
            return Ok(false);
        };
        if !claim.belongs_to(owner) {
            return Ok(false);
        }
        match response {
            OpenResponse::Discover { instance_id }
                if claim.discovery.is_none()
                    && claim.ownership.is_none()
                    && instance_id
                        .as_ref()
                        .is_none_or(|id| claim.workspace_ids.contains(id)) =>
            {
                inner.open_claims.get_mut(request_id).unwrap().discovery = Some(instance_id);
            }
            OpenResponse::Target {
                instance_id,
                registration_id,
            } if claim.target.is_none()
                && claim
                    .ownership
                    .as_ref()
                    .is_some_and(|owner| owner.instance_id == instance_id) =>
            {
                let Some(target) = inner
                    .registrations
                    .get(&registration_id)
                    .filter(|registration| {
                        registration.window_label == owner
                            && registration.session_id == claim.session_id
                            && registration.visible
                            && registration.instance_id.as_ref() == Some(&instance_id)
                    })
                    .cloned()
                else {
                    return Ok(false);
                };
                inner.open_claims.get_mut(request_id).unwrap().target = Some(target);
            }
            _ => return Ok(false),
        }
        ready.notify_all();
        Ok(true)
    }

    pub(crate) fn release_open(&self, owner: &str, request_id: &str) -> bool {
        let Ok(mut inner) = self.inner.0.lock() else {
            return false;
        };
        let Some(claim) = inner
            .open_claims
            .get_mut(request_id)
            .filter(|claim| claim.belongs_to(owner))
        else {
            return false;
        };
        claim.revoke();
        self.inner.1.notify_all();
        true
    }

    #[cfg(any(windows, target_os = "linux", target_os = "macos"))]
    pub(super) fn open(
        &self,
        app: &AppHandle,
        session_id: &str,
        raw_url: &str,
        workspace_ids: &Value,
        deadline: Instant,
        fence: &crate::native_request::RequestFence,
    ) -> Result<Value, String> {
        let url = allowed_url(raw_url)?;
        validate_id(session_id, 256)?;
        let workspaces: Arc<[String]> = workspace_ids
            .as_array()
            .filter(|ids| !ids.is_empty() && ids.len() <= 1024)
            .and_then(|ids| {
                ids.iter()
                    .map(|id| id.as_str().map(ToOwned::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .filter(|ids| ids.iter().all(|id| validate_id(id, 256).is_ok()))
            .ok_or("Owning project tabs are unavailable")?
            .into();
        let attach_deadline = deadline.min(Instant::now() + Duration::from_secs(10));
        let (lock, ready) = &*self.inner;
        let candidates = crate::local_windows::browser_open_candidates(app)?;
        'route: loop {
            fence.check()?;
            if Instant::now() >= attach_deadline {
                return Err("Browser open target timed out".into());
            }
            let (existing, recent) = {
                let inner = lock.lock().map_err(|error| error.to_string())?;
                (
                    inner.preview_owners.get(session_id).cloned(),
                    inner
                        .preview_owners
                        .last_used(session_id)
                        .filter(|(window, tab)| {
                            workspaces.iter().any(|id| id == tab)
                                && candidates.iter().any(|(label, _)| label == window)
                        })
                        .map(|(window, tab)| (window.to_owned(), tab.to_owned()))
                        .collect::<Vec<_>>(),
                )
            };
            if existing.as_ref().is_some_and(|owner| {
                !workspaces.contains(&owner.instance_id)
                    || !candidates.iter().any(|(label, _)| *label == owner.window)
            }) {
                return Err("The owning preview tab is unavailable".into());
            }
            let preferred = if let Some(owner) = &existing {
                Some((owner.window.clone(), owner.instance_id.clone()))
            } else {
                let mut preferred = None;
                for (window, tab) in recent {
                    if window_visible(app, &window)
                        .map_err(|error| preview_error("inventory is incomplete", error))?
                    {
                        preferred = Some((window, tab));
                        break;
                    }
                }
                preferred
            };
            for (window, incarnation) in &candidates {
                if preferred.as_ref().is_some_and(|(label, _)| label != window) {
                    continue;
                }
                if !window_visible(app, window)
                    .map_err(|error| preview_error("inventory is incomplete", error))?
                {
                    continue;
                }
                let check_window = || -> Result<(), String> {
                    if crate::local_windows::browser_open_window_current(app, window, incarnation) {
                        Ok(())
                    } else {
                        Err("Browser open target changed".into())
                    }
                };
                check_window()?;
                let request_id = uuid::Uuid::new_v4().to_string();
                let mut inner = lock.lock().map_err(|error| error.to_string())?;
                let claim = OpenClaim {
                    owner: window.clone(),
                    renderer_version: inner.renderer_versions.get(window).copied().unwrap_or(0),
                    session_id: session_id.into(),
                    workspace_ids: workspaces.clone(),
                    deadline,
                    attach_deadline,
                    fence: fence.clone(),
                    discovery: preferred.as_ref().map(|(_, tab)| Some(tab.clone())),
                    instance_id: None,
                    ownership: None,
                    revoked: false,
                    successor_url: None,
                    load_sequence: None,
                    target: None,
                };
                claim.current(&inner)?;
                inner.open_claims.insert(request_id.clone(), claim);
                drop(inner);
                let event_target = tauri::EventTarget::webview(window);
                let result = (|| -> Result<OpenResult, String> {
                    if preferred.is_none() {
                        app.emit_to(event_target.clone(), "browser-target:discover",
                            json!({ "requestID": request_id, "sessionID": session_id, "workspaceIDs": &*workspaces }))
                            .map_err(|error| error.to_string())?;
                    }
                    let instance_id = loop {
                        check_window()?;
                        let mut inner = lock.lock().map_err(|error| error.to_string())?;
                        let claim = current_claim(&inner, &request_id)?;
                        let actual = inner.preview_owners.get(session_id).cloned();
                        if actual != existing {
                            return Ok(OpenResult::Reroute);
                        }
                        if let Some(discovery) = &claim.discovery {
                            let Some(instance_id) = discovery.clone() else {
                                return Ok(OpenResult::Absent);
                            };
                            inner.open_claims.get_mut(&request_id).unwrap().instance_id =
                                Some(instance_id.clone());
                            break instance_id;
                        }
                        drop(
                            ready
                                .wait_timeout(inner, remaining(attach_deadline))
                                .map_err(|error| error.to_string())?,
                        );
                    };
                    app.emit_to(event_target.clone(), "browser-target:open", json!({
                        "sessionID": session_id, "url": raw_url, "requestID": request_id, "instanceId": instance_id,
                    })).map_err(|error| error.to_string())?;
                    let registration = loop {
                        check_window()?;
                        let inner = lock.lock().map_err(|error| error.to_string())?;
                        let claim = current_claim(&inner, &request_id)?;
                        if let Some(target) = &claim.target {
                            break target.clone();
                        }
                        drop(
                            ready
                                .wait_timeout(inner, remaining(attach_deadline))
                                .map_err(|error| error.to_string())?,
                        );
                    };
                    let webview = app
                        .get_webview(&registration.webview_label)
                        .ok_or("Browser open registration changed")?;
                    let (app, window, incarnation) =
                        (app.clone(), window.clone(), incarnation.clone());
                    self.navigate_and_wait(
                        &registration,
                        &webview,
                        &url,
                        deadline,
                        fence,
                        None,
                        Some(&request_id),
                        move || {
                            crate::local_windows::browser_open_window_current(
                                &app,
                                &window,
                                &incarnation,
                            )
                            .then_some(())
                            .ok_or("Browser open target changed".into())
                        },
                    )
                    .map(|url| OpenResult::Committed(url, super::registration_identity(&registration)))
                })();
                let mut inner = lock.lock().map_err(|error| error.to_string())?;
                let result = match result {
                    Ok(OpenResult::Committed(url, identity)) => {
                        current_claim(&inner, &request_id).and_then(|claim| {
                            check_open_target(
                                &inner,
                                &request_id,
                                claim.target.as_ref().ok_or("Browser open target changed")?,
                            )?;
                            Ok(OpenResult::Committed(url, identity))
                        })
                    }
                    other => other,
                };
                let retired = inner.open_claims.remove(&request_id);
                drop(inner);
                if let Some((claim, instance_id)) = retired
                    .as_ref()
                    .and_then(|claim| Some((claim, claim.instance_id.as_ref()?)))
                {
                    let committed = match &result {
                        Ok(OpenResult::Committed(url, _)) => Some(url),
                        _ => None,
                    };
                    let _ = app.emit_to(event_target, "browser-target:open-settled", json!({
                        "requestID": request_id, "sessionID": session_id, "instanceId": instance_id,
                        "committedUrl": committed, "keepGuest": true, "successorUrl": claim.successor_url,
                    }));
                }
                match result? {
                    OpenResult::Absent => continue,
                    OpenResult::Reroute => continue 'route,
                    OpenResult::Committed(url, registration) => {
                        return Ok(json!({ "url": url, "registration": registration }))
                    }
                }
            }
            return Err("No visible local window has the owning project tab".into());
        }
    }
}

enum OpenResult {
    Absent,
    Reroute,
    /// The committed URL and the registration that loaded it.
    Committed(String, String),
}

pub(super) fn check_open_target(
    inner: &Inner,
    request_id: &str,
    expected: &Registration,
) -> Result<(), String> {
    let claim = current_claim(inner, request_id)?;
    if claim.target.as_ref() != Some(expected)
        || inner.registrations.get(&expected.registration_id) != Some(expected)
    {
        return Err("Browser open registration changed".into());
    }
    Ok(())
}

pub(super) fn retire_open_for_navigation(
    inner: &mut Inner,
    registration_id: &str,
    generation: u64,
    displaced_load: Option<u64>,
    successor_url: Option<&str>,
) {
    let Some(current) = inner
        .registrations
        .get(registration_id)
        .filter(|registration| registration.generation == generation)
    else {
        return;
    };
    for claim in inner.open_claims.values_mut() {
        if !claim.revoked
            && claim.load_sequence == displaced_load
            && claim.target.as_ref() == Some(current)
        {
            claim.successor_url = successor_url.map(str::to_owned);
            claim.revoke();
        }
    }
}

fn current_claim<'a>(inner: &'a Inner, request_id: &str) -> Result<&'a OpenClaim, String> {
    let claim = inner
        .open_claims
        .get(request_id)
        .ok_or("Browser open target changed")?;
    claim.current(inner)?;
    Ok(claim)
}

fn remaining(deadline: Instant) -> Duration {
    deadline
        .saturating_duration_since(Instant::now())
        .min(Duration::from_millis(100))
}
