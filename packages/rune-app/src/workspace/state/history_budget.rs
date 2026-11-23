use super::{State, Ui};

// Same inactive payload budget as Solid's session-transcript-memory.ts, plus a row ceiling.
const BYTES: usize = 64 * 1024 * 1024;
const ROWS: usize = 16 * crate::history::MAX_ROWS;

pub(super) fn enforce(s: &mut State) {
    if let Some(ui) = &mut s.workspace {
        trim(ui, ROWS, BYTES);
    }
}

fn trim(ui: &mut Ui, max_rows: usize, max_bytes: usize) {
    let mut order = vec![];
    let mut rows = 0usize;
    let mut bytes = 0usize;
    for (index, entry) in ui.entries.iter().enumerate() {
        if index == ui.active {
            continue;
        }
        if let Some(cache) = &entry.cache {
            let (count, weight) = cache.history_weight();
            rows = rows.saturating_add(count);
            bytes = bytes.saturating_add(weight);
            if count > 0 && !cache.history_protected() {
                order.push((entry.history_touched, index, count, weight));
            }
        }
    }
    order.sort_unstable();
    for (_, index, count, weight) in order {
        if rows <= max_rows && bytes <= max_bytes {
            break;
        }
        if let Some(cache) = &mut ui.entries[index].cache {
            cache.evict_history();
            rows = rows.saturating_sub(count);
            bytes = bytes.saturating_sub(weight);
        }
    }
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
        for (key, touched) in [("a", 2), ("b", 3), ("c", 1)] {
            let mut s = crate::init();
            s.phase = Phase::Ready;
            s.draft = rune::edit::TextEdit::new(key);
            s.messages.push(Message {
                id: key.into(),
                body: key.into(),
                role: "user".into(),
                parts: vec![],
                completed: true,
            });
            let mut item = entry(key.into(), Tab::Blank);
            item.history_touched = touched;
            item.cache = Some(Cache::take(&mut s));
            ui.entries.push(item);
        }
        trim(&mut ui, 2, usize::MAX);
        assert_eq!(ui.entries[1].cache.as_ref().unwrap().history_weight().0, 1);
        assert_eq!(ui.entries[2].cache.as_ref().unwrap().history_weight().0, 1);
        let evicted = ui.entries[3].cache.take().unwrap();
        let mut s = crate::init();
        evicted.apply(&mut s);
        assert!(s.messages.is_empty());
        assert_eq!(s.draft.text, "c");
    }
}
