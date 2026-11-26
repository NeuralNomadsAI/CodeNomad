//! State machine, async orchestration, and main view for Preferences -> Providers (Models).
use super::{Catalog, Target, accounts, form, modal};
use crate::{backend::Backend, platform, settings::ExternalLink, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::provider_auth::{
        self, AccountSelection, AttemptPoll, AuthError, AuthMethod, CatalogSnapshot,
        ListedProvider, OAuthAttempt, OAuthMode, build_form_answer, initial_form_answers,
        is_field_complete, is_http_url,
    },
};
use rune::{El, TextEdit, Tx, Waker, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const POLL_INTERVAL_S: f64 = 1.0;
const MAX_RENAME_LEN: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum PickerId {
    ConnectProvider,
    AuthMethod,
    FormField(String),
    Account(String),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AuthStage {
    Prompts,
    Authorizing,
    Code,
    Waiting,
    Error,
}

#[derive(Clone, Debug)]
pub(super) enum ErrorCopy {
    Key(&'static str),
    Raw(String),
}

impl ErrorCopy {
    pub(super) fn as_str(&self) -> &str {
        match self {
            Self::Key(key) => t(key),
            Self::Raw(msg) => msg.as_str(),
        }
    }
}

#[derive(Clone, Debug)]
pub(super) enum AccountAction {
    Activate {
        integration_id: String,
        credential_id: String,
    },
    Rename {
        integration_id: String,
        credential_id: String,
        label: String,
        edit_revision: u64,
    },
    Remove {
        integration_id: String,
        credential_id: String,
    },
    AutoSelect {
        integration_id: String,
        enabled: bool,
    },
}

impl AccountAction {
    fn integration_id(&self) -> &str {
        match self {
            Self::Activate { integration_id, .. }
            | Self::Rename { integration_id, .. }
            | Self::Remove { integration_id, .. }
            | Self::AutoSelect { integration_id, .. } => integration_id,
        }
    }
}

pub(super) struct RenameDraft {
    pub text: TextEdit,
    pub dirty: bool,
    pub editing: bool,
    pub revision: u64,
}

pub(super) struct ConnectFlow {
    pub provider_id: String,
    pub method_index: usize,
    pub stage: AuthStage,
    pub api_key: TextEdit,
    pub oauth_code: TextEdit,
    pub form_answers: BTreeMap<String, Value>,
    pub form_edits: BTreeMap<String, TextEdit>,
    pub oauth: Option<OAuthAttempt>,
    pub command_attempt: Option<String>,
    pub command_status: Option<String>,
    pub error: Option<ErrorCopy>,
    pub launch_blocked: bool,
    pub link_copied: bool,
    pub return_focus: Option<String>,
    pending_submit: bool,
    pending_code_submit: bool,
    pending_url_launch: bool,
    next_poll_at: Option<f64>,
    operation_seq: u64,
    active_directory: Option<String>,
    active_workspace: Option<String>,
    active_backend: Option<Backend>,
}

impl ConnectFlow {
    fn new(
        provider_id: String,
        methods: &[AuthMethod],
        return_focus: Option<String>,
        seq: u64,
    ) -> Self {
        let form_fields = methods.first().map(AuthMethod::form).unwrap_or(&[]);
        let form_answers = initial_form_answers(form_fields);
        let form_edits = seed_form_edits(form_fields, &form_answers);
        Self {
            provider_id,
            method_index: 0,
            stage: AuthStage::Prompts,
            api_key: TextEdit::new(""),
            oauth_code: TextEdit::new(""),
            form_answers,
            form_edits,
            oauth: None,
            command_attempt: None,
            command_status: None,
            error: None,
            launch_blocked: false,
            link_copied: false,
            return_focus,
            pending_submit: false,
            pending_code_submit: false,
            pending_url_launch: false,
            next_poll_at: None,
            operation_seq: seq,
            active_directory: None,
            active_workspace: None,
            active_backend: None,
        }
    }

    fn wipe_secrets(&mut self) {
        self.api_key = TextEdit::new("");
        self.oauth_code = TextEdit::new("");
    }
}

enum AuthFlightOutcome {
    Done,
    OAuthStarted(OAuthAttempt),
    CommandStarted(String),
    Failed(AuthError),
}

enum AccountFlightOutcome {
    Done,
    AutoSelect(AccountSelection),
    Failed(AuthError),
}

type CatalogFlight = (Sender<()>, Receiver<Option<CatalogSnapshot>>);
type AuthFlight = (u64, Arc<AtomicBool>, Receiver<AuthFlightOutcome>);
type PollFlight = (u64, Receiver<Result<AttemptPoll, AuthError>>);
type AccountFlight = (AccountAction, Receiver<AccountFlightOutcome>);

pub(super) struct Manager {
    pub expanded: bool,
    scope: Option<(String, String, Option<String>)>,
    authority: u64,
    seen: Option<u64>,
    snapshot_rev: Option<u64>,
    refresh_nonce: u64,
    flight: Option<CatalogFlight>,
    pub snapshot: Option<CatalogSnapshot>,
    pub failed: bool,
    pub search: TextEdit,
    pub selected_provider_id: Option<String>,
    pub open_picker: Option<PickerId>,
    pub open_info_key: Option<String>,
    pub connect: Option<ConnectFlow>,
    auth_flight: Option<AuthFlight>,
    poll_flight: Option<PollFlight>,
    #[cfg(target_arch = "wasm32")]
    pending_copy: Option<String>,
    #[cfg(target_arch = "wasm32")]
    copy_flight: Option<(u64, Receiver<bool>)>,
    pending_account: Option<AccountAction>,
    account_flight: Option<AccountFlight>,
    pub account_errors: BTreeMap<String, ErrorCopy>,
    renames: BTreeMap<(String, String), RenameDraft>,
    external_link: ExternalLink,
    oauth_link: ExternalLink,
    oauth_launch_tracked: bool,
    op_counter: u64,
    clock: f64,
    fallback_edit: TextEdit,
}

impl Default for Manager {
    fn default() -> Self {
        Self {
            expanded: true,
            scope: None,
            authority: 0,
            seen: None,
            snapshot_rev: None,
            refresh_nonce: 0,
            flight: None,
            snapshot: None,
            failed: false,
            search: TextEdit::new(""),
            selected_provider_id: None,
            open_picker: None,
            open_info_key: None,
            connect: None,
            auth_flight: None,
            poll_flight: None,
            #[cfg(target_arch = "wasm32")]
            pending_copy: None,
            #[cfg(target_arch = "wasm32")]
            copy_flight: None,
            pending_account: None,
            account_flight: None,
            account_errors: BTreeMap::new(),
            renames: BTreeMap::new(),
            external_link: ExternalLink::default(),
            oauth_link: ExternalLink::default(),
            oauth_launch_tracked: false,
            op_counter: 1,
            clock: 0.0,
            fallback_edit: TextEdit::new(""),
        }
    }
}

impl Manager {
    pub(super) fn toggle(&mut self) {
        self.cancel_remote_attempt();
        let next = !self.expanded;
        *self = Self {
            expanded: next,
            ..Self::default()
        };
    }

    pub(super) fn suspend(&mut self) {
        self.cancel_remote_attempt();
        let expanded = self.expanded;
        *self = Self {
            expanded,
            ..Self::default()
        };
    }

    pub(super) fn cancel_on_hide(&mut self) -> bool {
        let had_active = self.connect.is_some()
            || self.open_picker.is_some()
            || self.open_info_key.is_some()
            || self.auth_flight.is_some()
            || self.poll_flight.is_some()
            || self.flight.is_some()
            || self.seen.is_some()
            || self.account_flight.is_some()
            || self.pending_account.is_some();
        if !had_active {
            return false;
        }
        self.cancel_remote_attempt();
        if let Some(mut flow) = self.connect.take() {
            flow.wipe_secrets();
        }
        self.open_picker = None;
        self.open_info_key = None;
        self.flight = None;
        self.seen = None;
        self.snapshot_rev = None;
        self.account_flight = None;
        self.pending_account = None;
        self.oauth_link.clear();
        self.oauth_launch_tracked = false;
        true
    }

    pub(super) fn modal_open(&self) -> bool {
        self.connect.is_some()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(super) fn dismiss_modal(&mut self, tx: &mut Tx) -> bool {
        if self.connect.is_some() {
            self.close_connect_modal(tx);
            true
        } else {
            self.open_picker.take().is_some()
        }
    }

    pub(super) fn toggle_picker(&mut self, id: PickerId) {
        if self.open_picker.as_ref() == Some(&id) {
            self.open_picker = None;
        } else {
            self.open_picker = Some(id);
        }
    }

    pub(super) fn close_picker(&mut self) {
        self.open_picker = None;
    }

    pub(super) fn toggle_info(&mut self, key: String) {
        if self.open_info_key.as_deref() == Some(key.as_str()) {
            self.open_info_key = None;
        } else {
            self.open_info_key = Some(key);
        }
    }

    pub(super) fn request_refresh(&mut self) {
        self.refresh_nonce = self.refresh_nonce.wrapping_add(1);
        self.seen = None;
        self.failed = false;
    }

    pub(super) fn select_configurable_provider(&mut self, id: String) {
        self.selected_provider_id = Some(id);
    }

    pub(super) fn provider_name(&self, id: &str) -> String {
        self.snapshot
            .as_ref()
            .and_then(|s| s.providers.iter().find(|p| p.id == id))
            .map(|p| p.name.clone())
            .unwrap_or_else(|| id.to_owned())
    }

    pub(super) fn methods_for(&self, id: &str) -> Vec<AuthMethod> {
        self.snapshot
            .as_ref()
            .and_then(|s| s.providers.iter().find(|p| p.id == id))
            .map(|p| p.methods.clone())
            .unwrap_or_default()
    }

    pub(super) fn open_connect_modal(
        &mut self,
        provider_id: String,
        return_focus: Option<String>,
        tx: &mut Tx,
    ) {
        let methods = self.methods_for(&provider_id);
        if methods.is_empty() {
            return;
        }
        self.cancel_remote_attempt();
        self.open_picker = None;
        self.auth_flight = None;
        self.poll_flight = None;
        self.oauth_link.clear();
        self.oauth_launch_tracked = false;
        self.op_counter = self.op_counter.wrapping_add(1);
        let focus_target = tx.focused().map(str::to_owned).or(return_focus);
        self.connect = Some(ConnectFlow::new(
            provider_id,
            &methods,
            focus_target,
            self.op_counter,
        ));
        tx.focus("provider-auth-close", true);
    }

    pub(super) fn close_connect_modal(&mut self, tx: &mut Tx) {
        self.cancel_remote_attempt();
        self.open_picker = None;
        self.auth_flight = None;
        self.poll_flight = None;
        self.oauth_link.clear();
        self.oauth_launch_tracked = false;
        if let Some(mut flow) = self.connect.take() {
            flow.wipe_secrets();
            if let Some(key) = flow.return_focus {
                tx.return_focus(key, tx.focus_visible());
            }
        }
    }

    pub(super) fn select_method(&mut self, index: usize) {
        let Some(provider_id) = self.connect.as_ref().map(|f| f.provider_id.clone()) else {
            return;
        };
        let methods = self.methods_for(&provider_id);
        let Some(method) = methods.get(index) else {
            return;
        };
        let form_answers = initial_form_answers(method.form());
        let form_edits = seed_form_edits(method.form(), &form_answers);
        if let Some(flow) = &mut self.connect {
            flow.method_index = index;
            flow.wipe_secrets();
            flow.form_answers = form_answers;
            flow.form_edits = form_edits;
            flow.oauth = None;
            flow.command_attempt = None;
            flow.command_status = None;
            flow.stage = AuthStage::Prompts;
            flow.error = None;
            flow.launch_blocked = false;
            flow.link_copied = false;
            flow.next_poll_at = None;
        }
    }

    pub(super) fn connect_api_key_mut(&mut self) -> &mut TextEdit {
        if let Some(flow) = &mut self.connect {
            &mut flow.api_key
        } else {
            self.fallback_edit = TextEdit::new("");
            &mut self.fallback_edit
        }
    }

    pub(super) fn connect_oauth_code_mut(&mut self) -> &mut TextEdit {
        if let Some(flow) = &mut self.connect {
            &mut flow.oauth_code
        } else {
            self.fallback_edit = TextEdit::new("");
            &mut self.fallback_edit
        }
    }

    pub(super) fn form_text_edit(&self, key: &str) -> &TextEdit {
        self.connect
            .as_ref()
            .and_then(|f| f.form_edits.get(key))
            .unwrap_or(&self.fallback_edit)
    }

    pub(super) fn form_text_edit_mut(&mut self, key: &str) -> &mut TextEdit {
        if let Some(flow) = &mut self.connect {
            flow.form_edits
                .entry(key.to_owned())
                .or_insert_with(|| TextEdit::new(""))
        } else {
            self.fallback_edit = TextEdit::new("");
            &mut self.fallback_edit
        }
    }

    pub(super) fn set_form_value(&mut self, key: &str, value: Option<Value>) {
        if let Some(flow) = &mut self.connect {
            match value {
                Some(v) => {
                    flow.form_answers.insert(key.to_owned(), v);
                }
                None => {
                    flow.form_answers.remove(key);
                }
            }
        }
    }

    pub(super) fn toggle_multiselect_option(&mut self, key: &str, option: &str) {
        if let Some(flow) = &mut self.connect {
            let mut items: Vec<String> = flow
                .form_answers
                .get(key)
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            if let Some(pos) = items.iter().position(|v| v == option) {
                items.remove(pos);
            } else {
                items.push(option.to_owned());
            }
            flow.form_answers
                .insert(key.to_owned(), serde_json::json!(items));
        }
    }

    pub(super) fn can_submit_auth(&self) -> bool {
        let Some(flow) = &self.connect else {
            return false;
        };
        if !matches!(flow.stage, AuthStage::Prompts | AuthStage::Error)
            || self.auth_flight.is_some()
        {
            return false;
        }
        let methods = self.methods_for(&flow.provider_id);
        let Some(method) = methods.get(flow.method_index).or_else(|| methods.first()) else {
            return false;
        };
        let answers = form::effective_answers(method.form(), &flow.form_answers, &flow.form_edits);
        let form_ok = method
            .form()
            .iter()
            .all(|field| is_field_complete(field, &answers));
        if !form_ok {
            return false;
        }
        match method {
            AuthMethod::Key { .. } => !flow.api_key.text.trim().is_empty(),
            AuthMethod::OAuth { .. } | AuthMethod::Command { .. } | AuthMethod::External { .. } => {
                true
            }
        }
    }

    pub(super) fn request_submit_auth(&mut self) {
        if self.can_submit_auth()
            && let Some(flow) = &mut self.connect
        {
            flow.pending_submit = true;
        }
    }

    pub(super) fn request_submit_oauth_code(&mut self) {
        if let Some(flow) = &mut self.connect
            && flow.stage == AuthStage::Code
            && !flow.oauth_code.text.trim().is_empty()
            && self.auth_flight.is_none()
        {
            flow.pending_code_submit = true;
        }
    }

    pub(super) fn cancel_active_attempt(&mut self) {
        self.cancel_remote_attempt();
        self.auth_flight = None;
        self.poll_flight = None;
        self.oauth_link.clear();
        self.oauth_launch_tracked = false;
        if let Some(flow) = &mut self.connect {
            flow.stage = AuthStage::Prompts;
            flow.oauth = None;
            flow.command_attempt = None;
            flow.command_status = None;
            flow.oauth_code = TextEdit::new("");
            flow.error = None;
            flow.launch_blocked = false;
            flow.link_copied = false;
            flow.next_poll_at = None;
            flow.pending_submit = false;
            flow.pending_code_submit = false;
            flow.pending_url_launch = false;
        }
    }

    pub(super) fn open_external_link<S: 'static>(
        &mut self,
        url: &str,
        tx: &mut Tx,
        access: fn(&mut S) -> &mut Catalog,
    ) {
        if !is_http_url(url) {
            return;
        }
        self.external_link.open(url, tx, move |s: &mut S| {
            Some(&mut access(s).manager.external_link)
        });
    }

    pub(super) fn open_oauth_url<S: 'static>(
        &mut self,
        url: &str,
        tx: &mut Tx,
        access: fn(&mut S) -> &mut Catalog,
    ) {
        if !is_http_url(url) {
            if let Some(flow) = &mut self.connect {
                flow.launch_blocked = true;
            }
            return;
        }
        if let Some(flow) = &mut self.connect {
            flow.launch_blocked = false;
        }
        self.oauth_launch_tracked = true;
        self.oauth_link.open(url, tx, move |s: &mut S| {
            Some(&mut access(s).manager.oauth_link)
        });
    }

    pub(super) fn copy_oauth_link(&mut self, url: &str, tx: &mut Tx) {
        if !is_http_url(url) {
            return;
        }
        #[cfg(not(target_arch = "wasm32"))]
        {
            tx.copy(url);
            if let Some(flow) = &mut self.connect {
                flow.link_copied = true;
            }
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = tx;
            if let Some(flow) = &mut self.connect {
                flow.link_copied = false;
                self.pending_copy = Some(url.to_owned());
            }
        }
    }

    pub(super) fn account_busy(&self, integration_id: &str) -> bool {
        self.account_flight
            .as_ref()
            .is_some_and(|(action, _)| action.integration_id() == integration_id)
            || self
                .pending_account
                .as_ref()
                .is_some_and(|action| action.integration_id() == integration_id)
    }

    pub(super) fn queue_account_action(&mut self, action: AccountAction) {
        if self.account_flight.is_some() || self.pending_account.is_some() || self.modal_open() {
            return;
        }
        self.account_errors.remove(action.integration_id());
        self.pending_account = Some(action);
    }

    pub(super) fn rename_draft(
        &self,
        integration_id: &str,
        credential_id: &str,
    ) -> Option<&RenameDraft> {
        self.renames
            .get(&(integration_id.to_owned(), credential_id.to_owned()))
    }

    pub(super) fn start_rename(
        &mut self,
        integration_id: &str,
        credential_id: &str,
        initial_label: &str,
    ) {
        let key = (integration_id.to_owned(), credential_id.to_owned());
        let entry = self.renames.entry(key).or_insert_with(|| RenameDraft {
            text: TextEdit::new(initial_label),
            dirty: false,
            editing: true,
            revision: 0,
        });
        entry.editing = true;
        if !entry.dirty {
            entry.text = TextEdit::new(initial_label);
        }
    }

    pub(super) fn rename_text_mut(
        &mut self,
        integration_id: &str,
        credential_id: &str,
    ) -> &mut TextEdit {
        let key = (integration_id.to_owned(), credential_id.to_owned());
        let entry = self.renames.entry(key).or_insert_with(|| RenameDraft {
            text: TextEdit::new(""),
            dirty: false,
            editing: true,
            revision: 0,
        });
        entry.dirty = true;
        entry.revision = entry.revision.wrapping_add(1);
        &mut entry.text
    }

    pub(super) fn submit_rename(&mut self, integration_id: &str, credential_id: &str) {
        if self.account_flight.is_some() || self.pending_account.is_some() || self.modal_open() {
            return;
        }
        let key = (integration_id.to_owned(), credential_id.to_owned());
        let Some(draft) = self.renames.get(&key) else {
            return;
        };
        let trimmed = draft.text.text.trim();
        if !draft.dirty
            || trimmed.is_empty()
            || trimmed.chars().take(MAX_RENAME_LEN + 1).count() > MAX_RENAME_LEN
        {
            return;
        }
        let action = AccountAction::Rename {
            integration_id: integration_id.to_owned(),
            credential_id: credential_id.to_owned(),
            label: trimmed.to_owned(),
            edit_revision: draft.revision,
        };
        self.queue_account_action(action);
    }

    pub(super) fn cancel_rename(&mut self, integration_id: &str, credential_id: &str) {
        self.renames
            .remove(&(integration_id.to_owned(), credential_id.to_owned()));
    }

    #[cfg(test)]
    pub(super) fn poll_flight_active(&self) -> bool {
        self.poll_flight.is_some()
    }

    #[cfg(test)]
    pub(super) fn catalog_flight_active(&self) -> bool {
        self.flight.is_some()
    }

    fn cancel_remote_attempt(&mut self) {
        let context = self.connect.as_ref().and_then(|flow| {
            Some((
                flow.active_backend.clone()?,
                flow.active_workspace.clone()?,
                flow.active_directory.clone()?,
                flow.provider_id.clone(),
            ))
        });
        if let Some((_, flag, rx)) = self.auth_flight.take() {
            flag.store(true, Ordering::Release);
            if let Some((backend, workspace, directory, provider_id)) = context.clone()
                && let Ok(outcome) = rx.try_recv()
            {
                match outcome {
                    AuthFlightOutcome::OAuthStarted(auth) => {
                        let attempt_id = auth.attempt_id;
                        platform::spawn(async move {
                            provider_auth::oauth_cancel(
                                &backend,
                                &workspace,
                                &directory,
                                &provider_id,
                                &attempt_id,
                            )
                            .await;
                        });
                    }
                    AuthFlightOutcome::CommandStarted(attempt_id) => {
                        platform::spawn(async move {
                            provider_auth::command_cancel(
                                &backend,
                                &workspace,
                                &directory,
                                &provider_id,
                                &attempt_id,
                            )
                            .await;
                        });
                    }
                    AuthFlightOutcome::Done | AuthFlightOutcome::Failed(_) => {}
                }
            }
        }
        self.poll_flight = None;
        #[cfg(target_arch = "wasm32")]
        {
            self.pending_copy = None;
            self.copy_flight = None;
        }
        let Some((backend, workspace, directory, provider_id)) = context else {
            return;
        };
        let Some(flow) = &self.connect else {
            return;
        };
        if let Some(auth) = &flow.oauth {
            let attempt_id = auth.attempt_id.clone();
            platform::spawn(async move {
                provider_auth::oauth_cancel(
                    &backend,
                    &workspace,
                    &directory,
                    &provider_id,
                    &attempt_id,
                )
                .await;
            });
        } else if let Some(attempt_id) = &flow.command_attempt {
            let attempt_id = attempt_id.clone();
            platform::spawn(async move {
                provider_auth::command_cancel(
                    &backend,
                    &workspace,
                    &directory,
                    &provider_id,
                    &attempt_id,
                )
                .await;
            });
        }
    }

    pub(super) fn poll(
        &mut self,
        target: Option<&Target>,
        now: f64,
        wake: Option<&Waker>,
        tx: &mut Tx,
    ) -> bool {
        self.clock = now;
        let Some((target, wake)) = target
            .zip(wake)
            .filter(|(target, _)| self.expanded && target.online())
        else {
            let changed = self.seen.is_some()
                || self.flight.is_some()
                || self.connect.is_some()
                || self.account_flight.is_some();
            if changed {
                self.cancel_remote_attempt();
                let expanded = self.expanded;
                *self = Self {
                    expanded,
                    ..Self::default()
                };
            }
            return changed;
        };

        let mut changed = false;
        let (workspace, session) = target.location();
        let backend = target.backend();
        if self.scope.as_ref().is_none_or(|(client, ws, ses)| {
            client != &backend.client_id || ws != workspace || ses.as_deref() != session
        }) || self.authority != target.authority()
        {
            self.cancel_remote_attempt();
            *self = Self {
                expanded: true,
                scope: Some((
                    backend.client_id.clone(),
                    workspace.to_owned(),
                    session.map(str::to_owned),
                )),
                authority: target.authority(),
                clock: now,
                ..Self::default()
            };
            changed = true;
        }

        if self.oauth_launch_tracked && self.oauth_link.failed() {
            self.oauth_launch_tracked = false;
            if let Some(flow) = &mut self.connect {
                flow.launch_blocked = true;
                changed = true;
            }
        }

        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok())
        {
            self.flight = None;
            let expected = target.revision().wrapping_add(self.refresh_nonce);
            if self.seen == Some(expected) {
                self.failed = result.is_none();
                if let Some(snap) = result {
                    self.snapshot_rev = Some(expected);
                    self.adopt_snapshot(snap);
                }
            }
            changed = true;
        }

        changed |= self.poll_account_flight();
        changed |= self.poll_auth_flight(now, tx);
        changed |= self.poll_attempt_flight(now, tx);

        let desired_rev = target.revision().wrapping_add(self.refresh_nonce);
        if self.flight.is_none() && self.seen != Some(desired_rev) {
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            let (backend_cl, ws_cl, ses_cl, wake_cl) = (
                backend.clone(),
                workspace.to_owned(),
                session.map(str::to_owned),
                wake.clone(),
            );
            self.seen = Some(desired_rev);
            self.flight = Some((cancel, reply));
            self.failed = false;
            platform::spawn(async move {
                if let Some(result) = platform::reads::cancellable(
                    &cancelled,
                    provider_auth::load_catalog(&backend_cl, &ws_cl, ses_cl.as_deref()),
                )
                .await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake_cl();
                }
            });
            changed = true;
        }

        let location_fresh = self.snapshot_rev == Some(desired_rev) && self.flight.is_none();
        if location_fresh {
            changed |= self.start_pending_account(backend, workspace, wake);
        }
        changed |= self.drive_connect_flow(backend, workspace, location_fresh, now, wake, tx);
        changed
    }

    fn adopt_snapshot(&mut self, snap: CatalogSnapshot) {
        let directory_changed = self.snapshot.as_ref().is_some_and(|prev| {
            !codenomad_client::same_server_path(&prev.directory, &snap.directory)
        });
        if directory_changed {
            self.cancel_remote_attempt();
            if let Some(mut flow) = self.connect.take() {
                flow.wipe_secrets();
            }
            self.pending_account = None;
            self.account_flight = None;
            self.renames.clear();
            self.account_errors.clear();
            self.open_picker = None;
            self.oauth_link.clear();
            self.oauth_launch_tracked = false;
        }
        // Keep active rename drafts intact across refreshes; only drop drafts whose credential disappeared.
        self.renames.retain(|(prov_id, cred_id), draft| {
            let exists = snap.providers.iter().any(|p| {
                p.id == *prov_id
                    && p.connections
                        .iter()
                        .any(|c| c.credential_id() == Some(cred_id.as_str()))
            });
            if exists
                && !draft.dirty
                && let Some(label) =
                    snap.providers
                        .iter()
                        .find(|p| p.id == *prov_id)
                        .and_then(|p| {
                            p.connections.iter().find_map(|c| {
                                match c {
                                codenomad_client::settings::provider_auth::Connection::Credential {
                                    id,
                                    label,
                                    ..
                                } if id == cred_id => Some(label.as_str()),
                                _ => None,
                            }
                            })
                        })
            {
                draft.text = TextEdit::new(label);
            }
            exists
        });
        let still_configurable = self.selected_provider_id.as_deref().is_some_and(|sel| {
            snap.providers
                .iter()
                .any(|p| p.id == sel && p.is_configurable())
        });
        if !still_configurable {
            self.selected_provider_id = snap
                .providers
                .iter()
                .find(|p| p.is_configurable())
                .map(|p| p.id.clone());
        }
        self.snapshot = Some(snap);
    }

    fn poll_account_flight(&mut self) -> bool {
        let Some((action, rx)) = &self.account_flight else {
            return false;
        };
        let outcome = match rx.try_recv() {
            Ok(out) => Some(out),
            Err(codenomad_client::TryRecvError::Closed) => {
                Some(AccountFlightOutcome::Failed(AuthError::Failed))
            }
            Err(codenomad_client::TryRecvError::Empty) => None,
        };
        let Some(outcome) = outcome else {
            return false;
        };
        let _ = action;
        let (action, _) = self.account_flight.take().unwrap();
        let integration_id = action.integration_id().to_owned();
        match outcome {
            AccountFlightOutcome::Done => {
                self.account_errors.remove(&integration_id);
                if let AccountAction::Rename {
                    integration_id,
                    credential_id,
                    edit_revision,
                    ..
                } = action
                    && let Some(draft) = self.renames.get_mut(&(integration_id, credential_id))
                    && draft.revision == edit_revision
                {
                    draft.dirty = false;
                    draft.editing = false;
                }
            }
            AccountFlightOutcome::AutoSelect(selection) => {
                self.account_errors.remove(&integration_id);
                if let Some(snap) = &mut self.snapshot
                    && let Some(prov) = snap.providers.iter_mut().find(|p| p.id == integration_id)
                {
                    prov.account_selection = selection;
                }
            }
            AccountFlightOutcome::Failed(err) => {
                self.account_errors
                    .insert(integration_id, account_error_copy(err));
            }
        }
        self.request_refresh();
        true
    }

    fn start_pending_account(&mut self, backend: &Backend, workspace: &str, wake: &Waker) -> bool {
        if self.account_flight.is_some() {
            return false;
        }
        let Some(action) = self.pending_account.take() else {
            return false;
        };
        let Some(directory) = self.snapshot.as_ref().map(|s| s.directory.clone()) else {
            return false;
        };
        let (out, rx) = bounded(1);
        let (backend_cl, ws_cl, wake_cl) = (backend.clone(), workspace.to_owned(), wake.clone());
        let action_cl = action.clone();
        self.account_flight = Some((action, rx));
        platform::spawn(async move {
            let outcome = match action_cl {
                AccountAction::Activate { credential_id, .. } => {
                    match provider_auth::activate_credential(
                        &backend_cl,
                        &ws_cl,
                        &directory,
                        &credential_id,
                    )
                    .await
                    {
                        Ok(()) => AccountFlightOutcome::Done,
                        Err(err) => AccountFlightOutcome::Failed(err),
                    }
                }
                AccountAction::Rename {
                    credential_id,
                    label,
                    ..
                } => match provider_auth::rename_credential(
                    &backend_cl,
                    &ws_cl,
                    &directory,
                    &credential_id,
                    &label,
                )
                .await
                {
                    Ok(()) => AccountFlightOutcome::Done,
                    Err(err) => AccountFlightOutcome::Failed(err),
                },
                AccountAction::Remove { credential_id, .. } => {
                    match provider_auth::remove_credential(
                        &backend_cl,
                        &ws_cl,
                        &directory,
                        &credential_id,
                    )
                    .await
                    {
                        Ok(()) => AccountFlightOutcome::Done,
                        Err(err) => AccountFlightOutcome::Failed(err),
                    }
                }
                AccountAction::AutoSelect {
                    integration_id,
                    enabled,
                } => match provider_auth::set_account_auto_select(
                    &backend_cl,
                    &ws_cl,
                    &directory,
                    &integration_id,
                    enabled,
                )
                .await
                {
                    Ok(sel) => AccountFlightOutcome::AutoSelect(sel),
                    Err(err) => AccountFlightOutcome::Failed(err),
                },
            };
            if out.send(outcome).await.is_ok() {
                wake_cl();
            }
        });
        true
    }

    fn poll_auth_flight(&mut self, now: f64, tx: &mut Tx) -> bool {
        let Some((_, _, rx)) = &self.auth_flight else {
            return false;
        };
        let outcome = match rx.try_recv() {
            Ok(out) => Some(out),
            Err(codenomad_client::TryRecvError::Closed) => {
                Some(AuthFlightOutcome::Failed(AuthError::Failed))
            }
            Err(codenomad_client::TryRecvError::Empty) => None,
        };
        let Some(outcome) = outcome else {
            return false;
        };
        let (seq, _, _) = self.auth_flight.take().unwrap();
        let Some(flow) = &mut self.connect else {
            return true;
        };
        if flow.operation_seq != seq {
            return true;
        }
        match outcome {
            AuthFlightOutcome::Done => {
                self.close_connect_modal(tx);
                self.request_refresh();
            }
            AuthFlightOutcome::OAuthStarted(attempt) => {
                let auto = attempt.mode == OAuthMode::Auto;
                let has_url = is_http_url(&attempt.url);
                flow.oauth = Some(attempt);
                flow.pending_url_launch = has_url;
                flow.launch_blocked = !has_url;
                flow.link_copied = false;
                flow.error = None;
                if auto {
                    flow.stage = AuthStage::Waiting;
                    flow.next_poll_at = Some(now);
                } else {
                    flow.stage = AuthStage::Code;
                    flow.next_poll_at = None;
                }
            }
            AuthFlightOutcome::CommandStarted(attempt_id) => {
                flow.command_attempt = Some(attempt_id);
                flow.command_status = None;
                flow.error = None;
                flow.stage = AuthStage::Waiting;
                flow.next_poll_at = Some(now);
            }
            AuthFlightOutcome::Failed(err) => {
                let was_code = flow
                    .oauth
                    .as_ref()
                    .is_some_and(|a| a.mode == OAuthMode::Code);
                flow.error = Some(auth_error_copy(err));
                flow.stage = if was_code {
                    AuthStage::Code
                } else {
                    AuthStage::Error
                };
            }
        }
        true
    }

    fn poll_attempt_flight(&mut self, now: f64, tx: &mut Tx) -> bool {
        let Some((_, rx)) = &self.poll_flight else {
            return false;
        };
        let outcome = match rx.try_recv() {
            Ok(out) => Some(out),
            Err(codenomad_client::TryRecvError::Closed) => Some(Err(AuthError::Failed)),
            Err(codenomad_client::TryRecvError::Empty) => None,
        };
        let Some(outcome) = outcome else {
            return false;
        };
        let (seq, _) = self.poll_flight.take().unwrap();
        let Some(flow) = &mut self.connect else {
            return true;
        };
        if flow.operation_seq != seq || flow.stage != AuthStage::Waiting {
            return true;
        }
        match outcome {
            Ok(AttemptPoll::Complete) => {
                // Attempt already settled on server; clear attempt IDs so close does not DELETE.
                flow.oauth = None;
                flow.command_attempt = None;
                self.close_connect_modal(tx);
                self.request_refresh();
            }
            Ok(AttemptPoll::Pending(msg)) => {
                if flow.command_attempt.is_some() {
                    flow.command_status = msg;
                }
                let next = now + POLL_INTERVAL_S;
                flow.next_poll_at = Some(next);
                tx.wake_at(next);
            }
            Ok(AttemptPoll::Failed(msg)) => {
                flow.oauth = None;
                flow.command_attempt = None;
                flow.next_poll_at = None;
                flow.error = Some(match msg {
                    Some(m) => ErrorCopy::Raw(m),
                    None => ErrorCopy::Key("settings.providers.errors.authorizationFailed"),
                });
                flow.stage = AuthStage::Error;
            }
            Ok(AttemptPoll::Expired) => {
                flow.oauth = None;
                flow.command_attempt = None;
                flow.next_poll_at = None;
                flow.error = Some(ErrorCopy::Key(
                    "settings.providers.errors.authorizationFailed",
                ));
                flow.stage = AuthStage::Error;
            }
            Err(err) => {
                // Cancel any potentially live server-side attempt before discarding its ID.
                self.cancel_remote_attempt();
                if let Some(flow) = &mut self.connect {
                    flow.oauth = None;
                    flow.command_attempt = None;
                    flow.next_poll_at = None;
                    flow.error = Some(auth_error_copy(err));
                    flow.stage = AuthStage::Error;
                }
            }
        }
        true
    }

    fn drive_connect_flow(
        &mut self,
        backend: &Backend,
        workspace: &str,
        location_fresh: bool,
        now: f64,
        wake: &Waker,
        tx: &mut Tx,
    ) -> bool {
        let mut changed = false;

        #[cfg(target_arch = "wasm32")]
        {
            if let Some((seq, rx)) = &self.copy_flight
                && let Ok(copied) = rx.try_recv()
            {
                let seq = *seq;
                self.copy_flight = None;
                if let Some(flow) = &mut self.connect
                    && flow.operation_seq == seq
                {
                    flow.link_copied = copied;
                }
                changed = true;
            }
            if let Some(url) = self.pending_copy.take()
                && let Some(flow) = &self.connect
            {
                let seq = flow.operation_seq;
                let (out, rx) = bounded(1);
                let wake_cl = wake.clone();
                self.copy_flight = Some((seq, rx));
                platform::diagnostics::copy(&url, move |copied| {
                    if out.try_send(copied).is_ok() {
                        wake_cl();
                    }
                });
                changed = true;
            }
        }

        let launch_url = self.connect.as_mut().and_then(|flow| {
            if flow.pending_url_launch {
                flow.pending_url_launch = false;
                flow.oauth.as_ref().map(|a| a.url.clone())
            } else {
                None
            }
        });
        if let Some(url) = launch_url {
            if is_http_url(&url) {
                if tx.open_url(&url).is_err()
                    && let Some(flow) = &mut self.connect
                {
                    flow.launch_blocked = true;
                }
            } else if let Some(flow) = &mut self.connect {
                flow.launch_blocked = true;
            }
            changed = true;
        }

        let want_submit = location_fresh
            && self.connect.as_mut().is_some_and(|flow| {
                let v = flow.pending_submit;
                flow.pending_submit = false;
                v
            });
        if want_submit
            && self.can_submit_auth()
            && let Some(directory) = self.snapshot.as_ref().map(|s| s.directory.clone())
        {
            self.op_counter = self.op_counter.wrapping_add(1);
            let seq = self.op_counter;
            let provider_id = self.connect.as_ref().unwrap().provider_id.clone();
            let methods = self.methods_for(&provider_id);
            let method = methods
                .get(self.connect.as_ref().unwrap().method_index)
                .or_else(|| methods.first())
                .cloned()
                .unwrap();
            let flow = self.connect.as_mut().unwrap();
            let effective =
                form::effective_answers(method.form(), &flow.form_answers, &flow.form_edits);
            flow.form_answers = effective;
            let answer = build_form_answer(method.form(), &flow.form_answers);
            let api_key = flow.api_key.text.trim().to_owned();
            flow.operation_seq = seq;
            flow.stage = AuthStage::Authorizing;
            flow.error = None;
            flow.active_directory = Some(directory.clone());
            flow.active_workspace = Some(workspace.to_owned());
            flow.active_backend = Some(backend.clone());
            let (out, rx) = bounded(1);
            let cancel_flag = Arc::new(AtomicBool::new(false));
            let cancel_cl = cancel_flag.clone();
            let (backend_cl, ws_cl, wake_cl) =
                (backend.clone(), workspace.to_owned(), wake.clone());
            self.auth_flight = Some((seq, cancel_flag, rx));
            platform::spawn(async move {
                let outcome = match method {
                    AuthMethod::Key { .. } => {
                        match provider_auth::connect_key(
                            &backend_cl,
                            &ws_cl,
                            &directory,
                            &provider_id,
                            &api_key,
                            answer,
                        )
                        .await
                        {
                            Ok(()) => AuthFlightOutcome::Done,
                            Err(err) => AuthFlightOutcome::Failed(err),
                        }
                    }
                    AuthMethod::External { id, .. } => {
                        match provider_auth::connect_external(
                            &backend_cl,
                            &ws_cl,
                            &directory,
                            &provider_id,
                            &id,
                            answer,
                        )
                        .await
                        {
                            Ok(()) => AuthFlightOutcome::Done,
                            Err(err) => AuthFlightOutcome::Failed(err),
                        }
                    }
                    AuthMethod::OAuth { id, .. } => {
                        match provider_auth::oauth_connect(
                            &backend_cl,
                            &ws_cl,
                            &directory,
                            &provider_id,
                            &id,
                            answer,
                        )
                        .await
                        {
                            Ok(attempt) => AuthFlightOutcome::OAuthStarted(attempt),
                            Err(err) => AuthFlightOutcome::Failed(err),
                        }
                    }
                    AuthMethod::Command { id, .. } => match provider_auth::command_connect(
                        &backend_cl,
                        &ws_cl,
                        &directory,
                        &provider_id,
                        &id,
                    )
                    .await
                    {
                        Ok(attempt_id) => AuthFlightOutcome::CommandStarted(attempt_id),
                        Err(err) => AuthFlightOutcome::Failed(err),
                    },
                };
                if cancel_cl.load(Ordering::Acquire) {
                    match outcome {
                        AuthFlightOutcome::OAuthStarted(attempt) => {
                            provider_auth::oauth_cancel(
                                &backend_cl,
                                &ws_cl,
                                &directory,
                                &provider_id,
                                &attempt.attempt_id,
                            )
                            .await;
                        }
                        AuthFlightOutcome::CommandStarted(attempt_id) => {
                            provider_auth::command_cancel(
                                &backend_cl,
                                &ws_cl,
                                &directory,
                                &provider_id,
                                &attempt_id,
                            )
                            .await;
                        }
                        AuthFlightOutcome::Done | AuthFlightOutcome::Failed(_) => {}
                    }
                    return;
                }
                if let Err(unsent) = out.send(outcome).await {
                    match unsent.into_inner() {
                        AuthFlightOutcome::OAuthStarted(attempt) => {
                            provider_auth::oauth_cancel(
                                &backend_cl,
                                &ws_cl,
                                &directory,
                                &provider_id,
                                &attempt.attempt_id,
                            )
                            .await;
                        }
                        AuthFlightOutcome::CommandStarted(attempt_id) => {
                            provider_auth::command_cancel(
                                &backend_cl,
                                &ws_cl,
                                &directory,
                                &provider_id,
                                &attempt_id,
                            )
                            .await;
                        }
                        AuthFlightOutcome::Done | AuthFlightOutcome::Failed(_) => {}
                    }
                } else {
                    wake_cl();
                }
            });
            changed = true;
        }

        let want_code = location_fresh
            && self.connect.as_mut().is_some_and(|flow| {
                let v = flow.pending_code_submit;
                flow.pending_code_submit = false;
                v
            });
        if want_code
            && self.auth_flight.is_none()
            && let Some(flow) = &mut self.connect
            && flow.stage == AuthStage::Code
        {
            let code = flow.oauth_code.text.trim().to_owned();
            if !code.is_empty()
                && let (Some(auth), Some(directory)) =
                    (flow.oauth.clone(), flow.active_directory.clone())
            {
                self.op_counter = self.op_counter.wrapping_add(1);
                let seq = self.op_counter;
                flow.operation_seq = seq;
                flow.stage = AuthStage::Authorizing;
                flow.error = None;
                let provider_id = flow.provider_id.clone();
                let (out, rx) = bounded(1);
                let cancel_flag = Arc::new(AtomicBool::new(false));
                let (backend_cl, ws_cl, wake_cl) =
                    (backend.clone(), workspace.to_owned(), wake.clone());
                self.auth_flight = Some((seq, cancel_flag, rx));
                platform::spawn(async move {
                    let outcome = match provider_auth::oauth_complete(
                        &backend_cl,
                        &ws_cl,
                        &directory,
                        &provider_id,
                        &auth.attempt_id,
                        &code,
                    )
                    .await
                    {
                        Ok(()) => AuthFlightOutcome::Done,
                        Err(err) => AuthFlightOutcome::Failed(err),
                    };
                    if out.send(outcome).await.is_ok() {
                        wake_cl();
                    }
                });
                changed = true;
            }
        }

        if self.poll_flight.is_none()
            && let Some(flow) = &mut self.connect
            && flow.stage == AuthStage::Waiting
            && let Some(due) = flow.next_poll_at
        {
            if now >= due {
                flow.next_poll_at = None;
                if let Some(directory) = flow.active_directory.clone() {
                    let seq = flow.operation_seq;
                    let provider_id = flow.provider_id.clone();
                    let is_oauth = flow.oauth.is_some();
                    let attempt_id = flow
                        .oauth
                        .as_ref()
                        .map(|a| a.attempt_id.clone())
                        .or_else(|| flow.command_attempt.clone());
                    if let Some(attempt_id) = attempt_id {
                        let (out, rx) = bounded(1);
                        let (backend_cl, ws_cl, wake_cl) =
                            (backend.clone(), workspace.to_owned(), wake.clone());
                        self.poll_flight = Some((seq, rx));
                        platform::spawn(async move {
                            let res = if is_oauth {
                                provider_auth::oauth_status(
                                    &backend_cl,
                                    &ws_cl,
                                    &directory,
                                    &provider_id,
                                    &attempt_id,
                                )
                                .await
                            } else {
                                provider_auth::command_status(
                                    &backend_cl,
                                    &ws_cl,
                                    &directory,
                                    &provider_id,
                                    &attempt_id,
                                )
                                .await
                            };
                            if out.send(res).await.is_ok() {
                                wake_cl();
                            }
                        });
                        changed = true;
                    }
                }
            } else {
                tx.wake_at(due);
            }
        }

        changed
    }

    pub(super) fn view<S: 'static>(
        catalog: &Catalog,
        available: bool,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut Catalog,
    ) -> El {
        let mgr = &catalog.manager;
        let mut body = col().full_width().separate(Space::Sm);
        if mgr.expanded {
            if !available {
                body = body.child(text(t("settings.providers.empty.noInstance")).role("status"));
            } else {
                body = body.child(connect_bar(catalog, layers, access));
                if mgr.flight.is_some() && mgr.snapshot.is_none() {
                    body = body.child(text(t("settings.providers.loading")).role("status"));
                } else if mgr.failed {
                    body = body.child(
                        text(t("settings.providers.errors.loadFailed"))
                            .wrap()
                            .role("alert"),
                    );
                }
                if let Some(snap) = &mgr.snapshot {
                    let query = mgr.search.text.trim().to_lowercase();
                    let configured: Vec<&ListedProvider> = snap
                        .providers
                        .iter()
                        .filter(|p| p.is_configured() && matches_query(p, &query))
                        .collect();
                    if configured.is_empty() {
                        body = body.child(
                            text(t("settings.providers.empty.noConfiguredProviders"))
                                .role("status"),
                        );
                    } else {
                        for provider in configured {
                            body = body.child(accounts::card(
                                catalog,
                                provider,
                                mgr.flight.is_some(),
                                layers,
                                access,
                            ));
                        }
                    }
                }
                modal::view(catalog, layers, access);
            }
        }
        chrome::card(chrome::disclosure(
            t("settings.providers.models.title"),
            mgr.expanded,
            body,
            move |s: &mut S| access(s).toggle(),
        ))
    }
}

