mod live_flag;
mod owner;
mod poll;
mod runner;

pub(crate) use live_flag::LiveFlag;
#[cfg(test)]
use live_flag::PHASE_CANCELLED;
use live_flag::{PHASE_DISPATCHED, PHASE_PREFLIGHT};

use super::lifecycle::MissionKey;
#[cfg(test)]
use super::lifecycle::Source;
use codenomad_client::{
    Receiver,
    backend::Backend,
    missions::{Cleanup, DeletionRequest, LifecycleTarget},
};
#[cfg(test)]
use codenomad_client::{Wake, bounded};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

const CAPACITY: usize = 64;
const DOCUMENT_CLEANUP_CAP: usize = 2_000;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(crate) struct WorkspaceScope {
    pub server: String,
    pub workspace: String,
    pub project: String,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub(super) struct CleanupKey {
    scope: WorkspaceScope,
    deletion_id: String,
    mission_id: String,
    request_id: String,
    expected_revision: u64,
    delete_managed_sessions: bool,
    created_at_bits: u64,
}

impl CleanupKey {
    pub fn new(scope: WorkspaceScope, cleanup: &Cleanup) -> Self {
        Self {
            scope,
            deletion_id: cleanup.deletion_id.clone(),
            mission_id: cleanup.mission_id.clone(),
            request_id: cleanup.request_id.clone(),
            expected_revision: cleanup.expected_revision,
            delete_managed_sessions: cleanup.delete_managed_sessions,
            created_at_bits: cleanup.created_at.to_bits(),
        }
    }

    pub fn identity(&self) -> super::directory::CleanupIdentity {
        (
            self.mission_id.clone(),
            self.deletion_id.clone(),
            self.request_id.clone(),
            self.expected_revision,
            self.delete_managed_sessions,
            self.created_at_bits,
        )
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum DeleteState {
    Busy,
    Failed(&'static str),
}

pub(super) enum DeleteResult {
    Deleted {
        receipt: Option<Box<Cleanup>>,
        dispatched: bool,
    },
    Failed {
        key: &'static str,
        dispatched: bool,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
        tombstoned: bool,
    },
    Cancelled {
        dispatched: bool,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
        tombstoned: bool,
    },
    AuthExpired {
        backend: Backend,
        document_cleanup: bool,
        deletion_id: Option<String>,
        created_at_bits: Option<u64>,
    },
}

pub(super) struct DeleteIntent {
    scope: WorkspaceScope,
    pub(super) title: String,
    target: LifecycleTarget,
    request: DeletionRequest,
    pub(super) flight: Option<Receiver<DeleteResult>>,
    flight_live: Option<LiveFlag>,
    flight_cancel: Option<Receiver<()>>,
    flight_phase: Option<Arc<AtomicU8>>,
    pub(super) error: Option<&'static str>,
    document_cleanup: bool,
    deletion_id: Option<String>,
    created_at_bits: Option<u64>,
    retired: bool,
}

impl DeleteIntent {
    pub(super) fn request_id(&self) -> &str {
        &self.request.request_id
    }
}

enum CleanupRetryResult {
    Settled {
        receipt: Box<Cleanup>,
        mutated: bool,
        document_cleanup: bool,
    },
    Failed {
        key: &'static str,
        mutated: bool,
        document_cleanup: bool,
    },
    Cancelled {
        mutated: bool,
        document_cleanup: bool,
    },
    AuthExpired {
        backend: Backend,
        document_cleanup: bool,
    },
}

struct CleanupRetry {
    key: CleanupKey,
    view_live: LiveFlag,
    row_live: LiveFlag,
    cancel: Option<Receiver<()>>,
    phase: Arc<AtomicU8>,
    flight: Receiver<CleanupRetryResult>,
    retired: bool,
}

impl CleanupRetry {
    fn is_live_or_dispatched(&self) -> bool {
        !self.retired
            && (self.phase.load(Ordering::Acquire) == PHASE_DISPATCHED
                || (self.phase.load(Ordering::Acquire) == PHASE_PREFLIGHT
                    && self.view_live.is_live()
                    && self.row_live.is_live()))
    }
}

#[derive(Default)]
pub(super) struct CleanupPolled {
    pub refreshed_missions: Vec<(MissionKey, LifecycleTarget)>,
    pub refreshed_scopes: Vec<WorkspaceScope>,
    pub deleted_missions: Vec<(WorkspaceScope, String)>,
    pub settled_cleanups: Vec<(WorkspaceScope, Cleanup)>,
    pub document_pending_rows: Vec<(WorkspaceScope, super::directory::CleanupIdentity)>,
    pub auth_expired: Vec<Backend>,
    pub changed: bool,
}

impl CleanupPolled {
    pub fn is_empty(&self) -> bool {
        !self.changed
            && self.refreshed_missions.is_empty()
            && self.refreshed_scopes.is_empty()
            && self.deleted_missions.is_empty()
            && self.settled_cleanups.is_empty()
            && self.document_pending_rows.is_empty()
            && self.auth_expired.is_empty()
    }
}

#[derive(Default)]
pub(super) struct CleanupOwner {
    deletes: HashMap<(WorkspaceScope, MissionKey), DeleteIntent>,
    retries: HashMap<WorkspaceScope, CleanupRetry>,
    retry_errors: HashMap<WorkspaceScope, (String, String, &'static str)>,
    document_cleanups: HashSet<CleanupKey>,
    document_cleanup_order: VecDeque<CleanupKey>,
    state_gen: u64,
}

#[cfg(test)]
mod tests;
