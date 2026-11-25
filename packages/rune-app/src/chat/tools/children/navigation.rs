use super::*;

impl Children {
    pub(in crate::chat::tools) fn background_session(s: &mut State) {
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

    pub(in crate::chat::tools) fn open_child(
        s: &mut State,
        parent: Option<&str>,
        child: &str,
        _tx: &mut rune::Tx,
    ) {
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
}
