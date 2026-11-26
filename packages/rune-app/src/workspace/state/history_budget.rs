use super::State;
#[cfg(any(test, all(feature = "test-support", not(target_arch = "wasm32"))))]
use super::Ui;
use crate::workspace::memory_budget;

pub(super) fn enforce(s: &mut State) {
    memory_budget::enforce(s);
}

#[cfg(all(feature = "test-support", not(target_arch = "wasm32")))]
pub(crate) fn evict_for_probe(s: &mut State, tab: &str) -> Option<(usize, usize)> {
    let ui = s.workspace.as_mut()?;
    let count = |ui: &Ui| {
        let entry = ui.entries.iter().find(|entry| entry.key == tab)?;
        Some(entry.cache.as_ref()?.history_weight().0)
    };
    let before = count(ui)?;
    memory_budget::trim_inactive_history(ui, 0, 0);
    Some((before, count(ui)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Message, Phase,
        workspace::state::{Cache, Tab, entry},
    };

    #[test]
    fn budget_evicts_the_least_recently_viewed_inactive_content_only() {
        let mut ui = Ui::new();
        for (key, touched) in [("a", 2), ("b", 3), ("c", 1), ("live", 0)] {
            let mut s = crate::init();
            s.phase = if key == "live" {
                Phase::Streaming
            } else {
                Phase::Ready
            };
            s.draft = rune::edit::TextEdit::new(key);
            s.messages.push(
                Message {
                    usage: None,
                    id: key.into(),
                    body: key.into(),
                    role: "user".into(),
                    parts: vec![],
                    completed: true,
                }
                .into(),
            );
            let mut item = entry(key.into(), Tab::Blank);
            item.history_touched = touched;
            item.cache = Some(Cache::take(&mut s));
            ui.entries.push(item);
        }
        memory_budget::trim_inactive_history(&mut ui, 3, usize::MAX);
        assert_eq!(ui.entries[1].cache.as_ref().unwrap().history_weight().0, 1);
        assert_eq!(ui.entries[2].cache.as_ref().unwrap().history_weight().0, 1);
        assert_eq!(ui.entries[4].cache.as_ref().unwrap().history_weight().0, 1);
        let evicted = ui.entries[3].cache.take().unwrap();
        let mut s = crate::init();
        evicted.apply(&mut s);
        assert!(s.messages.is_empty());
        assert_eq!(s.draft.text, "c");
    }
}
