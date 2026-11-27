//! Session-owned controls. Session, permissions, forms, model catalogue and stop use separate HTTP lanes.
pub(crate) mod form_view;
#[cfg(test)]
mod form_view_tests;
pub(crate) mod forms;
mod string_constraints;
#[cfg(test)]
mod tests;
pub(crate) mod view;
#[cfg(test)]
mod viewport_tests;
use crate::{
    agent_api::{Action, Form, Model, Permission, Snapshot},
    agent_forms::{self, Drafts},
    backend::Backend,
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::edit::TextEdit;
enum Job {
    Read(bool, u64),
    Act(Action, u64),
    VerifyIdle(String, String),
}
enum PendingJob {
    Read(u64),
    Act(Action, u64),
}
enum Result {
    #[cfg(test)]
    Read(Snapshot, bool, u64),
    Session(Snapshot, Option<String>, bool, u64),
    Permissions(Option<Vec<Permission>>, u64),
    Forms(Option<Vec<Form>>, u64),
    Catalog(Option<Vec<Model>>, String, u64),
    Act(bool, Snapshot, Option<String>, u64),
    ActPermission(bool, Option<Vec<Permission>>, u64),
    ActForm(crate::agent_api::FormReplyOutcome, Option<Vec<Form>>, u64),
    ActFormOutcome(crate::agent_api::FormReplyOutcome, u64),
    ActFormSnapshot(Option<Vec<Form>>, u64),
    Stop(bool),
    VerifiedIdle(String, bool),
}
#[derive(Default)]
struct RequestLane {
    known: bool,
    reading: bool,
    busy: bool,
    reconciling: bool,
    trailing: bool,
    error: bool,
    generation: u64,
    hint_during_job: bool,
}
impl RequestLane {
    fn locked(&self, online: bool) -> bool {
        self.busy || self.reading || self.reconciling || !self.known || !online
    }
    fn mutation_pending(&self) -> bool {
        self.busy || self.reconciling
    }
    fn idle(&self) -> bool {
        !self.reading && !self.busy && !self.reconciling && !self.trailing
    }
    fn bump(&mut self) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.generation
    }
    fn reset(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self {
            generation,
            ..Self::default()
        };
    }
}
pub fn navigation_blocked(s: &crate::State) -> bool {
    #[cfg(target_arch = "wasm32")]
    if s.phase == crate::Phase::RestoreFailed {
        return false;
    }
    s.agent.as_ref().is_some_and(Ui::navigation_blocked)
}

pub(crate) fn focused_field_key(s: &crate::State) -> Option<(String, Option<String>)> {
    let a = s.agent.as_ref()?;
    if a.picker && a.search.focused {
        return Some(("model-search".into(), None));
    }
    if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected)
        && a.reasons.get(&p.id).is_some_and(|e| e.focused)
    {
        return Some((
            format!("reason-{}", p.id),
            Some(format!("pending-content-{}", p.id)),
        ));
    }
    if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
        let (active_fields, _) = agent_forms::active_fields(f, &a.drafts);
        let region = format!("pending-content-{}", f.id);
        for field in active_fields
            .into_iter()
            .filter(|field| field["hidden"] != true)
        {
            let Some(key) = field["key"].as_str() else {
                continue;
            };
            let Some(d) = a.drafts.get(&(f.id.clone(), key.to_string())) else {
                continue;
            };
            if d.edit.focused {
                return Some((agent_forms::field_editor_key(key), Some(region)));
            }
            if d.custom.focused {
                return Some((agent_forms::custom_editor_key(key), Some(region)));
            }
        }
    }
    None
}
pub(crate) fn focused_control_key(
    s: &crate::State,
    focused: Option<&str>,
) -> Option<(String, Option<String>)> {
    if let Some(field) = focused_field_key(s) {
        return Some(field);
    }
    let key = focused?;
    let a = s.agent.as_ref()?;
    if matches!(key, "model-picker" | "controls-refresh" | "stop-response") {
        return Some((key.to_string(), None));
    }
    if matches!(key, "pending-prev" | "pending-next") && a.ids().len() > 1 {
        return Some((key.to_string(), None));
    }
    if matches!(key, "allow_once" | "allow_always" | "reject")
        && a.permissions.iter().any(|p| p.id == a.selected)
    {
        return Some((key.to_string(), None));
    }
    if matches!(key, "answer-question" | "cancel-question")
        && a.forms.iter().any(|f| f.id == a.selected)
    {
        return Some((key.to_string(), None));
    }
    if a.picker
        && a.models
            .iter()
            .any(|model| format!("model-{}", model.reference) == key)
    {
        return Some((key.to_string(), Some("model-list".into())));
    }
    if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
        let (active_fields, _) = agent_forms::active_fields(f, &a.drafts);
        let region = format!("pending-content-{}", f.id);
        if key == rune_theme_codenomad::form_controls::FORM_FOCUS_ANCHOR {
            return Some((key.to_string(), Some(region)));
        }
        for field in active_fields
            .into_iter()
            .filter(|field| field["type"] == "external" || field["hidden"] != true)
        {
            let Some(field_key) = field["key"].as_str() else {
                continue;
            };
            let matched = match field["type"].as_str() {
                Some("boolean") => {
                    key == agent_forms::bool_option_key(field_key, "true")
                        || key == agent_forms::bool_option_key(field_key, "false")
                }
                Some("external") => {
                    agent_forms::external_url(field).is_some()
                        && (key == agent_forms::external_link_key(field_key)
                            || key == agent_forms::external_ack_key(field_key))
                }
                Some("string") => {
                    let options = agent_forms::normalized_options(field);
                    options.iter().any(|option| {
                        agent_forms::string_option_key(field_key, option.value) == key
                            || (option.description.is_some()
                                && agent_forms::option_desc_reveal_key(field_key, option.value)
                                    == key)
                    }) || (field["required"] != true
                        && !options.is_empty()
                        && key == agent_forms::clear_option_key(field_key))
                }
                Some("multiselect") => {
                    agent_forms::normalized_options(field).iter().any(|option| {
                        agent_forms::multi_option_key(field_key, option.value) == key
                            || (option.description.is_some()
                                && agent_forms::option_desc_reveal_key(field_key, option.value)
                                    == key)
                    }) || (field["custom"] == true
                        && a.drafts
                            .get(&(f.id.clone(), field_key.to_string()))
                            .is_some_and(|d| {
                                d.preserved_custom
                                    .iter()
                                    .any(|raw| agent_forms::multi_option_key(field_key, raw) == key)
                            }))
                }
                _ => false,
            };
            if matched {
                return Some((key.to_string(), Some(region)));
            }
        }
    }
    None
}
pub(crate) fn focused_field_edit(s: &crate::State) -> Option<&rune::TextEdit> {
    let a = s.agent.as_ref()?;
    if a.picker && a.search.focused {
        return Some(&a.search);
    }
    if let Some(p) = a.permissions.iter().find(|p| p.id == a.selected)
        && let Some(edit) = a.reasons.get(&p.id)
        && edit.focused
    {
        return Some(edit);
    }
    if let Some(f) = a.forms.iter().find(|f| f.id == a.selected) {
        let (active_fields, _) = agent_forms::active_fields(f, &a.drafts);
        for field in active_fields
            .into_iter()
            .filter(|field| field["hidden"] != true)
        {
            let Some(key) = field["key"].as_str() else {
                continue;
            };
            let Some(d) = a.drafts.get(&(f.id.clone(), key.to_string())) else {
                continue;
            };
            if d.edit.focused {
                return Some(&d.edit);
            }
            if d.custom.focused {
                return Some(&d.custom);
            }
        }
    }
    None
}

