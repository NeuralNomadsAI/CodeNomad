use super::draft::{Attachment, Draft};
use crate::{State, settings, workspace};
use rune::{Tx, edit::TextEdit};
use std::collections::VecDeque;

mod persistence;
pub(crate) use persistence::poll;

use codenomad_client::prompt_history::MAX_ENTRIES;
const MAX_WINDOW_ENTRIES: usize = 3200;
#[cfg(target_arch = "wasm32")]
const MAX_BYTES: usize = 16 * 1024 * 1024;
#[cfg(not(target_arch = "wasm32"))]
const MAX_BYTES: usize = 80 * 1024 * 1024;
const MAX_INLINE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) enum Project {
    Workspace(Option<String>, Option<String>, String),
    Direct(String, String),
    Unbound,
}

fn scope(s: &State) -> Option<(Project, String, String)> {
    if let Some((tab, saved)) = workspace::active_workspace(s) {
        let session = saved.active_session_id.clone()?;
        let directory = s
            .composer
            .picker
            .backend()
            .filter(|backend| backend.session == session)
            .and_then(|backend| backend.session_directory.as_deref())
            .unwrap_or(&saved.folder);
        return Some((
            Project::Workspace(
                saved.backend_id.clone(),
                saved.server_id.clone(),
                directory.into(),
            ),
            tab.into(),
            session,
        ));
    }
    if s.workspace.is_some() {
        return None;
    }
    Some(
        settings::bound_backend(s).map_or((Project::Unbound, String::new(), String::new()), |b| {
            (
                Project::Direct(b.base, b.session_directory.unwrap_or(b.workspace)),
                String::new(),
                b.session,
            )
        }),
    )
}

pub(super) fn command_target(s: &State) -> Option<super::command_receipts::Target> {
    // Moving a native conversation changes history, never its outstanding receipts.
    if let Some((_, saved)) = workspace::active_workspace(s) {
        return Some((
            Project::Workspace(
                saved.backend_id.clone(),
                saved.server_id.clone(),
                String::new(),
            ),
            saved.active_session_id.clone()?,
        ));
    }
    if let Some(b) = settings::bound_backend(s) {
        return Some((Project::Direct(b.base, String::new()), b.session));
    }
    scope(s).map(|(project, _, session)| (project, session))
}

struct Entry {
    project: Project,
    origin: Option<(String, String)>,
    edit: TextEdit,
    draft: Draft,
    resolved: String,
    bytes: usize,
    id: i64,
}

impl Entry {
    fn originates_in(&self, tab: &str, session: &str) -> bool {
        self.origin
            .as_ref()
            .is_some_and(|(origin_tab, origin_session)| {
                origin_tab == tab && origin_session == session
            })
    }

    fn visible_in(&self, project: &Project, tab: &str, session: &str) -> bool {
        &self.project == project && (self.originates_in(tab, session) || !self.resolved.is_empty())
    }
}

#[derive(Default)]
pub(crate) struct History {
    entries: VecDeque<Entry>,
    bytes: usize,
    next: i64,
    oldest: i64,
    persistence: persistence::Storage,
}

impl History {
    #[cfg(test)]
    pub(crate) fn retained_bytes(&self) -> usize {
        self.bytes
    }

    pub(crate) fn retained_bytes_dedup(
        &self,
        seen: &mut std::collections::HashSet<usize>,
    ) -> usize {
        self.entries.iter().fold(0usize, |total, entry| {
            total
                .saturating_add(entry.edit.text.len())
                .saturating_add(
                    entry
                        .edit
                        .marks()
                        .len()
                        .saturating_mul(size_of::<rune::edit::MarkRange>()),
                )
                .saturating_add(entry.resolved.len())
                .saturating_add(entry.draft.retained_bytes(seen))
        })
    }