fn connect_bar<S: 'static>(
    catalog: &Catalog,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    let mgr = &catalog.manager;
    let query = mgr.search.text.trim().to_lowercase();
    let configurable: Vec<(String, String)> = mgr
        .snapshot
        .as_ref()
        .map(|snap| {
            let mut items: Vec<(String, String)> = snap
                .providers
                .iter()
                .filter(|p| p.is_configurable() && matches_query(p, &query))
                .map(|p| (p.id.clone(), p.name.clone()))
                .collect();
            items.sort_by_cached_key(|(id, _)| id.to_lowercase());
            items
        })
        .unwrap_or_default();

    let selected = mgr
        .selected_provider_id
        .as_deref()
        .and_then(|sel| configurable.iter().find(|(id, _)| id == sel))
        .or_else(|| configurable.first())
        .cloned();

    let mut bar = col().full_width().separate(Space::Xs);
    let search_input = layout::hinted_field(&mgr.search, t("settings.providers.selectProvider"))
        .label(t("settings.providers.selectProvider"))
        .disabled(mgr.modal_open())
        .on_edit(move |s: &mut S| &mut access(s).manager.search)
        .build(field_kit(layout::dark()))
        .key("providers-search");

    let mut row_el = layout::action_row();
    if !configurable.is_empty() {
        let raw_names: Vec<String> = configurable.iter().map(|(_, n)| n.clone()).collect();
        let display_names = unique_labels(&raw_names);
        let labels: Vec<&str> = display_names.iter().map(String::as_str).collect();
        let pairs: Vec<(String, String)> = configurable
            .iter()
            .zip(display_names.iter())
            .map(|((id, _), disp)| (id.clone(), disp.clone()))
            .collect();
        let current_name = selected
            .as_ref()
            .and_then(|(sel_id, _)| pairs.iter().find(|(id, _)| id == sel_id))
            .map(|(_, disp)| disp.as_str());
        let select = chrome::picker(
            "providers-connect-select",
            t("settings.providers.selectProvider"),
            &labels,
        )
        .current(current_name)
        .disabled(mgr.modal_open())
        .open(mgr.open_picker == Some(PickerId::ConnectProvider))
        .on_toggle(move |s: &mut S| access(s).manager.toggle_picker(PickerId::ConnectProvider))
        .on_close(move |s: &mut S| access(s).manager.close_picker())
        .on_choose(move |s: &mut S, chosen, _| {
            let mgr = &mut access(s).manager;
            if mgr.open_picker == Some(PickerId::ConnectProvider) {
                mgr.close_picker();
                if let Some((id, _)) = pairs.iter().find(|(_, disp)| disp == chosen) {
                    mgr.select_configurable_provider(id.clone());
                }
            }
        });
        let connect_id = selected.as_ref().map(|(id, _)| id.clone());
        row_el = row_el.child(chrome::build_picker(select, layers)).child(
            chrome::primary_action_tx(
                t("settings.providers.actions.connect"),
                connect_id.is_none() || mgr.modal_open(),
                move |s: &mut S, tx| {
                    if let Some(id) = connect_id.clone() {
                        access(s).manager.open_connect_modal(
                            id,
                            Some("providers-connect-button".into()),
                            tx,
                        );
                    }
                },
            )
            .key("providers-connect-button"),
        );
    }

    row_el = row_el.child(
        layout::button(
            t("settings.providers.refresh"),
            mgr.flight.is_some() || mgr.modal_open(),
            move |s: &mut S| access(s).manager.request_refresh(),
        )
        .key("providers-refresh"),
    );

    bar = bar.child(search_input).child(row_el);
    bar
}

