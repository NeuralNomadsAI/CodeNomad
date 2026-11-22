#[derive(Default)]
pub struct Visits {
    ids: Vec<Option<String>>,
    cursor: usize,
}

impl Visits {
    pub fn record(&mut self, id: &str, step: Option<usize>) {
        if let Some(step) = step.filter(|&step| self.at(step) == Some(id)) {
            self.cursor = step;
        } else if self.at(self.cursor) != Some(id) {
            self.ids.drain((self.cursor + 1).min(self.ids.len())..);
            self.ids.push(Some(id.into()));
            if self.ids.len() > 50 {
                self.ids.remove(0);
            }
            self.cursor = self.ids.len() - 1;
        }
    }
    fn at(&self, index: usize) -> Option<&str> {
        self.ids.get(index)?.as_deref()
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
            if id.as_ref().is_some_and(|id| missing.contains(id)) {
                *id = None;
            }
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
            visits.record(key, None);
        }
        visits.forget(&["b".into()]);
        assert_eq!(visits.steps(true, Some("c")).next(), Some((0, "a")));
        visits.record("a", Some(0));
        assert_eq!(visits.steps(false, Some("a")).next(), Some((2, "c")));
        assert_eq!(visits.steps(true, None).next(), Some((0, "a")));
        visits.record("d", None);
        assert_eq!(visits.steps(false, Some("d")).next(), None);
        assert_eq!(visits.steps(true, Some("d")).next(), Some((0, "a")));
    }
}
