use super::{
    Panel,
    cleanup::{CleanupKey, CleanupOwner, DeleteIntent, WorkspaceScope},
    lifecycle::MissionKey,
};
use crate::{
    State,
    strings::{locale, t},
};
use codenomad_client::missions::Cleanup;
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue, git_panel as theme,
    layout::{self, Layout},
};

pub(crate) type CleanupAct = fn(&mut State, String, WorkspaceScope, Cleanup);
pub(crate) type DeleteAct = fn(&mut State, String, WorkspaceScope, MissionKey, bool);

pub(crate) fn cleanup_view<S: 'static>(
    panel: &Panel,
    owner: &CleanupOwner,
    occurrence: &str,
    retry: fn(&mut S, String, WorkspaceScope, Cleanup),
    orphaned_delete: fn(&mut S, String, WorkspaceScope, MissionKey, bool),
) -> El {
    let scope = panel.cleanup_scope();
    let selected_id = panel
        .control_source(occurrence)
        .map(|(source, _)| source.mission);
    let mut orphaned: Vec<(&MissionKey, &DeleteIntent)> = scope
        .as_ref()
        .map(|scope| owner.orphaned_deletes(scope, selected_id.as_ref()))
        .unwrap_or_default();
    orphaned.sort_by(|(a, _), (b, _)| a.id.cmp(&b.id));
    if panel.cleanups.is_empty() && orphaned.is_empty() {
        return rune::el();
    }
    let mut root = col().full_width();
    if let Some(scope) = &scope
        && !orphaned.is_empty()
    {
        let mut pending = col()
            .full_width()
            .key("mission-orphaned-deletes")
            .role("region")
            .label(t("missions.control.delete"));
        for (mission_key, intent) in orphaned {
            let mut row = col()
                .full_width()
                .pad(Space::Sm)
                .key(format!("mission-delete-{}", mission_key.id))
                .child(
                    text(&intent.title)
                        .text_role(TextRole::Small)
                        .wrap_anywhere(),
                );
            if intent.flight.is_some() {
                row = row.child(theme::note(
                    t("missions.control.mutation.pending"),
                    "status",
                ));
            } else if let Some(err) = intent.error {
                let retry_disabled =
                    !panel.online() || owner.has_active_cleanup_retry(scope, &mission_key.id);
                let occ_retry = occurrence.to_owned();
                let scope_retry = scope.clone();
                let key_retry = mission_key.clone();
                let occ_cancel = occurrence.to_owned();
                let scope_cancel = scope.clone();
                let key_cancel = mission_key.clone();
                row = row.child(theme::note(t(err), "alert")).child(
                    layout::action_row()
                        .role("group")
                        .label(t("missions.control.delete"))
                        .child(
                            layout::button_tx(
                                t("missions.control.retry"),
                                false,
                                move |s: &mut S, tx| {
                                    if !retry_disabled {
                                        orphaned_delete(
                                            s,
                                            occ_retry.clone(),
                                            scope_retry.clone(),
                                            key_retry.clone(),
                                            true,
                                        );
                                        tx.instant();
                                    }
                                },
                            )
                            .disabled(retry_disabled)
                            .focusable(true)
                            .description(&intent.title)
                            .key(format!("mission-delete-retry-{}", mission_key.id)),
                        )
                        .child(
                            layout::button_tx(
                                t("missions.control.cancel"),
                                false,
                                move |s: &mut S, tx| {
                                    orphaned_delete(
                                        s,
                                        occ_cancel.clone(),
                                        scope_cancel.clone(),
                                        key_cancel.clone(),
                                        false,
                                    );
                                    tx.instant();
                                },
                            )
                            .description(&intent.title)
                            .key(format!("mission-delete-cancel-{}", mission_key.id)),
                        ),
                );
            }
            pending = pending.child(row);
        }
        root = root.child(pending);
    }
    if panel.cleanups.is_empty() {
        return root;
    }
    let any_pending = panel.cleanups.iter().any(Cleanup::is_pending);
    let heading = t(if any_pending {
        "missions.cleanup.title"
    } else {
        "missions.progress.cleanupHistory"
    });
    let busy = scope
        .as_ref()
        .is_some_and(|scope| owner.cleanup_busy(scope));
    let mut section = col()
        .full_width()
        .key("mission-cleanup-section")
        .role("region")
        .label(heading)
        .child(
            text(heading)
                .text_role(TextRole::Small)
                .pad(Space::Sm)
                .role("heading"),
        );
    for cleanup in &panel.cleanups {
        let counts = catalogue::format(
            locale(),
            "missions.cleanup.counts",
            &[
                ("removed", &cleanup.removed.to_string()),
                ("retained", &cleanup.retained.to_string()),
                ("pending", &cleanup.pending.to_string()),
            ],
        );
        let mut row = col()
            .full_width()
            .pad(Space::Sm)
            .key(format!(
                "mission-cleanup-{}-{}",
                cleanup.mission_id, cleanup.deletion_id
            ))
            .child(
                text(&cleanup.objective)
                    .text_role(TextRole::Small)
                    .wrap_anywhere(),
            )
            .child(text(counts).text_role(TextRole::Small).wrap_anywhere());
        if cleanup.document_pending == Some(true) {
            row = row.child(theme::note(t("missions.cleanup.documentPending"), "status"));
        }
        if cleanup.retained > 0 {
            for reason in &cleanup.reasons {
                if let Some(key) = reason_key(reason) {
                    row = row.child(text(t(key)).text_role(TextRole::Small).wrap_anywhere());
                }
            }
        }
        if cleanup.is_pending() {
            let retrying = scope.as_ref().is_some_and(|scope| {
                owner.cleanup_retrying(&CleanupKey::new(scope.clone(), cleanup))
            });
            let label = t(if retrying {
                "missions.cleanup.retrying"
            } else {
                "missions.control.retry"
            });
            let delete_busy = scope
                .as_ref()
                .is_some_and(|scope| owner.has_active_delete_flight(scope, &cleanup.mission_id));
            let disabled = !panel.online()
                || panel.cleanups_unavailable()
                || scope.is_none()
                || busy
                || delete_busy;
            let occ = occurrence.to_owned();
            let captured_scope = scope.clone();
            let saved = cleanup.clone();
            row = row.child(
                layout::button_tx(label, false, move |state: &mut S, tx| {
                    if !disabled && let Some(scope) = captured_scope.clone() {
                        retry(state, occ.clone(), scope, saved.clone());
                        tx.instant();
                    }
                })
                .disabled(disabled)
                .focusable(true)
                .description(&cleanup.objective)
                .key(format!(
                    "mission-cleanup-retry-{}-{}",
                    cleanup.mission_id, cleanup.deletion_id
                )),
            );
        }
        section = section.child(row);
    }
    section = section.child(
        text(t("missions.cleanup.preserved"))
            .text_role(TextRole::Small)
            .pad(Space::Sm)
            .wrap_anywhere(),
    );
    if let Some(err) = scope.as_ref().and_then(|scope| owner.cleanup_error(scope)) {
        section = section.child(theme::note(t(err), "alert"));
    }
    root.child(section)
}

fn reason_key(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "children" => "missions.cleanup.reason.children",
        "shared" => "missions.cleanup.reason.shared",
        "moved" => "missions.cleanup.reason.moved",
        "identity" => "missions.cleanup.reason.identity",
        "guarded" => "missions.cleanup.reason.guarded",
        _ => return None,
    })
}