    pub(crate) fn evict_under_pressure(
        &mut self,
        bytes_to_free: usize,
        active_tab: Option<&str>,
        active_session: Option<&str>,
        protected_ids: &[i64],
    ) -> usize {
        if bytes_to_free == 0 || self.entries.is_empty() {
            return 0;
        }
        let mut freed = 0usize;
        // Pass 1: evict oldest entries from inactive tabs/sessions first.
        let mut index = self.entries.len();
        while index > 0 && freed < bytes_to_free {
            index -= 1;
            let entry = &self.entries[index];
            let is_active = active_tab.is_some()
                && active_session.is_some()
                && entry.originates_in(
                    active_tab.unwrap_or_default(),
                    active_session.unwrap_or_default(),
                );
            if !is_active
                && !protected_ids.contains(&entry.id)
                && let Some(removed) = self.discard(index)
            {
                freed = freed.saturating_add(entry_sole_owner_bytes(&removed));
            }
        }
        // Pass 2: if still over budget, evict oldest remaining entries except protected ones.
        let mut index = self.entries.len();
        while index > 0 && freed < bytes_to_free {
            index -= 1;
            let entry = &self.entries[index];
            if !protected_ids.contains(&entry.id)
                && let Some(removed) = self.discard(index)
            {
                freed = freed.saturating_add(entry_sole_owner_bytes(&removed));
            }
        }
        freed
    }

    #[cfg(test)]
    pub(crate) fn fixture_push(&mut self, tab: &str, session: &str, text: String) -> i64 {
        self.fixture_push_with_draft(tab, session, text, Draft::default())
    }

    #[cfg(test)]
    pub(crate) fn fixture_push_with_draft(
        &mut self,
        tab: &str,
        session: &str,
        text: String,
        draft: Draft,
    ) -> i64 {
        self.next += 1;
        let bytes = text
            .len()
            .saturating_mul(2)
            .saturating_add(draft.retained_bytes(&mut std::collections::HashSet::new()));
        let id = self.next;
        self.bytes = self.bytes.saturating_add(bytes);
        self.entries.push_front(Entry {
            project: Project::Unbound,
            origin: Some((tab.into(), session.into())),
            edit: TextEdit::new(&text),
            draft,
            resolved: text,
            bytes,
            id,
        });
        id
    }

    fn discard(&mut self, index: usize) -> Option<Entry> {
        let entry = self.entries.remove(index)?;
        self.bytes = self.bytes.saturating_sub(entry.bytes);
        Some(entry)
    }

    fn count(&self, project: &Project) -> usize {
        self.entries
            .iter()
            .filter(|entry| &entry.project == project)
            .count()
    }

    fn full(&self, additional: usize) -> bool {
        self.entries.len() >= MAX_WINDOW_ENTRIES || self.bytes + additional > MAX_BYTES
    }

    pub(crate) fn unique_inline_usage(
        &self,
        seen: &mut std::collections::HashSet<usize>,
    ) -> (usize, usize) {
        self.entries
            .iter()
            .fold((0usize, 0usize), |(files, bytes), entry| {
                let (f, b) = entry.draft.add_unique_inline_usage(seen);
                (files.saturating_add(f), bytes.saturating_add(b))
            })
    }

    fn inline_usage_with(
        &self,
        base_seen: &std::collections::HashSet<usize>,
        base_files: usize,
        base_bytes: usize,
        draft: &Draft,
    ) -> (usize, usize) {
        let mut seen = base_seen.clone();
        let (df, db) = draft.add_unique_inline_usage(&mut seen);
        let (hf, hb) = self.unique_inline_usage(&mut seen);
        (
            base_files.saturating_add(df).saturating_add(hf),
            base_bytes.saturating_add(db).saturating_add(hb),
        )
    }
}

pub(crate) struct Recall {
    id: i64,
    edit: TextEdit,
    draft: Draft,
    missing: bool,
}

impl Recall {
    pub(crate) fn edit(&self) -> &TextEdit {
        &self.edit
    }