pub struct Handle {
    connection: Option<codenomad_client::http::Http>,
    workspace_id: Option<String>,
    jobs: Sender<Job>,
    permissions: Sender<PendingJob>,
    forms: Sender<PendingJob>,
    catalog: Sender<(String, u64)>,
    stop: Sender<()>,
    results: Receiver<Result>,
}
#[cfg(test)]
impl Handle {
    fn test(jobs: Sender<Job>, stop: Sender<()>, results: Receiver<Result>) -> Self {
        let (permissions, _) = bounded(1);
        let (forms, _) = bounded(1);
        let (catalog, _) = bounded(1);
        Self {
            connection: None,
            workspace_id: None,
            jobs,
            permissions,
            forms,
            catalog,
            stop,
            results,
        }
    }
}
impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SessionControls")
    }
}
pub struct Ui {
    handle: Handle,
    pub models: Vec<Model>,
    pub current: Option<serde_json::Value>,
    pub usage: Option<crate::content::Usage>,
    pub directory: Option<String>,
    model_generation: u64,
    confirmed_model_generation: u64,
    pub permissions: Vec<Permission>,
    pub forms: Vec<Form>,
    pub drafts: Drafts,
    pub reasons: std::collections::HashMap<String, TextEdit>,
    pub selected: String,
    pub picker: bool,
    pub search: TextEdit,
    pub busy: bool,
    pub stopping: bool,
    pub error: bool,
    session_error: bool,
    catalog_error: bool,
    stop_error: bool,
    pub known: bool,
    pub running: bool,
    pub pending_known: bool,
    pub online: bool,
    scope_missing: bool,
    pub(crate) attention: crate::shell::notifications::Attention,
    reading: bool,
    catalog_reading: bool,
    catalog_generation: u64,
    catalog_directory: Option<String>,
    models_directory: Option<String>,
    permissions_lane: RequestLane,
    forms_lane: RequestLane,
    pending_deferred_submission: Option<Box<PendingDeferredSubmission>>,
    pending_field_rejection: Option<Box<PendingFieldRejection>>,
    activity_during_job: bool,
    usage_during_job: bool,
    trailing: Option<bool>,
    catalog_trailing: Option<String>,
}

struct PendingDeferredSubmission {
    form_id: String,
    submitted_fields: Vec<serde_json::Value>,
    deferred_fields: Vec<(String, serde_json::Value)>,
}

struct PendingFieldRejection {
    form_id: String,
    submitted_fields: Vec<serde_json::Value>,
    to_mark: Vec<(String, serde_json::Value)>,
}
fn extract_field_key_from_message(message: &str, valid_keys: &[&str]) -> Option<String> {
    // OpenCode form validation messages end with `: <field_key>` (e.g.
    // `Form field does not match pattern: code` or `...: code.`). Match only the exact key
    // after `: ` without stripping punctuation or whitespace.
    let mut search = message;
    let mut matched: Option<&str> = None;
    while let Some((_, tail)) = search.split_once(": ") {
        if let Some(&key) = valid_keys.iter().find(|&&k| k == tail)
            && matched.is_none_or(|prev| key.len() > prev.len())
        {
            matched = Some(key);
        }
        search = tail;
    }
    matched.map(str::to_string)
}

