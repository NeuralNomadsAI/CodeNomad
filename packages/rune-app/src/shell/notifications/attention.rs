//! Qualify pending input and terminal activity against the conversation observer.
use super::{Category, Notice, RETAINED, Target, deliver};
use crate::State;
use std::collections::HashSet;

#[derive(Default)]
pub(crate) struct Attention {
    requests: [HashSet<String>; 2],
    hinted: [HashSet<String>; 2],
    deferred_requests: [Option<(HashSet<String>, bool)>; 2],
    directory: Option<String>,
    compactions: Vec<String>,
    execution: Option<(String, bool)>,
    pub(super) pending: Vec<(Category, String)>,
    updated: [bool; 2],
    invalidated_completion: bool,
}

impl Attention {
    #[cfg(test)]
    pub(crate) fn take_pending(&mut self) -> Vec<(Category, String)> {
        std::mem::take(&mut self.pending)
    }

    #[cfg(test)]
    pub(crate) fn observe(&mut self, snapshot: &crate::agent_api::Snapshot, current: bool) {
        self.observe_session(snapshot.session_known, snapshot.root_directory.as_deref());
        if let Some(permissions) = snapshot.permissions.as_deref() {
            self.observe_kind(0, permissions.iter().map(|item| item.id.clone()), current);
        }
        if let Some(forms) = snapshot.forms.as_deref() {
            self.observe_kind(1, forms.iter().map(|item| item.id.clone()), current);
        }
    }

    pub(crate) fn observe_session(&mut self, session_known: bool, root_directory: Option<&str>) {
        self.directory = root_directory.map(str::to_owned);
        if self.directory.is_none() {
            if session_known {
                self.compactions.clear();
                self.deferred_requests = [None, None];
            }
            return;
        }
        let capacity = RETAINED.saturating_sub(self.pending.len());
        self.pending.extend(
            self.compactions
                .drain(..)
                .take(capacity)
                .map(|id| (Category::Sessions, id)),
        );
        for kind in 0..2 {
            if let Some((ids, authoritative)) = self.deferred_requests[kind].take() {
                self.observe_requests(kind, ids.into_iter(), authoritative);
            }
        }
    }

    pub(crate) fn observe_kind(
        &mut self,
        kind: usize,
        ids: impl Iterator<Item = String>,
        current: bool,
    ) {
        if self.directory.is_some() {
            self.deferred_requests[kind] = None;
            self.observe_requests(kind, ids, current);
        } else {
            self.deferred_requests[kind] = Some((ids.collect(), current));
        }
    }

    pub(crate) fn execution(&mut self, notice: Option<String>) {
        if let Some(id) = &notice
            && self
                .execution
                .as_ref()
                .is_some_and(|(previous, _)| previous == id)
        {
            return;
        }
        self.execution = notice.map(|id| (id, false));
        self.invalidate_completion();
    }

    pub(crate) fn verify_idle(&mut self) -> Option<(String, String)> {
        let (id, sent) = self.execution.as_mut()?;
        let directory = self.directory.clone()?;
        if std::mem::replace(sent, true) {
            return None;
        }
        Some((id.clone(), directory))
    }

    pub(crate) fn invalidate_kind(&mut self, kind: usize) {
        self.deferred_requests[kind] = None;
    }

    pub(crate) fn resolve_request(&mut self, form: bool, id: &str) {
        let kind = usize::from(form);
        self.hinted[kind].remove(id);
        if let Some((ids, _)) = &mut self.deferred_requests[kind] {
            ids.remove(id);
        }
        self.requests[kind].remove(id);
        self.updated[kind] = true;
        let key = format!("{kind}:{id}");
        self.pending.retain(|(category, pending_id)| {
            *category != Category::NeedsInput || pending_id != &key
        });
    }

    pub(crate) fn disconnected(&mut self) {
        self.execution = None;
        self.directory = None;
        self.compactions.clear();
        self.deferred_requests = [None, None];
        self.pending
            .retain(|(category, _)| *category != Category::Sessions);
        self.hinted.iter_mut().for_each(HashSet::clear);
        self.invalidate_completion();
    }

