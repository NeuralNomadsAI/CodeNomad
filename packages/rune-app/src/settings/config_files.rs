use super::Preferences;
use crate::{backend::Backend, platform, strings::t};
use codenomad_client::{Receiver, Sender, bounded, settings::config_files as api};
use rune::{El, TextEdit, Waker, col, text};
use rune_theme_codenomad::{
    Space, field_kit,
    layout::{self, Layout},
    settings as chrome,
};
mod syntax;

#[derive(Default)]
pub(super) struct Editor {
    owner: Option<String>,
    files: Option<Vec<api::File>>,
    active: Option<usize>,
    original: Option<String>,
    draft: TextEdit,
    exists: bool,
    crlf: bool,
    syntax_line: Option<usize>,
    read: Option<(Sender<()>, Receiver<Read>)>,
    write: Option<Receiver<(String, bool)>>,
    goal: Option<usize>,
    requested_id: Option<String>,
    confirm: Option<usize>,
    notice: Option<&'static str>,
}

enum Read {
    List(Option<Vec<api::File>>),
    Content(usize, Option<api::Content>),
}

impl Editor {
    pub fn dirty(&self) -> bool {
        self.original
            .as_ref()
            .is_some_and(|saved| saved != &self.draft.text)
    }

    pub fn busy(&self) -> bool {
        self.write.is_some()
    }

    pub fn request_file(&mut self, id: String) {
        if let Some(files) = &self.files {
            if let Some(index) = files.iter().position(|f| f.id == id) {
                self.requested_id = None;
                if self.active != Some(index) {
                    self.choose(index);
                }
            } else {
                self.requested_id = Some(id);
            }
        } else {
            self.requested_id = Some(id);
        }
    }

    pub fn suspend(&mut self) {
        self.read = None;
        self.goal = None;
        self.confirm = None;
    }