fn collect_structured_field_keys(
    value: &serde_json::Value,
    valid_keys: &[&str],
    out: &mut Vec<String>,
) {
    fn push_key(raw: &str, valid_keys: &[&str], out: &mut Vec<String>) {
        if valid_keys.contains(&raw) && !out.iter().any(|existing| existing == raw) {
            out.push(raw.to_string());
        }
    }
    if let Some(obj) = value.as_object() {
        for prop in ["field", "key"] {
            if let Some(k) = obj.get(prop).and_then(serde_json::Value::as_str) {
                push_key(k, valid_keys, out);
            }
        }
        if let Some(path) = obj.get("path").and_then(serde_json::Value::as_array)
            && let Some(last) = path.last().and_then(serde_json::Value::as_str)
        {
            push_key(last, valid_keys, out);
        }
        for map_key in ["fields", "fieldErrors"] {
            if let Some(map) = obj.get(map_key).and_then(serde_json::Value::as_object) {
                for k in map.keys() {
                    push_key(k, valid_keys, out);
                }
            }
        }
        for arr_key in ["issues", "errors", "details"] {
            if let Some(arr) = obj.get(arr_key).and_then(serde_json::Value::as_array) {
                for item in arr {
                    collect_structured_field_keys(item, valid_keys, out);
                }
            }
        }
        for nested in ["error", "data"] {
            if let Some(child) = obj.get(nested) {
                if child.is_object() {
                    collect_structured_field_keys(child, valid_keys, out);
                } else if let Some(msg) = child.as_str()
                    && let Some(k) = extract_field_key_from_message(msg, valid_keys)
                {
                    push_key(&k, valid_keys, out);
                }
            }
        }
        if let Some(msg) = obj.get("message").and_then(serde_json::Value::as_str)
            && let Some(k) = extract_field_key_from_message(msg, valid_keys)
        {
            push_key(&k, valid_keys, out);
        }
    }
}

fn extract_rejected_field_keys(body: &str, valid_keys: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(body) {
        collect_structured_field_keys(&json, valid_keys, &mut out);
        if !out.is_empty() {
            return out;
        }
        if let Some(s) = json.as_str()
            && let Some(k) = extract_field_key_from_message(s, valid_keys)
        {
            out.push(k);
            return out;
        }
        return out;
    }
    if let Some(k) = extract_field_key_from_message(body, valid_keys) {
        out.push(k);
    }
    out
}

pub fn start(backend: Backend, wake: rune::Waker) -> Handle {
    let (jobs, rx) = bounded(1);
    let (permissions, prx) = bounded(1);
    let (forms, frx) = bounded(1);
    let (catalog, crx) = bounded::<(String, u64)>(1);
    let (stop, srx) = bounded(1);
    let (out, results) = bounded(16);
    let connection = Some(backend.client.clone());
    let workspace_id = Some(backend.workspace.clone());
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while srx.recv().await.is_ok() {
            if o.send(Result::Stop(b.interrupt().await.is_ok()))
                .await
                .is_err()
            {
                break;
            }
            w();
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok(job) = prx.recv().await {
            let result = match job {
                PendingJob::Read(generation) => {
                    Result::Permissions(b.permissions_snapshot().await, generation)
                }
                PendingJob::Act(action, generation) => {
                    let ok = b.agent_action(&action).await.is_ok();
                    Result::ActPermission(ok, b.permissions_snapshot().await, generation)
                }
            };
            if o.send(result).await.is_err() {
                break;
            }
            w();
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok(job) = frx.recv().await {
            match job {
                PendingJob::Read(generation) => {
                    if o.send(Result::Forms(b.forms_snapshot().await, generation))
                        .await
                        .is_err()
                    {
                        break;
                    }
                    w();
                }
                PendingJob::Act(action, generation) => {
                    let outcome = b.agent_form_action(&action).await;
                    if matches!(outcome, crate::agent_api::FormReplyOutcome::Ok) {
                        let snapshot = b.forms_snapshot().await;
                        if o.send(Result::ActForm(outcome, snapshot, generation))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        w();
                    } else {
                        if o.send(Result::ActFormOutcome(outcome, generation))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        w();
                        let snapshot = b.forms_snapshot().await;
                        if o.send(Result::ActFormSnapshot(snapshot, generation))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        w();
                    }
                }
            }
        }
    });
    let b = backend.clone();
    let w = wake.clone();
    let o = out.clone();
    crate::platform::spawn(async move {
        while let Ok((directory, generation)) = crx.recv().await {
            let models = b.model_catalog(&directory).await;
            if o.send(Result::Catalog(models, directory, generation))
                .await
                .is_err()
            {
                break;
            }
            w();
        }
    });
    crate::platform::spawn(async move {
        while let Ok(job) = rx.recv().await {
            let result = match job {
                Job::Read(catalog, generation) => {
                    let (snapshot, catalog_dir) = backend.session_snapshot().await;
                    Result::Session(snapshot, catalog_dir, catalog, generation)
                }
                Job::Act(action, generation) => match action {
                    Action::Model(reference) => match backend.apply_model(&reference).await {
                        Ok((snapshot, catalog_dir)) => {
                            Result::Act(true, snapshot, catalog_dir, generation)
                        }
                        Err(_) => {
                            let (snapshot, catalog_dir) = backend.session_snapshot().await;
                            Result::Act(false, snapshot, catalog_dir, generation)
                        }
                    },
                    other => {
                        let ok = backend.agent_action(&other).await.is_ok();
                        let (snapshot, catalog_dir) = backend.session_snapshot().await;
                        Result::Act(ok, snapshot, catalog_dir, generation)
                    }
                },
                Job::VerifyIdle(id, directory) => {
                    Result::VerifiedIdle(id, backend.session_inactive_at(&directory).await)
                }
            };
            if out.send(result).await.is_err() {
                break;
            }
            wake();
        }
    });
    Handle {
        connection,
        workspace_id,
        jobs,
        permissions,
        forms,
        catalog,
        stop,
        results,
    }
}
impl Ui {
    pub(crate) fn includes_cost(&self, provider: &str, id: &str) -> bool {
        self.models.iter().any(|model| {
            model.included
                && model.reference["providerID"] == provider
                && model.reference["id"] == id
        })
    }