    pub(crate) fn compacted(&mut self, id: String) {
        if self.compactions.len() < RETAINED && !self.compactions.contains(&id) {
            self.compactions.push(id);
        }
    }

    fn invalidate_completion(&mut self) {
        self.invalidated_completion = true;
        self.pending
            .retain(|(event, _)| *event != Category::SessionDone);
    }

    pub(crate) fn request(&mut self, form: bool, id: String) {
        let kind = usize::from(form);
        if let Some((_, authoritative)) = &mut self.deferred_requests[kind] {
            *authoritative = false;
        }
        let hinted = &mut self.hinted[kind];
        if hinted.len() < RETAINED {
            hinted.insert(id);
        }
    }

    pub(crate) fn confirm_idle(&mut self, id: String, inactive: bool) {
        if self
            .execution
            .as_ref()
            .is_some_and(|(current, _)| current == &id)
        {
            self.execution = None;
            if inactive && self.pending.len() < RETAINED {
                self.pending.push((Category::SessionDone, id));
            }
        }
    }

    fn observe_requests(
        &mut self,
        kind: usize,
        ids: impl Iterator<Item = String>,
        authoritative: bool,
    ) {
        self.updated[kind] = true;
        let current: HashSet<_> = ids.collect();
        let capacity = RETAINED.saturating_sub(self.pending.len());
        let hinted = &mut self.hinted[kind];
        self.pending.extend(
            hinted
                .intersection(&current)
                .take(capacity)
                .map(|id| (Category::NeedsInput, format!("{kind}:{id}"))),
        );
        hinted.retain(|id| !authoritative && !current.contains(id));
        self.requests[kind] = current;
    }
}

fn request_present(key: &str, updated: [bool; 2], requests: &[HashSet<String>; 2]) -> bool {
    match key.split_once(':') {
        Some(("0", id)) if updated[0] => requests[0].contains(id),
        Some(("1", id)) if updated[1] => requests[1].contains(id),
        _ => true,
    }
}

pub(crate) fn collect(s: &mut State, target: impl FnOnce(&State) -> Option<(Target, String)>) {
    let Some(agent) = &mut s.agent else { return };
    if agent.attention.pending.is_empty()
        && agent.attention.updated == [false; 2]
        && !agent.attention.invalidated_completion
    {
        return;
    }
    let pending = std::mem::take(&mut agent.attention.pending);
    let updated = std::mem::take(&mut agent.attention.updated);
    let invalidated_completion = std::mem::take(&mut agent.attention.invalidated_completion);
    let online = agent.online;
    let running = agent.running;
    let Some((target, project)) = target(s) else {
        return;
    };
    if invalidated_completion || running {
        s.notifications
            .deferred
            .retain(|notice| notice.target != target || notice.category != Category::SessionDone);
    }
    if !online {
        return;
    }
    if updated != [false; 2] {
        let requests = &s.agent.as_ref().unwrap().attention.requests;
        s.notifications.deferred.retain(|notice| {
            notice.target != target
                || notice.category != Category::NeedsInput
                || request_present(&notice.id, updated, requests)
        });
    }
    let label = if s.chat_title.trim().is_empty() {
        target.session.clone()
    } else {
        s.chat_title.clone()
    };
    for (category, id) in pending {
        if category == Category::Sessions {
            if let Some(source) = crate::settings::bound_backend(s) {
                super::messages::enqueue(
                    s,
                    source,
                    category,
                    Some(project.clone()),
                    super::messages::compaction(&label),
                    Some(target.clone()),
                    Some(id),
                    false,
                    super::in_app::BubbleOptions::Compaction,
                );
            }
            continue;
        }
        if running && matches!(category, Category::SessionDone) {
            continue;
        }
        deliver(
            s,
            Notice {
                target: target.clone(),
                category,
                id,
                project: project.clone(),
                label: label.clone(),
            },
        );
    }
}