    pub(crate) fn draft(&self) -> &Draft {
        &self.draft
    }

    pub(crate) fn clear_draft(&mut self) {
        self.edit.clear();
        self.draft = Draft::default();
        self.missing = false;
    }

    pub(crate) fn id(&self) -> i64 {
        self.id
    }

    pub(crate) fn retained_bytes(&self, seen: &mut std::collections::HashSet<usize>) -> usize {
        self.edit
            .text
            .len()
            .saturating_add(self.draft.retained_bytes(seen))
    }
}

fn entry_sole_owner_bytes(entry: &Entry) -> usize {
    entry
        .edit
        .text
        .len()
        .saturating_add(
            entry
                .edit
                .marks()
                .len()
                .saturating_mul(size_of::<rune::edit::MarkRange>()),
        )
        .saturating_add(entry.resolved.len())
        .saturating_add(entry.draft.sole_owner_bytes())
}
pub(super) fn record(s: &mut State, resolved: String, slash: bool) -> bool {
    record_with_limits(
        s,
        resolved,
        slash,
        crate::workspace::memory_budget::Limits::DEFAULT,
    )
}

#[cfg(test)]
pub(crate) fn fixture_record(
    s: &mut State,
    resolved: String,
    slash: bool,
    limits: crate::workspace::memory_budget::Limits,
) -> bool {
    record_with_limits(s, resolved, slash, limits)
}

fn record_with_limits(
    s: &mut State,
    resolved: String,
    slash: bool,
    limits: crate::workspace::memory_budget::Limits,
) -> bool {
    let Some((project, tab, session)) = scope(s) else {
        return false;
    };
    let mut edit = TextEdit::default();
    let mut draft = Draft::default();
    if slash {
        super::literal::paste(&mut edit, &resolved);
    } else {
        edit.replace_text(&s.draft.text);
        edit.set_marks(s.draft.marks().to_vec());
        draft = s.composer.draft.clone();
        let tokens = super::long_paste::active_tokens(&edit)
            .map(|(_, id)| id)
            .collect::<std::collections::BTreeSet<_>>();
        draft.attachments.retain(|part| match part {
            Attachment::Pasted { id, .. } => tokens.contains(id),
            _ => true,
        });
    }
    let bytes = edit.text.len()
        + edit.marks().len() * size_of::<rune::edit::MarkRange>()
        + resolved.len()
        + draft.inline_usage().1
        + draft
            .attachments
            .iter()
            .map(|part| match part {
                Attachment::Pasted { text, .. } => text.len(),
                Attachment::Project {
                    name, path, uri, ..
                } => name.len() + path.len() + uri.len(),
                Attachment::Path(path) | Attachment::Agent(path) => path.len(),
                Attachment::Skill { id, name } => id.len() + name.len(),
                Attachment::Device {
                    name, mime, token, ..
                } => name.len() + mime.len() + token.as_ref().map_or(0, String::len),
            })
            .sum::<usize>();
    let mut base_seen = std::collections::HashSet::new();
    let (base_inline_files, base_inline_bytes) =
        workspace::window_inline_usage_without_history(s, &mut base_seen, false);
    let mut with_new = base_seen.clone();
    let (new_files, new_bytes) = draft.add_unique_inline_usage(&mut with_new);
    let new_inline_files = base_inline_files.saturating_add(new_files);
    let new_inline_total = base_inline_bytes.saturating_add(new_bytes);
    if bytes > MAX_BYTES
        || new_inline_total > MAX_INLINE_BYTES
        || new_inline_files > workspace::MAX_WINDOW_DEVICE_FILES
    {
        persistence::append(s, &resolved);
        return false;
    }
    persistence::append(s, &resolved);
    let history = &mut s.prompt_history;
    if history.count(&project) >= MAX_ENTRIES
        && let Some(index) = history
            .entries
            .iter()
            .rposition(|entry| entry.project == project)
    {
        history.discard(index);
    }
    while !history.entries.is_empty() && {
        let (total_files, total_bytes) =
            history.inline_usage_with(&base_seen, base_inline_files, base_inline_bytes, &draft);
        history.full(bytes)
            || total_bytes > MAX_INLINE_BYTES
            || total_files > workspace::MAX_WINDOW_DEVICE_FILES
    } {
        history.discard(history.entries.len() - 1);
    }
    history.next += 1;
    history.bytes += bytes;
    let recorded_id = history.next;
    history.entries.push_front(Entry {
        project,
        origin: Some((tab, session)),
        edit,
        draft,
        resolved,
        bytes,
        id: recorded_id,
    });
    let _ = crate::workspace::memory_budget::enforce_with_recall(s, limits, Some(recorded_id));
    true
}