    fn sync_error(&mut self) {
        self.error = self.session_error
            || self.permissions_lane.error
            || self.forms_lane.error
            || self.catalog_error
            || self.stop_error;
    }

    fn sync_pending_known(&mut self) {
        self.pending_known = self.permissions_lane.known && self.forms_lane.known;
    }

    pub(crate) fn mark_offline(&mut self) {
        self.online = false;
        self.permissions_lane.known = false;
        self.forms_lane.known = false;
        self.sync_pending_known();
    }

    pub(crate) fn is_scope_missing(&self) -> bool {
        self.scope_missing
    }

    pub(crate) fn mark_scope_missing(&mut self) {
        self.scope_missing = true;
        self.online = false;
        self.known = false;
        self.trailing = None;
        self.catalog_trailing = None;
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        self.session_error = false;
        self.catalog_error = false;
        self.stop_error = false;
        self.permissions_lane.bump();
        self.permissions_lane.known = false;
        self.permissions_lane.reconciling = false;
        self.permissions_lane.trailing = false;
        self.permissions_lane.error = false;
        self.forms_lane.bump();
        self.forms_lane.known = false;
        self.forms_lane.reconciling = false;
        self.forms_lane.trailing = false;
        self.forms_lane.error = false;
        self.pending_deferred_submission = None;
        self.pending_field_rejection = None;
        self.attention.disconnected();
        self.sync_error();
        self.sync_pending_known();
    }

    pub(crate) fn workspace_stopped(&mut self, workspace_id: &str) -> bool {
        if self.handle.workspace_id.as_deref() == Some(workspace_id) {
            self.mark_scope_missing();
            true
        } else {
            false
        }
    }

    #[cfg(test)]
    pub(crate) fn mark_pending_known(&mut self) {
        self.permissions_lane.known = true;
        self.forms_lane.known = true;
        self.sync_pending_known();
    }

    pub fn rebind(&mut self, handle: Handle) {
        self.handle = handle;
        self.models.clear();
        self.models_directory = None;
        self.current = None;
        self.directory = None;
        self.reading = false;
        self.catalog_reading = false;
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        self.catalog_directory = None;
        self.permissions_lane.reset();
        self.forms_lane.reset();
        self.pending_deferred_submission = None;
        self.pending_field_rejection = None;
        self.activity_during_job = false;
        self.usage_during_job = false;
        self.trailing = None;
        self.catalog_trailing = None;
        self.busy = false;
        self.stopping = false;
        self.session_error = false;
        self.catalog_error = false;
        self.stop_error = false;
        self.sync_error();
        self.running = false;
        self.known = false;
        self.sync_pending_known();
        self.online = false;
        self.scope_missing = false;
        self.refresh(true);
    }
    pub(crate) fn uses_connection(&self, backend: &Backend) -> bool {
        self.handle
            .connection
            .as_ref()
            .is_none_or(|previous| previous.same_connection(&backend.client))
    }

    pub(crate) fn reauthenticate(&mut self, handle: Handle) {
        let mut replacement = Self::new(handle);
        replacement.drafts = std::mem::take(&mut self.drafts);
        replacement.reasons = std::mem::take(&mut self.reasons);
        replacement.attention = std::mem::take(&mut self.attention);
        *self = replacement;
    }