    pub fn poll(&mut self, prefs: &Preferences, wake: &Waker, visible: bool) -> bool {
        let Some(backend) = prefs.backend.as_ref().filter(|_| prefs.can_retry()) else {
            self.suspend();
            return false;
        };
        let mut changed = self.owner.is_some() && self.owner.as_deref() != Some(&backend.client_id);
        if changed {
            let requested = self.requested_id.take();
            *self = Self {
                owner: Some(backend.client_id.clone()),
                requested_id: requested,
                ..Self::default()
            };
        }
        if let Some((draft, saved)) = self.write.as_ref().and_then(|inbox| inbox.try_recv().ok()) {
            self.write = None;
            if saved {
                self.original = Some(draft);
                self.exists = true;
                self.notice = Some("settings.configFiles.toast.saveSuccess");
            } else {
                self.notice = Some("settings.configFiles.errors.save");
            }
            changed = true;
        }
        if !visible {
            self.suspend();
            return changed;
        }
        self.owner.get_or_insert_with(|| backend.client_id.clone());
        if let Some(result) = self
            .read
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read = None;
            match result {
                Read::List(Some(files)) => {
                    self.goal = self
                        .requested_id
                        .take()
                        .and_then(|id| files.iter().position(|f| f.id == id))
                        .or_else(|| (!files.is_empty()).then_some(0));
                    self.files = Some(files);
                }
                Read::List(None) => self.notice = Some("settings.configFiles.errors.loadList"),
                Read::Content(index, Some(content)) => {
                    self.active = Some(index);
                    self.exists = content.exists;
                    self.crlf = content.contents.contains("\r\n")
                        && !content.contents.replace("\r\n", "").contains('\n');
                    let input = content.contents.replace("\r\n", "\n");
                    self.draft = TextEdit::new(&input);
                    self.original = Some(input);
                    self.diagnose();
                }
                Read::Content(_, None) => {
                    self.notice = Some("settings.configFiles.errors.loadContent")
                }
            }
            changed = true;
        }
        if self.read.is_none() && !self.busy() && self.notice.is_none() {
            if self.files.is_none() {
                self.start_read(backend, wake, None);
                changed = true;
            } else if let Some(index) = self
                .goal
                .take()
                .or_else(|| self.active.is_none().then_some(0))
                && let Some(id) = self
                    .files
                    .as_ref()
                    .and_then(|files| files.get(index))
                    .map(|file| file.id.clone())
            {
                self.start_read(backend, wake, Some((index, id)));
                changed = true;
            }
        }
        changed
    }

    fn start_read(&mut self, backend: &Backend, wake: &Waker, content: Option<(usize, String)>) {
        let (cancel, cancelled) = bounded(1);
        let (out, reply) = bounded(1);
        self.read = Some((cancel, reply));
        let (backend, wake) = (backend.clone(), wake.clone());
        platform::spawn(async move {
            let read = async {
                match content {
                    Some((index, id)) => Read::Content(index, api::read(&backend, &id).await.ok()),
                    None => Read::List(api::list(&backend).await.ok()),
                }
            };
            if let Some(result) = platform::reads::cancellable(&cancelled, read).await
                && out.try_send(result).is_ok()
            {
                wake();
            }
        });
    }

    fn choose(&mut self, index: usize) {
        if self.busy() || self.read.is_some() {
            return;
        }
        if self.dirty() {
            self.confirm = Some(index);
        } else {
            self.reload(index);
        }
    }

    fn reload(&mut self, index: usize) {
        self.notice = None;
        self.goal = Some(index);
    }

    fn diagnose(&mut self) {
        let language = self
            .active
            .and_then(|index| self.files.as_ref()?.get(index))
            .map(|file| file.language.as_str());
        self.syntax_line = match language {
            Some("json") => syntax::error_line(&self.draft.text, false),
            Some("jsonc") => syntax::error_line(&self.draft.text, true),
            _ => None,
        };
    }

    fn save(&mut self, prefs: &Preferences) {
        let Some(backend) = prefs
            .backend
            .as_ref()
            .filter(|b| prefs.can_retry() && Some(&b.client_id) == self.owner.as_ref())
        else {
            return;
        };
        let Some(file) = self
            .active
            .and_then(|index| self.files.as_ref()?.get(index))
        else {
            return;
        };
        let Some(wake) = prefs.window_wake.as_ref().or(prefs.main_wake.as_ref()) else {
            return;
        };
        if self.busy()
            || self.read.is_some()
            || !self.dirty()
            || self.draft.text.len() > api::MAX_CONTENT
        {
            return;
        }
        let (out, inbox) = bounded(1);
        let (backend, wake, id, draft) = (
            backend.clone(),
            wake.clone(),
            file.id.clone(),
            self.draft.text.clone(),
        );
        let payload = if self.crlf {
            draft.replace('\n', "\r\n")
        } else {
            draft.clone()
        };
        self.write = Some(inbox);
        self.notice = None;
        platform::spawn(async move {
            let saved = match api::save(&backend, &id, &payload).await {
                Ok(()) => true,
                Err(_) => api::read(&backend, &id)
                    .await
                    .is_ok_and(|content| content.exists && content.contents == payload),
            };
            if out.try_send((draft, saved)).is_ok() {
                wake();
            }
        });
    }

    pub fn view<S: 'static>(
        &self,
        layers: &mut Vec<El>,
        shared: &std::rc::Rc<std::cell::RefCell<Preferences>>,
        edit: fn(&mut S) -> &mut Editor,
    ) -> El {
        let waiting = self.busy() || self.read.is_some() || self.goal.is_some();
        let files = self.files.as_deref().unwrap_or_default();
        let names: Vec<_> = files.iter().map(|file| file.label.as_str()).collect();
        let mut view = col().full_width().separate(Space::Sm);
        if files.is_empty() && !waiting && self.notice.is_none() {
            view = view.child(text(t("settings.configFiles.empty")));
        }
        if !files.is_empty() {
            view = view.child(chrome::segments(
                t("settings.configFiles.selector.label"),
                &names,
                self.active,
                waiting,
                move |s, index| {
                    let editor = edit(s);
                    if editor.active != Some(index) {
                        editor.choose(index);
                    }
                },
            ));
        }
        if let Some(index) = self.active {
            let shared = shared.clone();
            view = view
                .child(text(&files[index].path).literal_direction().wrap())
                .child(
                    layout::textarea(&self.draft)
                        .rows(12)
                        .label(t("settings.configFiles.title"))
                        .disabled(waiting || self.confirm.is_some())
                        .on_edit(move |s| &mut edit(s).draft)
                        .on_change(move |s, _| edit(s).diagnose())
                        .build(field_kit(layout::dark())),
                )
                .children(self.syntax_line.map(|line| {
                    text(t("settings.configFiles.syntaxLine").replace("{line}", &line.to_string()))
                        .role("status")
                }))
                .child(
                    layout::action_row()
                        .child(chrome::primary_action(
                            t("settings.configFiles.actions.save"),
                            waiting || !self.dirty() || self.draft.text.len() > api::MAX_CONTENT,
                            move |s| edit(s).save(&shared.borrow()),
                        ))
                        .child(layout::button(
                            t("settings.configFiles.actions.reload"),
                            waiting,
                            move |s| edit(s).choose(index),
                        )),
                )
                .children((self.dirty() || !self.exists).then(|| {
                    text(t(if self.dirty() {
                        "settings.configFiles.state.unsaved"
                    } else {
                        "settings.configFiles.state.notCreated"
                    }))
                    .role("status")
                }));
        }
        if let Some(key) = self.notice {
            view = view.child(text(t(key)).role(if key.contains(".errors.") {
                "alert"
            } else {
                "status"
            }));
            if key == "settings.configFiles.errors.loadList" || self.active.is_none() {
                view = view.child(layout::button(
                    t("sessionList.loadError.retry"),
                    waiting,
                    move |s| {
                        let editor = edit(s);
                        editor.notice = None;
                        editor.goal = editor
                            .files
                            .as_ref()
                            .and_then(|list| (!list.is_empty()).then_some(0));
                    },
                ));
            }
        }
        if let Some(index) = self.confirm {
            layers.push(confirm_discard(move |s, accept, _| {
                let editor = edit(s);
                if editor.confirm.take() == Some(index) && accept {
                    editor.reload(index);
                }
            }));
        }
        chrome::card(view)
    }
}

pub(super) fn confirm_discard<S: 'static>(
    decide: impl Fn(&mut S, bool, &mut rune::Tx) + 'static,
) -> El {
    rune_theme_codenomad::document_reader::editor::confirmation(
        layout::dark(),
        t("settings.configFiles.confirmDiscard.message"),
        t("settings.configFiles.confirmDiscard.cancelLabel"),
        t("settings.configFiles.confirmDiscard.confirmLabel"),
        decide,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switching_and_reloading_a_dirty_config_require_consent() {
        let mut editor = Editor {
            active: Some(0),
            original: Some("{}".into()),
            draft: TextEdit::new("{/* draft */}"),
            ..Editor::default()
        };
        editor.choose(1);
        assert_eq!(editor.confirm.take(), Some(1));
        assert_eq!(editor.goal, None);
        assert!(editor.dirty());
        editor.choose(0);
        assert_eq!(editor.confirm.take(), Some(0));
        assert_eq!(editor.goal, None);
        editor.suspend();
        assert_eq!(editor.draft.text, "{/* draft */}");
    }
}