pub(crate) fn forget_tab(s: &mut State, tab_key: &str) {
    let history = &mut s.prompt_history;
    let mut index = 0;
    while index < history.entries.len() {
        let owned_by_closed_tab = history.entries[index]
            .origin
            .as_ref()
            .is_some_and(|(tab, _)| tab == tab_key);
        if !owned_by_closed_tab {
            index += 1;
            continue;
        }
        if history.entries[index].resolved.is_empty() {
            history.discard(index);
            continue;
        }
        let entry = &mut history.entries[index];
        entry.origin = None;
        entry.draft = Draft::default();
        let next_bytes = entry.edit.text.len() + entry.resolved.len();
        history.bytes = history.bytes.saturating_sub(entry.bytes) + next_bytes;
        entry.bytes = next_bytes;
        index += 1;
    }
}

pub(crate) fn fresh(s: &State) -> (&TextEdit, &Draft, bool) {
    s.composer.recall.as_ref().map_or(
        (&s.draft, &s.composer.draft, s.composer.attachments_missing),
        |r| (&r.edit, &r.draft, r.missing),
    )
}

pub(crate) fn restore(s: &mut State) {
    if let Some(recall) = s.composer.recall.take() {
        replace_edit(s, recall.edit);
        s.composer.draft = recall.draft;
        s.composer.attachments_missing = recall.missing;
    }
}

pub(super) fn replace_edit(s: &mut State, mut edit: TextEdit) {
    edit.focused = s.draft.focused;
    s.draft = edit;
}

pub(crate) fn available(s: &State) -> bool {
    scope(s).is_some_and(|(project, tab, session)| {
        s.prompt_history
            .entries
            .iter()
            .any(|e| e.visible_in(&project, &tab, &session))
    })
}

pub(super) fn can_browse(s: &State, older: bool) -> bool {
    if s.composer.editing_locked() || s.composer.device.busy() {
        return false;
    }
    if !older {
        return s.composer.recall.is_some();
    }
    scope(s).is_some_and(|(project, tab, session)| {
        s.prompt_history.entries.iter().any(|entry| {
            s.composer.recall.as_ref().is_none_or(|r| entry.id < r.id)
                && entry.visible_in(&project, &tab, &session)
        })
    })
}