    pub fn navigation_blocked(&self) -> bool {
        if self.scope_missing {
            return false;
        }
        self.busy
            || self.permissions_lane.mutation_pending()
            || self.forms_lane.mutation_pending()
            || self.stopping
            || self.has_unsaved_form_drafts()
    }
    pub(crate) fn has_unsaved_form_drafts(&self) -> bool {
        self.drafts.values().any(agent_forms::Draft::is_dirty)
            || self.reasons.values().any(|d| !d.text.is_empty())
    }
    pub fn toggle_picker(&mut self) {
        self.picker = !self.picker;
        if self.picker {
            self.refresh(true)
        }
    }
    pub fn refresh_controls(&mut self) {
        self.session_error = false;
        self.permissions_lane.error = false;
        self.forms_lane.error = false;
        self.catalog_error = false;
        self.stop_error = false;
        self.sync_error();
        self.refresh(true)
    }
    pub fn choose_model(&mut self, reference: serde_json::Value) {
        if self.model_locked() || !self.models.iter().any(|model| model.reference == reference) {
            return;
        }
        self.act(Action::Model(reference));
        self.picker = false;
    }
    pub fn select_request(&mut self, id: String) {
        if self.permissions.iter().any(|p| p.id == id) || self.forms.iter().any(|f| f.id == id) {
            self.selected = id;
        }
    }
    pub fn reply_permission(&mut self, id: String, decision: &str) {
        if !self.permissions.iter().any(|p| p.id == id && p.supported) {
            return;
        }
        let message = self
            .reasons
            .get(&id)
            .map(|v| v.text.clone())
            .unwrap_or_default();
        self.act(Action::Permission(id, decision.into(), message))
    }
    pub fn answer_form(&mut self, id: &str) {
        self.reconcile_custom_focus();
        if let Some(form) = self.forms.iter().find(|f| f.id == id) {
            if let Ok((answer, deferred)) = agent_forms::answer_with_deferred(form, &self.drafts) {
                let fields = form.fields.clone();
                if !self.forms_locked() {
                    self.pending_field_rejection = None;
                    self.pending_deferred_submission = (!deferred.is_empty()).then(|| {
                        Box::new(PendingDeferredSubmission {
                            form_id: id.to_string(),
                            submitted_fields: fields.clone(),
                            deferred_fields: deferred,
                        })
                    });
                }
                self.act(Action::Answer(id.into(), answer, fields))
            }
        }
    }
    pub fn cancel_form(&mut self, id: String) {
        if self.forms.iter().any(|f| f.id == id) {
            self.pending_deferred_submission = None;
            self.pending_field_rejection = None;
            self.act(Action::Cancel(id));
        }
    }
    pub(crate) fn reconcile_custom_focus(&mut self) -> bool {
        let mut changed = false;
        for form in &self.forms {
            for field in &form.fields {
                if field["type"] != "multiselect" || field["custom"] != true {
                    continue;
                }
                let Some(key) = field["key"].as_str() else {
                    continue;
                };
                let Some(draft) = self.drafts.get_mut(&(form.id.clone(), key.to_string())) else {
                    continue;
                };
                if draft.custom.focused {
                    draft.custom_was_focused = true;
                } else if draft.custom_was_focused {
                    let options = agent_forms::normalized_options(field);
                    if draft.reconcile_committed_multiselect_custom(&options) {
                        changed = true;
                    }
                }
            }
        }
        changed
    }
    fn clear_form_editor_focus(&mut self) {
        for draft in self.drafts.values_mut() {
            draft.edit.focused = false;
            draft.custom.focused = false;
            draft.custom_was_focused = false;
        }
    }
    pub fn idle(&self) -> bool {
        !self.reading
            && !self.busy
            && self.permissions_lane.idle()
            && self.forms_lane.idle()
            && !self.catalog_reading
            && !self.stopping
            && self.trailing.is_none()
            && self.catalog_trailing.is_none()
    }
    #[cfg(test)]
    pub(crate) fn fixture_ready(&mut self) {
        self.reading = false;
        self.known = true;
        self.pending_known = true;
        self.online = true;
    }
    pub fn new(handle: Handle) -> Self {
        let mut ui = Self {
            handle,
            models: vec![],
            current: None,
            usage: None,
            directory: None,
            model_generation: 0,
            confirmed_model_generation: 0,
            permissions: vec![],
            forms: vec![],
            drafts: Default::default(),
            reasons: Default::default(),
            selected: String::new(),
            picker: false,
            search: TextEdit::new(""),
            busy: false,
            stopping: false,
            error: false,
            session_error: false,
            catalog_error: false,
            stop_error: false,
            known: false,
            running: false,
            pending_known: false,
            online: false,
            scope_missing: false,
            attention: Default::default(),
            reading: false,
            catalog_reading: false,
            catalog_generation: 0,
            catalog_directory: None,
            models_directory: None,
            permissions_lane: RequestLane::default(),
            forms_lane: RequestLane::default(),
            pending_deferred_submission: None,
            pending_field_rejection: None,
            activity_during_job: false,
            usage_during_job: false,
            trailing: None,
            catalog_trailing: None,
        };
        ui.refresh(true);
        ui
    }
    pub fn refresh(&mut self, catalog: bool) {
        self.refresh_session(catalog);
        self.refresh_permissions();
        self.refresh_forms();
    }
    pub(crate) fn refresh_session(&mut self, catalog: bool) {
        if self.scope_missing {
            return;
        }
        if self.reading || self.busy {
            self.trailing = Some(self.trailing.unwrap_or(false) || catalog);
            return;
        }
        if self
            .handle
            .jobs
            .try_send(Job::Read(catalog, self.model_generation))
            .is_ok()
        {
            self.reading = true
        }
    }
    fn dispatch_permissions_read(&mut self, generation: u64) {
        if self
            .handle
            .permissions
            .try_send(PendingJob::Read(generation))
            .is_ok()
        {
            self.permissions_lane.reading = true;
            self.permissions_lane.hint_during_job = false;
        }
    }
    pub(crate) fn refresh_permissions(&mut self) {
        if self.scope_missing {
            return;
        }
        let generation = self.permissions_lane.bump();
        self.attention.invalidate_kind(0);
        if self.permissions_lane.reading || self.permissions_lane.busy {
            self.permissions_lane.trailing = true;
            return;
        }
        self.dispatch_permissions_read(generation);
    }
    fn dispatch_forms_read(&mut self, generation: u64) {
        if self
            .handle
            .forms
            .try_send(PendingJob::Read(generation))
            .is_ok()
        {
            self.forms_lane.reading = true;
            self.forms_lane.hint_during_job = false;
        }
    }
    pub(crate) fn refresh_forms(&mut self) {
        if self.scope_missing {
            return;
        }
        let generation = self.forms_lane.bump();
        self.attention.invalidate_kind(1);
        if self.forms_lane.reading || self.forms_lane.busy {
            self.forms_lane.trailing = true;
            return;
        }
        self.dispatch_forms_read(generation);
    }
    fn dispatch_catalog_read(&mut self, directory: String, generation: u64) {
        if self
            .handle
            .catalog
            .try_send((directory, generation))
            .is_ok()
        {
            self.catalog_reading = true;
        }
    }
    fn refresh_catalog(&mut self, directory: String) {
        self.catalog_generation = self.catalog_generation.wrapping_add(1);
        self.catalog_directory = Some(directory.clone());
        if self.catalog_reading {
            self.catalog_trailing = Some(directory);
            return;
        }
        self.dispatch_catalog_read(directory, self.catalog_generation);
    }
    fn sync_catalog_scope(
        &mut self,
        session_known: bool,
        catalog_dir: Option<String>,
        force_refresh: bool,
    ) {
        if !session_known {
            if force_refresh {
                self.catalog_error = true;
                self.sync_error();
            }
            return;
        }
        let dir_changed = self.catalog_directory != catalog_dir;
        if dir_changed {
            self.models.clear();
            self.models_directory = None;
            self.catalog_generation = self.catalog_generation.wrapping_add(1);
            self.catalog_trailing = None;
            self.catalog_directory = catalog_dir.clone();
        }
        if let Some(dir) = catalog_dir {
            if force_refresh || dir_changed {
                self.refresh_catalog(dir);
            }
        } else if force_refresh {
            self.catalog_error = true;
            self.sync_error();
        }
    }

