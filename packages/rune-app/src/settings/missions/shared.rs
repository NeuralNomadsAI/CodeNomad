//! Persistent Missions write state stored on `Preferences` and its config-bridge helpers.
use super::{defaults, depth, library};
use crate::{
    backend::Backend,
    platform,
    settings::{ServerOwner, providers::Target},
};
use codenomad_client::{
    Receiver, Sender, absolute_server_path, bounded, same_server_path,
    settings::missions::{
        MissionDefaultScope, MissionPreferenceExpectation, resolve_workspace_directory,
    },
};
use rune::Waker;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

#[cfg(test)]
pub(super) type PostAttestGate = (Sender<()>, Receiver<()>);

#[derive(Clone)]
pub(in crate::settings) struct SendAuthority {
    prefs_authority: Arc<AtomicU64>,
    expected_prefs_authority: u64,
    doc_epoch: Option<(Arc<AtomicU64>, u64)>,
    location_token: Option<(Arc<AtomicU64>, u64)>,
    expected_location: Option<(String, Option<String>, u64)>,
    drop_generation: u64,
    stream_drop_epoch: u64,
    expected_server: Option<String>,
    #[cfg(test)]
    pre_send_gate: Option<Receiver<()>>,
    #[cfg(test)]
    post_attest_gate: Option<PostAttestGate>,
}

impl SendAuthority {
    pub(super) fn capture(
        prefs_authority: Arc<AtomicU64>,
        doc_epoch: Option<(Arc<AtomicU64>, u64)>,
        location_token: Option<&Arc<AtomicU64>>,
        expected_location: Option<(String, Option<String>, u64)>,
        backend: &Backend,
        #[cfg(test)] pre_send_gate: Option<Receiver<()>>,
        #[cfg(test)] post_attest_gate: Option<PostAttestGate>,
    ) -> Self {
        let expected_prefs_authority = prefs_authority.load(Ordering::SeqCst);
        let location_token =
            location_token.map(|guard| (guard.clone(), guard.load(Ordering::SeqCst)));
        Self {
            prefs_authority,
            expected_prefs_authority,
            doc_epoch,
            location_token,
            expected_location,
            drop_generation: backend.client.drop_generation(),
            stream_drop_epoch: backend.client.stream_drop_epoch(),
            expected_server: backend.client.server_identity().map(str::to_owned),
            #[cfg(test)]
            pre_send_gate,
            #[cfg(test)]
            post_attest_gate,
        }
    }

    pub(super) fn still_ok(&self, backend: &Backend) -> bool {
        self.prefs_authority.load(Ordering::SeqCst) == self.expected_prefs_authority
            && self
                .doc_epoch
                .as_ref()
                .is_none_or(|(guard, expected)| guard.load(Ordering::Acquire) == *expected)
            && backend.client.drop_generation() == self.drop_generation
            && backend.client.stream_drop_epoch() == self.stream_drop_epoch
            && ServerOwner::backend_verified(backend)
            && self
                .expected_server
                .as_deref()
                .is_none_or(|id| backend.client.server_identity() == Some(id))
            && self
                .location_token
                .as_ref()
                .is_none_or(|(guard, expected)| guard.load(Ordering::SeqCst) == *expected)
            && self
                .expected_location
                .as_ref()
                .is_none_or(|(ws, ses, rev)| {
                    let (current_rev, healthy) = backend.client.location_state(ws, ses.as_deref());
                    current_rev == *rev && healthy
                })
    }

    pub(super) async fn authorize_send(&self, backend: &Backend) -> bool {
        #[cfg(test)]
        if let Some(gate) = &self.pre_send_gate {
            let _ = gate.recv().await;
        }
        if !self.still_ok(backend) {
            return false;
        }
        if backend.client.tracks_server_attestation() {
            if backend.attest_server().await.is_err() {
                return false;
            }
            if !self.still_ok(backend) {
                return false;
            }
        }
        self.still_ok(backend)
    }

    #[cfg(test)]
    pub(super) async fn wait_post_attest(&self) {
        if let Some((entered, gate)) = &self.post_attest_gate {
            let _ = entered.send(()).await;
            let _ = gate.recv().await;
        }
    }
}

pub(in crate::settings) struct ConfigContext<'a> {
    pub backend: Option<&'a Backend>,
    pub config_loaded: bool,
    pub config_refreshing: bool,
    pub config_busy: bool,
    pub config_snapshot: Option<&'a Value>,
    pub prefs_authority: Arc<AtomicU64>,
    pub doc_epoch: (Arc<AtomicU64>, u64),
    pub transport_lost: bool,
    pub can_retry: bool,
}

