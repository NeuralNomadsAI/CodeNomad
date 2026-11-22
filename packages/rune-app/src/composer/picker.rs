use super::{
    draft::{Attachment, Draft},
    tokens::{Query, query, whitespace},
};
use crate::{backend::Backend, platform};
use codenomad_client::{
    Receiver, Sender, bounded,
    files::EntryKind,
    prompt_catalogue::{Catalogue, Named, ProjectMatch},
};
use rune::{Key, KeyEvent, Tx, edit::TextEdit};
use std::{ops::Range, time::Duration};

#[derive(Default)]
pub struct Picker {
    backend: Option<Backend>,
    dismissed: Option<usize>,
    current: Option<(Query, String)>,
    directory: Option<String>,
    catalog: Vec<Item>,
    files: Vec<Item>,
    pub entries: Vec<Item>,
    pub selected: usize,
    pub generation: u64,
    command: Option<String>,
    read: Option<Read>,
    search: Option<Read>,
    pub error: bool,
}
struct Read {
    _cancel: Sender<()>,
    replies: Receiver<Reply>,
}
struct Reply {
    directory: String,
    items: Vec<Item>,
    error: bool,
}

#[derive(Clone)]
pub enum Item {
    File(ProjectMatch),
    Agent(Named),
    Skill(Named),
    Command(Named),
}
impl Item {
    pub fn label(&self) -> &str {
        match self {
            Self::File(item) => &item.path,
            Self::Agent(item) | Self::Skill(item) | Self::Command(item) => &item.name,
        }
    }
    pub fn description(&self) -> &str {
        match self {
            Self::File(_) => "",
            Self::Agent(item) | Self::Skill(item) | Self::Command(item) => &item.description,
        }
    }
}

fn launch(
    backend: Backend,
    directory: Option<String>,
    search: Option<String>,
    slash: bool,
    reads: platform::reads::Reads,
    wake: rune::Waker,
) -> Read {
    let (out, replies) = bounded(1);
    let (cancel, cancelled) = bounded(1);
    platform::spawn(async move {
        let search = search.as_deref();
        if search.is_some_and(|s| !s.is_empty())
            && platform::reads::cancellable(&cancelled, platform::sleep(Duration::from_millis(200)))
                .await
                .is_none()
        {
            return;
        }
        let Some(_slot) = reads.background(&cancelled).await else {
            return;
        };
        let result = platform::reads::cancellable(&cancelled, async {
            let directory = if let Some(directory) = directory {
                directory
            } else {
                backend.prompt_directory().await?
            };
            let mut result = Reply {
                directory,
                items: vec![],
                error: false,
            };
            if let Some(search) = search {
                let normalized = search.trim().trim_start_matches("./");
                match backend.prompt_files(&result.directory, normalized).await {
                    Ok(files) => result.items.extend(files.into_iter().map(Item::File)),
                    Err(_) => result.error = true,
                }
            } else {
                let kinds = if slash {
                    &[Catalogue::Commands][..]
                } else {
                    &[Catalogue::Agents, Catalogue::Skills]
                };
                for &kind in kinds {
                    match backend.prompt_catalogue(&result.directory, kind).await {
                        Ok(rows) => result.items.extend(rows.into_iter().map(match kind {
                            Catalogue::Agents => Item::Agent,
                            Catalogue::Skills => Item::Skill,
                            Catalogue::Commands => Item::Command,
                        })),
                        Err(_) => result.error = true,
                    }
                }
            }
            Ok::<_, crate::history::Error>(result)
        })
        .await;
        let Some(result) = result else { return };
        let result = result.unwrap_or(Reply {
            directory: String::new(),
            items: vec![],
            error: true,
        });
        if out.send(result).await.is_ok() {
            wake();
        }
    });
    Read {
        _cancel: cancel,
        replies,
    }
}

