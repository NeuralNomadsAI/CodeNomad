use codenomad_client::{Receiver, catalog::SessionAbsence, runtime::Instant};
use std::collections::{HashMap, HashSet};

type Checks = (
    Receiver<(String, Instant, SessionAbsence)>,
    HashMap<String, Option<Instant>>,
);

pub struct PollChecks {
    pub changed: bool,
    pub deleted: Vec<String>,
}

struct Visit {
    id: String,
    listed: bool,
}

#[derive(Default)]
pub struct Visits {
    ids: Vec<Option<Visit>>,
    cursor: usize,
    checks: Option<Checks>,
}

impl Visits {
    pub fn record(&mut self, id: &str, step: Option<usize>, listed: bool) {
        let listed = listed || self.ids.iter().flatten().any(|v| v.id == id && v.listed);
        if let Some(step) = step.filter(|&step| self.at(step) == Some(id)) {
            self.cursor = step;
        } else if self.at(self.cursor) != Some(id) {
            self.ids.drain((self.cursor + 1).min(self.ids.len())..);
            self.ids.push(Some(Visit {
                id: id.into(),
                listed,
            }));
            if self.ids.len() > 50 {
                self.ids.remove(0);
            }
            self.cursor = self.ids.len() - 1;
        }
        if listed && let Some(Some(visit)) = self.ids.get_mut(self.cursor) {
            visit.listed = true;
        }
    }
    pub fn current(&self) -> Option<&str> {
        self.at(self.cursor)
    }
    fn at(&self, index: usize) -> Option<&str> {
        self.ids.get(index)?.as_ref().map(|visit| visit.id.as_str())
    }
    pub fn steps<'a>(
        &'a self,
        back: bool,
        shown: Option<&'a str>,
    ) -> impl Iterator<Item = (usize, &'a str)> {
        let first = if back { self.cursor } else { self.cursor + 1 };
        let offset = if back { -1 } else { 1 };
        std::iter::successors(Some(first), move |i| i.checked_add_signed(offset))
            .take_while(|&i| i < self.ids.len())
            .filter_map(move |i| self.at(i).filter(|id| Some(*id) != shown).map(|id| (i, id)))
    }
    pub fn forget(&mut self, missing: &[String]) {
        for id in &mut self.ids {
            if id.as_ref().is_some_and(|visit| missing.contains(&visit.id)) {
                *id = None;
            }
        }
    }
    pub fn observe_listing(&mut self, listed: &HashSet<String>) {
        for visit in self.ids.iter_mut().flatten() {
            if listed.contains(&visit.id) {
                visit.listed = true;
            }
        }
    }
    pub fn listed_ids(&self) -> impl Iterator<Item = &str> {
        let mut seen = HashSet::new();
        self.ids.iter().rev().flatten().filter_map(move |visit| {
            let id = visit.id.as_str();
            (visit.listed && seen.insert(id)).then_some(id)
        })
    }
    pub fn start_checks(
        &mut self,
        ids: &[String],
        rx: Receiver<(String, Instant, SessionAbsence)>,
    ) {
        self.checks = Some((rx, ids.iter().map(|id| (id.clone(), None)).collect()));
    }
    pub fn cancel_checks(&mut self) {
        self.checks = None;
    }
    pub fn verified(&mut self, id: &str, at: Instant) {
        if let Some((_, verified)) = &mut self.checks
            && let Some(stamp) = verified.get_mut(id)
        {
            *stamp = Some(at);
        }
    }
    pub fn poll_checks(&mut self) -> PollChecks {
        let Some((checks, verified)) = &self.checks else {
            return PollChecks {
                changed: false,
                deleted: Vec::new(),
            };
        };
        let mut unavailable = Vec::new();
        let mut deleted = Vec::new();
        for (id, start, absence) in std::iter::from_fn(|| checks.try_recv().ok()) {
            if verified
                .get(&id)
                .is_some_and(|stamp| stamp.is_none_or(|stamp| start > stamp))
            {
                if absence == SessionAbsence::NotFound {
                    deleted.push(id.clone());
                }
                unavailable.push(id);
            }
        }
        if checks.is_closed() && checks.is_empty() {
            self.checks = None;
        }
        self.forget(&unavailable);
        PollChecks {
            changed: !unavailable.is_empty(),
            deleted,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_after_back_replaces_forward_and_unavailable_sessions_are_skipped() {
        let mut visits = Visits::default();
        for key in ["a", "b", "c"] {
            visits.record(key, None, false);
        }
        visits.forget(&["b".into()]);
        assert_eq!(visits.steps(true, Some("c")).next(), Some((0, "a")));
        visits.record("a", Some(0), false);
        assert_eq!(visits.steps(false, Some("a")).next(), Some((2, "c")));
        assert_eq!(visits.steps(true, None).next(), Some((0, "a")));
        visits.record("d", None, false);
        assert_eq!(visits.steps(false, Some("d")).next(), None);
        assert_eq!(visits.steps(true, Some("d")).next(), Some((0, "a")));
    }

    #[test]
    fn selecting_while_checks_are_pending_supersedes_only_that_sessions_check() {
        let mut visits = Visits::default();
        for key in ["a", "b", "c"] {
            visits.record(key, None, true);
        }
        let (out, input) = codenomad_client::bounded(3);
        visits.start_checks(&["a".into(), "b".into()], input);
        let started = Instant::now();
        visits.record("b", Some(1), true);
        visits.verified("b", started);
        out.try_send(("a".into(), started, SessionAbsence::NotFound))
            .unwrap();
        out.try_send(("b".into(), started, SessionAbsence::NotFound))
            .unwrap();
        let first = visits.poll_checks();
        assert!(first.changed);
        assert_eq!(first.deleted, vec!["a"]);
        assert_eq!(visits.steps(true, None).next(), Some((1, "b")));
        assert!(visits.steps(true, Some("b")).next().is_none());
        out.try_send((
            "b".into(),
            Instant::now() + std::time::Duration::from_secs(1),
            SessionAbsence::LocatedElsewhere,
        ))
        .unwrap();
        let second = visits.poll_checks();
        assert!(second.changed);
        assert!(second.deleted.is_empty());
        assert!(visits.steps(true, None).next().is_none());
    }
}