pub(crate) fn step(s: &mut State, older: bool, forced: bool, tx: &mut Tx) -> bool {
    if s.composer.editing_locked()
        || s.composer.device.busy()
        || !forced && s.composer.picker.open()
    {
        return false;
    }
    let current = s.composer.recall.as_ref().map(|r| r.id);
    if current.is_none()
        && (!older
            || !forced
                && (!s.draft.text.trim().is_empty()
                    || s.draft.range() != (0, 0)
                    || !s.composer.draft.attachments.is_empty()
                    || s.composer.attachments_missing))
    {
        return false;
    }
    let Some((project, tab, session)) = scope(s) else {
        return false;
    };
    let mut entries = s
        .prompt_history
        .entries
        .iter()
        .filter(|e| e.visible_in(&project, &tab, &session));
    let next = match (older, current) {
        (true, None) => entries.next(),
        (true, Some(id)) => entries.find(|e| e.id < id),
        (false, Some(id)) => entries.rev().find(|e| e.id > id),
        _ => None,
    };
    if let Some(entry) = next {
        let (mut edit, draft) = if entry.originates_in(&tab, &session) {
            (entry.edit.clone(), entry.draft.clone())
        } else {
            let mut edit = TextEdit::default();
            super::literal::paste(&mut edit, &entry.resolved);
            (edit, Draft::default())
        };
        if let Some(recall) = &mut s.composer.recall {
            recall.id = entry.id;
        } else {
            s.composer.recall = Some(Recall {
                id: entry.id,
                edit: s.draft.clone(),
                draft: s.composer.draft.clone(),
                missing: s.composer.attachments_missing,
            });
        }
        edit.set_caret(edit.text.len());
        replace_edit(s, edit);
        let had_inline = draft.inline_usage().0 > 0;
        s.composer.draft = draft;
        s.composer.attachments_missing = false;
        if had_inline && !workspace::attachment_draft_admissible(s) {
            s.composer
                .draft
                .attachments
                .retain(|part| !matches!(part, Attachment::Device { .. }));
            s.composer.attachments_missing = true;
        }
    } else if !older && current.is_some() {
        restore(s);
        s.draft.set_caret(s.draft.text.len());
    } else {
        return current.is_some();
    }
    s.composer.picker.reset();
    tx.focus("composer", true);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transport::{Command, PromptOutcome};
    use rune::{Env, Key, Runtime};

    #[test]
    fn a_refused_attempt_is_recallable_without_overwriting_new_edits() {
        let (out, commands) = codenomad_client::bounded(1);
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        s.commands = Some(out);
        s.draft = TextEdit::new("attempt");
        s.composer.picker.set_attachments_supported(true);
        let file = Attachment::Device {
            name: "device.txt".into(),
            mime: "text/plain".into(),
            bytes: std::sync::Arc::from(b"here".as_slice()),
            token: None,
        };
        assert!(s.composer.draft.attach(file.clone()));
        let mut rt = Runtime::new(s, crate::view, (900.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            tx.focus("composer", false);
            crate::composer::send(s, tx, false);
        });
        let Command::Prompt(first) = commands.try_recv().unwrap() else {
            panic!("first prompt")
        };
        assert!(rt.state.composer.pending());
        rt.frame(0.0);
        rt.paste("next draft");
        rt.frame(0.0);
        assert_eq!(rt.state.draft.text, "next draft");
        rt.key(Key::Enter.into());
        rt.frame(0.0);
        assert!(commands.try_recv().is_err());
        rt.update(|s, _| {
            crate::composer::acknowledge(s, &first.id.unwrap(), PromptOutcome::Rejected)
        });
        assert_eq!(rt.state.draft.text, "next draft");
        assert!(rt.state.messages.is_empty());

        rt.update(|s, tx| assert!(step(s, true, true, tx)));
        assert_eq!(rt.state.draft.text, "attempt");
        assert_eq!(rt.state.composer.draft.attachments, [file]);
        rt.paste(" edited");
        rt.frame(0.0);
        assert_eq!(fresh(&rt.state).0.text, "next draft");
        rt.key(Key::Down.into());
        rt.frame(0.0);
        assert_eq!(rt.state.draft.text, "next draft");
        assert!(rt.state.composer.draft.attachments.is_empty());
        rt.update(|s, tx| assert!(step(s, true, true, tx)));
        rt.update(|s, tx| crate::composer::send(s, tx, false));
        let Command::Prompt(recalled) = commands.try_recv().unwrap() else {
            panic!("recalled prompt")
        };
        assert_eq!(recalled.text, "attempt");
        assert_eq!(recalled.files.len(), 1);
        assert_eq!(rt.state.draft.text, "next draft");
    }
}