    pub(crate) fn refresh_usage_model(&mut self, generation: u64) {
        if generation != self.model_generation {
            self.model_generation = generation;
            self.refresh_session(false);
        }
    }

    pub(crate) fn usage_model(&self, generation: u64) -> Option<(&str, &serde_json::Value)> {
        (generation == self.confirmed_model_generation).then_some(())?;
        self.directory.as_deref().zip(self.current.as_ref())
    }

    pub(crate) fn observe_running(&mut self, running: bool) {
        let refresh = !self.known || self.running != running;
        self.running = running;
        self.activity_during_job |= self.reading || self.busy;
        if refresh {
            self.refresh_session(false);
        }
    }

    pub(crate) fn observe_usage(&mut self, usage: crate::content::Usage) {
        self.usage = Some(usage);
        self.usage_during_job |= self.reading || self.busy;
    }
    pub fn act(&mut self, action: Action) {
        match action {
            Action::Model(_) => {
                if self.model_locked() {
                    return;
                }
                if self
                    .handle
                    .jobs
                    .try_send(Job::Act(action, self.model_generation))
                    .is_ok()
                {
                    self.busy = true;
                    self.session_error = false;
                    self.sync_error();
                }
            }
            Action::Permission(_, _, _) => {
                if self.permissions_locked() {
                    return;
                }
                let generation = self.permissions_lane.bump();
                if self
                    .handle
                    .permissions
                    .try_send(PendingJob::Act(action, generation))
                    .is_ok()
                {
                    self.attention.invalidate_kind(0);
                    self.permissions_lane.busy = true;
                    self.permissions_lane.hint_during_job = false;
                    self.permissions_lane.error = false;
                    self.sync_error();
                }
            }
            Action::Answer(_, _, _) | Action::Cancel(_) => {
                if self.forms_locked() {
                    return;
                }
                let generation = self.forms_lane.bump();
                if self
                    .handle
                    .forms
                    .try_send(PendingJob::Act(action, generation))
                    .is_ok()
                {
                    self.attention.invalidate_kind(1);
                    self.clear_form_editor_focus();
                    self.forms_lane.busy = true;
                    self.forms_lane.hint_during_job = false;
                    self.forms_lane.error = false;
                    self.sync_error();
                } else {
                    self.pending_deferred_submission = None;
                }
            }
        }
    }
    pub fn stop(&mut self) {
        if !self.scope_missing && !self.stopping && self.handle.stop.try_send(()).is_ok() {
            self.stopping = true;
            self.stop_error = false;
            self.sync_error();
        }
    }
    pub fn blocked(&self) -> bool {
        self.blocks_prompt(false)
    }
    pub(crate) fn blocks_prompt(&self, stream_disconnected: bool) -> bool {
        self.scope_missing
            || self.busy
            || self.permissions_lane.mutation_pending()
            || self.forms_lane.mutation_pending()
            || !self.known
            || (!self.online && !stream_disconnected)
            || self.stopping
    }
    pub fn model_locked(&self) -> bool {
        self.scope_missing
            || self.busy
            || self.reading
            || self.catalog_reading
            || !self.online
            || self.models_directory != self.catalog_directory
    }
    pub fn permissions_locked(&self) -> bool {
        self.scope_missing || self.permissions_lane.locked(self.online)
    }
    pub fn forms_locked(&self) -> bool {
        self.scope_missing || self.forms_lane.locked(self.online)
    }
    /// True only while a form reply/cancel POST is actively in flight. Draft editing remains
    /// available once the POST finishes even if post-reply reconciliation is still pending, while
    /// Answer/Cancel stay gated by `forms_locked()`.
    pub fn forms_mutating(&self) -> bool {
        self.forms_lane.busy
    }
    pub fn ids(&self) -> Vec<String> {
        self.permissions
            .iter()
            .map(|p| p.id.clone())
            .chain(self.forms.iter().map(|p| p.id.clone()))
            .collect()
    }
    pub(crate) fn notice_request(&mut self, form: bool, id: String) {
        self.attention.request(form, id);
        if form {
            self.forms_lane.hint_during_job |= self.forms_lane.reading || self.forms_lane.busy;
            self.refresh_forms();
        } else {
            self.permissions_lane.hint_during_job |=
                self.permissions_lane.reading || self.permissions_lane.busy;
            self.refresh_permissions();
        }
        if !self.known {
            self.refresh_session(false);
        }
    }

    pub(crate) fn resolve_request(&mut self, form: bool, id: &str) {
        self.attention.resolve_request(form, id);
        if form {
            self.refresh_forms();
        } else {
            self.refresh_permissions();
        }
    }

