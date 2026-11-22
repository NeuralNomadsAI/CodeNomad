use super::*;

#[derive(Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum OpenResponse {
    Discover {
        #[serde(default, deserialize_with = "discovered_instance")]
        instance_id: Option<Option<String>>,
        ambiguous: Option<bool>,
    },
    Claim {
        instance_id: String,
    },
    Adopt {
        instance_id: String,
    },
    Target {
        instance_id: String,
        registration_id: String,
    },
}

// Only an explicit null confirms absence; a missing field is inconclusive.
fn discovered_instance<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

enum Discovery {
    Absent,
    Ambiguous,
    Occurrence(String),
}

pub(super) struct OpenClaim {
    owner: String,
    renderer_version: u64,
    session_id: String,
    workspace_ids: Arc<[String]>,
    deadline: Instant,
    attach_deadline: Instant,
    fence: crate::native_request::RequestFence,
    discovery: Option<Discovery>,
    instance_id: Option<String>,
    claimed: bool,
    adopted: bool,
    revoked: bool,
    keep_guest: bool,
    successor_url: Option<String>,
    pub(super) load_sequence: Option<u64>,
    construction: Option<(String, u64)>,
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
        if self.revoked {
            return Err("Browser open target changed".into());
        }
        self.fence.check()?;
        if Instant::now()
            >= if self.target.is_some() {
                self.deadline
            } else {
                self.attach_deadline
            }
        {
            return Err("Browser open target timed out".into());
        }
        if inner
            .renderer_versions
            .get(&self.owner)
            .copied()
            .unwrap_or(0)
            != self.renderer_version
        {
            return Err("Browser open renderer changed".into());
        }
        Ok(())
    }
}

