use super::cache::Cache;
use super::memory_budget::{
    BudgetLedger, Coordinator, Evictable, Limits, Pool, PoolUsage, enforce_with, measure,
    plan_evictions,
};
use super::state::Ui;
use crate::{Message, Phase};
use codenomad_client::backend::Backend;
use std::sync::Arc;

fn test_backend(workspace: &str) -> Backend {
    let mut backend = Backend::unauthenticated("http://127.0.0.1:1/").unwrap();
    backend.workspace = workspace.into();
    backend.session = "ses-1".into();
    backend
}

fn message_with_size(id: &str, bytes: usize) -> crate::history::Row {
    Message {
        usage: None,
        id: id.into(),
        body: "x".repeat(bytes),
        role: "assistant".into(),
        parts: vec![],
        completed: true,
    }
    .into()
}

fn build_inactive_tab(
    workspace_id: &str,
    phase: Phase,
    message_bytes: usize,
    file_preview_bytes: usize,
    git_diff_bytes: usize,
    mission_body_bytes: usize,
    composer_draft: &str,
    commit_draft: &str,
    dirty_file_edit: bool,
) -> (Cache, Option<crate::missions::Panel>) {
    let mut s = crate::init();
    s.phase = phase;
    s.draft = rune::edit::TextEdit::new(composer_draft);
    if message_bytes > 0 {
        s.messages
            .push(message_with_size(workspace_id, message_bytes));
    }
    let backend = test_backend(workspace_id);
    if file_preview_bytes > 0 || dirty_file_edit {
        let mut files = crate::files::Ui::new(
            backend.clone(),
            "/project".into(),
            Default::default(),
            Arc::new(|| {}),
        );
        if file_preview_bytes > 0 {
            files
                .reader
                .fixture_set_preview("/project", "big.txt", vec![b'a'; file_preview_bytes]);
        }
        if dirty_file_edit {
            files
                .document
                .fixture_mark_dirty("original", "unsaved local edit");
        }
        s.files = Some(files);
    }
    if git_diff_bytes > 0 || !commit_draft.is_empty() {
        crate::git::connected(&mut s, &backend);
        if let Some(git) = s.git.owner.as_mut() {
            if git_diff_bytes > 0 {
                let half = git_diff_bytes / 2;
                git.fixture_load_diff("diff.rs", "a".repeat(half), "b".repeat(half));
            }
            if !commit_draft.is_empty() {
                let _ = crate::git::fixture_commit_draft(&mut s, Some(commit_draft));
            }
        }
    }
    let missions = (mission_body_bytes > 0).then(|| {
        let mut panel = crate::missions::Panel::new(
            backend,
            Some(workspace_id.into()),
            Default::default(),
            Arc::new(|| {}),
        );
        panel.fixture_cache_body(workspace_id, "m".repeat(mission_body_bytes));
        panel
    });
    (Cache::take(&mut s), missions)
}

#[test]
fn ledger_reservations_resize_release_drop_and_clear_without_leaks() {
    let ledger = BudgetLedger::new();
    assert_eq!(ledger.total_bytes(), 0);

    {
        let mut transcript = ledger.reserve(Pool::Transcript, 1_000);
        let mut media = ledger.reserve(Pool::Rendered, 500);
        assert_eq!(transcript.pool(), Pool::Transcript);
        assert_eq!(transcript.bytes(), 1_000);
        assert_eq!(ledger.pool_bytes(Pool::Transcript), 1_000);
        assert_eq!(ledger.pool_bytes(Pool::Rendered), 500);
        assert_eq!(ledger.total_bytes(), 1_500);

        transcript.resize(2_500);
        assert_eq!(ledger.pool_bytes(Pool::Transcript), 2_500);
        assert_eq!(ledger.total_bytes(), 3_000);

        transcript.resize(400);
        assert_eq!(ledger.pool_bytes(Pool::Transcript), 400);
        assert_eq!(ledger.total_bytes(), 900);

        // Idempotent manual release leaves zero residual bytes.
        media.release();
        media.release();
        assert_eq!(media.bytes(), 0);
        assert_eq!(ledger.pool_bytes(Pool::Rendered), 0);
        assert_eq!(ledger.total_bytes(), 400);
    }
    // Dropping `transcript` releases its remaining reservation cleanly.
    assert_eq!(ledger.pool_bytes(Pool::Transcript), 0);
    assert_eq!(ledger.total_bytes(), 0);

    // Coordinator sync, clear, and Drop also return every pool to zero.
    let external = {
        let mut coordinator = Coordinator::new();
        let mut usage = PoolUsage::default();
        usage.add(Pool::FilesAndGit, 4_096);
        usage.add(Pool::Missions, 2_048);
        coordinator.sync(usage);
        assert_eq!(coordinator.total_bytes(), 6_144);
        assert_eq!(coordinator.ledger().pool_bytes(Pool::FilesAndGit), 4_096);

        coordinator.clear();
        assert_eq!(coordinator.total_bytes(), 0);

        coordinator.sync(usage);
        assert_eq!(coordinator.total_bytes(), 6_144);
        Arc::clone(coordinator.ledger())
    };
    assert_eq!(external.total_bytes(), 0);
    for pool in Pool::ALL {
        assert_eq!(external.pool_bytes(pool), 0);
    }
}

