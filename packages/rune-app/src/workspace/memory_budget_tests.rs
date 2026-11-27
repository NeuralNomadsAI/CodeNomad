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

#[derive(Default)]
struct TabFixture<'a> {
    workspace_id: &'a str,
    phase: Option<Phase>,
    message_bytes: usize,
    file_preview_bytes: usize,
    clean_editor_bytes: usize,
    git_diff_bytes: usize,
    mission_body_bytes: usize,
    mission_summaries: usize,
    composer_draft: &'a str,
    commit_draft: &'a str,
    dirty_file_edit: bool,
}

fn build_inactive_tab(spec: TabFixture<'_>) -> (Cache, Option<crate::missions::Panel>) {
    let mut s = crate::init();
    s.phase = spec.phase.unwrap_or(Phase::Ready);
    s.draft = rune::edit::TextEdit::new(spec.composer_draft);
    if spec.message_bytes > 0 {
        s.messages
            .push(message_with_size(spec.workspace_id, spec.message_bytes));
    }
    let backend = test_backend(spec.workspace_id);
    if spec.file_preview_bytes > 0 || spec.clean_editor_bytes > 0 || spec.dirty_file_edit {
        let mut files = crate::files::Ui::new(
            backend.clone(),
            "/project".into(),
            Default::default(),
            Arc::new(|| {}),
        );
        if spec.file_preview_bytes > 0 {
            files.reader.fixture_set_preview(
                "/project",
                "big.txt",
                vec![b'a'; spec.file_preview_bytes],
            );
        }
        if spec.clean_editor_bytes > 0 {
            files
                .document
                .fixture_load_clean(&"c".repeat(spec.clean_editor_bytes));
        }
        if spec.dirty_file_edit {
            files
                .document
                .fixture_mark_dirty("original", "unsaved local edit");
        }
        s.files = Some(files);
    }
    if spec.git_diff_bytes > 0 || !spec.commit_draft.is_empty() {
        crate::git::connected(&mut s, &backend);
        if let Some(git) = s.git.owner.as_mut() {
            if spec.git_diff_bytes > 0 {
                let half = spec.git_diff_bytes / 2;
                git.fixture_load_diff("diff.rs", "a".repeat(half), "b".repeat(half));
            }
            if !spec.commit_draft.is_empty() {
                let _ = crate::git::fixture_commit_draft(&mut s, Some(spec.commit_draft));
            }
        }
    }
    let missions = (spec.mission_body_bytes > 0 || spec.mission_summaries > 0).then(|| {
        let mut panel = crate::missions::Panel::new(
            backend,
            Some(spec.workspace_id.into()),
            Default::default(),
            Arc::new(|| {}),
        );
        if spec.mission_body_bytes > 0 {
            panel.fixture_cache_body(spec.workspace_id, "m".repeat(spec.mission_body_bytes));
        }
        if spec.mission_summaries > 0 {
            panel.fixture_add_summaries(spec.mission_summaries);
        }
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
    s.transcript_display.timeline.fixture_set_excerpt_scope(
        10,
        Some(("active-hit:Assistant:0:false".into(), "active-hit".into())),
    );
    s.rail_excerpts
        .fixture_remember(10, "active-hit".into(), "a".repeat(512), 1.0);
    s.rail_excerpts
        .fixture_remember(99, "inactive-hit".into(), "z".repeat(4_096), 1.0);

    let mut ui = Ui::new();
    // Add three inactive tabs with non-monotonic timestamps: oldest is `tab-oldest` (touched=1).
    for (key, touched) in [("tab-mid", 2), ("tab-recent", 3), ("tab-oldest", 1)] {
        let (cache, missions) = build_inactive_tab(TabFixture {
            workspace_id: key,
            message_bytes: 10_000,
            file_preview_bytes: 4_000,
            git_diff_bytes: 4_000,
            mission_body_bytes: 4_000,
            composer_draft: key,
            ..Default::default()
        });
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
    assert_eq!(oldest_cache.files_and_git_bytes(&mut Default::default()), 0);
    assert_eq!(ui.entry_missions_ref(3).unwrap().retained_bytes(), 0);
    // Draft on evicted tab is still preserved when restored.
    let mut restored = crate::init();
    oldest_cache.apply(&mut restored);
    assert_eq!(restored.draft.text, "tab-oldest");
    let _ = mid_cache;
}

#[test]
fn non_evictable_mission_summaries_do_not_mask_evictable_file_caches_on_newer_tabs() {
    let mut s = crate::init();
    s.messages.push(message_with_size("active", 4_000));

    let mut ui = Ui::new();
    // Older tab has only non-evictable Mission summaries (200 * 256 = 51_200 B).
    let (old_cache, old_missions) = build_inactive_tab(TabFixture {
        workspace_id: "tab-summaries-only",
        mission_summaries: 200,
        ..Default::default()
    });
    ui.push_fixture_entry("tab-summaries-only", 1, old_cache, old_missions);

    // Newer tab has clean file preview + clean editor buffers (evictable!).
    let (new_cache, new_missions) = build_inactive_tab(TabFixture {
        workspace_id: "tab-clean-files",
        file_preview_bytes: 16_000,
        clean_editor_bytes: 8_000,
        ..Default::default()
    });
    ui.push_fixture_entry("tab-clean-files", 2, new_cache, new_missions);
    s.workspace = Some(ui);

    // Set ceiling below total (active ~4 KiB + summaries 51.2 KiB + files ~40 KiB) so evicting
    // `tab-clean-files` is required; `tab-summaries-only` has 0 evictable bytes and must not stop
    // the Tier-1 planner early.
    let after = enforce_with(
        &mut s,
        Limits {
            global_bytes: 60_000,
            inactive_history_bytes: usize::MAX,
            inactive_history_rows: usize::MAX,
        },
    );
    assert!(
        after.total() <= 60_000,
        "expected total {} <= 60000 after shedding newer tab's evictable files cache",
        after.total()
    );

    let mut newer = s.workspace.as_mut().unwrap().take_entry_cache(2).unwrap();
    let files = newer.files_mut().as_ref().unwrap();
    // Both reader preview and clean editor buffers were evicted and armed for reload on return.
    assert!(files.reader.preview().is_none());
    assert!(files.reader.target().is_some());
    assert_eq!(
        files.document.clean_retained_bytes(&mut Default::default()),
        0
    );
    assert_eq!(files.document.fixture_receipt(), 0);
    assert_eq!(files.retained_bytes(&mut Default::default()), 0);
}

#[test]
fn extreme_pressure_protects_active_tab_streaming_tab_hovered_message_and_all_unsaved_drafts() {
    let mut s = crate::init();
    s.draft = rune::edit::TextEdit::new("active composer draft");
    s.messages.push(message_with_size("active-msg", 12_000));
    s.documents
        .insert_test_file_draft("notes.md", "unsaved file store draft");
    // Distinct marker ID ("msg-keep:Assistant:0:false") vs ExcerptCache message key ("msg-keep").
    s.transcript_display.timeline.fixture_set_excerpt_scope(
        7,
        Some(("msg-keep:Assistant:0:false".into(), "msg-keep".into())),
    );
    s.rail_excerpts
        .fixture_remember(7, "msg-keep".into(), "k".repeat(1_024), 1.0);
    s.rail_excerpts
        .fixture_remember(7, "msg-drop".into(), "d".repeat(4_096), 2.0);
    s.prompt_history
        .fixture_push("other-tab", "ses-old", "r".repeat(4_096));
    s.prompt_history
        .fixture_push("tab-0", "ses-active", "p".repeat(4_096));

    let mut ui = Ui::new();
    // Protected streaming tab: transcript & draft must survive even under extreme pressure.
    let (live_cache, live_missions) = build_inactive_tab(TabFixture {
        workspace_id: "tab-live",
        phase: Some(Phase::Streaming),
        message_bytes: 8_000,
        file_preview_bytes: 4_000,
        git_diff_bytes: 4_000,
        mission_body_bytes: 4_000,
        composer_draft: "live draft",
        commit_draft: "live commit msg",
        ..Default::default()
    });
    ui.push_fixture_entry("tab-live", 1, live_cache, live_missions);

    // Unprotected inactive tab with composer draft, git commit draft, and dirty file editor edit.
    let (dirty_cache, dirty_missions) = build_inactive_tab(TabFixture {
        workspace_id: "tab-dirty",
        message_bytes: 8_000,
        file_preview_bytes: 4_000,
        git_diff_bytes: 4_000,
        mission_body_bytes: 4_000,
        composer_draft: "dirty tab composer draft",
        commit_draft: "unsaved commit message",
        dirty_file_edit: true,
        ..Default::default()
    });
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

    // Window-global recall & non-hovered rail excerpts were shed; hovered message excerpt kept
    // even though the marker ID differs from the ExcerptCache message key.
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
    assert_eq!(live_cache.files_and_git_bytes(&mut Default::default()), 0);
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
fn draft_arc_attachments_are_deduplicated_and_pasted_payloads_are_counted() {
    use crate::composer::draft::Attachment;

    let mut s = crate::init();
    let shared_bytes: Arc<[u8]> = Arc::from(vec![7u8; 4_096]);
    let pasted: Arc<str> = Arc::from("p".repeat(2_048));
    s.composer.draft.attachments.push(Attachment::Device {
        name: "a.bin".into(),
        mime: "application/octet-stream".into(),
        bytes: Arc::clone(&shared_bytes),
        token: None,
    });
    s.composer.draft.attachments.push(Attachment::Pasted {
        id: 1,
        text: Arc::clone(&pasted),
    });

    // Put a second clone of the exact same Arc payloads into an inactive tab's cached composer.
    let mut inactive_state = crate::init();
    inactive_state
        .composer
        .draft
        .attachments
        .push(Attachment::Device {
            name: "a.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: shared_bytes,
            token: None,
        });
    inactive_state
        .composer
        .draft
        .attachments
        .push(Attachment::Pasted {
            id: 1,
            text: pasted,
        });
    let mut ui = Ui::new();
    ui.push_fixture_entry("tab-clone", 1, Cache::take(&mut inactive_state), None);
    s.workspace = Some(ui);

    let usage = measure(&s);
    let drafts = usage.get(Pool::ProtectedDrafts);
    // Counted once (4096 + 2048 + small metadata), never doubled to > 12 KiB.
    assert!(
        drafts >= 6_144,
        "expected pasted + device bytes >= 6144, got {drafts}"
    );
    assert!(
        drafts < 7_000,
        "shared Arc attachments must not be double counted, got {drafts}"
    );
}

#[test]
fn wasm_and_native_limits_are_consistent_and_ui_drop_releases_ledger() {
    const {
        assert!(Limits::WASM.global_bytes == 96 * 1024 * 1024);
        assert!(Limits::WASM.inactive_history_bytes <= Limits::WASM.global_bytes);
        assert!(Limits::WASM.global_bytes < Limits::NATIVE.global_bytes);
    }

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

#[test]
fn shared_clean_file_draft_stays_intact_in_active_tab_and_resyncs_on_reactivation() {
    let shared_store = crate::files::document::store::Store::default();
    let backend = test_backend("ws-shared");
    let content = "shared file body\n".repeat(400);

    // Active tab opens `shared.rs` against `shared_store`.
    let mut s = crate::init();
    s.documents = shared_store.clone();
    let mut active_files = crate::files::Ui::new(
        backend.clone(),
        "/project".into(),
        Default::default(),
        Arc::new(|| {}),
    );
    active_files
        .reader
        .fixture_set_preview("/project", "shared.rs", content.as_bytes().to_vec());
    active_files.document.fixture_attach_shared(
        shared_store.clone(),
        "/project",
        "shared.rs",
        &content,
    );
    let active_preview_bytes = active_files.reader.retained_bytes();
    s.files = Some(active_files);

    // Inactive tab opens the exact same file against the same `shared_store`.
    let mut inactive_state = crate::init();
    let mut inactive_files = crate::files::Ui::new(
        backend,
        "/project".into(),
        Default::default(),
        Arc::new(|| {}),
    );
    inactive_files
        .reader
        .fixture_set_preview("/project", "shared.rs", content.as_bytes().to_vec());
    inactive_files
        .document
        .fixture_attach_shared(shared_store, "/project", "shared.rs", &content);
    inactive_files.activate(false);
    let inactive_preview_bytes = inactive_files.reader.retained_bytes();
    inactive_state.files = Some(inactive_files);

    let mut ui = Ui::new();
    ui.push_fixture_entry("tab-inactive", 1, Cache::take(&mut inactive_state), None);
    s.workspace = Some(ui);

    // Before eviction, the shared clean Draft (text + original text + original wire = 3x content)
    // is counted once globally, alongside both tabs' edit buffers (2x content) and reader previews.
    let before_files = measure(&s).get(Pool::FilesAndGit);
    assert_eq!(
        before_files,
        content.len() * 5 + active_preview_bytes + inactive_preview_bytes,
        "expected 1x shared Draft (3x) + 2x edit + both previews"
    );

    // Force extreme pressure so inactive tab's files caches are evicted.
    let after = enforce_with(
        &mut s,
        Limits {
            global_bytes: 1,
            inactive_history_bytes: usize::MAX,
            inactive_history_rows: usize::MAX,
        },
    );
    // After eviction, active tab retains 1x shared Draft (3x) + 1x edit + active preview.
    assert_eq!(
        after.get(Pool::FilesAndGit),
        content.len() * 4 + active_preview_bytes,
        "shared clean Draft must stay counted once after inactive tab eviction"
    );

    // Active tab's shared Draft and edit buffer remain completely intact and editable!
    let active = s.files.as_ref().unwrap();
    assert_eq!(active.document.edit().text, content);
    assert!(active.document.editable());

    // Inactive tab shed its own edit buffer & reader preview. Even when reactivated OFFLINE,
    // it resyncs from the shared Draft immediately and an offline edit appends to the real body
    // without clobbering the active tab's content.
    let mut inactive_cache = s.workspace.as_mut().unwrap().take_entry_cache(1).unwrap();
    let inactive = inactive_cache.files_mut().as_mut().unwrap();
    assert!(inactive.document.edit().text.is_empty());
    assert!(inactive.reader.preview().is_none());
    inactive.online(false);
    inactive.activate(true);
    assert_eq!(inactive.document.edit().text, content);
    assert!(inactive.document.editable());
    assert!(!inactive.document.poll(&mut inactive.reader));
    let scope = inactive.document.scope();
    let edited = format!("{content}// offline edit\n");
    inactive.document.input(scope).replace_text(&edited);
    inactive.document.changed(scope);
    assert_eq!(inactive.document.edit().text, edited);
    let active = s.files.as_mut().unwrap();
    assert!(active.document.poll(&mut active.reader));
    assert_eq!(active.document.edit().text, edited);
}

#[test]
fn recall_record_protects_newly_recorded_entry_and_evicts_past_shared_arc_attachments() {
    use crate::composer::draft::{Attachment, Draft};

    let mut s = crate::init();

    // Seed an oldest recall entry sharing an 8 KiB Arc<[u8]> with the active composer draft,
    // plus a newer unshared 8 KiB recall entry.
    let shared_bytes: Arc<[u8]> = Arc::from(vec![b's'; 8_192]);
    let unshared_bytes: Arc<[u8]> = Arc::from(vec![b'u'; 8_192]);
    s.composer.draft.attachments.push(Attachment::Device {
        name: "shared.bin".into(),
        mime: "application/octet-stream".into(),
        bytes: Arc::clone(&shared_bytes),
        token: None,
    });
    let shared_draft = Draft {
        attachments: vec![Attachment::Device {
            name: "shared.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: shared_bytes,
            token: None,
        }],
        literal_spans: Vec::new(),
    };
    let unshared_draft = Draft {
        attachments: vec![Attachment::Device {
            name: "unshared.bin".into(),
            mime: "application/octet-stream".into(),
            bytes: unshared_bytes,
            token: None,
        }],
        literal_spans: Vec::new(),
    };
    let _oldest_shared =
        s.prompt_history
            .fixture_push_with_draft("tab-old", "ses-old", "a".into(), shared_draft);
    let _middle_unshared =
        s.prompt_history
            .fixture_push_with_draft("tab-old", "ses-old", "b".into(), unshared_draft);

    // Record a fresh prompt via the real `record` path under a mid-range budget:
    // the oldest shared-Arc entry frees only a few bytes, so eviction must NOT stop there
    // and must also evict the middle unshared-Arc entry.
    let fresh_text = "fresh-attempt".repeat(20);
    s.draft.replace_text(&fresh_text);
    let mid_budget = Limits {
        global_bytes: 12_000,
        inactive_history_bytes: usize::MAX,
        inactive_history_rows: usize::MAX,
    };
    assert!(crate::composer::recall::fixture_record(
        &mut s,
        fresh_text.clone(),
        false,
        mid_budget,
    ));
    let mut seen = std::collections::HashSet::new();
    let _ = s.composer.draft.retained_bytes(&mut seen);
    let remaining_recall = s.prompt_history.retained_bytes_dedup(&mut seen);
    assert!(
        remaining_recall >= fresh_text.len() * 2,
        "newly recorded entry must stay intact, got {remaining_recall}"
    );
    assert!(
        remaining_recall < 4_096,
        "eviction must continue past shared-Arc entry to evict unshared 8 KiB entry, got {remaining_recall}"
    );

    // Record another prompt under an extreme 1-byte ceiling (below the new entry's own size):
    // evicting the previous entry is NOT enough to drop below 1 byte, yet the newly recorded entry
    // must remain protected because `record` returns `true`.
    let latest_text = "latest-protected".repeat(20);
    s.draft.replace_text(&latest_text);
    let extreme = Limits {
        global_bytes: 1,
        inactive_history_bytes: usize::MAX,
        inactive_history_rows: usize::MAX,
    };
    assert!(crate::composer::recall::fixture_record(
        &mut s,
        latest_text.clone(),
        false,
        extreme,
    ));
    let mut seen = std::collections::HashSet::new();
    let _ = s.composer.draft.retained_bytes(&mut seen);
    let protected_remaining = s.prompt_history.retained_bytes_dedup(&mut seen);
    assert!(
        protected_remaining >= latest_text.len() * 2,
        "newly recorded entry must survive extreme 1-byte ceiling, got {protected_remaining}"
    );
    assert!(
        protected_remaining < latest_text.len() * 2 + 128,
        "older recall entry must be evicted under 1-byte ceiling, got {protected_remaining}"
    );
}

#[test]
fn shared_outline_in_saved_cache_and_two_inactive_timelines_is_evicted_without_losing_transcripts()
{
    use codenomad_client::timeline::{Entry, Kind, Outline};

    let entries: Vec<Entry> = (0..64)
        .map(|i| Entry {
            id: format!("msg-{i:04}"),
            seq: i,
            kind: Kind::Assistant,
            tools: 0,
            reasoning: 0,
            text: Some(64),
            tool_name: None,
            layout: Some("plain".into()),
            omitted: None,
        })
        .collect();
    let outline = Arc::new(Outline {
        entries,
        total: 64,
        cacheable: true,
        saved: None,
    });
    let expected_weight = crate::timeline::outline_weight(&outline);
    assert!(expected_weight > 2_000);

    let mut s = crate::init();
    s.saved_outlines.fixture_insert(Arc::clone(&outline));

    // Two inactive tabs share the exact same Arc<Outline>; the newer tab also holds a transcript.
    let mut oldest_state = crate::init();
    oldest_state
        .transcript_display
        .timeline
        .fixture_set_outline(Arc::clone(&outline));

    let mut newer_state = crate::init();
    newer_state
        .messages
        .push(message_with_size("keep-msg", 4_000));
    let transcript_weight = crate::history::retained_bytes(&newer_state.messages);
    newer_state
        .transcript_display
        .timeline
        .fixture_set_outline(outline);

    let mut ui = Ui::new();
    ui.push_fixture_entry("tab-outline-1", 1, Cache::take(&mut oldest_state), None);
    ui.push_fixture_entry("tab-outline-2", 2, Cache::take(&mut newer_state), None);
    s.workspace = Some(ui);

    // Counted once globally (in Pool::Rendered), not zero and not double-counted.
    let before = measure(&s);
    assert_eq!(before.get(Pool::Rendered), expected_weight);
    assert_eq!(before.get(Pool::WindowCaches), 0);
    assert_eq!(before.total(), expected_weight + transcript_weight);

    // Budget fits the newer tab's transcript once the shared outline is freed from saved_outlines
    // AND both inactive tabs. Tier 1 must drop both references instead of falling through to Tier 2.
    let limit = transcript_weight + 512;
    let after = enforce_with(
        &mut s,
        Limits {
            global_bytes: limit,
            inactive_history_bytes: usize::MAX,
            inactive_history_rows: usize::MAX,
        },
    );
    assert_eq!(s.saved_outlines.len(), 0);
    let oldest_cache = s.workspace.as_mut().unwrap().take_entry_cache(1).unwrap();
    let newer_cache = s.workspace.as_mut().unwrap().take_entry_cache(2).unwrap();
    assert!(!oldest_cache.timeline_ref().has_outline());
    assert!(!newer_cache.timeline_ref().has_outline());
    assert_eq!(newer_cache.history_weight().0, 1);
    assert_eq!(after.get(Pool::Rendered), 0);
    assert_eq!(after.total(), transcript_weight);
}
