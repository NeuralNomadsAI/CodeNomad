//! Numeric handles for a bounded window of retained native history objects.
use std::sync::atomic::{AtomicI64, Ordering};

static NEXT_ID: AtomicI64 = AtomicI64::new(1);

pub(super) fn bounded<T>(
    entries: Vec<T>,
    current: Option<usize>,
    token: impl Fn(&T) -> usize,
) -> Vec<T> {
    let index = entries
        .iter()
        .position(|entry| Some(token(entry)) == current)
        .unwrap_or(0);
    let start = index
        .saturating_sub(16)
        .min(entries.len().saturating_sub(32));
    entries.into_iter().skip(start).take(32).collect()
}

#[derive(Default)]
pub(super) struct HistoryIds {
    entries: Vec<(usize, i64)>,
}

impl HistoryIds {
    // Call while the preceding snapshot's objects are still retained: a removed
    // native object's address cannot be recycled into a live numeric handle.
    pub(super) fn reconcile(&mut self, tokens: impl Iterator<Item = usize>) -> Vec<i64> {
        let entries = tokens
            .take(32)
            .map(|token| {
                let id = self
                    .entries
                    .iter()
                    .find(|(old, _)| *old == token)
                    .map(|(_, id)| *id)
                    .unwrap_or_else(|| NEXT_ID.fetch_add(1, Ordering::Relaxed));
                (token, id)
            })
            .collect::<Vec<_>>();
        let ids = entries.iter().map(|(_, id)| *id).collect();
        self.entries = entries;
        ids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_history_native_identity_branch_and_registration() {
        let mut history = HistoryIds::default();
        let original = history.reconcile([10, 20, 30].into_iter());
        // URL changes (redirect/replaceState), duplicate URLs and cursor moves
        // do not enter identity assignment; only the native object does.
        assert_eq!(history.reconcile([10, 20, 30].into_iter()), original);
        let branch = history.reconcile([10, 20, 40].into_iter());
        assert_eq!(&branch[..2], &original[..2]);
        assert!(!branch.contains(&original[2]));
        let reused = history.reconcile([10, 20, 30].into_iter());
        assert_ne!(reused[2], original[2]);
        let mut replacement = HistoryIds::default();
        assert!(!replacement
            .reconcile([10, 20, 30].into_iter())
            .iter()
            .any(|id| reused.contains(id)));
        assert_eq!(history.reconcile(0..100).len(), 32);
        for current in 0..100 {
            let entries = bounded((0..100).collect(), Some(current), |token| *token);
            assert_eq!(entries.len(), 32);
            assert!(entries.contains(&current));
        }
    }
}
