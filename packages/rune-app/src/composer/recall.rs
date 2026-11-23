use super::draft::{Attachment, Draft};
use crate::{State, settings, workspace};
use rune::{Tx, edit::TextEdit};
use std::collections::VecDeque;

mod persistence;
pub(crate) use persistence::poll;

use codenomad_client::prompt_history::MAX_ENTRIES;
const MAX_WINDOW_ENTRIES: usize = 3200;
const MAX_BYTES: usize = 80 * 1024 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub(super) enum Project {
    Workspace(Option<String>, Option<String>, String),
    Direct(String, String),
    Unbound,
}

fn scope(s: &State) -> Option<(Project, String, String)> {
    if let Some((tab, saved)) = workspace::active_workspace(s) {
        return Some((
            Project::Workspace(
                saved.backend_id.clone(),
                saved.server_id.clone(),
                saved.folder.clone(),
            ),
            tab.into(),
            saved.active_session_id.clone()?,
        ));
    }
    if s.workspace.is_some() {
        return None;
    }
    Some(
        settings::bound_backend(s).map_or((Project::Unbound, String::new(), String::new()), |b| {
            (
                Project::Direct(b.base, b.workspace),
                String::new(),
                b.session,
            )
        }),
    )
}

pub(super) fn command_target(s: &State) -> Option<super::command_receipts::Target> {
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
    fn discard(&mut self, index: usize) {
        if let Some(entry) = self.entries.remove(index) {
            self.bytes -= entry.bytes;
        }
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
}

pub(crate) struct Recall {
    id: i64,
    edit: TextEdit,
    draft: Draft,
    missing: bool,
}

pub(super) fn record(s: &mut State, resolved: String, slash: bool) -> bool {
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
    if bytes > MAX_BYTES {
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
    while history.full(bytes) {
        history.discard(history.entries.len() - 1);
    }
    history.next += 1;
    history.bytes += bytes;
    history.entries.push_front(Entry {
        project,
        origin: Some((tab, session)),
        edit,
        draft,
        resolved,
        bytes,
        id: history.next,
    });
    true
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

pub(super) fn available(s: &State) -> bool {
    scope(s).is_some_and(|(project, tab, session)| {
        s.prompt_history
            .entries
            .iter()
            .any(|e| e.visible_in(&project, &tab, &session))
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
        s.composer.draft = draft;
        s.composer.attachments_missing = false;
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