impl BrowserController {
    pub(crate) fn claim_open<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        owner: &str,
        request_id: &str,
        response: OpenResponse,
    ) -> Result<bool, String> {
        self.claim_open_with_visibility(owner, request_id, response, |label| {
            window_visible(app, label)
        })
    }

    fn claim_open_with_visibility(
        &self,
        owner: &str,
        request_id: &str,
        response: OpenResponse,
        read_visibility: impl FnMut(&str) -> tauri::Result<bool>,
    ) -> Result<bool, String> {
        let (inner, ready) = &*self.inner;
        let mut inner = inner.lock().map_err(|error| error.to_string())?;
        let Some(claim) = inner
            .open_claims
            .get(request_id)
            .filter(|claim| claim.belongs_to(owner))
        else {
            return Ok(false);
        };
        if claim.current(&inner).is_err() {
            return Ok(false);
        }
        let target = match &response {
            OpenResponse::Adopt { instance_id } => {
                if claim.instance_id.as_ref() != Some(instance_id) || !claim.claimed || claim.adopted
                {
                    return Ok(false);
                }
                let snapshot = OpenPreviewSnapshot::new(&inner, &claim.session_id, owner);
                drop(inner);
                let visibility = snapshot.read(read_visibility)?;
                inner = self.inner.0.lock().map_err(|error| error.to_string())?;
                let Ok(claim) = current_claim(&inner, request_id) else {
                    return Ok(false);
                };
                if inner.open_claims.iter().any(|(id, other)| {
                    id != request_id && other.session_id == claim.session_id && other.adopted
                }) {
                    return Err("Browser preview open is already in progress".into());
                }
                visibility.check(&inner, &claim.session_id, owner, Some(instance_id), None)?;
                None
            }
            OpenResponse::Target {
                instance_id,
                registration_id,
            } => {
                let Some(registration) =
                    inner
                        .registrations
                        .get(registration_id)
                        .filter(|registration| {
                            registration.window_label == owner
                                && registration.session_id == claim.session_id
                                && registration.visible
                                && registration.instance_id.as_ref() == Some(instance_id)
                                && claim.construction.as_ref().is_none_or(|(id, generation)| {
                                    registration.registration_id == *id
                                        && registration.generation == *generation
                                })
                        })
                else {
                    return Ok(false);
                };
                Some(registration.clone())
            }
            _ => None,
        };
        let claim = inner.open_claims.get_mut(request_id).unwrap();
        match response {
            OpenResponse::Discover {
                instance_id,
                ambiguous,
            } if claim.discovery.is_none() && claim.instance_id.is_none() => {
                claim.discovery = Some(match (ambiguous, instance_id) {
                    (Some(true), _) => Discovery::Ambiguous,
                    (_, Some(None)) => Discovery::Absent,
                    (_, Some(Some(id))) if claim.workspace_ids.contains(&id) => {
                        Discovery::Occurrence(id)
                    }
                    _ => return Ok(false),
                });
            }
            OpenResponse::Claim { instance_id }
                if claim.instance_id.as_ref() == Some(&instance_id) && !claim.claimed =>
            {
                claim.claimed = true
            }
            OpenResponse::Adopt { instance_id }
                if claim.instance_id.as_ref() == Some(&instance_id)
                    && claim.claimed
                    && !claim.adopted =>
            {
                claim.adopted = true
            }
            OpenResponse::Target { instance_id, .. }
                if claim.instance_id.as_ref() == Some(&instance_id)
                    && claim.adopted
                    && claim.target.is_none() =>
            {
                claim.target = target;
            }
            _ => return Ok(false),
        }
        ready.notify_all();
        Ok(true)
    }

    pub(crate) fn release_open(&self, owner: &str, request_id: &str, keep_guest: bool) -> bool {
        let Ok(mut inner) = self.inner.0.lock() else {
            return false;
        };
        let preserve_guest = keep_guest
            && inner
                .open_claims
                .get(request_id)
                .and_then(|claim| claim.target.as_ref())
                .is_some_and(|target| inner.registrations.get(&target.registration_id) == Some(target));
        let Some(claim) = inner
            .open_claims
            .get_mut(request_id)
            .filter(|claim| claim.belongs_to(owner) && !claim.revoked)
        else {
            return false;
        };
        claim.keep_guest = preserve_guest;
        claim.revoke();
        self.inner.1.notify_all();
        !keep_guest || claim.keep_guest
    }

    pub(super) fn reserve_open_construction(
        &self,
        request_id: &str,
        owner: &str,
        input: &BrowserTargetRegistration,
        generation: u64,
    ) -> Result<(), String> {
        let mut inner = self.inner.0.lock().map_err(|error| error.to_string())?;
        let claim = current_claim(&inner, request_id)?;
        if !claim.adopted
            || claim.owner != owner
            || claim.session_id != input.session_id
            || claim.instance_id != input.instance_id
            || claim.construction.is_some()
            || claim.target.is_some()
        {
            return Err("Browser open construction is no longer current".into());
        }
        check_no_foreign_preview(&inner, &claim.session_id, owner)?;
        inner.open_claims.get_mut(request_id).unwrap().construction =
            Some((input.registration_id.clone(), generation));
        Ok(())
    }

    pub(super) fn check_open_publication(
        inner: &Inner,
        request_id: &str,
        registration: &Registration,
    ) -> Result<(), String> {
        let claim = current_claim(inner, request_id)?;
        if claim.owner != registration.window_label
            || claim.target.is_some()
            || claim.construction.as_ref().is_none_or(|(id, generation)| {
                id != &registration.registration_id || *generation != registration.generation
            })
        {
            return Err("Browser open construction is no longer current".into());
        }
        check_no_foreign_preview(inner, &claim.session_id, &claim.owner)
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
        for (owner, incarnation) in crate::local_windows::browser_open_candidates(app)? {
            let renderer_version = self.renderer_version(&owner)?;
            if !window_visible(app, &owner)
                .map_err(|error| preview_error("inventory is incomplete", error))?
            {
                continue;
            }
            let owner_current = || -> Result<(), String> {
                if !crate::local_windows::browser_open_window_current(app, &owner, &incarnation)
                    || !window_visible(app, &owner)
                        .map_err(|error| preview_error("inventory is incomplete", error))?
                {
                    return Err("Browser open target changed".into());
                }
                Ok(())
            };
            owner_current()?;
            let request_id = uuid::Uuid::new_v4().to_string();
            let (inner, ready) = &*self.inner;
            let mut guard = inner.lock().map_err(|error| error.to_string())?;
            let claim = OpenClaim {
                owner: owner.clone(),
                renderer_version,
                session_id: session_id.into(),
                workspace_ids: workspaces.clone(),
                deadline,
                attach_deadline,
                fence: fence.clone(),
                discovery: None,
                instance_id: None,
                claimed: false,
                adopted: false,
                revoked: false,
                keep_guest: false,
                successor_url: None,
                load_sequence: None,
                construction: None,
                target: None,
            };
            claim.current(&guard)?;
            guard.open_claims.insert(request_id.clone(), claim);
            drop(guard);
            let event_target = tauri::EventTarget::webview(&owner);
            let result = (|| -> Result<Option<String>, String> {
                app.emit_to(
                    event_target.clone(),
                    "browser-target:discover",
                    json!({ "requestID": request_id, "workspaceIDs": &*workspaces }),
                )
                .map_err(|error| error.to_string())?;
                let instance_id =
                    loop {
                        owner_current()?;
                        let guard = inner.lock().map_err(|error| error.to_string())?;
                        let claim = current_claim(&guard, &request_id)?;
                        if let Some(discovery) = &claim.discovery {
                            match discovery {
                                Discovery::Absent => return Ok(None),
                                Discovery::Ambiguous => return Err(
                                    "Multiple owning tabs; select one before opening the preview"
                                        .into(),
                                ),
                                Discovery::Occurrence(id) => break id.clone(),
                            }
                        }
                        drop(
                            ready
                                .wait_timeout(guard, remaining(attach_deadline))
                                .map_err(|error| error.to_string())?,
                        );
                    };
                let visibility = self.read_open_preview(app, session_id, &owner)?;
                owner_current()?;
                {
                    let mut guard = inner.lock().map_err(|error| error.to_string())?;
                    current_claim(&guard, &request_id)?;
                    visibility.check(&guard, session_id, &owner, Some(&instance_id), None)?;
                    guard.open_claims.get_mut(&request_id).unwrap().instance_id =
                        Some(instance_id.clone());
                }
                app.emit_to(event_target, "browser-target:open", json!({
                    "sessionID": session_id, "url": raw_url, "requestID": request_id, "instanceId": instance_id,
                })).map_err(|error| error.to_string())?;
                let registration = loop {
                    owner_current()?;
                    let guard = inner.lock().map_err(|error| error.to_string())?;
                    let claim = current_claim(&guard, &request_id)?;
                    if let Some(target) = &claim.target {
                        break target.clone();
                    }
                    drop(
                        ready
                            .wait_timeout(guard, remaining(attach_deadline))
                            .map_err(|error| error.to_string())?,
                    );
                };
                let webview = app
                    .get_webview(&registration.webview_label)
                    .ok_or("Browser open registration changed")?;
                let (app, owner, incarnation) = (app.clone(), owner.clone(), incarnation.clone());
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
                            &owner,
                            &incarnation,
                        )
                        .then_some(())
                        .ok_or("Browser open target changed".into())
                    },
                )
                .map(Some)
            })();
            let result = result.and_then(|url| {
                let visibility = url
                    .as_ref()
                    .map(|_| self.read_open_preview(app, session_id, &owner))
                    .transpose()?;
                owner_current()?;
                Ok((url, visibility))
            });
            let (result, retired) = {
                let mut guard = inner.lock().map_err(|error| error.to_string())?;
                let result = result.and_then(|(url, visibility)| {
                    let claim = current_claim(&guard, &request_id)?;
                    if let Some(visibility) = visibility {
                        let target = claim.target.as_ref().ok_or("Browser open target changed")?;
                        check_open_target(&guard, &request_id, target, &visibility)?;
                    }
                    Ok(url)
                });
                let retired = guard.open_claims.remove(&request_id).map(|mut claim| {
                    claim.keep_guest &= claim.target.as_ref().is_some_and(|target| {
                        guard.registrations.get(&target.registration_id) == Some(target)
                    });
                    claim
                });
                (result, retired)
            };
            if let Some(claim) = retired.filter(|claim| claim.adopted) {
                if claim.target.is_none() {
                    if let Some((id, generation)) = claim.construction {
                        let _ = self.unregister_generation(app, &owner, &id, Some(generation));
                    }
                }
                let committed_url = result.as_ref().ok().and_then(|url| url.as_deref());
                let _ = app.emit_to(tauri::EventTarget::webview(&owner), "browser-target:open-settled",
                    json!({ "requestID": request_id, "sessionID": session_id, "instanceId": claim.instance_id,
                        "committedUrl": committed_url, "keepGuest": claim.keep_guest,
                        "successorUrl": claim.successor_url }));
            }
            if let Some(url) = result? {
                return Ok(json!({ "url": url }));
            }
        }
        Err("No visible local window has the owning project tab".into())
    }

    pub(super) fn read_open_preview<R: tauri::Runtime>(
        &self,
        app: &AppHandle<R>,
        session_id: &str,
        owner: &str,
    ) -> Result<OpenPreviewCheck, String> {
        let snapshot = {
            let inner = self.inner.0.lock().map_err(|error| error.to_string())?;
            OpenPreviewSnapshot::new(&inner, session_id, owner)
        };
        snapshot.read(|label| window_visible(app, label))
    }
}

