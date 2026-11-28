use super::detail::read_window;
use crate::{
    platform::{self, reads::Reads},
    strings::t,
};
use codenomad_client::{
    Receiver, Wake,
    backend::Backend,
    bounded,
    history::Result,
    missions::{Activity, ActorState, Coverage, DirectoryChanged},
    runtime::timeout,
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, attachment,
    git_panel::{self as theme, ButtonLook::Flat},
    layout::{self, Layout},
    shell,
};
use std::{collections::HashSet, rc::Rc, time::Duration};

#[derive(Default)]
pub(super) struct Observation {
    pages: Vec<Activity>,
    current_actors: Rc<HashSet<String>>,
    current_end: Option<u64>,
    revision: Option<u64>,
    seen_revision: Option<u64>,
    active: Option<(u64, Receiver<Result<Activity>>)>,
    pending: Option<u64>,
    failed: Option<u64>,
    due: Option<f64>,
    settled_at: Option<f64>,
}

impl Observation {
    #[cfg(test)]
    pub(super) fn fixture_actor(&mut self, session_id: &str) {
        use codenomad_client::missions::{Activity, Actor, Window};
        let actor = Actor {
            session_id: session_id.into(),
            title: session_id.into(),
            state: ActorState::Running,
            request: None,
        };
        if let Some(first) = self.pages.first_mut() {
            first.actors.push(actor);
        } else {
            self.pages.push(Activity {
                revision: 2,
                observed_at: 10.0,
                window: Window {
                    order: "same".into(),
                    offset: 0,
                    end: 1,
                    total: 1,
                },
                coverage: Coverage::Observed,
                requests: Coverage::Observed,
                actors: vec![actor],
            });
            self.current_end = Some(1);
        }
        self.rebuild_current_actors();
    }

    pub fn includes_actor(&self, session_id: &str) -> bool {
        self.current_actors.contains(session_id)
    }

    pub fn current_actors(&self) -> Rc<HashSet<String>> {
        self.current_actors.clone()
    }

    fn rebuild_current_actors(&mut self) {
        let actors: HashSet<String> = self
            .pages
            .iter()
            .filter(|page| self.current(page))
            .flat_map(|page| &page.actors)
            .map(|actor| actor.session_id.clone())
            .collect();
        self.current_actors = Rc::new(actors);
    }

    pub fn working(&self) -> bool {
        self.pages
            .iter()
            .filter(|page| self.current(page))
            .flat_map(|page| &page.actors)
            .any(|actor| {
                actor.request.is_some()
                    || matches!(
                        actor.state,
                        ActorState::Running
                            | ActorState::Queued
                            | ActorState::Background
                            | ActorState::Form
                            | ActorState::Permission
                    )
            })
    }

    pub fn refresh(&mut self) {
        self.pending = Some(0);
    }

    pub fn observe(&mut self, revision: u64) {
        let next = self.revision.max(Some(revision));
        if next != self.revision {
            self.revision = next;
            self.rebuild_current_actors();
        }
    }

    pub fn cancel(&mut self) {
        self.active = None;
        self.pending = None;
        self.due = None;
        self.current_end = None;
        self.rebuild_current_actors();
    }

    pub fn invalidate(&mut self, now: f64) {
        self.due
            .get_or_insert_with(|| self.settled_at.map_or(now, |last| now.max(last + 5.0)));
    }

    pub fn schedule(&mut self, now: f64, tx: &mut rune::Tx) {
        if self.active.is_none()
            && let Some(due) = self.due
        {
            if due > now {
                tx.wake_at(due);
            } else {
                self.due = None;
                self.refresh();
            }
        }
    }

    pub fn settle(&mut self, floor: Option<u64>, now: f64, wake: &Wake) -> bool {
        let advanced = floor > self.revision;
        if advanced {
            self.revision = floor;
            self.refresh();
            self.rebuild_current_actors();
        }
        if let Some((offset, result)) = self
            .active
            .as_ref()
            .and_then(|(offset, inbox)| inbox.try_recv().ok().map(|result| (*offset, result)))
        {
            self.active = None;
            self.settled_at = Some(now);
            if let Some(due) = &mut self.due {
                *due = (*due).max(now + 5.0);
            }
            if self.due.is_some() {
                wake();
            }
            self.failed = match result {
                Ok(page) if Some(page.revision) >= self.revision.max(floor) => {
                    let revision = page.revision;
                    let previous_failure = self.failed.filter(|failed| offset == 0 && *failed != 0);
                    let same_order = self
                        .pages
                        .first()
                        .is_some_and(|old| old.window.order == page.window.order);
                    if self.adopt(offset, page) {
                        self.observe(revision);
                        self.seen_revision = self.seen_revision.max(Some(revision));
                        previous_failure.map(|failed| {
                            if same_order {
                                failed.min(self.current_end.unwrap_or(0))
                            } else {
                                0
                            }
                        })
                    } else {
                        Some(offset)
                    }
                }
                Err(error) if error.is::<DirectoryChanged>() => Some(0),
                Ok(_) => Some(0),
                _ => Some(offset),
            };
            self.rebuild_current_actors();
            return true;
        }
        advanced
    }