pub(super) fn unique_labels(raw: &[String]) -> Vec<String> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for item in raw {
        *counts.entry(item.as_str()).or_insert(0) += 1;
    }
    let mut used: std::collections::HashSet<String> = counts
        .iter()
        .filter(|(_, count)| **count == 1)
        .map(|(label, _)| (*label).to_owned())
        .collect();
    let mut next_num: BTreeMap<&str, usize> = BTreeMap::new();
    raw.iter()
        .map(|base| {
            if counts.get(base.as_str()).copied().unwrap_or(0) <= 1 {
                return base.clone();
            }
            let counter = next_num.entry(base.as_str()).or_insert(0);
            loop {
                *counter += 1;
                let candidate = format!("{base} ({counter})");
                if used.insert(candidate.clone()) {
                    return candidate;
                }
            }
        })
        .collect()
}

fn matches_query(provider: &ListedProvider, query: &str) -> bool {
    if query.is_empty() {
        return true;
    }
    provider.name.to_lowercase().contains(query) || provider.id.to_lowercase().contains(query)
}

fn seed_form_edits(
    fields: &[codenomad_client::settings::provider_auth::FormField],
    answers: &BTreeMap<String, Value>,
) -> BTreeMap<String, TextEdit> {
    let mut edits = BTreeMap::new();
    for field in fields {
        let initial = match &field.kind {
            codenomad_client::settings::provider_auth::FormFieldKind::String {
                options,
                custom,
                ..
            } if options.is_empty() || *custom => answers
                .get(&field.key)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            codenomad_client::settings::provider_auth::FormFieldKind::Number { .. } => answers
                .get(&field.key)
                .map(|v| v.to_string())
                .unwrap_or_default(),
            codenomad_client::settings::provider_auth::FormFieldKind::Multiselect {
                options,
                custom: true,
                ..
            } => {
                let option_values: Vec<&str> = options.iter().map(|o| o.value.as_str()).collect();
                answers
                    .get(&field.key)
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .filter(|s| !option_values.contains(s))
                            .collect::<Vec<_>>()
                            .join(", ")
                    })
                    .unwrap_or_default()
            }
            _ => continue,
        };
        edits.insert(field.key.clone(), TextEdit::new(initial));
    }
    edits
}

fn auth_error_copy(err: AuthError) -> ErrorCopy {
    match err {
        AuthError::Unsupported => ErrorCopy::Key("integrations.connection.unsupported"),
        AuthError::Message(msg) => ErrorCopy::Raw(msg),
        AuthError::Failed => ErrorCopy::Key("settings.providers.errors.authorizationFailed"),
    }
}

fn account_error_copy(err: AuthError) -> ErrorCopy {
    match err {
        AuthError::Unsupported => ErrorCopy::Key("integrations.connection.unsupported"),
        AuthError::Message(msg) => ErrorCopy::Raw(msg),
        AuthError::Failed => ErrorCopy::Key("settings.accounts.error"),
    }
}