struct OpenPreviewSnapshot(Option<Vec<Registration>>);

pub(super) struct OpenPreviewCheck(Option<(Vec<Registration>, Registration)>);

impl OpenPreviewSnapshot {
    fn new(inner: &Inner, session_id: &str, owner: &str) -> Self {
        Self(has_foreign_preview(inner, session_id, owner).then(|| {
            advertised_visible_registrations(inner, session_id).cloned().collect()
        }))
    }

    fn read(
        self,
        read_visibility: impl FnMut(&str) -> tauri::Result<bool>,
    ) -> Result<OpenPreviewCheck, String> {
        let Some(registrations) = self.0 else {
            return Ok(OpenPreviewCheck(None));
        };
        let visible = resolve_visible_registration(&registrations, read_visibility)?.clone();
        Ok(OpenPreviewCheck(Some((registrations, visible))))
    }
}

impl OpenPreviewCheck {
    fn check(
        &self,
        inner: &Inner,
        session_id: &str,
        owner: &str,
        instance_id: Option<&str>,
        expected: Option<&Registration>,
    ) -> Result<(), String> {
        if !has_foreign_preview(inner, session_id, owner) {
            return Ok(());
        }
        // Only reuse the exact visible inventory sampled outside the registry lock.
        if let Some((registrations, visible)) = &self.0 {
            if visible.window_label == owner
                && instance_id.is_some()
                && visible.instance_id.as_deref() == instance_id
                && expected.is_none_or(|expected| visible == expected)
                && advertised_visible_registrations(inner, session_id).count() == registrations.len()
                && registrations.iter().all(|registration| {
                    inner.registrations.get(&registration.registration_id) == Some(registration)
                })
            {
                return Ok(());
            }
        }
        Err(foreign_preview_error())
    }
}