    fn apply_session(&mut self, s: Snapshot, generation: u64) {
        let current_activity = !std::mem::take(&mut self.activity_during_job);
        let current_usage = !std::mem::take(&mut self.usage_during_job);
        if self.online {
            self.attention
                .observe_session(s.session_known, s.root_directory.as_deref());
        }
        self.known = s.session_known;
        if generation == self.model_generation {
            self.directory = s.directory;
            if s.session_known {
                self.current = s.current;
                self.confirmed_model_generation = generation;
            }
        }
        if s.session_known {
            if current_usage {
                self.usage = s.usage;
            }
            if current_activity {
                self.running = s.running;
            }
        }
        if let Some(models) = s.models {
            self.models = models;
            self.models_directory = self.catalog_directory.clone();
        }
    }

    fn reconcile_selected(&mut self) {
        let ids = self.ids();
        if !ids.contains(&self.selected) {
            self.selected = ids.first().cloned().unwrap_or_default();
        }
    }

    fn apply_permissions(&mut self, permissions: Option<Vec<Permission>>) {
        let current_requests = !std::mem::take(&mut self.permissions_lane.hint_during_job);
        self.permissions_lane.known = permissions.is_some();
        self.sync_pending_known();
        if let Some(permissions) = permissions {
            if self.online {
                self.attention.observe_kind(
                    0,
                    permissions.iter().map(|p| p.id.clone()),
                    current_requests,
                );
            }
            self.permissions = permissions;
            self.reasons
                .retain(|k, _| self.permissions.iter().any(|p| p.id == *k));
            for p in &self.permissions {
                self.reasons
                    .entry(p.id.clone())
                    .or_insert_with(|| TextEdit::new(""));
            }
        }
        self.reconcile_selected();
    }

    fn apply_forms(&mut self, forms: Option<Vec<Form>>) {
        let current_requests = !std::mem::take(&mut self.forms_lane.hint_during_job);
        self.forms_lane.known = forms.is_some();
        self.sync_pending_known();
        if let Some(forms) = forms {
            if self.online {
                self.attention.observe_kind(
                    1,
                    forms.iter().map(|f| f.id.clone()),
                    current_requests,
                );
            }
            self.forms = forms;
            agent_forms::seed(&self.forms, &mut self.drafts);
            if let Some(rejection) = self.pending_field_rejection.take() {
                if self
                    .forms
                    .iter()
                    .any(|f| f.id == rejection.form_id && f.fields == rejection.submitted_fields)
                {
                    for (field_key, submitted_value) in rejection.to_mark {
                        if let Some(field_schema) = rejection
                            .submitted_fields
                            .iter()
                            .find(|f| f["key"].as_str() == Some(field_key.as_str()))
                            && let Some(draft) =
                                self.drafts.get_mut(&(rejection.form_id.clone(), field_key))
                        {
                            draft.set_server_rejected(field_schema.clone(), submitted_value);
                        }
                    }
                } else {
                    for (field_key, submitted_value) in rejection.to_mark {
                        if let Some(draft) =
                            self.drafts.get_mut(&(rejection.form_id.clone(), field_key))
                            && draft.server_rejected_value.as_ref() == Some(&submitted_value)
                        {
                            draft.clear_server_rejected();
                        }
                    }
                }
            }
        }
        self.reconcile_selected();
    }

    fn handle_act_form_outcome(&mut self, outcome: crate::agent_api::FormReplyOutcome) {
        self.forms_lane.busy = false;
        self.forms_lane.reading = true;
        self.clear_form_editor_focus();
        let submitted_deferred = self.pending_deferred_submission.take();
        let ok = matches!(outcome, crate::agent_api::FormReplyOutcome::Ok);
        if self.scope_missing {
            self.forms_lane.reconciling = false;
            self.pending_field_rejection = None;
            return;
        }
        if let crate::agent_api::FormReplyOutcome::ValidationRejected(ref detail) = outcome
            && let Some(submitted) = submitted_deferred
        {
            let PendingDeferredSubmission {
                form_id,
                submitted_fields,
                deferred_fields,
            } = *submitted;
            let all_keys: Vec<&str> = submitted_fields
                .iter()
                .filter_map(|f| f["key"].as_str())
                .collect();
            let rejected_keys = detail
                .as_deref()
                .map(|body| extract_rejected_field_keys(body, &all_keys))
                .unwrap_or_default();
            let to_mark: Vec<(String, serde_json::Value)> = if !rejected_keys.is_empty() {
                deferred_fields
                    .into_iter()
                    .filter(|(k, _)| rejected_keys.iter().any(|r| r == k))
                    .collect()
            } else {
                Vec::new()
            };
            if !to_mark.is_empty() {
                if self
                    .forms
                    .iter()
                    .any(|f| f.id == form_id && f.fields == submitted_fields)
                {
                    for (field_key, submitted_value) in &to_mark {
                        if let Some(field_schema) = submitted_fields
                            .iter()
                            .find(|f| f["key"].as_str() == Some(field_key.as_str()))
                            && let Some(draft) =
                                self.drafts.get_mut(&(form_id.clone(), field_key.clone()))
                        {
                            draft
                                .set_server_rejected(field_schema.clone(), submitted_value.clone());
                        }
                    }
                }
                self.pending_field_rejection = Some(Box::new(PendingFieldRejection {
                    form_id,
                    submitted_fields,
                    to_mark,
                }));
            }
        }
        self.forms_lane.error = !ok;
        self.forms_lane.reconciling = true;
        self.sync_error();
    }