impl Picker {
    pub fn bind(&mut self, backend: Backend) {
        *self = Self {
            backend: Some(backend),
            ..Self::default()
        };
    }
    pub fn open(&self) -> bool {
        self.current.is_some()
    }
    pub fn selected_command(&self, text: &str) -> bool {
        self.command.as_ref().is_some_and(|name| {
            text.strip_prefix('/')
                .and_then(|text| text.split(whitespace).next())
                == Some(name.as_str())
        })
    }
    pub fn slash(&self) -> bool {
        matches!(self.current, Some((Query::Command(_), _)))
    }
    pub fn loading(&self) -> bool {
        self.read.is_some() || self.search.is_some()
    }
    pub fn close(&mut self) {
        if let Some((token, _)) = &self.current {
            self.dismissed = Some(match token {
                Query::Command(range) | Query::Mention(range) => range.start,
            });
        }
        self.reset();
    }
    pub fn reset(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.current = None;
        self.catalog.clear();
        self.files.clear();
        self.entries.clear();
        self.read = None;
        self.search = None;
        self.error = false;
    }
    pub fn changed(&mut self, edit: &TextEdit, reads: &platform::reads::Reads, wake: &rune::Waker) {
        let caret = edit.range().0;
        let Some(token) =
            query(&edit.text, caret).filter(|token| matches!(token, Query::Mention(_)))
        else {
            self.dismissed = None;
            self.reset();
            return;
        };
        let range = match &token {
            Query::Command(range) | Query::Mention(range) => range,
        };
        if self.dismissed == Some(range.start) {
            return;
        }
        self.dismissed = None;
        let draft = edit.text[range.start + 1..range.end].to_owned();
        let same_mode = self.open() && (matches!(token, Query::Command(_)) == self.slash());
        if self
            .current
            .as_ref()
            .is_some_and(|(old, query)| old == &token && query == &draft)
        {
            return;
        }
        if !same_mode {
            self.reset();
        }
        self.current = Some((token, draft.clone()));
        self.files.clear();
        self.selected = 0;
        self.search = None;
        if let Some(backend) = &self.backend {
            let slash = self.slash();
            if !same_mode {
                self.read = Some(launch(
                    backend.clone(),
                    self.directory.clone(),
                    None,
                    slash,
                    reads.clone(),
                    wake.clone(),
                ));
            }
            if !slash {
                self.search = Some(launch(
                    backend.clone(),
                    self.directory.clone(),
                    Some(draft),
                    false,
                    reads.clone(),
                    wake.clone(),
                ));
            }
        }
        self.refresh_entries();
    }
    pub fn poll(&mut self) -> bool {
        fn take(read: &mut Option<Read>) -> Option<Reply> {
            let reply = read.as_ref()?.replies.try_recv().ok()?;
            *read = None;
            Some(reply)
        }
        let (catalogue, files) = (take(&mut self.read), take(&mut self.search));
        let changed = catalogue.is_some() || files.is_some();
        if let Some(reply) = catalogue {
            self.error |= reply.error;
            if !reply.directory.is_empty() {
                self.directory = Some(reply.directory);
            }
            self.catalog = reply.items;
        }
        if let Some(reply) = files {
            self.error |= reply.error;
            if !reply.directory.is_empty() {
                self.directory = Some(reply.directory);
            }
            self.files = reply.items;
            self.selected = 0;
        }
        if changed {
            self.refresh_entries();
        }
        changed
    }
    fn refresh_entries(&mut self) {
        let Some((_, query)) = &self.current else {
            return;
        };
        self.generation = self.generation.wrapping_add(1);
        let root = !self.slash() && matches!(query.trim(), "." | "./");
        self.entries.clear();
        if root {
            self.entries.push(Item::File(ProjectMatch {
                path: ".".into(),
                kind: EntryKind::Directory,
            }));
        }
        self.entries.extend(self.files.iter().cloned());
        if !root {
            let query = query.trim().to_lowercase();
            self.entries.extend(
                self.catalog
                    .iter()
                    .filter(|item| {
                        item.label().to_lowercase().contains(&query)
                            || item.description().to_lowercase().contains(&query)
                    })
                    .cloned(),
            );
        }
    }
    pub fn key(&mut self, event: &KeyEvent, tx: &mut Tx) -> bool {
        match event.key {
            Key::Up => self.selected = self.selected.saturating_sub(1),
            Key::Down => {
                self.selected = (self.selected + 1).min(self.entries.len().saturating_sub(1))
            }
            Key::Escape => {
                self.close();
                return true;
            }
            _ => return false,
        }
        if let Some(item) = self.entries.get(self.selected) {
            rune_theme_codenomad::layout::announce_selection(tx, item.label());
        }
        true
    }
    pub fn choose(
        &mut self,
        edit: &mut TextEdit,
        draft: &mut Draft,
        index: usize,
        tab: bool,
        path_only: bool,
    ) -> bool {
        let Some((query, _)) = self.current.as_ref() else {
            return false;
        };
        if super::tokens::query(&edit.text, edit.range().0).as_ref() != Some(query) {
            return false;
        }
        let Some(item) = self.entries.get(index) else {
            return false;
        };
        let range = match query {
            Query::Command(range) | Query::Mention(range) => range.clone(),
        };
        let (range, insertion) = match item {
            Item::File(file) => {
                let mut path = file.path.trim_end_matches('/').to_owned();
                let folder = file.kind == EntryKind::Directory;
                if tab && folder {
                    path.push('/');
                }
                if tab {
                    replace(edit, range, &format!("@{path}"));
                    return true;
                }
                let normalized = if path == "." {
                    "./".into()
                } else {
                    format!("./{path}")
                };
                if path_only {
                    draft.attach(Attachment::Path(normalized.clone()));
                } else {
                    let Some(directory) = self.directory.as_deref() else {
                        return false;
                    };
                    let separator = if directory.starts_with('/') {
                        &['/'][..]
                    } else {
                        &['/', '\\'][..]
                    };
                    let mut absolute = format!("{}/", directory.trim_end_matches(separator));
                    if path != "." {
                        absolute.push_str(&path);
                    }
                    let Ok(uri) = codenomad_client::server_file_uri(&absolute) else {
                        return false;
                    };
                    let label = if path == "." {
                        "."
                    } else {
                        path.rsplit('/').next().unwrap_or(&path)
                    };
                    draft.attach(Attachment::Project {
                        name: if folder {
                            format!("{label}/")
                        } else {
                            label.into()
                        },
                        path: normalized.clone(),
                        uri,
                        directory: folder,
                    });
                }
                let token = if folder && path != "." {
                    format!("{path}/")
                } else {
                    normalized
                };
                (range, format!("@{token} "))
            }
            Item::Agent(agent) => {
                draft.attach(Attachment::Agent(agent.name.clone()));
                (range, format!("@{} ", agent.name))
            }
            Item::Skill(skill) => {
                draft.attach(Attachment::Skill {
                    id: skill.id.clone(),
                    name: skill.name.clone(),
                });
                (range, String::new())
            }
            Item::Command(cmd) => {
                let end = edit.text.find(whitespace).unwrap_or(edit.text.len());
                self.command = Some(cmd.name.clone());
                (0..end, format!("/{} ", cmd.name))
            }
        };
        replace(edit, range, &insertion);
        self.close();
        true
    }
}
fn replace(edit: &mut TextEdit, range: Range<usize>, insertion: &str) {
    if edit.text.get(range.clone()).is_none() {
        return;
    }
    edit.set_selection(range.start, range.end);
    edit.insert(insertion);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Phase, State, init, view};
    use rune::{Env, Mods, Runtime};

    fn runtime() -> Runtime<State> {
        let mut state = init();
        state.phase = Phase::Ready;
        let (send, _receive) = bounded(1);
        state.commands = Some(send);
        let mut rt = Runtime::new(state, view, (680.0, 640.0), Env::new(false, 1.0));
        rt.frame(0.0);
        let (x, y) = rt.find("composer").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        rt
    }
    fn press(rt: &mut Runtime<State>, key: Key, mods: Mods) {
        let event = KeyEvent { key, mods };
        rt.key(event.clone());
        rt.key_up(event);
        rt.frame(0.0);
    }
    fn named(name: &str) -> Named {
        Named {
            id: name.into(),
            name: name.into(),
            description: String::new(),
            primary: false,
        }
    }

    #[test]
    fn real_field_consumes_picker_keys_and_commits_the_selected_skill() {
        let mut rt = runtime();
        rt.paste("🦀 @review");
        rt.frame(0.0);
        assert!(rt.state.composer.picker.open());
        press(&mut rt, Key::Enter, Mods::default());
        assert_eq!(rt.state.draft.text, "🦀 @review");
        rt.update(|s, _| {
            let picker = &mut s.composer.picker;
            picker.directory = Some("D:/test".into());
            picker.files.push(Item::File(ProjectMatch {
                path: "review.md".into(),
                kind: EntryKind::File,
            }));
            picker.catalog.push(Item::Agent(named("review-agent")));
            picker.catalog.push(Item::Skill(named("review-skill")));
            picker.refresh_entries();
        });
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        let tree = rt.accessibility_json().to_string();
        for label in ["review.md", "review-agent", "review-skill"] {
            assert!(tree.contains(label), "missing {label}: {tree}");
        }
        press(&mut rt, Key::Down, Mods::default());
        press(&mut rt, Key::Down, Mods::default());
        press(&mut rt, Key::Down, Mods::default());
        assert_eq!(rt.state.composer.picker.selected, 2);
        press(
            &mut rt,
            Key::Enter,
            Mods {
                ctrl: true,
                cmd: true,
                ..Mods::default()
            },
        );
        assert_eq!(rt.state.draft.text, "🦀 @review");
        press(&mut rt, Key::Enter, Mods::default());
        assert_eq!(rt.state.draft.text, "🦀 ");
        assert!(matches!(&rt.state.composer.draft.attachments[..],
            [Attachment::Skill{id, ..}] if id == "review-skill"));
        assert!(!rt.state.composer.picker.open());
        assert!(rt.state.draft.focused);
        assert!(rt.state.messages.is_empty());
        let (out, submitted) = bounded(1);
        rt.state.commands = Some(out);
        press(&mut rt, Key::Enter, Mods::default());
        let crate::transport::Command::Prompt(prompt) = submitted.try_recv().unwrap() else {
            panic!("expected native prompt")
        };
        assert_eq!(prompt.text, "🦀");
        assert_eq!(prompt.skills[0].id, "review-skill");
    }

    #[test]
    fn tab_only_completes_and_shift_enter_records_a_path_without_a_file() {
        let mut rt = runtime();
        rt.paste("@a");
        rt.frame(0.0);
        let seed = |s: &mut State, _: &mut Tx| {
            let p = &mut s.composer.picker;
            p.directory = Some("D:/test".into());
            p.files.push(Item::File(ProjectMatch {
                path: "a #%.txt".into(),
                kind: EntryKind::File,
            }));
            p.refresh_entries();
        };
        rt.update(seed);
        press(&mut rt, Key::Tab, Mods::default());
        assert_eq!(rt.state.draft.text, "@a #%.txt");
        assert!(rt.state.composer.draft.attachments.is_empty());

        let mut rt = runtime();
        rt.paste("@a");
        rt.frame(0.0);
        rt.update(seed);
        press(
            &mut rt,
            Key::Enter,
            Mods {
                shift: true,
                ..Mods::default()
            },
        );
        assert_eq!(rt.state.draft.text, "@./a #%.txt ");
        let (prompt, _) = rt.state.composer.draft.prepare(
            &rt.state.draft.text,
            "msg_x",
            codenomad_client::prompt::Delivery::Steer,
        );
        assert_eq!(prompt.text, "./a #%.txt");
        assert!(prompt.files.is_empty());
    }
}