impl ConfigContext<'_> {
    pub(super) fn can_start_write(&self) -> bool {
        self.config_loaded
            && !self.config_busy
            && !self.transport_lost
            && self.can_retry
            && self.backend.is_some_and(ServerOwner::backend_verified)
    }

    pub(super) fn send_authority(
        &self,
        backend: &Backend,
        #[cfg(test)] pre_send_gate: Option<Receiver<()>>,
    ) -> SendAuthority {
        SendAuthority::capture(
            self.prefs_authority.clone(),
            Some(self.doc_epoch.clone()),
            None,
            None,
            backend,
            #[cfg(test)]
            pre_send_gate,
            #[cfg(test)]
            None,
        )
    }
}

#[derive(Default)]
pub(in crate::settings) struct ConfigEffects {
    pub invalidate: bool,
    pub revalidate_transport: bool,
    pub changed: bool,
    pub settled: bool,
}

impl ConfigEffects {
    fn merge(&mut self, other: Self) {
        self.invalidate |= other.invalidate;
        self.revalidate_transport |= other.revalidate_transport;
        self.changed |= other.changed;
        self.settled |= other.settled;
    }
}

type LocationFlight = (u64, String, u64, u64, Sender<()>, Receiver<Option<String>>);

/// Persistent Missions write queues and depth state stored on `Preferences` so closing/reopening
/// Preferences or reattaching to the same server preserves in-flight writes and Uncertain state.
#[derive(Default)]
pub(in crate::settings) struct Shared {
    pub(super) defaults: defaults::State,
    pub(super) library: library::State,
    pub(super) depth: depth::State,
    scope: Option<MissionDefaultScope>,
    profiles_open: bool,
    open_epoch: u64,
    pinned_directory: Option<String>,
    pinned_location_revision: Option<u64>,
    pinned_target: Option<(Backend, String, Option<String>)>,
    location_authority: Option<(String, u64)>,
    location_token: Arc<AtomicU64>,
    location_flight: Option<LocationFlight>,
    location_failed: Option<(u64, String, u64, u64, u64)>,
    location_retry_epoch: u64,
    #[cfg(test)]
    pre_patch_gate: Option<Receiver<()>>,
    #[cfg(test)]
    pre_depth_put_gate: Option<Receiver<()>>,
    #[cfg(test)]
    post_attest_depth_gate: Option<PostAttestGate>,
}

impl Shared {
    #[cfg(test)]
    pub(in crate::settings) fn set_pre_patch_gate(&mut self, gate: Receiver<()>) {
        self.pre_patch_gate = Some(gate);
    }

    #[cfg(test)]
    pub(in crate::settings) fn set_pre_depth_put_gate(&mut self, gate: Receiver<()>) {
        self.pre_depth_put_gate = Some(gate);
    }

    #[cfg(test)]
    pub(in crate::settings) fn set_post_attest_depth_gate(
        &mut self,
        entered: Sender<()>,
        gate: Receiver<()>,
    ) {
        self.post_attest_depth_gate = Some((entered, gate));
    }

    #[cfg(test)]
    pub(in crate::settings) fn defaults_writing(&self) -> bool {
        self.defaults.writing()
    }

    #[cfg(test)]
    pub(in crate::settings) fn depth_disabled(
        &self,
        active: bool,
        has_target: bool,
        pinned_directory: Option<&str>,
    ) -> bool {
        self.depth.disabled(active, has_target, pinned_directory)
    }

    #[cfg(test)]
    pub(in crate::settings) fn choose_depth(
        &mut self,
        value: String,
        active: bool,
        has_target: bool,
        pinned_directory: Option<&str>,
    ) {
        self.depth
            .choose(value, active, has_target, pinned_directory);
    }

    #[cfg(test)]
    pub(in crate::settings) fn depth_save_in_flight(&self) -> bool {
        self.depth.save_in_flight()
    }

    pub(in crate::settings) fn scope(&self) -> MissionDefaultScope {
        self.scope.unwrap_or(MissionDefaultScope::All)
    }

    pub(super) fn set_scope(&mut self, scope: MissionDefaultScope) {
        self.scope = Some(scope);
    }

    pub(in crate::settings) fn profiles_open(&self) -> bool {
        self.profiles_open
    }

    pub(super) fn toggle_profiles_open(&mut self) {
        self.profiles_open = !self.profiles_open;
    }

    pub(in crate::settings) fn revoke_location(&self) {
        self.location_token.fetch_add(1, Ordering::SeqCst);
    }