    fn handle_act_form_snapshot(&mut self, forms: Option<Vec<Form>>, generation: u64) {
        self.forms_lane.reading = false;
        if self.scope_missing {
            self.forms_lane.reconciling = false;
            return;
        }
        let fresh = generation == self.forms_lane.generation;
        self.forms_lane.error |= fresh && forms.is_none();
        self.sync_error();
        if fresh {
            self.forms_lane.reconciling = forms.is_none();
            self.apply_forms(forms);
        } else {
            self.forms_lane.reconciling = true;
            self.forms_lane.trailing = true;
        }
    }

    #[cfg(test)]
    fn snapshot(&mut self, mut s: Snapshot, generation: u64) {
        let permissions = s.permissions.take();
        let forms = s.forms.take();
        self.apply_session(s, generation);
        self.apply_permissions(permissions);
        self.apply_forms(forms);
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        while let Ok(result) = self.handle.results.try_recv() {
            match result {
                #[cfg(test)]
                Result::Read(s, catalog, generation) => {
                    self.reading = false;
                    self.permissions_lane.reading = false;
                    self.forms_lane.reading = false;
                    self.session_error |= !s.session_known;
                    self.permissions_lane.error |= s.permissions.is_none();
                    self.forms_lane.error |= s.forms.is_none();
                    self.catalog_error |= catalog && s.models.is_none();
                    self.sync_error();
                    self.snapshot(s, generation)
                }
                Result::Session(s, catalog_dir, catalog, generation) => {
                    self.reading = false;
                    if !self.scope_missing {
                        let session_known = s.session_known;
                        self.session_error |= !session_known;
                        self.sync_error();
                        self.apply_session(s, generation);
                        self.sync_catalog_scope(session_known, catalog_dir, catalog);
                    }
                }
                Result::Permissions(permissions, generation) => {
                    self.permissions_lane.reading = false;
                    if !self.scope_missing && generation == self.permissions_lane.generation {
                        if permissions.is_some() {
                            self.permissions_lane.reconciling = false;
                        }
                        self.permissions_lane.error |= permissions.is_none();
                        self.sync_error();
                        self.apply_permissions(permissions);
                    }
                }
                Result::Forms(forms, generation) => {
                    self.forms_lane.reading = false;
                    if !self.scope_missing && generation == self.forms_lane.generation {
                        if forms.is_some() {
                            self.forms_lane.reconciling = false;
                        }
                        self.forms_lane.error |= forms.is_none();
                        self.sync_error();
                        self.apply_forms(forms);
                    }
                }
                Result::Catalog(models, directory, generation) => {
                    self.catalog_reading = false;
                    if !self.scope_missing
                        && generation == self.catalog_generation
                        && self.catalog_directory.as_deref() == Some(directory.as_str())
                    {
                        self.catalog_error = models.is_none();
                        self.sync_error();
                        if let Some(models) = models {
                            self.models = models;
                            self.models_directory = Some(directory);
                        }
                    }
                }
                Result::Act(ok, s, catalog_dir, generation) => {
                    self.busy = false;
                    if !self.scope_missing {
                        let session_known = s.session_known;
                        self.session_error = !ok || !session_known;
                        self.sync_error();
                        self.apply_session(s, generation);
                        self.sync_catalog_scope(session_known, catalog_dir, false);
                    }
                }
                Result::ActPermission(ok, permissions, generation) => {
                    self.permissions_lane.busy = false;
                    if self.scope_missing {
                        self.permissions_lane.reconciling = false;
                    } else {
                        let fresh = generation == self.permissions_lane.generation;
                        self.permissions_lane.error = !ok || (fresh && permissions.is_none());
                        self.sync_error();
                        if fresh {
                            self.permissions_lane.reconciling = permissions.is_none();
                            self.apply_permissions(permissions);
                        } else {
                            self.permissions_lane.reconciling = true;
                            self.permissions_lane.trailing = true;
                        }
                    }
                }
                Result::ActForm(outcome, forms, generation) => {
                    self.handle_act_form_outcome(outcome);
                    self.handle_act_form_snapshot(forms, generation);
                }
                Result::ActFormOutcome(outcome, _generation) => {
                    self.handle_act_form_outcome(outcome);
                }
                Result::ActFormSnapshot(forms, generation) => {
                    self.handle_act_form_snapshot(forms, generation);
                }
                Result::Stop(ok) => {
                    self.stopping = false;
                    if !self.scope_missing {
                        self.stop_error = !ok;
                        self.sync_error();
                        self.refresh(false)
                    }
                }
                Result::VerifiedIdle(idle, inactive) => {
                    if !self.scope_missing {
                        self.attention
                            .confirm_idle(idle, inactive && self.online && !self.running);
                    }
                }
            }
            changed = true;
        }
        if !self.scope_missing {
            if !self.reading && !self.busy {
                if let Some(catalog) = self.trailing.take() {
                    self.refresh_session(catalog)
                } else if let Some((id, directory)) = self.attention.verify_idle() {
                    let _ = self.handle.jobs.try_send(Job::VerifyIdle(id, directory));
                }
            }
            if !self.permissions_lane.reading
                && !self.permissions_lane.busy
                && std::mem::take(&mut self.permissions_lane.trailing)
            {
                self.dispatch_permissions_read(self.permissions_lane.generation);
            }
            if !self.forms_lane.reading
                && !self.forms_lane.busy
                && std::mem::take(&mut self.forms_lane.trailing)
            {
                self.dispatch_forms_read(self.forms_lane.generation);
            }
            if !self.catalog_reading
                && let Some(directory) = self.catalog_trailing.take()
            {
                self.dispatch_catalog_read(directory, self.catalog_generation);
            }
        }
        changed
    }
}