#[test]
fn plan_evictions_orders_by_tier_then_lru_and_skips_protected() {
    let candidates = vec![
        Evictable {
            id: 1,
            tier: 2,
            last_used: 10,
            bytes: 300,
            protected: false,
        },
        Evictable {
            id: 2,
            tier: 1,
            last_used: 50,
            bytes: 400,
            protected: false,
        },
        Evictable {
            id: 3,
            tier: 1,
            last_used: 5,
            bytes: 350,
            protected: false,
        },
        Evictable {
            id: 4,
            tier: 1,
            last_used: 1,
            bytes: 900,
            protected: true,
        },
        Evictable {
            id: 5,
            tier: 1,
            last_used: 2,
            bytes: 0,
            protected: false,
        },
    ];
    // Need to shed 600 bytes from 1_050 down to 450: tier 1 id=3 (350) then id=2 (400) suffices.
    let plan = plan_evictions(1_050, 450, &candidates);
    assert_eq!(plan, vec![3, 2]);

    // Already under ceiling selects nothing.
    assert!(plan_evictions(400, 450, &candidates).is_empty());
}

#[test]
fn global_ceiling_evicts_inactive_tabs_in_deterministic_lru_order() {
    let mut s = crate::init();
    s.draft = rune::edit::TextEdit::new("active unsaved draft");
    s.messages.push(message_with_size("active", 8_000));
    s.transcript_display
        .timeline
        .fixture_set_excerpt_scope(10, Some("active-hit".into()));
    s.rail_excerpts
        .fixture_remember(10, "active-hit".into(), "a".repeat(512), 1.0);
    s.rail_excerpts
        .fixture_remember(99, "inactive-hit".into(), "z".repeat(4_096), 1.0);

    let mut ui = Ui::new();
    // Add three inactive tabs with non-monotonic timestamps: oldest is `tab-oldest` (touched=1).
    for (key, touched) in [("tab-mid", 2), ("tab-recent", 3), ("tab-oldest", 1)] {
        let (cache, missions) = build_inactive_tab(
            key,
            Phase::Ready,
            10_000,
            4_000,
            4_000,
            4_000,
            key,
            "",
            false,
        );
        ui.push_fixture_entry(key, touched, cache, missions);
    }
    s.workspace = Some(ui);

    let before = measure(&s);
    assert!(before.total() > 70_000);

    // Budget allows active tab (~8 KiB) + recent tab + mid tab transcripts, forcing eviction of
    // inactive rail scope, inactive secondary caches, and the oldest tab's transcript first.
    let limits = Limits {
        global_bytes: 34_000,
        inactive_history_bytes: usize::MAX,
        inactive_history_rows: usize::MAX,
    };
    let after = enforce_with(&mut s, limits);
    assert!(
        after.total() <= limits.global_bytes,
        "expected total {} <= {}",
        after.total(),
        limits.global_bytes
    );
    assert_eq!(
        s.workspace
            .as_mut()
            .unwrap()
            .memory_budget_mut()
            .total_bytes(),
        after.total()
    );

    // Active tab transcript and draft remain intact.
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.draft.text, "active unsaved draft");
    // Inactive rail scope was shed, active scope kept.
    assert!(s.rail_excerpts.retained_bytes() < 2_000);

    let ui = s.workspace.as_mut().unwrap();
    // Entries: 0 = active blank, 1 = tab-mid (touched=2), 2 = tab-recent (touched=3), 3 = tab-oldest (touched=1).
    let oldest_cache = ui.take_entry_cache(3).unwrap();
    let mid_cache = ui.take_entry_cache(1).unwrap();
    let recent_cache = ui.take_entry_cache(2).unwrap();

    // Oldest tab's transcript was evicted first; most recent tab's transcript survived.
    assert_eq!(oldest_cache.history_weight().0, 0);
    assert_eq!(recent_cache.history_weight().0, 1);
    // Secondary caches on the oldest tab were evicted (files/git + mission body).
    assert_eq!(oldest_cache.files_and_git_bytes(), 0);
    assert_eq!(ui.entry_missions_ref(3).unwrap().retained_bytes(), 0);
    // Draft on evicted tab is still preserved when restored.
    let mut restored = crate::init();
    oldest_cache.apply(&mut restored);
    assert_eq!(restored.draft.text, "tab-oldest");
    let _ = mid_cache;
}