    pub(in crate::settings) fn capture_opener(
        &mut self,
        directory: Option<String>,
        target: Option<&Target>,
    ) {
        let upstream_healthy = target.is_none_or(|t| {
            t.backend()
                .client
                .workspace_upstream_healthy(t.location().0)
        });
        let has_session = target.is_some_and(|t| t.location().1.is_some());
        let next_dir = directory
            .filter(|_| upstream_healthy && !has_session)
            .filter(|path| absolute_server_path(path));
        let next_target = target.map(|t| {
            let (ws, ses) = t.location();
            (t.backend().clone(), ws.to_owned(), ses.map(str::to_owned))
        });
        let next_loc_rev = target.map(|t| {
            let (ws, ses) = t.location();
            t.backend().client.location_revision(ws, ses)
        });
        let same_pinned = upstream_healthy
            && matches!(
                (&self.pinned_target, &next_target, &self.pinned_directory),
                (
                    Some((prev_b, prev_ws, prev_ses)),
                    Some((next_b, next_ws, next_ses)),
                    Some(cur_dir),
                ) if prev_b.client.same_connection(&next_b.client)
                    && prev_ws == next_ws
                    && prev_ses == next_ses
                    && self.pinned_location_revision == next_loc_rev
                    && next_dir
                        .as_deref()
                        .is_none_or(|dir| same_server_path(cur_dir, dir))
            );
        if same_pinned && self.depth.has_live_work() {
            if let Some(t) = target {
                let auth = t.authority();
                self.location_authority = Some((t.location().0.to_owned(), auth));
                self.depth.adopt_reopened_authority(auth, t.revision());
            }
            return;
        }
        self.open_epoch = self.open_epoch.wrapping_add(1);
        self.revoke_location();
        self.pinned_directory = next_dir;
        self.pinned_location_revision = self.pinned_directory.as_ref().and(next_loc_rev);
        self.pinned_target = self.pinned_directory.as_ref().and(next_target);
        self.location_authority = target.map(|t| (t.location().0.to_owned(), t.authority()));
        self.location_flight = None;
        self.location_failed = None;
    }

    pub(super) fn open_epoch(&self) -> u64 {
        self.open_epoch
    }

    pub(in crate::settings) fn pinned_directory(&self) -> Option<&str> {
        self.pinned_directory.as_deref()
    }

    pub(super) fn retry_location(&mut self) {
        self.location_retry_epoch = self.location_retry_epoch.wrapping_add(1);
        self.location_failed = None;
    }

    pub(in crate::settings) fn on_transport_lost(&mut self) {
        self.revoke_location();
        self.pinned_directory = None;
        self.pinned_location_revision = None;
        self.pinned_target = None;
        self.location_authority = None;
        self.location_flight = None;
        self.location_failed = None;
        self.depth.invalidate_location();
    }

