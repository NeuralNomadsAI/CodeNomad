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

static CLIPBOARD_EPOCH: AtomicU64 = AtomicU64::new(0);

pub(crate) fn note_clipboard_write() {
    CLIPBOARD_EPOCH.fetch_add(1, Ordering::SeqCst);
}

fn next_clipboard_epoch() -> u64 {
    CLIPBOARD_EPOCH.fetch_add(1, Ordering::SeqCst) + 1
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

pub(super) const STEP_LIMIT: usize = 200;
const CHILD_LIMIT: usize = 12;
const RETAINED_LIMIT: usize = 24;
const WAITING_LIMIT: usize = 32;
pub(super) const STEP_BYTES: usize = 2 << 20;
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
    truncated_tools: HashSet<(String, String)>,
    reports: Reports,
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

    pub(crate) fn cancel_copy(&mut self) {
        note_clipboard_write();
        self.report_copy = ReportCopy::Idle;
    }

    pub(super) fn commit_ready_copy(s: &mut State, key: &CopyKey, tx: &mut rune::Tx) -> bool {
        let ready = match &s.transcript_display.children.report_copy {
            ReportCopy::Ready {
                key: current,
                revocation,
                ..
            } if current == key => {
                if revocation.is_revoked() {
                    s.transcript_display.children.report_copy = ReportCopy::Idle;
                    return false;
                }
                match std::mem::take(&mut s.transcript_display.children.report_copy) {
                    ReportCopy::Ready { text, .. } => Some(text),
                    _ => None,
                }
            }
            _ => None,
        };
        let Some(text) = ready else {
            return false;
        };
        #[cfg(not(target_arch = "wasm32"))]
        {
            note_clipboard_write();
            tx.copy(text);
            s.transcript_display.children.report_copy = ReportCopy::Copied { key: key.clone() };
        }
        #[cfg(target_arch = "wasm32")]
        {
            let _ = tx;
            let epoch = next_clipboard_epoch();
            let (out, rx) = bounded(1);
            let wake = s.wake.clone();
            crate::platform::diagnostics::copy(&text, move |copied| {
                if out.try_send(copied).is_ok() {
                    wake();
                }
            });
            s.transcript_display.children.report_copy = ReportCopy::Confirming {
                key: key.clone(),
                epoch,
                rx,
            };
        }
        true
    }

    pub(super) fn copy_failed(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Failed { key: current } if current == key)
    }

    pub(super) fn copy_copied(&self, key: &CopyKey) -> bool {
        matches!(&self.report_copy, ReportCopy::Copied { key: current } if current == key)
    }

    pub(super) fn copy_ready(&self, key: &CopyKey) -> bool {
        matches!(
            &self.report_copy,
            ReportCopy::Ready {
                key: current,
                revocation,
                ..
            } if current == key && !revocation.is_revoked()
        )
    }

    pub(super) fn loaded_report(&self, key: &ReportCopyKey) -> Option<&str> {
        let target = ExpandKey::Report(key.clone());
        self.expanded_reports
            .iter()
            .find(|(current, _)| current == &target)
            .map(|(_, text)| text.as_str())
    }

    pub(super) fn expand_failed(&self, key: &ReportCopyKey) -> bool {
        self.failed_report.as_ref() == Some(&ExpandKey::Report(key.clone()))
    }

    pub(super) fn loaded_tool_output(&self, key: &ToolCopyKey) -> Option<&str> {
        let target = ExpandKey::ToolOutput(key.clone());
        self.expanded_reports
            .iter()
            .find(|(current, _)| current == &target)
            .map(|(_, text)| text.as_str())
    }

    pub(super) fn expand_tool_failed(&self, key: &ToolCopyKey) -> bool {
        self.failed_report.as_ref() == Some(&ExpandKey::ToolOutput(key.clone()))
    }

    pub(super) fn release(s: &mut State, key: &str) {
        let prefix = format!("{key}-");
        let children = &mut s.transcript_display.children;
        children.entries.retain(|_, entry| {
            entry
                .cards
                .retain(|card, _| card != key && !card.starts_with(&prefix));
            !entry.cards.is_empty()
        });
        children
            .waiting
            .retain(|(_, card, _)| card != key && !card.starts_with(&prefix));
        let matches_card = |ui_key: &str| {
            ui_key
                .strip_prefix("copy-")
                .and_then(|rest| {
                    rest.strip_suffix("-output")
                        .or_else(|| rest.strip_suffix("-input"))
                        .or_else(|| rest.strip_suffix("-error"))
                        .or_else(|| rest.strip_suffix("-steps"))
                })
                .is_some_and(|card| card == key || card.starts_with(&prefix))
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

    fn card_lease(&self, ui_key: &str) -> Option<Weak<()>> {
        let card = ui_key.strip_prefix("copy-").and_then(|rest| {
            rest.strip_suffix("-output")
                .or_else(|| rest.strip_suffix("-input"))
                .or_else(|| rest.strip_suffix("-error"))
                .or_else(|| rest.strip_suffix("-steps"))
        })?;
        self.entries
            .values()
            .find_map(|entry| {
                entry.cards.get(card).cloned().or_else(|| {
                    entry
                        .cards
                        .iter()
                        .find_map(|(k, w)| card.starts_with(&format!("{k}-")).then(|| w.clone()))
                })
            })
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(_, wkey, _)| wkey == card)
                    .map(|(_, _, lease)| lease.clone())
            })
    }

    fn fetch_report(
        s: &State,
        key: &ReportCopyKey,
        shared: Option<(Arc<codenomad_client::stream::ChildSettlement>, u64)>,
    ) -> Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)> {
        let backend = s.transcript_display.children.backend.clone()?;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let (parent, row_id, part_index, child) = (
            key.parent.clone(),
            key.row_id.clone(),
            key.part_index,
            key.child.clone(),
        );
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let body = with_timeout(COPY_BUDGET, async {
                    let (_owned_rx, settlement, rev_before) = match shared {
                        Some((settlement, rev_before)) => (None, settlement, rev_before),
                        None => {
                            let (rx, settlement) = backend.watch_child(&parent)?;
                            let rev = settlement.revocation_gen();
                            (Some(rx), settlement, rev)
                        }
                    };
                    let _slot = reads.background(&cancelled).await?;
                    let page = backend.child_page(&parent).await.ok().flatten()?;
                    if settlement.revocation_gen() != rev_before {
                        return None;
                    }
                    page.rows
                        .iter()
                        .find(|row| row.id == row_id)
                        .and_then(|row| {
                            row.parts
                                .get(part_index)
                                .and_then(|part| match part {
                                    Part::SubagentReport(report) if report.child == child => {
                                        Some(report.body.clone())
                                    }
                                    _ => None,
                                })
                                .or_else(|| {
                                    row.parts.iter().rev().find_map(|part| match part {
                                        Part::SubagentReport(report) if report.child == child => {
                                            Some(report.body.clone())
                                        }
                                        _ => None,
                                    })
                                })
                        })
                })
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
        Some((cancel, rx))
    }

    fn fetch_tool_section(
        s: &State,
        key: &ToolCopyKey,
        shared: Option<(Arc<codenomad_client::stream::ChildSettlement>, u64)>,
    ) -> Option<(codenomad_client::Sender<()>, Receiver<Option<String>>)> {
        let backend = s.transcript_display.children.backend.clone()?;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let key = key.clone();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let expected_parent = key.parent.as_deref().unwrap_or(&backend.session);
                let body = with_timeout(COPY_BUDGET, async {
                    let (_owned_rx, settlement, rev_before) = match shared {
                        Some((settlement, rev_before)) => (None, settlement, rev_before),
                        None => {
                            let (rx, settlement) = backend.watch_child(&key.child)?;
                            let rev = settlement.revocation_gen();
                            (Some(rx), settlement, rev)
                        }
                    };
                    let location = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_ownership_token(&key.child, expected_parent)
                            .await
                            .ok()??
                    };
                    let page = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_page_request(
                                &key.child,
                                serde_json::json!({"kind": "around", "messageID": key.row_id}),
                            )
                            .await
                            .ok()
                    };
                    let page = match page {
                        Some(page) => page,
                        None => {
                            let _slot = reads.background(&cancelled).await?;
                            backend
                                .child_page_under(&key.child, expected_parent)
                                .await
                                .ok()??
                        }
                    };
                    let still_owned = {
                        let _slot = reads.background(&cancelled).await?;
                        backend
                            .child_ownership_token(&key.child, expected_parent)
                            .await
                            .ok()?
                    };
                    if still_owned != Some(location) || settlement.revocation_gen() != rev_before {
                        return None;
                    }
                    let tool =
                        page.rows
                            .iter()
                            .find(|row| row.id == key.row_id)
                            .and_then(|row| {
                                row.parts.iter().find_map(|part| match part {
                                    Part::Tool(tool) if tool.id == key.call => Some(tool.as_ref()),
                                    _ => None,
                                })
                            })?;
                    match key.section {
                        0 => super::format::bounded_json(&tool.input, MAX_COPY_BYTES),
                        1 => {
                            if let Some(value) = super::format::structured_output(tool) {
                                match super::format::format_unknown(value, Some(MAX_COPY_BYTES)) {
                                    super::format::Formatted::Text(source, _) => Some(source),
                                    _ => None,
                                }
                            } else if tool.name == "todowrite" {
                                super::todo::copy(tool)
                            } else if matches!(tool.name.as_str(), "apply_patch" | "patch") {
                                super::apply_patch::copy_all(None, tool).or_else(|| {
                                    let mut parts = [""; 4];
                                    super::output(tool, &mut parts);
                                    let joined = parts.concat();
                                    (!joined.is_empty()).then_some(joined)
                                })
                            } else {
                                let mut parts = [""; 4];
                                super::output(tool, &mut parts);
                                Some(parts.concat())
                            }
                        }
                        _ => Some(super::error(tool).to_owned()),
                    }
                })
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
        Some((cancel, rx))
    }

    pub(super) fn copy_report(s: &mut State, key: ReportCopyKey, tx: &mut rune::Tx) {
        let lease = s.transcript_display.children.card_lease(&key.key);
        let copy_key = CopyKey::Report(key.clone());
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.parent))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_report(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
    }

    pub(super) fn copy_tool_section(s: &mut State, key: ToolCopyKey, tx: &mut rune::Tx) {
        let lease = s.transcript_display.children.card_lease(&key.key);
        let copy_key = CopyKey::ToolSection(key.clone());
        if matches!(&s.transcript_display.children.report_copy, ReportCopy::Loading { key: current, .. } if current == &copy_key)
        {
            return;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.child))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_tool_section(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
    }

    pub(super) fn copy_steps(
        s: &mut State,
        key: String,
        parent: Option<String>,
        child: String,
        tx: &mut rune::Tx,
    ) {
        let lease = s.transcript_display.children.card_lease(&key);
        let copy_key = CopyKey::Steps {
            key,
            parent: parent.clone(),
            child: child.clone(),
        };
        if matches!(&s.transcript_display.children.report_copy, ReportCopy::Loading { key: current, .. } if current == &copy_key)
        {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let Some((watch_rx, settlement)) = backend.watch_child(&child) else {
            s.transcript_display.children.report_copy = ReportCopy::Failed { key: copy_key };
            return;
        };
        let rev_before = settlement.revocation_gen();
        let task_settlement = settlement.clone();
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let epoch = next_clipboard_epoch();
        let scope = s.input_scope.clone();
        let baseline = Rc::new(Cell::new(None));
        #[cfg(not(target_arch = "wasm32"))]
        {
            let capture = baseline.clone();
            tx.read_clipboard(move |_: &mut State, content, _| {
                capture.set(Some(rune_theme_codenomad::clipboard::fingerprint(content)));
            });
        }
        #[cfg(target_arch = "wasm32")]
        let _ = tx;
        s.transcript_display.children.report_copy = ReportCopy::Loading {
            key: copy_key,
            epoch,
            scope,
            baseline,
            lease,
            revocation,
            _cancel: cancel,
            rx,
        };
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let expected_parent = parent.as_deref().unwrap_or(&backend.session);
                let body = with_timeout(
                    COPY_BUDGET,
                    copy_child_steps_bounded(
                        &backend,
                        &reads,
                        &cancelled,
                        &child,
                        expected_parent,
                        &task_settlement,
                        rev_before,
                    ),
                )
                .await;
                if out.send(body).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn background_session(s: &mut State) {
        if s.transcript_display.children.background_pending.is_some() {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            return;
        };
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        s.transcript_display.children.background_pending = Some((cancel, rx));
        let wake = s.wake.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let ok = backend.background().await.is_ok();
                if out.send(ok).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn open_child(s: &mut State, parent: Option<&str>, child: &str, _tx: &mut rune::Tx) {
        if !crate::launcher::can_open_child_session(s) {
            return;
        }
        let Some(backend) = s.transcript_display.children.backend.clone() else {
            return;
        };
        let fallback_tab = crate::workspace::open_session_tab_target(s, &backend, child);
        s.notifications.supersede_navigation();
        let ticket = s.notifications.navigation_ticket();
        let ck = child_key(parent, child);
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        s.transcript_display.children.pending_nav = Some((ck, ticket, cancel, rx));
        let expected_parent = parent.map_or_else(|| backend.session.clone(), str::to_owned);
        let child = child.to_owned();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                let outcome = match backend
                    .child_ownership_token(&child, &expected_parent)
                    .await
                {
                    Ok(Some(_)) => NavOutcome::Verified(child),
                    first @ (Ok(None) | Err(_)) => {
                        if let Some((tab_key, mut tab_backend)) = fallback_tab {
                            tab_backend.session = expected_parent.clone();
                            match tab_backend
                                .child_ownership_token(&child, &expected_parent)
                                .await
                            {
                                Ok(Some(_)) => NavOutcome::VerifiedInTab(tab_key, child),
                                Ok(None) if first.is_ok() => NavOutcome::Missing,
                                Ok(None) | Err(_) => NavOutcome::Error,
                            }
                        } else if first.is_ok() {
                            NavOutcome::Missing
                        } else {
                            NavOutcome::Error
                        }
                    }
                };
                if out.send(outcome).await.is_ok() {
                    wake();
                }
            })
            .await;
        });
    }

    pub(super) fn expand_report(s: &mut State, key: ReportCopyKey) {
        let expand_key = ExpandKey::Report(key.clone());
        if s.transcript_display
            .children
            .expanded_reports
            .iter()
            .any(|(current, _)| current == &expand_key)
            || s.transcript_display
                .children
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| current == &expand_key)
        {
            return;
        }
        if s.transcript_display.children.failed_report.as_ref() == Some(&expand_key) {
            s.transcript_display.children.failed_report = None;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.parent))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_report(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        s.transcript_display.children.loading_report = Some((expand_key, revocation, cancel, rx));
    }

    pub(super) fn expand_tool_output(s: &mut State, key: ToolCopyKey) {
        let expand_key = ExpandKey::ToolOutput(key.clone());
        if s.transcript_display
            .children
            .expanded_reports
            .iter()
            .any(|(current, _)| current == &expand_key)
            || s.transcript_display
                .children
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| current == &expand_key)
        {
            return;
        }
        if s.transcript_display.children.failed_report.as_ref() == Some(&expand_key) {
            s.transcript_display.children.failed_report = None;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.child))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_tool_section(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        s.transcript_display.children.loading_report = Some((expand_key, revocation, cancel, rx));
    }

    pub(crate) fn poll_actions(s: &mut State, tx: &mut rune::Tx) -> bool {
        let mut changed = Self::poll_copy(s, tx);
        let bg = match s.transcript_display.children.background_pending.as_ref() {
            Some((_, rx)) => match rx.try_recv() {
                Ok(ok) => Some(ok),
                Err(error) if error.is_closed() => Some(false),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(ok) = bg {
            s.transcript_display.children.background_pending = None;
            if !ok {
                crate::shell::notifications::emit_outcome(
                    s,
                    crate::shell::notifications::Category::Sessions,
                    None,
                    crate::strings::t("promptInput.background.error.message"),
                    true,
                );
                changed = true;
            }
        }
        let cat_gen = s.screen.launcher().map_or(0, |l| l.catalogue_generation);
        if s.transcript_display.children.unavailable_catalogue_gen != cat_gen {
            s.transcript_display.children.unavailable_catalogue_gen = cat_gen;
            if !s.transcript_display.children.unavailable.is_empty() {
                s.transcript_display.children.unavailable.clear();
                changed = true;
            }
        }
        let nav = match s.transcript_display.children.pending_nav.as_ref() {
            Some((_, _, _, rx)) => match rx.try_recv() {
                Ok(outcome) => Some(outcome),
                Err(error) if error.is_closed() => Some(NavOutcome::Error),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(outcome) = nav {
            let Some((ck, ticket, _, _)) = s.transcript_display.children.pending_nav.take() else {
                return changed;
            };
            if ticket != s.notifications.navigation_ticket() {
                return changed;
            }
            match outcome {
                NavOutcome::Verified(child_id) => {
                    s.transcript_display.children.unavailable.remove(&ck);
                    if crate::launcher::can_open_child_session(s) {
                        crate::launcher::choose_child_ticket(s, child_id, Some(ticket), tx);
                        changed = true;
                    }
                }
                NavOutcome::VerifiedInTab(tab_key, child_id) => {
                    s.transcript_display.children.unavailable.remove(&ck);
                    if crate::workspace::switch_tab_for_child(s, &tab_key, child_id, ticket, tx) {
                        changed = true;
                    }
                }
                NavOutcome::Missing => {
                    if s.transcript_display.children.entries.contains_key(&ck) {
                        s.transcript_display.children.mark_unavailable(ck);
                    }
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t("sessionList.reload.error"),
                        true,
                    );
                    changed = true;
                }
                NavOutcome::Error => {
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t("sessionList.reload.error"),
                        true,
                    );
                    changed = true;
                }
            }
        }
        changed
    }

    fn poll_copy(s: &mut State, tx: &mut rune::Tx) -> bool {
        #[cfg(target_arch = "wasm32")]
        {
            let confirm_outcome = match &s.transcript_display.children.report_copy {
                ReportCopy::Confirming { epoch, rx, .. } => {
                    if CLIPBOARD_EPOCH.load(Ordering::SeqCst) != *epoch {
                        s.transcript_display.children.report_copy = ReportCopy::Idle;
                        return false;
                    }
                    match rx.try_recv() {
                        Ok(copied) => Some(copied),
                        Err(error) if error.is_closed() => Some(false),
                        Err(_) => return false,
                    }
                }
                _ => None,
            };
            if let Some(copied) = confirm_outcome {
                if let ReportCopy::Confirming { key, epoch, .. } =
                    std::mem::take(&mut s.transcript_display.children.report_copy)
                {
                    if CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch {
                        return false;
                    }
                    if copied {
                        note_clipboard_write();
                        s.transcript_display.children.report_copy = ReportCopy::Copied { key };
                    } else {
                        crate::shell::notifications::emit_outcome(
                            s,
                            crate::shell::notifications::Category::Sessions,
                            None,
                            crate::strings::t("messageSection.quote.copyFailed"),
                            true,
                        );
                        s.transcript_display.children.report_copy = ReportCopy::Failed { key };
                    }
                    return true;
                }
                return false;
            }
        }
        let outcome = match &s.transcript_display.children.report_copy {
            ReportCopy::Loading {
                epoch,
                scope,
                lease,
                revocation,
                rx,
                ..
            } => {
                if !s.current_scope(scope)
                    || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
                    || revocation.is_revoked()
                    || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != *epoch
                {
                    s.transcript_display.children.report_copy = ReportCopy::Idle;
                    return false;
                }
                match rx.try_recv() {
                    Ok(body) => Some(body),
                    Err(error) if error.is_closed() => Some(None),
                    Err(_) => return false,
                }
            }
            _ => return false,
        };
        let (key, epoch, scope, baseline, lease, revocation) =
            match std::mem::take(&mut s.transcript_display.children.report_copy) {
                ReportCopy::Loading {
                    key,
                    epoch,
                    scope,
                    baseline,
                    lease,
                    revocation,
                    ..
                } => (key, epoch, scope, baseline, lease, revocation),
                _ => return false,
            };
        if !s.current_scope(&scope)
            || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
            || revocation.is_revoked()
            || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch
        {
            return false;
        }
        match outcome {
            Some(Some(text)) => {
                #[cfg(not(target_arch = "wasm32"))]
                {
                    let expected = baseline.get();
                    tx.read_clipboard(move |s: &mut State, current, tx| {
                        if !s.current_scope(&scope)
                            || lease.as_ref().is_some_and(|w| w.strong_count() == 0)
                            || revocation.is_revoked()
                            || CLIPBOARD_EPOCH.load(Ordering::SeqCst) != epoch
                        {
                            return;
                        }
                        if let Some(before) = expected
                            && rune_theme_codenomad::clipboard::fingerprint(current) != before
                        {
                            return;
                        }
                        note_clipboard_write();
                        tx.copy(text);
                        s.transcript_display.children.report_copy = ReportCopy::Copied { key };
                    });
                }
                #[cfg(target_arch = "wasm32")]
                {
                    let _ = (tx, baseline);
                    // On the web, never write to the clipboard asynchronously after an HTTP
                    // round trip: stage the payload so the user's next click writes it directly.
                    s.transcript_display.children.report_copy = ReportCopy::Ready {
                        key,
                        text,
                        revocation,
                    };
                }
                true
            }
            _ => {
                if matches!(key, CopyKey::ToolSection(_)) {
                    crate::shell::notifications::emit_outcome(
                        s,
                        crate::shell::notifications::Category::Sessions,
                        None,
                        crate::strings::t("messageSection.quote.copyFailed"),
                        true,
                    );
                }
                s.transcript_display.children.report_copy = ReportCopy::Failed { key };
                true
            }
        }
    }

    pub(super) fn lease(&self, parent: Option<&str>, id: &str, key: &str) -> Rc<()> {
        let ck = child_key(parent, id);
        self.entries
            .get(&ck)
            .and_then(|entry| entry.cards.get(key))
            .and_then(Weak::upgrade)
            .or_else(|| {
                self.waiting
                    .iter()
                    .find(|(wck, wkey, _)| *wck == ck && wkey == key)
                    .and_then(|(_, _, lease)| lease.upgrade())
            })
            .unwrap_or_default()
    }

    pub(super) fn demand(
        s: &mut State,
        parent: Option<&str>,
        id: &str,
        key: &str,
        lease: &Rc<()>,
        visible: bool,
    ) {
        let wake = s.wake.clone();
        let ck = child_key(parent, id);
        let children = &mut s.transcript_display.children;
        let freed = children.prune();
        if !visible {
            let mut removed = false;
            if let Some(entry) = children.entries.get_mut(&ck) {
                entry.cards.remove(key);
                if entry.cards.is_empty() {
                    children.entries.remove(&ck);
                    removed = true;
                }
            }
            if removed {
                children.evict_unwatched_cache(std::slice::from_ref(&ck.1));
            }
            children
                .waiting
                .retain(|(wck, wkey, _)| !(*wck == ck && wkey == key));
            if freed || removed {
                Self::promote_waiting(s);
            }
            return;
        }
        let needs_watch = if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            Some(matches!(
                entry.watch,
                WatchState::Pending
                    | WatchState::Dormant {
                        pending_promote: true,
                        ..
                    }
            ))
        } else {
            None
        };
        if let Some(needs_watch) = needs_watch {
            if needs_watch {
                if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                    children.enqueue_waiting(ck, key, lease);
                } else {
                    Self::start_entry(s, ck, key, lease);
                }
            } else if freed {
                Self::promote_waiting(s);
            }
            return;
        }
        if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
            children.enqueue_waiting(ck, key, lease);
            return;
        }
        Self::start_entry(s, ck, key, lease);
    }

    fn enqueue_waiting(&mut self, ck: ChildKey, key: &str, lease: &Rc<()>) {
        self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
        if let Some(existing) = self
            .waiting
            .iter_mut()
            .find(|(wck, wkey, _)| *wck == ck && wkey == key)
        {
            existing.2 = Rc::downgrade(lease);
        } else if self.waiting.len() < WAITING_LIMIT {
            self.waiting
                .push_back((ck, key.into(), Rc::downgrade(lease)));
        }
    }

    pub(super) fn retry(s: &mut State, parent: Option<&str>, id: &str) {
        let ck = child_key(parent, id);
        if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
            entry.load_error = false;
            if let WatchState::Active(watcher) = &entry.watch {
                let _ = watcher.retry.try_send(());
                return;
            }
            entry.watch = WatchState::Pending;
            if let Some((card, lease)) = entry
                .cards
                .iter()
                .find_map(|(k, w)| w.upgrade().map(|l| (k.clone(), l)))
            {
                Self::demand(s, parent, id, &card, &lease, true);
            }
        }
    }

    fn active_watchers(&self) -> usize {
        self.entries
            .values()
            .filter(|e| matches!(e.watch, WatchState::Active(_)))
            .count()
    }

    fn dormant_watch(&self, child: &str, wake: &codenomad_client::Wake) -> WatchState {
        let Some(backend) = self.backend.as_ref() else {
            return WatchState::Pending;
        };
        let Some((dirty, settlement)) = backend.watch_child(child) else {
            return WatchState::Pending;
        };
        let (out, wake_rx) = bounded(2);
        let (cancel, cancelled) = bounded(1);
        let wake = wake.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                while dirty.recv().await.is_ok() {
                    let revoked = settlement.take().revoked;
                    if revoked {
                        if out.send(true).await.is_err() {
                            break;
                        }
                        wake();
                    } else if out.try_send(false).is_ok() {
                        wake();
                    }
                }
            })
            .await;
        });
        WatchState::Dormant {
            _cancel: cancel,
            wake: wake_rx,
            pending_promote: false,
        }
    }

    fn demote_settled(&mut self, wake: &codenomad_client::Wake) -> bool {
        let candidate = self
            .entries
            .iter()
            .find(|(_, e)| matches!(e.watch, WatchState::Active(_)) && e.settled)
            .map(|(k, _)| k.clone());
        let Some(key) = candidate else {
            return false;
        };
        // Register the dormant SSE watch before dropping the active watcher so no wake is missed.
        let dormant = self.dormant_watch(&key.1, wake);
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.watch = dormant;
            return true;
        }
        false
    }

    fn promote_waiting(s: &mut State) {
        let wake = s.wake.clone();
        loop {
            let next = loop {
                let Some((ck, key, weak)) = s.transcript_display.children.waiting.pop_front()
                else {
                    return;
                };
                if let Some(lease) = weak.upgrade() {
                    break (ck, key, lease);
                }
            };
            let (ck, key, lease) = next;
            let needs_start =
                if let Some(entry) = s.transcript_display.children.entries.get_mut(&ck) {
                    entry.cards.insert(key.clone(), Rc::downgrade(&lease));
                    matches!(
                        entry.watch,
                        WatchState::Pending
                            | WatchState::Dormant {
                                pending_promote: true,
                                ..
                            }
                    )
                } else {
                    true
                };
            if !needs_start {
                continue;
            }
            let children = &mut s.transcript_display.children;
            if children.active_watchers() >= CHILD_LIMIT && !children.demote_settled(&wake) {
                children
                    .waiting
                    .push_front((ck, key, Rc::downgrade(&lease)));
                return;
            }
            if !Self::start_entry(s, ck, &key, &lease) {
                break;
            }
        }
    }

    fn start_entry(s: &mut State, ck: ChildKey, key: &str, lease: &Rc<()>) -> bool {
        let children = &mut s.transcript_display.children;
        let Some(backend) = children.backend.clone() else {
            return false;
        };
        let Some((dirty, settlement)) = backend.watch_child(&ck.1) else {
            return false;
        };
        let (out, result) = bounded(2);
        let (cancel, cancelled) = bounded(1);
        let (retry, retry_rx) = bounded(1);
        let (expected_parent, child) = ck.clone();
        let watcher = Watcher {
            _cancel: cancel,
            retry,
            result,
        };
        if let Some(entry) = children.entries.get_mut(&ck) {
            entry.cards.insert(key.into(), Rc::downgrade(lease));
            entry.watch = WatchState::Active(watcher);
            entry.load_error = false;
            entry.settled = false;
        } else {
            while children.entries.len() >= RETAINED_LIMIT {
                let evict = children
                    .entries
                    .iter()
                    .find(|(_, e)| !matches!(e.watch, WatchState::Active(_)))
                    .map(|(k, _)| k.clone());
                let Some(evict) = evict else {
                    break;
                };
                children.entries.remove(&evict);
                children.evict_unwatched_cache(std::slice::from_ref(&evict.1));
            }
            children.entries.insert(
                ck,
                Entry {
                    cards: HashMap::from([(key.into(), Rc::downgrade(lease))]),
                    watch: WatchState::Active(watcher),
                    snapshot: Snapshot::default(),
                    load_error: false,
                    settled: false,
                },
            );
        }
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        crate::platform::spawn(async move {
            crate::platform::reads::cancellable(&cancelled, async {
                let mut owed_calls: HashMap<(Option<String>, String), (u8, Option<u64>)> =
                    HashMap::new();
                let mut frozen_ends: HashMap<(Option<String>, String), u64> = HashMap::new();
                let mut pending_events = Vec::new();
                let mut pending_bytes = 0usize;
                let mut owed_synthetics: Vec<(u8, usize, crate::history::Row)> = Vec::new();
                let mut synthetic_owed = 0u8;
                let mut execution_owed = 0u8;
                let mut last_exec_end: Option<u64> = None;
                let mut live_page: Option<crate::history::Page> = None;
                loop {
                    let drain = settlement.take();
                    if drain.revoked {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        owed_synthetics.clear();
                        synthetic_owed = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                    } else {
                        for end in drain.calls {
                            let key = (end.message, end.call);
                            if let Some(ts) = end.ended
                                && (frozen_ends.contains_key(&key) || frozen_ends.len() < 128)
                            {
                                frozen_ends.entry(key.clone()).or_insert(ts);
                            }
                            if owed_calls.contains_key(&key) || owed_calls.len() < 64 {
                                let entry = owed_calls.entry(key).or_insert((0, end.ended));
                                if entry.1.is_none() {
                                    entry.1 = end.ended;
                                }
                            }
                        }
                        if drain.execution_ended {
                            execution_owed = 3;
                            last_exec_end = drain
                                .execution_ended_at
                                .or(Some(crate::platform::storage::unix_millis()));
                        }
                        let mut live_changed = false;
                        if drain.synthetic_dirty {
                            if drain.synthetics.is_empty() {
                                synthetic_owed = 3;
                            }
                            for row in drain.synthetics {
                                let prior_matches = live_page.as_ref().map_or(0, |page| {
                                    page.rows
                                        .iter()
                                        .filter(|p| same_synthetic_report(p, &row))
                                        .count()
                                });
                                if owed_synthetics.len() < 16
                                    && !owed_synthetics.iter().any(|(_, _, r)| r.id == row.id)
                                {
                                    owed_synthetics.push((0, prior_matches, row.clone()));
                                }
                                if let Some(page) = live_page.as_mut()
                                    && page.rows.len() < codenomad_client::history::MAX_ROWS
                                    && !page.rows.iter().any(|p| p.id == row.id)
                                {
                                    page.rows.push(row);
                                    if codenomad_client::history::check(&page.rows).is_err() {
                                        page.rows.pop();
                                    } else {
                                        live_changed = true;
                                    }
                                }
                            }
                        }
                        if !drain.events.is_empty() {
                            let mut overflowed = false;
                            for ev in drain.events {
                                let outcome = live_page.as_mut().map_or(
                                    codenomad_client::content::ToolEventOutcome::Pending,
                                    |page| {
                                        codenomad_client::content::apply_tool_event(
                                            &mut page.rows,
                                            ev.message.as_deref(),
                                            &ev.kind,
                                            &ev.data,
                                            ev.at,
                                        )
                                    },
                                );
                                match outcome {
                                    codenomad_client::content::ToolEventOutcome::Applied => {
                                        if live_page.as_ref().is_some_and(|page| {
                                            codenomad_client::history::check(&page.rows).is_err()
                                        }) {
                                            live_page = None;
                                            overflowed = true;
                                            break;
                                        }
                                        live_changed = true;
                                    }
                                    codenomad_client::content::ToolEventOutcome::Drop => {}
                                    codenomad_client::content::ToolEventOutcome::Pending => {
                                        if pending_events.len() < MAX_PENDING_EVENTS
                                            && pending_bytes.saturating_add(ev.bytes)
                                                <= MAX_PENDING_BYTES
                                        {
                                            pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                            pending_events.push((0, ev));
                                        }
                                    }
                                }
                            }
                            if overflowed {
                                live_changed = false;
                            }
                        }
                        if live_changed && let Some(page) = live_page.as_ref() {
                            let snap = snapshot_with_frozen(page.clone(), &frozen_ends);
                            if out
                                .try_send(ChildUpdate::Loaded {
                                    snapshot: snap,
                                    settled: false,
                                    unavailable: false,
                                })
                                .is_ok()
                            {
                                wake();
                            }
                        }
                    }
                    let rev_before = settlement.revocation_gen();
                    let fetched = {
                        let Some(_slot) = reads.background(&cancelled).await else {
                            break;
                        };
                        let parent_id = expected_parent.as_deref().unwrap_or(&backend.session);
                        backend.child_page_under(&child, parent_id).await
                    };
                    if settlement.revocation_gen() != rev_before {
                        owed_calls.clear();
                        frozen_ends.clear();
                        pending_events.clear();
                        pending_bytes = 0;
                        owed_synthetics.clear();
                        synthetic_owed = 0;
                        execution_owed = 0;
                        last_exec_end = None;
                        live_page = None;
                        if out.send(ChildUpdate::Unverified).await.is_err() {
                            break;
                        }
                        wake();
                        let _ = dirty.try_recv();
                        continue;
                    }
                    let (update, last_settled, last_running, last_failed) = match fetched {
                        Ok(Some(mut page)) => {
                            owed_calls.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            frozen_ends.retain(|(msg, call), _| {
                                !child_tool_settled(&page.rows, msg.as_deref(), call)
                            });
                            if execution_owed > 0 {
                                let turn_start = page
                                    .rows
                                    .iter()
                                    .rposition(|r| r.role == "user")
                                    .map_or(0, |idx| idx + 1);
                                if !page.running {
                                    for row in &page.rows[turn_start..] {
                                        for part in &row.parts {
                                            if let Part::Tool(tool) = part
                                                && matches!(
                                                    tool.status.as_str(),
                                                    "pending" | "streaming" | "running"
                                                )
                                            {
                                                let k = (Some(row.id.clone()), tool.id.clone());
                                                if let Some(ts) = last_exec_end
                                                    && tool.started.is_none_or(|start| start <= ts)
                                                    && (frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128)
                                                {
                                                    frozen_ends.entry(k.clone()).or_insert(ts);
                                                }
                                                if owed_calls.len() < 64 {
                                                    owed_calls
                                                        .entry(k)
                                                        .or_insert((0, last_exec_end));
                                                }
                                            }
                                        }
                                    }
                                    execution_owed = 0;
                                    last_exec_end = None;
                                } else {
                                    if let Some(ts) = last_exec_end {
                                        for row in &page.rows[turn_start..] {
                                            for part in &row.parts {
                                                if let Part::Tool(tool) = part
                                                    && matches!(
                                                        tool.status.as_str(),
                                                        "streaming" | "running"
                                                    )
                                                    && tool.started.is_some_and(|start| start <= ts)
                                                {
                                                    let k = (Some(row.id.clone()), tool.id.clone());
                                                    if frozen_ends.contains_key(&k)
                                                        || frozen_ends.len() < 128
                                                    {
                                                        frozen_ends.entry(k).or_insert(ts);
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    execution_owed -= 1;
                                    if execution_owed == 0 {
                                        last_exec_end = None;
                                    }
                                }
                            }
                            if let Some(prior) = live_page.as_ref() {
                                let mut merged = page.rows.clone();
                                if codenomad_client::content::merge_page(&prior.rows, &mut merged)
                                    .is_ok()
                                {
                                    page.rows = merged;
                                }
                            }
                            if !pending_events.is_empty() {
                                let mut kept = Vec::new();
                                pending_bytes = 0;
                                for (age, ev) in pending_events.drain(..) {
                                    let outcome = codenomad_client::content::apply_tool_event(
                                        &mut page.rows,
                                        ev.message.as_deref(),
                                        &ev.kind,
                                        &ev.data,
                                        ev.at,
                                    );
                                    if matches!(
                                        outcome,
                                        codenomad_client::content::ToolEventOutcome::Pending
                                    ) && age < 2
                                    {
                                        pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                        kept.push((age + 1, ev));
                                    }
                                }
                                pending_events = kept;
                                if codenomad_client::history::check(&page.rows).is_err() {
                                    live_page = None;
                                    pending_events.clear();
                                    pending_bytes = 0;
                                    continue;
                                }
                            }
                            if !owed_synthetics.is_empty() && page.newer.is_none() {
                                owed_synthetics.retain(|(_, prior_matches, r)| {
                                    if page.rows.iter().any(|p| p.id == r.id) {
                                        return false;
                                    }
                                    if r.id.starts_with("msg_") {
                                        return true;
                                    }
                                    let page_matches = page
                                        .rows
                                        .iter()
                                        .filter(|p| same_synthetic_report(p, r))
                                        .count();
                                    page_matches <= *prior_matches
                                });
                                for (_, _, row) in &owed_synthetics {
                                    if page.rows.len() < codenomad_client::history::MAX_ROWS
                                        && !page.rows.iter().any(|p| p.id == row.id)
                                    {
                                        page.rows.push(row.clone());
                                        if codenomad_client::history::check(&page.rows).is_err() {
                                            page.rows.pop();
                                            break;
                                        }
                                    }
                                }
                            }
                            if synthetic_owed > 0 {
                                synthetic_owed -= 1;
                            }
                            let settled = !page.running
                                && owed_calls.is_empty()
                                && owed_synthetics.is_empty()
                                && synthetic_owed == 0
                                && execution_owed == 0
                                && pending_events.is_empty();
                            let running = page.running;
                            live_page = Some(page.clone());
                            (
                                ChildUpdate::Loaded {
                                    snapshot: snapshot_with_frozen(page, &frozen_ends),
                                    settled,
                                    unavailable: false,
                                },
                                settled,
                                running,
                                false,
                            )
                        }
                        Ok(None) => {
                            owed_calls.clear();
                            frozen_ends.clear();
                            pending_events.clear();
                            pending_bytes = 0;
                            owed_synthetics.clear();
                            synthetic_owed = 0;
                            execution_owed = 0;
                            last_exec_end = None;
                            live_page = None;
                            (
                                ChildUpdate::Loaded {
                                    snapshot: Snapshot::default(),
                                    settled: true,
                                    unavailable: true,
                                },
                                true,
                                false,
                                false,
                            )
                        }
                        Err(_) => {
                            if execution_owed > 0 {
                                execution_owed -= 1;
                                if execution_owed == 0 {
                                    last_exec_end = None;
                                }
                            }
                            if synthetic_owed > 0 {
                                synthetic_owed -= 1;
                            }
                            if !pending_events.is_empty() {
                                let mut kept = Vec::new();
                                pending_bytes = 0;
                                for (age, ev) in pending_events.drain(..) {
                                    if age < 2 {
                                        pending_bytes = pending_bytes.saturating_add(ev.bytes);
                                        kept.push((age + 1, ev));
                                    }
                                }
                                pending_events = kept;
                            }
                            (ChildUpdate::Failed, false, false, true)
                        }
                    };
                    if out.send(update).await.is_err() {
                        break;
                    }
                    wake();
                    let mut max_attempt = 0u8;
                    owed_calls.retain(|_, (attempts, _)| {
                        *attempts = attempts.saturating_add(1);
                        if *attempts <= 3 {
                            max_attempt = max_attempt.max(*attempts);
                            true
                        } else {
                            false
                        }
                    });
                    owed_synthetics.retain_mut(|(attempts, _, _)| {
                        *attempts = attempts.saturating_add(1);
                        if *attempts <= 3 {
                            max_attempt = max_attempt.max(*attempts);
                            true
                        } else {
                            false
                        }
                    });
                    if !owed_calls.is_empty()
                        || !owed_synthetics.is_empty()
                        || synthetic_owed > 0
                        || execution_owed > 0
                        || !pending_events.is_empty()
                    {
                        let step = max_attempt.max(1);
                        let delay = Duration::from_millis(100 * u64::from(step));
                        runtime::sleep(delay).await;
                        let _ = dirty.try_recv();
                        let _ = retry_rx.try_recv();
                        continue;
                    }
                    if !last_settled
                        && !last_running
                        && pending_events.is_empty()
                        && (live_page.is_some() || last_failed)
                    {
                        if out.send(ChildUpdate::Settled).await.is_err() {
                            break;
                        }
                        wake();
                    }
                    if !last_running && !last_failed && pending_events.is_empty() {
                        // Release full HTTP page buffer while idle; next wake re-fetches fresh.
                        live_page = None;
                    }
                    if !wait_wake(&dirty, &retry_rx).await {
                        break;
                    }
                    runtime::sleep(Duration::from_millis(100)).await;
                    let _ = dirty.try_recv();
                    let _ = retry_rx.try_recv();
                }
            })
            .await;
        });
        true
    }

    pub(crate) fn poll_and_promote(s: &mut State) -> bool {
        let changed = s.transcript_display.children.poll();
        Self::promote_waiting(s);
        changed
    }

    pub(crate) fn poll(&mut self) -> bool {
        let mut changed = self.prune();
        let mut to_requeue: Vec<(ChildKey, String, Weak<()>)> = Vec::new();
        let mut mark_unavailable: Vec<ChildKey> = Vec::new();
        let mut clear_unavailable: Vec<ChildKey> = Vec::new();
        let mut revoked_children: Vec<String> = Vec::new();
        for (ck, entry) in self.entries.iter_mut() {
            match &mut entry.watch {
                WatchState::Active(watcher) => {
                    while let Ok(update) = watcher.result.try_recv() {
                        match update {
                            ChildUpdate::Loaded {
                                snapshot: next,
                                settled,
                                unavailable,
                            } => {
                                if unavailable {
                                    mark_unavailable.push(ck.clone());
                                    revoked_children.push(ck.1.clone());
                                } else {
                                    clear_unavailable.push(ck.clone());
                                }
                                changed |= entry.load_error
                                    || entry.settled != settled
                                    || entry.snapshot != next;
                                entry.load_error = false;
                                entry.settled = settled;
                                entry.snapshot = next;
                            }
                            ChildUpdate::Settled => {
                                changed |= !entry.settled;
                                entry.settled = true;
                            }
                            ChildUpdate::Unverified => {
                                clear_unavailable.push(ck.clone());
                                revoked_children.push(ck.1.clone());
                                changed |= entry.load_error
                                    || entry.settled
                                    || entry.snapshot != Snapshot::default();
                                entry.snapshot = Snapshot::default();
                                entry.load_error = false;
                                entry.settled = false;
                            }
                            ChildUpdate::Failed => {
                                changed |= !entry.load_error;
                                entry.load_error = true;
                            }
                        }
                    }
                }
                WatchState::Dormant {
                    wake,
                    pending_promote,
                    ..
                } => {
                    let mut woke = false;
                    let mut revoked = false;
                    let mut closed = false;
                    loop {
                        match wake.try_recv() {
                            Ok(is_revoked) => {
                                woke = true;
                                revoked |= is_revoked;
                            }
                            Err(error) if error.is_closed() => {
                                closed = true;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    if revoked {
                        clear_unavailable.push(ck.clone());
                        revoked_children.push(ck.1.clone());
                        changed |= entry.load_error || entry.snapshot != Snapshot::default();
                        entry.snapshot = Snapshot::default();
                        entry.load_error = false;
                    }
                    if woke || closed {
                        entry.settled = false;
                        if closed {
                            entry.watch = WatchState::Pending;
                        } else {
                            *pending_promote = true;
                        }
                        if let Some((card, lease)) =
                            entry.cards.iter().find(|(_, w)| w.strong_count() > 0)
                        {
                            to_requeue.push((ck.clone(), card.clone(), lease.clone()));
                        }
                    }
                }
                WatchState::Pending => {}
            }
        }
        for ck in clear_unavailable {
            changed |= self.unavailable.remove(&ck);
        }
        if !revoked_children.is_empty() {
            let cancel_copy = match &self.report_copy {
                ReportCopy::Loading { key, .. }
                | ReportCopy::Ready { key, .. }
                | ReportCopy::Copied { key }
                | ReportCopy::Failed { key } => {
                    revoked_children.iter().any(|id| key.touches_child(id))
                }
                #[cfg(target_arch = "wasm32")]
                ReportCopy::Confirming { key, .. } => {
                    revoked_children.iter().any(|id| key.touches_child(id))
                }
                ReportCopy::Idle => false,
            };
            if cancel_copy {
                self.report_copy = ReportCopy::Idle;
                changed = true;
            }
            let before_expanded = self.expanded_reports.len();
            self.expanded_reports.retain(|(current, text)| {
                let drop = revoked_children.iter().any(|id| current.touches_child(id));
                if drop {
                    self.expanded_report_bytes =
                        self.expanded_report_bytes.saturating_sub(text.len());
                }
                !drop
            });
            changed |= self.expanded_reports.len() != before_expanded;
            if self
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| {
                    revoked_children.iter().any(|id| current.touches_child(id))
                })
            {
                self.loading_report = None;
                changed = true;
            }
            if self
                .failed_report
                .as_ref()
                .is_some_and(|current| revoked_children.iter().any(|id| current.touches_child(id)))
            {
                self.failed_report = None;
                changed = true;
            }
        }
        for ck in mark_unavailable {
            if !self.unavailable.contains(&ck) {
                self.mark_unavailable(ck);
                changed = true;
            }
        }
        if !to_requeue.is_empty() {
            self.waiting.retain(|(_, _, w)| w.strong_count() > 0);
            for (ck, card, lease) in to_requeue {
                if !self.waiting.iter().any(|(wck, _, _)| *wck == ck)
                    && self.waiting.len() < WAITING_LIMIT
                {
                    self.waiting.push_back((ck, card, lease));
                }
            }
        }
        let expand_outcome = match self.loading_report.as_ref() {
            Some((_, revocation, _, _)) if revocation.is_revoked() => {
                self.loading_report = None;
                changed = true;
                None
            }
            Some((_, _, _, rx)) => match rx.try_recv() {
                Ok(body) => Some(body),
                Err(error) if error.is_closed() => Some(None),
                Err(_) => None,
            },
            None => None,
        };
        if let Some(outcome) = expand_outcome
            && let Some((key, revocation, _, _)) = self.loading_report.take()
        {
            let unavailable = self.unavailable.iter().any(|(_, id)| key.touches_child(id));
            if !revocation.is_revoked() && !unavailable {
                match outcome {
                    Some(text) if text.len() <= MAX_EXPANDED_REPORT_BYTES => {
                        while self.expanded_reports.len() >= MAX_EXPANDED_REPORTS
                            || self.expanded_report_bytes.saturating_add(text.len())
                                > MAX_EXPANDED_REPORT_BYTES
                        {
                            if let Some((_, dropped)) = self.expanded_reports.pop_front() {
                                self.expanded_report_bytes =
                                    self.expanded_report_bytes.saturating_sub(dropped.len());
                            } else {
                                break;
                            }
                        }
                        self.expanded_report_bytes =
                            self.expanded_report_bytes.saturating_add(text.len());
                        self.expanded_reports.push_back((key, text));
                    }
                    _ => {
                        self.failed_report = Some(key);
                    }
                }
            }
            changed = true;
        }
        changed
    }

    fn evict_unwatched_cache(&mut self, removed_children: &[String]) {
        let unwatched: Vec<&str> = removed_children
            .iter()
            .map(String::as_str)
            .filter(|id| !self.entries.keys().any(|(_, active)| active == *id))
            .collect();
        if unwatched.is_empty() {
            return;
        }
        self.expanded_reports.retain(|(current, text)| {
            let drop = unwatched.iter().any(|id| current.touches_child(id));
            if drop {
                self.expanded_report_bytes = self.expanded_report_bytes.saturating_sub(text.len());
            }
            !drop
        });
        if self
            .loading_report
            .as_ref()
            .is_some_and(|(current, _, _, _)| unwatched.iter().any(|id| current.touches_child(id)))
        {
            self.loading_report = None;
        }
        if self
            .failed_report
            .as_ref()
            .is_some_and(|current| unwatched.iter().any(|id| current.touches_child(id)))
        {
            self.failed_report = None;
        }
    }

    fn prune(&mut self) -> bool {
        // Rune drops the visibility handler on unmount without a final `false` callback.
        let before = self.entries.len();
        let mut removed = Vec::new();
        self.entries.retain(|ck, entry| {
            entry.cards.retain(|_, lease| lease.strong_count() > 0);
            let keep = !entry.cards.is_empty();
            if !keep {
                removed.push(ck.1.clone());
            }
            keep
        });
        if !removed.is_empty() {
            self.evict_unwatched_cache(&removed);
        }
        before != self.entries.len()
    }

    pub(super) fn steps(&self, parent: Option<&str>, id: &str) -> &[(String, Arc<Tool>)] {
        self.entries
            .get(&child_key(parent, id))
            .map_or(&[], |entry| entry.snapshot.steps.as_slice())
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

async fn wait_wake(dirty: &Receiver<()>, retry: &Receiver<()>) -> bool {
    use std::{future::Future, task::Poll};
    let mut d = std::pin::pin!(dirty.recv());
    let mut r = std::pin::pin!(retry.recv());
    std::future::poll_fn(|cx| {
        if let Poll::Ready(res) = d.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        if let Poll::Ready(res) = r.as_mut().poll(cx) {
            return Poll::Ready(res.is_ok());
        }
        Poll::Pending
    })
    .await
}

fn snapshot_with_frozen(
    page: crate::history::Page,
    frozen_ends: &HashMap<(Option<String>, String), u64>,
) -> Snapshot {
    let mut snap = snapshot(page);
    for ((msg, call), &ts) in frozen_ends {
        let target = if let Some(msg) = msg.as_deref() {
            snap.steps
                .iter_mut()
                .find(|(row_id, tool)| row_id == msg && tool.id == *call)
        } else {
            snap.steps
                .iter_mut()
                .rev()
                .find(|(_, tool)| tool.id == *call)
        };
        if let Some((_, tool)) = target
            && matches!(tool.status.as_str(), "streaming" | "running")
            && tool.ended.is_none()
            && tool.started.is_none_or(|start| start <= ts)
        {
            Arc::make_mut(tool).ended = Some(ts);
        }
    }
    snap
}

fn child_tool_settled(rows: &[crate::history::Row], message: Option<&str>, call: &str) -> bool {
    let tool = if let Some(msg) = message {
        rows.iter().find(|row| row.id == msg).and_then(|row| {
            row.parts.iter().find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
        })
    } else {
        rows.iter()
            .rev()
            .flat_map(|row| row.parts.iter().rev())
            .find_map(|part| match part {
                Part::Tool(tool) if tool.id == call => Some(tool),
                _ => None,
            })
    };
    tool.is_some_and(|tool| !matches!(tool.status.as_str(), "pending" | "streaming" | "running"))
}

fn snapshot(page: crate::history::Page) -> Snapshot {
    let raw_tools: Vec<_> = page
        .rows
        .iter()
        .rev()
        .flat_map(|row| {
            row.parts.iter().rev().filter_map(move |part| match part {
                Part::Tool(tool) => Some((row, tool)),
                _ => None,
            })
        })
        .collect();
    let mut steps_truncated = raw_tools.len() > STEP_LIMIT;
    let kept_tools: Vec<_> = raw_tools.into_iter().take(STEP_LIMIT).collect();
    let total_tool_bytes: usize = kept_tools
        .iter()
        .map(|(_, tool)| tool.retained_bytes())
        .sum();
    let mut truncated_tools = HashSet::new();
    let mut tools: Steps = if total_tool_bytes <= STEP_BYTES {
        kept_tools
            .into_iter()
            .map(|(row, tool)| (row.id.clone(), tool.clone()))
            .collect()
    } else {
        steps_truncated = true;
        // Shortest-first water-filling keeps smaller steps intact beside an oversized step.
        let mut order: Vec<usize> = (0..kept_tools.len()).collect();
        order.sort_by_key(|&i| kept_tools[i].1.retained_bytes());
        let mut caps = vec![0usize; kept_tools.len()];
        let mut rem = STEP_BYTES;
        for (pos, &idx) in order.iter().enumerate() {
            let share = rem / (order.len() - pos);
            let size = kept_tools[idx].1.retained_bytes();
            let take = size.min(share);
            caps[idx] = take;
            rem -= take;
        }
        kept_tools
            .into_iter()
            .enumerate()
            .map(|(idx, (row, tool))| {
                let cap = caps[idx];
                let bounded = if tool.retained_bytes() <= cap {
                    tool.clone()
                } else {
                    truncated_tools.insert((row.id.clone(), tool.id.clone()));
                    Arc::new(tool.with_budget(cap))
                };
                (row.id.clone(), bounded)
            })
            .collect()
    };
    tools.reverse();
    let raw_reports: Vec<_> =
        page.rows
            .iter()
            .rev()
            .flat_map(|row| {
                row.parts.iter().enumerate().rev().filter_map(
                    move |(part_index, part)| match part {
                        Part::SubagentReport(report) => Some((row, part_index, report)),
                        _ => None,
                    },
                )
            })
            .take(STEP_LIMIT)
            .collect();
    // Shortest-first water-filling keeps short older reports intact even beside giant ones.
    let mut order: Vec<usize> = (0..raw_reports.len()).collect();
    order.sort_by_key(|&i| raw_reports[i].2.body.len());
    let mut caps = vec![0usize; raw_reports.len()];
    let mut report_bytes = STEP_BYTES;
    for (pos, &idx) in order.iter().enumerate() {
        let share = report_bytes / (order.len() - pos);
        let len = raw_reports[idx].2.body.len();
        let take = len.min(share);
        caps[idx] = take;
        report_bytes -= take;
    }
    let mut reports: Reports = raw_reports
        .into_iter()
        .enumerate()
        .map(|(idx, (row, part_index, report))| {
            let cap = caps[idx];
            let (body, truncated) = if report.body.len() <= cap {
                (report.body.clone(), false)
            } else {
                let end = report.body.floor_char_boundary(cap);
                (report.body[..end].to_owned(), true)
            };
            ChildReport {
                row_id: row.id.clone(),
                part_index,
                report: Arc::new(SubagentReport {
                    child: report.child.clone(),
                    state: report.state.clone(),
                    body,
                    created: report.created,
                }),
                truncated,
            }
        })
        .collect();
    reports.reverse();
    Snapshot {
        steps: tools,
        steps_truncated,
        steps_incomplete: steps_truncated || page.older.is_some(),
        truncated_tools,
        reports,
    }
}

async fn with_timeout<T>(
    budget: Duration,
    fut: impl std::future::Future<Output = Option<T>>,
) -> Option<T> {
    use std::{future::Future, task::Poll};
    let mut fut = std::pin::pin!(fut);
    let mut timer = std::pin::pin!(runtime::sleep(budget));
    std::future::poll_fn(|cx| {
        if let Poll::Ready(value) = fut.as_mut().poll(cx) {
            return Poll::Ready(value);
        }
        if timer.as_mut().poll(cx).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

async fn copy_child_steps_bounded(
    backend: &Backend,
    reads: &crate::platform::reads::Reads,
    cancelled: &Receiver<()>,
    child: &str,
    expected_parent: &str,
    settlement: &codenomad_client::stream::ChildSettlement,
    rev_before: u64,
) -> Option<String> {
    use std::{collections::HashSet, io};
    struct Limited(Vec<u8>, usize);
    impl io::Write for Limited {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if self.0.len().saturating_add(bytes.len()) > self.1 {
                return Err(io::ErrorKind::FileTooLarge.into());
            }
            self.0.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let deadline = runtime::Instant::now() + COPY_BUDGET;
    let location = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()??
    };
    let mut out = Limited(Vec::new(), MAX_COPY_BYTES);
    io::Write::write_all(&mut out, b"[\n").ok()?;
    let mut count = 0usize;
    let mut seen_rows = HashSet::new();
    let mut cursor = Some(serde_json::json!({"kind": "oldest"}));
    let mut seen_cursors = HashSet::new();
    for _ in 0..MAX_COPY_PAGES {
        if runtime::Instant::now() >= deadline || settlement.revocation_gen() != rev_before {
            return None;
        }
        let Some(request) = cursor.take() else {
            break;
        };
        let encoded_cursor = request.to_string();
        if encoded_cursor.len() > 4096 {
            return None;
        }
        let cursor_key = (
            request["kind"].as_str().unwrap_or_default().to_owned(),
            request["messageID"].as_str().unwrap_or_default().to_owned(),
            fnv1a64(encoded_cursor.as_bytes()),
        );
        if !seen_cursors.insert(cursor_key) {
            return None;
        }
        let (rows, newer) = {
            let _slot = reads.background(cancelled).await?;
            backend.child_raw_tools_request(child, request).await.ok()?
        };
        if settlement.revocation_gen() != rev_before {
            return None;
        }
        for (row_id, tools) in rows {
            if !seen_rows.insert(row_id) {
                continue;
            }
            for part in tools {
                if count > 0 {
                    io::Write::write_all(&mut out, b",\n").ok()?;
                }
                serde_json::to_writer_pretty(&mut out, &part).ok()?;
                count += 1;
            }
        }
        cursor = newer;
    }
    if cursor.is_some()
        || runtime::Instant::now() >= deadline
        || settlement.revocation_gen() != rev_before
    {
        return None;
    }
    io::Write::write_all(&mut out, if count > 0 { b"\n]" } else { b"]" }).ok()?;
    let still_owned = {
        let _slot = reads.background(cancelled).await?;
        backend
            .child_ownership_token(child, expected_parent)
            .await
            .ok()?
    };
    (still_owned == Some(location) && settlement.revocation_gen() == rev_before)
        .then(|| String::from_utf8(out.0).ok())
        .flatten()
}

fn same_synthetic_report(a: &crate::history::Row, b: &crate::history::Row) -> bool {
    if a.role != "synthetic" || b.role != "synthetic" {
        return false;
    }
    fn report(row: &crate::history::Row) -> Option<&SubagentReport> {
        row.parts.iter().find_map(|part| match part {
            Part::SubagentReport(r) => Some(r),
            _ => None,
        })
    }
    match (report(a), report(b)) {
        (Some(ra), Some(rb)) => ra.child == rb.child && ra.state == rb.state && ra.body == rb.body,
        _ => false,
    }
}

#[cfg(test)]
impl Children {
    pub(super) fn install(&mut self, child: &str, page: crate::history::Page) -> Rc<()> {
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
            snapshot: snapshot(page),
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
}