#[test]
fn extreme_pressure_protects_active_tab_streaming_tab_and_all_unsaved_drafts() {
    let mut s = crate::init();
    s.draft = rune::edit::TextEdit::new("active composer draft");
    s.messages.push(message_with_size("active-msg", 12_000));
    s.documents
        .insert_test_file_draft("notes.md", "unsaved file store draft");
    s.transcript_display
        .timeline
        .fixture_set_excerpt_scope(7, Some("keep-me".into()));
    s.rail_excerpts
        .fixture_remember(7, "keep-me".into(), "k".repeat(1_024), 1.0);
    s.rail_excerpts
        .fixture_remember(7, "drop-me".into(), "d".repeat(4_096), 2.0);
    s.prompt_history
        .fixture_push("other-tab", "ses-old", "r".repeat(4_096));
    s.prompt_history
        .fixture_push("tab-0", "ses-active", "p".repeat(4_096));

    let mut ui = Ui::new();
    // Protected streaming tab: transcript & draft must survive even under extreme pressure.
    let (live_cache, live_missions) = build_inactive_tab(
        "tab-live",
        Phase::Streaming,
        8_000,
        4_000,
        4_000,
        4_000,
        "live draft",
        "live commit msg",
        false,
    );
    ui.push_fixture_entry("tab-live", 1, live_cache, live_missions);

    // Unprotected inactive tab with composer draft, git commit draft, and dirty file editor edit.
    let (dirty_cache, dirty_missions) = build_inactive_tab(
        "tab-dirty",
        Phase::Ready,
        8_000,
        4_000,
        4_000,
        4_000,
        "dirty tab composer draft",
        "unsaved commit message",
        true,
    );
    ui.push_fixture_entry("tab-dirty", 2, dirty_cache, dirty_missions);
    s.workspace = Some(ui);

    // Extreme 1-byte ceiling forces every evictable tier to run.
    let after = enforce_with(
        &mut s,
        Limits {
            global_bytes: 1,
            inactive_history_bytes: usize::MAX,
            inactive_history_rows: usize::MAX,
        },
    );

    // Active tab and window file-draft store are completely preserved.
    assert_eq!(s.messages.len(), 1);
    assert_eq!(s.draft.text, "active composer draft");
    assert!(s.documents.has_tab_edits("tab-0"));

    // Window-global recall & non-hovered rail excerpts were shed; hovered target kept.
    assert_eq!(s.prompt_history.retained_bytes(), 0);
    assert!(s.rail_excerpts.retained_bytes() >= 1_024);
    assert!(s.rail_excerpts.retained_bytes() < 2_048);

    let ui = s.workspace.as_mut().unwrap();
    // Accounting stays exact after eviction.
    assert_eq!(ui.memory_budget_mut().total_bytes(), after.total());
    // Missions caches on both inactive tabs were evicted.
    assert_eq!(ui.entry_missions_ref(1).unwrap().retained_bytes(), 0);
    assert_eq!(ui.entry_missions_ref(2).unwrap().retained_bytes(), 0);

    // Protected streaming tab kept its transcript AND drafts, while shedding reloadable file/git caches.
    let live_cache = ui.take_entry_cache(1).unwrap();
    assert_eq!(live_cache.history_weight().0, 1);
    assert_eq!(live_cache.files_and_git_bytes(), 0);
    let mut restored_live = crate::init();
    live_cache.apply(&mut restored_live);
    assert_eq!(restored_live.draft.text, "live draft");
    assert_eq!(
        crate::git::fixture_commit_draft(&mut restored_live, None).as_deref(),
        Some("live commit msg")
    );

    // Unprotected dirty tab evicted its transcript and git diff, but preserved its composer draft,
    // git commit draft, and dirty file editor preview!
    let mut dirty_cache = ui.take_entry_cache(2).unwrap();
    assert_eq!(dirty_cache.history_weight().0, 0);
    assert!(
        dirty_cache
            .files_mut()
            .as_ref()
            .unwrap()
            .reader
            .preview()
            .is_some(),
        "dirty file editor preview must remain protected"
    );
    let mut restored_dirty = crate::init();
    dirty_cache.apply(&mut restored_dirty);
    assert_eq!(restored_dirty.draft.text, "dirty tab composer draft");
    assert_eq!(
        crate::git::fixture_commit_draft(&mut restored_dirty, None).as_deref(),
        Some("unsaved commit message")
    );
    assert_eq!(restored_dirty.git.retained_bytes(), 0);
}

#[test]
fn wasm_and_native_limits_are_consistent_and_ui_drop_releases_ledger() {
    assert_eq!(Limits::WASM.global_bytes, 96 * 1024 * 1024);
    assert!(Limits::WASM.inactive_history_bytes <= Limits::WASM.global_bytes);
    assert!(Limits::WASM.global_bytes < Limits::NATIVE.global_bytes);

    let mut s = crate::init();
    s.messages.push(message_with_size("m", 4_096));
    s.workspace = Some(Ui::new());
    let usage = enforce_with(&mut s, Limits::WASM);
    let ledger = Arc::clone(s.workspace.as_mut().unwrap().memory_budget_mut().ledger());
    assert_eq!(ledger.total_bytes(), usage.total());
    assert!(ledger.total_bytes() >= 4_096);

    // Dropping workspace::Ui drops all measured reservations -> zero accounting leak.
    s.workspace = None;
    assert_eq!(ledger.total_bytes(), 0);
}