    pub(super) fn poll_location(
        &mut self,
        target: Option<&Target>,
        online: bool,
        active: bool,
        wake: &Waker,
    ) -> (bool, bool) {
        let mut changed = false;
        if let Some(target) = target {
            let (backend, workspace, authority, _) = target.stats_source();
            let (_, session) = target.location();
            let current_loc_rev = backend.client.location_revision(workspace, session);
            let same_authority = self
                .location_authority
                .as_ref()
                .is_some_and(|(w, a)| w == workspace && *a == authority);
            let rev_stale = self
                .pinned_location_revision
                .is_some_and(|rev| rev != current_loc_rev);
            let upstream_unhealthy = !backend.client.workspace_upstream_healthy(workspace);
            let needs_invalidation = !same_authority
                || rev_stale
                || (upstream_unhealthy
                    && (self.pinned_directory.is_some()
                        || self.pinned_location_revision.is_some()
                        || self.pinned_target.is_some()
                        || self.location_flight.is_some()
                        || self.location_failed.is_some()
                        || self.depth.has_live_work()));
            if needs_invalidation {
                self.revoke_location();
                let invalidated = self.pinned_directory.take().is_some()
                    | self.pinned_location_revision.take().is_some()
                    | self.pinned_target.take().is_some()
                    | self.location_flight.take().is_some()
                    | self.location_failed.take().is_some();
                self.location_authority = Some((workspace.to_owned(), authority));
                changed |= invalidated | self.depth.invalidate_location();
            }
        } else if active
            && (self.location_authority.take().is_some()
                | self.pinned_directory.take().is_some()
                | self.pinned_location_revision.take().is_some()
                | self.pinned_target.take().is_some()
                | self.location_flight.take().is_some()
                | self.location_failed.take().is_some())
        {
            self.revoke_location();
            let _ = self.depth.invalidate_location();
            changed = true;
        }
        if !online || !active {
            changed |= self.location_flight.take().is_some();
            return (changed, false);
        }
        let Some(target) = target else {
            changed |= self.location_flight.take().is_some();
            return (changed, false);
        };
        if self.pinned_directory.is_some() {
            changed |= self.location_flight.take().is_some();
            self.location_failed = None;
            return (changed, false);
        }
        let (backend, workspace, authority, _) = target.stats_source();
        let (_, session) = target.location();
        let current_loc_rev = backend.client.location_revision(workspace, session);
        let revision = target.revision().wrapping_add(self.location_retry_epoch);
        if self
            .location_flight
            .as_ref()
            .is_some_and(|(e, w, a, loc_rev, _, _)| {
                *e != self.open_epoch
                    || w != workspace
                    || *a != authority
                    || *loc_rev != current_loc_rev
            })
        {
            self.location_flight = None;
            changed = true;
        }
        if let Some((started_loc_rev, result)) = self
            .location_flight
            .as_ref()
            .and_then(|(_, _, _, loc_rev, _, inbox)| inbox.try_recv().ok().map(|r| (*loc_rev, r)))
        {
            self.location_flight = None;
            if started_loc_rev == current_loc_rev {
                match result.filter(|dir| absolute_server_path(dir)) {
                    Some(dir) => {
                        self.pinned_directory = Some(dir);
                        self.pinned_location_revision = Some(current_loc_rev);
                        self.pinned_target = Some((
                            backend.clone(),
                            workspace.to_owned(),
                            session.map(str::to_owned),
                        ));
                        self.location_failed = None;
                    }
                    None => {
                        self.location_failed = Some((
                            self.open_epoch,
                            workspace.to_owned(),
                            authority,
                            revision,
                            current_loc_rev,
                        ));
                    }
                }
            }
            changed = true;
        }
        let failed = self
            .location_failed
            .as_ref()
            .is_some_and(|(e, w, a, r, loc_rev)| {
                *e == self.open_epoch
                    && w == workspace
                    && *a == authority
                    && *r == revision
                    && *loc_rev == current_loc_rev
            });
        if self.pinned_directory.is_none() && self.location_flight.is_none() && !failed {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let backend = backend.clone();
            let workspace_owned = workspace.to_owned();
            let session = session.map(str::to_owned);
            let wake = wake.clone();
            self.location_flight = Some((
                self.open_epoch,
                workspace_owned.clone(),
                authority,
                current_loc_rev,
                cancel,
                inbox,
            ));
            platform::spawn(async move {
                let task =
                    resolve_workspace_directory(&backend, &workspace_owned, session.as_deref());
                if let Some(result) = platform::reads::cancellable(&cancelled, task).await
                    && out.send(result.ok()).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        (changed, failed)
    }

    pub(in crate::settings) fn rebind(&mut self, same_address: bool) {
        self.revoke_location();
        self.defaults.rebind(same_address);
        self.library.rebind(same_address);
        self.depth.rebind(same_address);
        if !same_address {
            self.scope = None;
            self.profiles_open = false;
        }
        self.pinned_directory = None;
        self.pinned_location_revision = None;
        self.pinned_target = None;
        self.location_authority = None;
        self.location_flight = None;
        self.location_failed = None;
    }

    pub(in crate::settings) fn suspend_reads(&mut self) {
        self.location_flight = None;
        self.depth.suspend();
    }

    pub(in crate::settings) fn config_write_in_flight(&self) -> bool {
        self.defaults.write_in_flight() || self.library.write_in_flight()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn draining(
        &self,
        can_start_write: bool,
        config_refreshing: bool,
    ) -> bool {
        self.depth.saving()
            || self.library.draining(can_start_write, config_refreshing)
            || self.defaults.draining(can_start_write, config_refreshing)
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn needs_config_revalidation(&self) -> bool {
        self.library.needs_config_revalidation() || self.defaults.needs_config_revalidation()
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn pending_ops(&self) -> u32 {
        self.defaults
            .pending_ops()
            .saturating_add(self.library.pending_ops())
            .saturating_add(u32::from(self.depth.saving()))
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(in crate::settings) fn has_unconfirmed(&self) -> bool {
        self.defaults.has_unconfirmed()
            || self.library.has_unconfirmed()
            || self.depth.has_unconfirmed()
    }

    pub(in crate::settings) fn poll_writes(
        &mut self,
        ctx: &ConfigContext<'_>,
        launch_pending_depth: bool,
        wake: &Waker,
    ) -> ConfigEffects {
        let mut effects = self.defaults.poll_replies(ctx);
        effects.merge(self.library.poll_replies(ctx));
        let (depth_changed, depth_settled) = self.depth.poll_background_writes(
            ctx.transport_lost,
            launch_pending_depth,
            &ctx.prefs_authority,
            &self.location_token,
            #[cfg(test)]
            &mut self.pre_depth_put_gate,
            #[cfg(test)]
            &mut self.post_attest_depth_gate,
            wake,
        );
        effects.changed |= depth_changed;
        effects.settled |= depth_settled;

        if !effects.invalidate {
            effects.merge(self.defaults.settle_config(ctx));
            effects.merge(self.library.settle_config(ctx));
        }

        if !effects.invalidate && ctx.can_start_write() && !self.config_write_in_flight() {
            effects.merge(self.defaults.launch_next(
                ctx,
                #[cfg(test)]
                &mut self.pre_patch_gate,
                wake,
            ));
            if !effects.invalidate && !self.config_write_in_flight() {
                effects.merge(self.library.launch_next(
                    ctx,
                    #[cfg(test)]
                    &mut self.pre_patch_gate,
                    wake,
                ));
            }
        }
        effects
    }

    pub(super) fn poll_depth(
        &mut self,
        target: Option<&Target>,
        location_failed: bool,
        transport_lost: bool,
        active: bool,
        prefs_authority: &Arc<AtomicU64>,
        wake: &Waker,
    ) -> bool {
        let pinned = self.pinned_directory.as_deref();
        self.depth.poll(
            target,
            pinned,
            location_failed,
            self.open_epoch,
            transport_lost,
            active,
            prefs_authority,
            &self.location_token,
            #[cfg(test)]
            &mut self.pre_depth_put_gate,
            #[cfg(test)]
            &mut self.post_attest_depth_gate,
            wake,
        )
    }

    pub(in crate::settings) fn start_defaults_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
    ) -> ConfigEffects {
        self.defaults.start_reload(ctx)
    }

    pub(in crate::settings) fn toggle_delete_sessions(
        &mut self,
        ctx: &ConfigContext<'_>,
        next: bool,
        wake: &Waker,
    ) -> bool {
        if !self.defaults.queue_delete_sessions(ctx, next) {
            return false;
        }
        if ctx.can_start_write() && !self.config_write_in_flight() {
            let _ = self.defaults.launch_next(
                ctx,
                #[cfg(test)]
                &mut self.pre_patch_gate,
                wake,
            );
        }
        true
    }

    pub(in crate::settings) fn start_library_reload(
        &mut self,
        ctx: &ConfigContext<'_>,
    ) -> ConfigEffects {
        self.library.start_reload(ctx)
    }

    pub(in crate::settings) fn start_model_remove(
        &mut self,
        ctx: &ConfigContext<'_>,
        id: &str,
        owner: &str,
        expected: MissionPreferenceExpectation,
        wake: &Waker,
    ) -> bool {
        if !self.library.queue_remove(ctx, id, owner, expected) {
            return false;
        }
        if ctx.can_start_write() && !self.config_write_in_flight() {
            let _ = self.library.launch_next(
                ctx,
                #[cfg(test)]
                &mut self.pre_patch_gate,
                wake,
            );
        }
        true
    }

    pub(in crate::settings) fn start_models_reset(
        &mut self,
        ctx: &ConfigContext<'_>,
        owner: &str,
        expected: MissionPreferenceExpectation,
        wake: &Waker,
    ) -> bool {
        if !self.library.queue_reset(ctx, owner, expected) {
            return false;
        }
        if ctx.can_start_write() && !self.config_write_in_flight() {
            let _ = self.library.launch_next(
                ctx,
                #[cfg(test)]
                &mut self.pre_patch_gate,
                wake,
            );
        }
        true
    }
}

pub(in crate::settings) fn opener_directory(s: &crate::State) -> Option<String> {
    let has_active_session = if s.screen.launcher().is_some() {
        crate::workspace::active_session(s).is_some()
    } else {
        crate::settings::bound_backend(s).is_some_and(|backend| !backend.session.is_empty())
    };
    if has_active_session {
        return None;
    }
    if let Some((_, directory)) = crate::git::file_link_scope(s)
        && absolute_server_path(directory)
    {
        return Some(directory.to_owned());
    }
    if let Some(launcher) = s.screen.launcher()
        && let Some(project) = launcher.project.as_ref()
        && absolute_server_path(&project.path)
    {
        return Some(project.path.clone());
    }
    None
}
