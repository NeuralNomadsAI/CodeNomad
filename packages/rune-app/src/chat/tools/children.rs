mod copy;
mod expand;
mod navigation;
mod snapshot;
mod watch;
mod watcher;

pub(crate) use copy::note_clipboard_write;

use crate::{
    State,
    backend::Backend,
    content::{Part, SubagentReport, Tool},
};
use codenomad_client::{Receiver, bounded, runtime};
use std::{
    cell::Cell,
    collections::{HashMap, HashSet, VecDeque},
    rc::{Rc, Weak},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

pub(super) const STEP_LIMIT: usize = 200;
const CHILD_LIMIT: usize = 12;
const RETAINED_LIMIT: usize = 24;
const WAITING_LIMIT: usize = 32;
pub(super) const STEP_BYTES: usize = 2 << 20;
pub(super) const MAX_TRUNCATED_IMAGE_PATH_BYTES: usize = 4 * 1024;
pub(super) const MAX_TRUNCATED_IMAGE_SNAPSHOT_BYTES: usize = 32 * 1024;

pub(super) fn tool_image_shadows_bytes(groups: &crate::chat::document::ToolImageShadows) -> usize {
    let base = groups
        .len()
        .saturating_mul(std::mem::size_of::<Box<[Box<str>]>>());
    groups.iter().fold(base, |acc, paths| {
        paths.iter().fold(
            acc.saturating_add(paths.len().saturating_mul(std::mem::size_of::<Box<str>>())),
            |inner, path| inner.saturating_add(path.len()),
        )
    })
}

pub(super) fn truncated_image_entry_bytes(
    msg_id: &str,
    tool_id: &str,
    groups: &crate::chat::document::ToolImageShadows,
) -> usize {
    std::mem::size_of::<(Box<str>, Box<str>, crate::chat::document::ToolImageShadows)>()
        .saturating_add(msg_id.len())
        .saturating_add(tool_id.len())
        .saturating_add(tool_image_shadows_bytes(groups))
}

pub(super) fn dropped_image_entry_bytes(groups: &crate::chat::document::ToolImageShadows) -> usize {
    std::mem::size_of::<crate::chat::document::ToolImageShadows>()
        .saturating_add(tool_image_shadows_bytes(groups))
}
const MAX_COPY_PAGES: usize = 64;
pub(super) const MAX_COPY_BYTES: usize = 32 * 1024 * 1024;
const MAX_EXPANDED_REPORTS: usize = 8;
const MAX_EXPANDED_REPORT_BYTES: usize = codenomad_client::history::MESSAGE_BYTES;
const COPY_BUDGET: Duration = Duration::from_secs(30);
const MAX_PENDING_EVENTS: usize = 32;
const MAX_PENDING_BYTES: usize = 256 * 1024;
type Steps = Vec<(String, Arc<Tool>)>;
type ChildKey = (Option<String>, String);

fn child_key(parent: Option<&str>, id: &str) -> ChildKey {
    (parent.map(str::to_owned), id.to_owned())
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ReportCopyKey {
    pub key: String,
    pub parent: String,
    pub row_id: String,
    pub part_index: usize,
    pub child: String,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ToolCopyKey {
    pub key: String,
    pub parent: Option<String>,
    pub child: String,
    pub row_id: String,
    pub call: String,
    pub section: u8,
}

#[derive(Clone, PartialEq, Eq)]
pub(super) enum CopyKey {
    Report(ReportCopyKey),
    ToolSection(ToolCopyKey),
    Steps {
        key: String,
        parent: Option<String>,
        child: String,
    },
}

impl CopyKey {
    fn touches_child(&self, id: &str) -> bool {
        match self {
            Self::Report(k) => k.parent == id || k.child == id,
            Self::ToolSection(k) => k.child == id || k.parent.as_deref() == Some(id),
            Self::Steps { parent, child, .. } => child == id || parent.as_deref() == Some(id),
        }
    }
}

enum NavOutcome {
    Verified(String),
    VerifiedInTab(String, String),
    Missing,
    Error,
}

struct CopyRevocation {
    _rx: Receiver<()>,
    settlement: Arc<codenomad_client::stream::ChildSettlement>,
    rev_before: u64,
}

impl CopyRevocation {
    fn is_revoked(&self) -> bool {
        self.settlement.revocation_gen() != self.rev_before
    }
}

#[derive(Clone, PartialEq)]
pub(super) struct ChildReport {
    pub row_id: String,
    pub part_index: usize,
    pub report: Arc<SubagentReport>,
    pub truncated: bool,
}

type Reports = Vec<ChildReport>;

#[derive(Default, PartialEq)]
struct Snapshot {
    steps: Steps,
    steps_truncated: bool,
    steps_incomplete: bool,
    older_pages: bool,
    truncated_tools: HashSet<(String, String)>,
    truncated_tool_images: Box<[(Box<str>, Box<str>, crate::chat::document::ToolImageShadows)]>,
    dropped_tool_images: Box<[crate::chat::document::ToolImageShadows]>,
    truncated_tool_images_overflow: bool,
    reports: Reports,
}

#[derive(Clone, Copy, Default)]
pub(in crate::chat) struct ChildToolState<'a> {
    pub steps: &'a [(String, Arc<Tool>)],
    pub truncated_images: &'a [(Box<str>, Box<str>, crate::chat::document::ToolImageShadows)],
    pub dropped_images: &'a [crate::chat::document::ToolImageShadows],
    pub older_pages: bool,
}

enum ChildUpdate {
    Loaded {
        snapshot: Snapshot,
        settled: bool,
        unavailable: bool,
    },
    Settled,
    Unverified,
    Failed,
}

enum ReportCopy {
    Idle,
    Loading {
        key: CopyKey,
        epoch: u64,
        scope: Rc<()>,
        baseline: Rc<Cell<Option<u64>>>,
        lease: Option<Weak<()>>,
        revocation: CopyRevocation,
        _cancel: codenomad_client::Sender<()>,
        rx: Receiver<Option<String>>,
    },
    #[cfg(target_arch = "wasm32")]
    Confirming {
        key: CopyKey,
        epoch: u64,
        rx: Receiver<bool>,
    },
    #[allow(dead_code)]
    Ready {
        key: CopyKey,
        text: String,
        revocation: CopyRevocation,
    },
    #[allow(dead_code)]
    Copied {
        key: CopyKey,
    },
    Failed {
        key: CopyKey,
    },
}

impl Default for ReportCopy {
    fn default() -> Self {
        Self::Idle
    }
}

#[derive(Clone, PartialEq, Eq)]
enum ExpandKey {
    Report(ReportCopyKey),
    ToolOutput(ToolCopyKey),
}

impl ExpandKey {
    fn ui_key(&self) -> &str {
        match self {
            Self::Report(k) => &k.key,
            Self::ToolOutput(k) => &k.key,
        }
    }

    fn touches_child(&self, id: &str) -> bool {
        match self {
            Self::Report(k) => k.parent == id || k.child == id,
            Self::ToolOutput(k) => k.child == id || k.parent.as_deref() == Some(id),
        }
    }
}

#[derive(Default)]
pub(crate) struct Children {
    backend: Option<Backend>,
    entries: HashMap<ChildKey, Entry>,
    unavailable: HashSet<ChildKey>,
    unavailable_catalogue_gen: u64,
    waiting: VecDeque<(ChildKey, String, Weak<()>)>,
    report_copy: ReportCopy,
    expanded_reports: VecDeque<(ExpandKey, String)>,
    expanded_report_bytes: usize,
    loading_report: Option<(
        ExpandKey,
        CopyRevocation,
        codenomad_client::Sender<()>,
        Receiver<Option<String>>,
    )>,
    failed_report: Option<ExpandKey>,
    pending_nav: Option<(
        ChildKey,
        u64,
        codenomad_client::Sender<()>,
        Receiver<NavOutcome>,
    )>,
    background_pending: Option<(codenomad_client::Sender<()>, Receiver<bool>)>,
    #[cfg(test)]
    started_entries: Vec<(Option<String>, String, String)>,
}

struct Watcher {
    _cancel: codenomad_client::Sender<()>,
    retry: codenomad_client::Sender<()>,
    result: Receiver<ChildUpdate>,
}

enum WatchState {
    Active(Watcher),
    Dormant {
        _cancel: codenomad_client::Sender<()>,
        wake: Receiver<bool>,
        pending_promote: bool,
    },
    Pending,
}

struct Entry {
    cards: HashMap<String, Weak<()>>,
    watch: WatchState,
    snapshot: Snapshot,
    load_error: bool,
    settled: bool,
}

impl Children {
    pub(crate) fn bind(&mut self, backend: Backend) {
        self.clear();
        self.backend = Some(backend);
    }

    pub(crate) fn clear(&mut self) {
        self.entries.clear();
        self.unavailable.clear();
        self.waiting.clear();
        self.report_copy = ReportCopy::Idle;
        self.expanded_reports.clear();
        self.expanded_report_bytes = 0;
        self.loading_report = None;
        self.failed_report = None;
        self.pending_nav = None;
        self.background_pending = None;
    }

    pub(crate) fn retained_bytes(&self) -> usize {
        let mut total = self.expanded_report_bytes;
        if let ReportCopy::Ready { text, .. } = &self.report_copy {
            total = total.saturating_add(text.len());
        }
        for ((parent, id), entry) in &self.entries {
            total = total
                .saturating_add(parent.as_deref().map_or(0, str::len))
                .saturating_add(id.len());
            for (msg_id, tool) in &entry.snapshot.steps {
                total = total
                    .saturating_add(msg_id.len())
                    .saturating_add(tool.id.len())
                    .saturating_add(tool.name.len())
                    .saturating_add(tool.status.len())
                    .saturating_add(tool.output.len())
                    .saturating_add(tool.error.len());
            }
            for report in &entry.snapshot.reports {
                total = total
                    .saturating_add(report.row_id.len())
                    .saturating_add(report.report.child.len())
                    .saturating_add(report.report.state.len())
                    .saturating_add(report.report.body.len());
            }
            for (msg_id, tool_id, groups) in entry.snapshot.truncated_tool_images.iter() {
                total = total.saturating_add(truncated_image_entry_bytes(msg_id, tool_id, groups));
            }
            for groups in entry.snapshot.dropped_tool_images.iter() {
                total = total.saturating_add(dropped_image_entry_bytes(groups));
            }
        }
        total
    }

    pub(super) fn unavailable(&self, parent: Option<&str>, id: &str) -> bool {
        self.unavailable.contains(&child_key(parent, id))
    }

    pub(super) fn has_open_tab_fallback(&self, s: &State, id: &str) -> bool {
        self.backend.as_ref().is_some_and(|backend| {
            crate::workspace::open_session_tab_target(s, backend, id).is_some()
        })
    }

    pub(super) fn is_waiting(&self, parent: Option<&str>, id: &str) -> bool {
        let ck = child_key(parent, id);
        self.waiting
            .iter()
            .any(|(wck, _, lease)| *wck == ck && lease.strong_count() > 0)
    }

    fn mark_unavailable(&mut self, ck: ChildKey) {
        if self.unavailable.len() >= 64 && !self.unavailable.contains(&ck) {
            self.unavailable.clear();
        }
        self.unavailable.insert(ck);
    }

    pub(super) fn release(s: &mut State, key: &str) {
        let prefix = format!("{key}-");
        let nested_pane = format!("{key}-task-steps-");
        let owns_card =
            |card: &str| card == key || card.starts_with(&prefix) || card.contains(&nested_pane);
        let children = &mut s.transcript_display.children;
        children.entries.retain(|_, entry| {
            entry
                .cards
                .retain(|card, lease| lease.strong_count() > 0 && !owns_card(card));
            !entry.cards.is_empty()
        });
        children.waiting.retain(|(_, card, _)| !owns_card(card));
        let matches_card = |ui_key: &str| {
            ui_key
                .strip_prefix("copy-")
                .and_then(|rest| {
                    rest.strip_suffix("-output")
                        .or_else(|| rest.strip_suffix("-input"))
                        .or_else(|| rest.strip_suffix("-error"))
                        .or_else(|| rest.strip_suffix("-steps"))
                })
                .is_some_and(owns_card)
        };
        let clear_copy = match &children.report_copy {
            ReportCopy::Loading { key: current, .. }
            | ReportCopy::Ready { key: current, .. }
            | ReportCopy::Copied { key: current }
            | ReportCopy::Failed { key: current } => match current {
                CopyKey::Report(k) => matches_card(&k.key),
                CopyKey::ToolSection(k) => matches_card(&k.key),
                CopyKey::Steps { key: k, .. } => matches_card(k),
            },
            #[cfg(target_arch = "wasm32")]
            ReportCopy::Confirming { key: current, .. } => match current {
                CopyKey::Report(k) => matches_card(&k.key),
                CopyKey::ToolSection(k) => matches_card(&k.key),
                CopyKey::Steps { key: k, .. } => matches_card(k),
            },
            ReportCopy::Idle => false,
        };
        if clear_copy {
            children.report_copy = ReportCopy::Idle;
        }
        children.expanded_reports.retain(|(current, text)| {
            let drop = matches_card(current.ui_key());
            if drop {
                children.expanded_report_bytes =
                    children.expanded_report_bytes.saturating_sub(text.len());
            }
            !drop
        });
        if children
            .loading_report
            .as_ref()
            .is_some_and(|(current, _, _, _)| matches_card(current.ui_key()))
        {
            children.loading_report = None;
        }
        if children
            .failed_report
            .as_ref()
            .is_some_and(|current| matches_card(current.ui_key()))
        {
            children.failed_report = None;
        }
        Self::promote_waiting(s);
    }

    pub(super) fn steps(&self, parent: Option<&str>, id: &str) -> &[(String, Arc<Tool>)] {
        self.entries
            .get(&child_key(parent, id))
            .map_or(&[], |entry| entry.snapshot.steps.as_slice())
    }

    pub(in crate::chat) fn verified_tool_state(
        &self,
        parent: Option<&str>,
        id: &str,
    ) -> ChildToolState<'_> {
        let key = child_key(parent, id);
        if self.unavailable.contains(&key) {
            return ChildToolState::default();
        }
        self.entries
            .get(&key)
            .filter(|entry| !entry.load_error && !entry.snapshot.truncated_tool_images_overflow)
            .map_or_else(ChildToolState::default, |entry| ChildToolState {
                steps: entry.snapshot.steps.as_slice(),
                truncated_images: entry.snapshot.truncated_tool_images.as_ref(),
                dropped_images: entry.snapshot.dropped_tool_images.as_ref(),
                older_pages: entry.snapshot.older_pages,
            })
    }

    pub(super) fn steps_truncated(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.snapshot.steps_truncated)
    }

    pub(super) fn tool_truncated(
        &self,
        parent: Option<&str>,
        id: &str,
        row_id: &str,
        call: &str,
    ) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| {
                entry
                    .snapshot
                    .truncated_tools
                    .contains(&(row_id.to_owned(), call.to_owned()))
            })
    }

    pub(super) fn steps_incomplete(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.snapshot.steps_incomplete)
    }

    pub(super) fn load_error(&self, parent: Option<&str>, id: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.load_error)
    }

    pub(super) fn reports(&self, parent: Option<&str>, id: &str) -> &[ChildReport] {
        self.entries
            .get(&child_key(parent, id))
            .map_or(&[], |entry| entry.snapshot.reports.as_slice())
    }
}