    #[allow(clippy::misnamed_getters)]
    pub fn revision(&self) -> Option<u64> {
        self.seen_revision
    }

    pub fn poll(
        &mut self,
        backend: &Backend,
        project: &str,
        id: &str,
        revision: u64,
        reads: &Reads,
        wake: &Wake,
    ) -> bool {
        if self.revision.is_none_or(|known| revision > known) {
            self.revision = Some(revision);
            self.refresh();
            self.rebuild_current_actors();
        }
        if self.active.is_some() {
            return false;
        }
        let Some(offset) = self.pending.take() else {
            return false;
        };
        let order = self
            .pages
            .first()
            .filter(|_| offset != 0)
            .map(|page| page.window.order.as_str());
        let read = backend.mission_activity(project, id, offset, order);
        let (out, inbox) = bounded(1);
        self.active = Some((offset, inbox));
        let reads = reads.clone();
        let wake = wake.clone();
        platform::spawn(async move {
            let (_cancel, alive) = bounded(1);
            let read = async {
                read_window(read?, &reads, &alive)
                    .await
                    .ok_or("cancelled Mission observation")?
            };
            let task = async {
                timeout(Duration::from_secs(30), read)
                    .await
                    .ok_or("Mission observation timed out")?
            };
            if let Some(result) = codenomad_client::runtime::until_closed(&out, task).await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
        true
    }

    fn adopt(&mut self, offset: u64, page: Activity) -> bool {
        let end = page.window.end;
        let total = page.window.total;
        if offset == 0 {
            if self.pages.first().is_some_and(|prior| {
                prior.revision > page.revision
                    || prior.revision == page.revision && prior.observed_at > page.observed_at
                    || prior.window.order == page.window.order && prior.window.total != total
            }) {
                return false;
            }
            if self
                .pages
                .first()
                .is_some_and(|prior| prior.window.order != page.window.order)
            {
                self.pages.clear();
            }
            if let Some(prior) = self.pages.first_mut() {
                *prior = page;
            } else {
                self.pages.push(page);
            }
        } else {
            if self.current_end != Some(offset)
                || self.pages.first().is_none_or(|prior| {
                    offset != page.window.offset
                        || prior.window.order != page.window.order
                        || prior.window.total != page.window.total
                })
                || page.actors.iter().any(|actor| {
                    self.pages
                        .iter()
                        .take_while(|prior| prior.window.offset < offset)
                        .flat_map(|page| &page.actors)
                        .any(|old| old.session_id == actor.session_id)
                })
            {
                return false;
            }
            match self
                .pages
                .binary_search_by_key(&offset, |prior| prior.window.offset)
            {
                Ok(index) => self.pages[index] = page,
                Err(index) => self.pages.insert(index, page),
            }
        }
        self.current_end = Some(end);
        if end == total {
            self.pages
                .retain(|page| page.window.offset < end || end == 0 && page.window.offset == 0);
        }
        self.rebuild_current_actors();
        true
    }

    pub fn more(&mut self) {
        if !self.busy() {
            self.pending = self.failed.or_else(|| self.more_offset());
        }
    }

    fn more_offset(&self) -> Option<u64> {
        let end = self.current_end?;
        self.pages
            .first()
            .filter(|page| end < page.window.total)
            .map(|_| end)
    }

    fn busy(&self) -> bool {
        self.active.is_some() || self.pending.is_some()
    }

    fn current(&self, page: &Activity) -> bool {
        self.current_end.is_some_and(|end| page.window.end <= end)
            && Some(page.revision) >= self.revision
            && self
                .failed
                .is_none_or(|offset| offset != 0 && offset != page.window.offset)
    }

    pub fn view<S: 'static>(&self, more: impl Fn(&mut S) + 'static) -> El {
        let label = t("missions.control.activity.title");
        let partial = self.more_offset().is_some()
            || self.pages.len() > 1
            || self.pages.iter().any(|page| {
                page.coverage != Coverage::Observed
                    || page.requests != Coverage::Observed
                    || !self.current(page)
            });
        let mut view = theme::context()
            .role("region")
            .label(label)
            .key("mission-activity")
            .child(shell::panel_title(label).role("heading"));
        let mut list = col().full_width().role("list").label(label);
        for page in &self.pages {
            for actor in &page.actors {
                let title = if actor.title.is_empty() {
                    &actor.session_id
                } else {
                    &actor.title
                };
                let state = if !self.current(page) {
                    ActorState::Unknown
                } else {
                    actor.request.unwrap_or(actor.state)
                };
                list = list.child(
                    layout::action_row()
                        .pad(Space::Xs)
                        .role("listitem")
                        .label(title)
                        .key(format!("mission-actor-{}", actor.session_id))
                        .child(text(title).wrap_anywhere().remaining())
                        .child(attachment::status_badge(status(state))),
                );
            }
        }
        view = view.child(list);
        if self.busy() {
            view = view.child(theme::note(t("missions.control.loading"), "status"));
        } else if self.failed.is_some() || self.more_offset().is_some() {
            let failed = self.failed.is_some();
            if failed {
                view = view.child(theme::note(t("missionsPanel.pages.failed"), "alert"));
            }
            let mut action = theme::button(
                t(if failed {
                    "missionsPanel.reader.retry"
                } else {
                    "missionsPanel.pages.more"
                }),
                Flat,
                false,
                move |s, tx| {
                    more(s);
                    tx.instant();
                },
            )
            .key("mission-activity-more");
            if partial {
                let help = t("missionsPanel.pages.observations");
                action = action.help(help).description(help);
            }
            view = view.child(layout::action_row().child(action));
        } else if partial {
            view = view.child(
                theme::note(status(ActorState::Unknown), "status")
                    .description(t("missionsPanel.pages.observations")),
            );
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codenomad_client::missions::Window;

    fn page(revision: u64, observed_at: f64, offset: u64, total: u64) -> Activity {
        Activity {
            revision,
            observed_at,
            window: Window {
                order: "same".into(),
                offset,
                end: offset + 1,
                total,
            },
            coverage: Coverage::Partial,
            requests: Coverage::Unknown,
            actors: vec![],
        }
    }

    #[test]
    fn activity_windows_keep_independent_provenance_and_cannot_retry_an_older_observation() {
        let mut state = Observation::default();
        assert!(state.adopt(0, page(7, 100.0, 0, 2)));
        assert!(state.adopt(1, page(7, 107.0, 1, 2)));
        assert!(!state.adopt(0, page(7, 99.0, 0, 2)));
        assert!(state.adopt(0, page(7, 200.0, 0, 2)));
        assert!(state.current(&state.pages[0]));
        assert!(
            !state.current(&state.pages[1]),
            "same revision is not the same observation cycle"
        );
        assert_eq!(state.more_offset(), Some(1));
        assert!(state.adopt(1, page(7, 201.0, 1, 2)));
        assert!(state.current(&state.pages[1]));
        assert_eq!(state.more_offset(), None);
    }

    #[test]
    fn lifecycle_burst_owes_one_observation_after_settlement_and_hiding_revokes_it() {
        let mut state = Observation::default();
        let (send, inbox) = bounded(1);
        state.active = Some((0, inbox));
        state.invalidate(1.0);
        state.invalidate(2.0);
        send.try_send(Ok(page(7, 100.0, 0, 2))).ok().unwrap();
        let wake: Wake = std::sync::Arc::new(|| {});
        assert!(state.settle(Some(8), 3.0, &wake));
        assert!(state.pages.is_empty());
        assert_eq!(state.due, Some(8.0));
        state.cancel();
        assert!(state.due.is_none() && !state.busy());
    }

    #[test]
    fn actor_index_stays_in_sync_with_revision_advance_and_offset_zero_failure() {
        let mut state = Observation::default();
        state.fixture_actor("ses_worker");
        assert!(state.includes_actor("ses_worker"));

        // Advancing revision retires older pages from the actor index immediately.
        state.observe(3);
        assert!(!state.includes_actor("ses_worker"));

        // Re-adopting at revision 3 restores the actor; an offset-0 failure clears it again.
        let (send, inbox) = bounded(1);
        state.active = Some((0, inbox));
        let mut p = page(3, 100.0, 0, 1);
        p.actors.push(codenomad_client::missions::Actor {
            session_id: "ses_worker".into(),
            title: "worker".into(),
            state: ActorState::Running,
            request: None,
        });
        send.try_send(Ok(p)).ok().unwrap();
        let wake: Wake = std::sync::Arc::new(|| {});
        assert!(state.settle(Some(3), 1.0, &wake));
        assert!(state.includes_actor("ses_worker"));

        let (send2, inbox2) = bounded(1);
        state.active = Some((0, inbox2));
        send2.try_send(Err("network".into())).ok().unwrap();
        assert!(state.settle(Some(3), 2.0, &wake));
        assert!(!state.includes_actor("ses_worker"));
    }
}

fn status(state: ActorState) -> &'static str {
    t(match state {
        ActorState::Running => "missions.control.activity.state.running",
        ActorState::Queued => "missions.control.activity.state.queued",
        ActorState::Background => "missions.control.activity.state.background",
        ActorState::Permission => "missions.control.activity.state.permission",
        ActorState::Form => "missions.control.activity.state.form",
        ActorState::Missing => "missions.control.activity.state.missing",
        ActorState::IdleWithoutReport => "missions.control.activity.state.idle-without-report",
        ActorState::Unknown => "missions.control.activity.state.unknown",
    })
}