fn advertised_visible_registrations<'a>(
    inner: &'a Inner,
    session_id: &'a str,
) -> impl Iterator<Item = &'a Registration> {
    inner
        .registrations
        .values()
        .filter(move |registration| registration.session_id == session_id && registration.visible)
}

fn has_foreign_preview(inner: &Inner, session_id: &str, owner: &str) -> bool {
    inner.registrations.values().any(|registration| {
        registration.session_id == session_id && registration.window_label != owner
    })
}

fn foreign_preview_error() -> String {
    "Browser preview already exists in another window".into()
}

fn check_no_foreign_preview(inner: &Inner, session_id: &str, owner: &str) -> Result<(), String> {
    if has_foreign_preview(inner, session_id, owner) {
        return Err(foreign_preview_error());
    }
    Ok(())
}

pub(super) fn check_open_target(
    inner: &Inner,
    request_id: &str,
    expected: &Registration,
    visibility: &OpenPreviewCheck,
) -> Result<(), String> {
    let claim = current_claim(inner, request_id)?;
    if claim.target.as_ref() != Some(expected)
        || inner.registrations.get(&expected.registration_id) != Some(expected)
    {
        return Err("Browser open registration changed".into());
    }
    visibility.check(
        inner,
        &expected.session_id,
        &expected.window_label,
        expected.instance_id.as_deref(),
        Some(expected),
    )
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
            claim.keep_guest = true;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn open_claim_is_bound_to_renderer_occurrence_and_registration() {
        let controller = BrowserController::new(Default::default());
        let current = Arc::new(AtomicBool::new(true));
        let live = current.clone();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let fence = crate::native_request::RequestFence::new(now + 10_000, move || {
            live.load(Ordering::SeqCst)
        });
        {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.open_claims.insert(
                "request".into(),
                OpenClaim {
                    owner: "owner".into(),
                    renderer_version: 0,
                    session_id: "session".into(),
                    workspace_ids: vec!["tab".into()].into(),
                    instance_id: None,
                    deadline: Instant::now() + Duration::from_secs(10),
                    attach_deadline: Instant::now() + Duration::from_secs(10),
                    fence,
                    discovery: None,
                    claimed: false,
                    adopted: false,
                    revoked: false,
                    keep_guest: false,
                    successor_url: None,
                    load_sequence: None,
                    construction: None,
                    target: None,
                },
            );
            for (id, tab) in [("wrong", "some-other-tab"), ("right", "tab")] {
                inner.registrations.insert(
                    id.into(),
                    Registration {
                        session_id: "session".into(),
                        instance_id: Some(tab.into()),
                        registration_id: id.into(),
                        window_label: "owner".into(),
                        webview_label: id.into(),
                        generation: 1,
                        visibility_version: 0,
                        visible: true,
                    },
                );
            }
        }
        let report = |owner, response| {
            controller
                .claim_open_with_visibility(
                    owner,
                    "request",
                    serde_json::from_value(response).unwrap(),
                    |label| {
                        assert!(controller.inner.0.try_lock().is_ok());
                        Ok(label != "other")
                    },
                )
                .unwrap()
        };
        assert!(!report(
            "other",
            json!({"kind":"discover","instanceId":"tab"})
        ));
        assert!(!report(
            "owner",
            json!({"kind":"discover","instanceId":"wrong"})
        ));
        assert!(!report("owner", json!({"kind":"discover"})));
        assert!(report(
            "owner",
            json!({"kind":"discover","instanceId":"tab"})
        ));
        {
            let mut inner = controller.inner.0.lock().unwrap();
            let claim = inner.open_claims.get_mut("request").unwrap();
            let Some(Discovery::Occurrence(id)) = claim.discovery.take() else {
                panic!("expected a discovery match")
            };
            claim.instance_id = Some(id);
        }
        assert!(!report(
            "owner",
            json!({"kind":"claim","instanceId":"wrong"})
        ));
        assert!(report("owner", json!({"kind":"claim","instanceId":"tab"})));
        let foreign = {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.registrations.get_mut("wrong").unwrap().visible = false;
            let mut foreign = inner.registrations["right"].clone();
            foreign.registration_id = "foreign".into();
            foreign.window_label = "other".into();
            inner.registrations.insert("foreign".into(), foreign.clone());
            foreign
        };
        assert!(report("owner", json!({"kind":"adopt","instanceId":"tab"})));
        let mut construction = controller.owned_registration("owner", "right").unwrap();
        construction.generation += 1;
        let input: BrowserTargetRegistration = serde_json::from_value(json!({
            "sessionId": "session", "instanceId": "tab", "registrationId": "right",
            "url": "https://example.com/", "bounds": { "x": 0, "y": 0, "width": 1, "height": 1 }
        }))
        .unwrap();
        assert!(controller
            .reserve_open_construction("request", "owner", &input, construction.generation)
            .is_err());
        controller
            .inner
            .0
            .lock()
            .unwrap()
            .registrations
            .remove("foreign");
        controller
            .reserve_open_construction("request", "owner", &input, construction.generation)
            .unwrap();
        {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.registrations.insert("foreign".into(), foreign.clone());
            assert!(
                BrowserController::check_open_publication(&inner, "request", &construction).is_err()
            );
            inner.registrations.remove("foreign");
            inner
                .open_claims
                .get_mut("request")
                .unwrap()
                .attach_deadline = Instant::now();
        }
        assert!(controller
            .publish_registration(
                construction.clone(),
                0,
                "https://example.com/",
                Some("request"),
            )
            .is_err());
        {
            let mut inner = controller.inner.0.lock().unwrap();
            inner
                .open_claims
                .get_mut("request")
                .unwrap()
                .attach_deadline = Instant::now() + Duration::from_secs(10);
        }
        let target = |registration_id| json!({"kind":"target","instanceId":"tab","registrationId":registration_id});
        assert!(!report("owner", target("wrong")));
        assert!(!report("owner", target("right")));
        controller
            .publish_registration(construction, 0, "https://example.com/", Some("request"))
            .unwrap();
        assert!(report("owner", target("right")));
        assert!(!report("owner", target("right")));
        let (expected, minimized) = {
            let mut inner = controller.inner.0.lock().unwrap();
            inner
                .open_claims
                .get_mut("request")
                .unwrap()
                .attach_deadline = Instant::now() - Duration::from_secs(11);
            let expected = current_claim(&inner, "request")
                .unwrap()
                .target
                .clone()
                .unwrap();
            assert_eq!(expected.registration_id, "right");
            let no_foreign = OpenPreviewCheck(None);
            assert!(check_open_target(&inner, "request", &expected, &no_foreign).is_ok());
            inner
                .registrations
                .insert("foreign".into(), foreign.clone());
            assert!(check_open_target(&inner, "request", &expected, &no_foreign).is_err());
            assert!(check_no_foreign_preview(&inner, "session", "owner").is_err());
            let snapshot = || OpenPreviewSnapshot::new(&inner, "session", "owner");
            assert!(snapshot().read(|_| Ok(true)).is_err());
            assert!(snapshot()
                .read(|label| Ok(label == "other"))
                .unwrap()
                .check(&inner, "session", "owner", Some("tab"), None)
                .is_err());
            let minimized = snapshot().read(|label| Ok(label == "owner")).unwrap();
            assert!(minimized
                .check(&inner, "session", "owner", Some("wrong"), None)
                .is_err());
            assert!(check_open_target(&inner, "request", &expected, &minimized).is_ok());
            assert!(check_open_target(&inner, "request", &foreign, &minimized).is_err());
            inner.registrations.get_mut("foreign").unwrap().visibility_version += 1;
            assert!(check_open_target(&inner, "request", &expected, &minimized).is_err());
            inner.registrations.remove("foreign");
            let mut replacement = expected.clone();
            replacement.generation += 1;
            inner
                .registrations
                .insert("right".into(), replacement.clone());
            assert!(check_open_target(&inner, "request", &replacement, &no_foreign).is_err());
            assert!(check_open_target(&inner, "request", &expected, &no_foreign).is_err());
            inner.registrations.insert("right".into(), expected.clone());
            current.store(false, Ordering::SeqCst);
            assert!(current_claim(&inner, "request").is_err());
            current.store(true, Ordering::SeqCst);
            let claim = inner.open_claims.get_mut("request").unwrap();
            claim.deadline = Instant::now();
            inner.registrations.insert("foreign".into(), foreign);
            let minimized = OpenPreviewSnapshot::new(&inner, "session", "owner")
                .read(|label| Ok(label == "owner"))
                .unwrap();
            (expected, minimized)
        };
        let admit = || {
            controller.prepare_navigation(
                &expected,
                "https://example.com/",
                None,
                Some(("request", &minimized)),
                || Ok(()),
            )
        };
        assert!(admit().unwrap_err().contains("timed out"));
        {
            let mut inner = controller.inner.0.lock().unwrap();
            inner.open_claims.get_mut("request").unwrap().deadline =
                Instant::now() + Duration::from_secs(10);
            inner.renderer_versions.insert("owner".into(), 1);
            assert!(current_claim(&inner, "request").is_err());
            inner.renderer_versions.remove("owner");
        }
        assert!(!controller.release_open("other", "request", false));
        controller.mark_page_started(
            "right",
            expected.generation - 1,
            1,
            "https://example.com/old".into(),
        );
        {
            let inner = controller.inner.0.lock().unwrap();
            assert!(check_open_target(&inner, "request", &expected, &minimized).is_ok());
        }
        controller.mark_page_started(
            "right",
            expected.generation,
            2,
            "https://example.com/manual".into(),
        );
        assert!(admit().unwrap_err().contains("target changed"));
        {
            let mut inner = controller.inner.0.lock().unwrap();
            let claim = inner.open_claims.get_mut("request").unwrap();
            assert!(claim.keep_guest);
            assert_eq!(claim.successor_url.as_deref(), Some("https://example.com/manual"));
            claim.revoked = false;
            claim.keep_guest = false;
            claim.successor_url = None;
        }
        let sequence = admit().unwrap();
        controller.mark_page_started(
            "right",
            expected.generation,
            3,
            "https://example.com/".into(),
        );
        {
            let inner = controller.inner.0.lock().unwrap();
            assert!(check_open_target(&inner, "request", &expected, &minimized).is_ok());
        }
        controller.mark_page_committed(
            "right",
            expected.generation,
            3,
            "https://example.com/".into(),
        );
        controller.mark_page_started(
            "right",
            expected.generation,
            4,
            "https://example.com/manual".into(),
        );
        {
            let inner = controller.inner.0.lock().unwrap();
            let claim = inner.open_claims.get("request").unwrap();
            assert!(claim.revoked && claim.keep_guest);
            assert_eq!(claim.successor_url.as_deref(), Some("https://example.com/manual"));
        }
        assert!(!controller.take_navigation_stop(&expected, sequence));
        assert!(admit().unwrap_err().contains("target changed"));
        assert!(!report("other", json!({"kind":"claim","instanceId":"tab"})));
        assert!(!report("owner", json!({"kind":"claim","instanceId":"tab"})));
    }
}