#[cfg(test)]
impl Children {
    pub(in crate::chat) fn install(&mut self, child: &str, page: crate::history::Page) -> Rc<()> {
        self.install_under(None, child, page)
    }

    pub(super) fn install_under(
        &mut self,
        parent: Option<&str>,
        child: &str,
        page: crate::history::Page,
    ) -> Rc<()> {
        let lease = Rc::default();
        let (out, result) = bounded(1);
        out.try_send(ChildUpdate::Loaded {
            snapshot: snapshot::snapshot(page),
            settled: true,
            unavailable: false,
        })
        .unwrap();
        let (cancel, _) = bounded(1);
        let (retry, _) = bounded(1);
        self.entries.insert(
            child_key(parent, child),
            Entry {
                cards: HashMap::from([("test".into(), Rc::downgrade(&lease))]),
                watch: WatchState::Active(Watcher {
                    _cancel: cancel,
                    retry,
                    result,
                }),
                snapshot: Snapshot::default(),
                load_error: false,
                settled: true,
            },
        );
        lease
    }

    pub(super) fn has_visible_card(&self, parent: Option<&str>, id: &str, card: &str) -> bool {
        self.entries
            .get(&child_key(parent, id))
            .is_some_and(|entry| entry.cards.get(card).is_some_and(|w| w.strong_count() > 0))
    }

    pub(super) fn take_started_entries(&mut self) -> Vec<(Option<String>, String, String)> {
        std::mem::take(&mut self.started_entries)
    }
}
