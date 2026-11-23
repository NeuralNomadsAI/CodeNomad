use super::{
    Item,
    lookup::{Lookup, Read, Reply},
    matching, replace,
};
use crate::{
    backend::Backend,
    composer::draft::{Attachment, Draft},
    platform::reads::Reads,
};
use codenomad_client::{files::EntryKind, prompt_catalogue::ProjectMatch};
use rune::{Waker, edit::TextEdit};
use std::ops::Range;

#[derive(PartialEq, Eq)]
pub(super) enum Mode {
    Text,
    Path,
    Attachment,
}

#[derive(Default)]
pub(super) struct Mentions {
    pub(super) directory: Option<String>,
    pub(super) catalog: Vec<Item>,
    pub(super) files: Vec<Item>,
    pub(super) catalog_read: Option<Read>,
    catalog_dirty: bool,
    pub(super) file_read: Option<Read>,
    catalog_error: bool,
    file_error: bool,
}

impl Mentions {
    pub(super) fn reset(&mut self) {
        self.catalog.clear();
        self.files.clear();
        self.catalog_read = None;
        self.catalog_dirty = false;
        self.file_read = None;
        self.catalog_error = false;
        self.file_error = false;
    }

    pub(super) fn loading(&self) -> bool {
        self.catalog_read.is_some() || self.file_read.is_some()
    }

    pub(super) fn error(&self) -> bool {
        self.catalog_error || self.file_error
    }

    pub(super) fn search(
        &mut self,
        backend: Option<&Backend>,
        text: &str,
        opening: bool,
        reads: &Reads,
        wake: &Waker,
    ) {
        self.files.clear();
        self.file_read = None;
        self.file_error = false;
        let Some(backend) = backend else { return };
        if opening {
            self.catalogue_changed(Some(backend), reads, wake);
        }
        self.file_read = Some(Read::start(
            backend,
            self.directory.clone(),
            Lookup::Files(text.into()),
            reads,
            wake,
        ));
    }

    pub(super) fn catalogue_changed(
        &mut self,
        backend: Option<&Backend>,
        reads: &Reads,
        wake: &Waker,
    ) {
        if self.catalog_read.is_some() {
            self.catalog_dirty = true;
        } else if let Some(backend) = backend {
            self.catalog_read = Some(Read::start(backend, None, Lookup::Mentions, reads, wake));
        }
    }

    pub(super) fn poll(&mut self, backend: Option<&Backend>, reads: &Reads, wake: &Waker) -> bool {
        let catalogue = Read::take(&mut self.catalog_read);
        let files = Read::take(&mut self.file_read);
        let changed = catalogue.is_some() || files.is_some();
        if let Some(reply) = catalogue {
            if std::mem::take(&mut self.catalog_dirty) {
                self.catalogue_changed(backend, reads, wake);
            } else {
                self.observe(&reply);
                self.catalog_error = reply.error;
                if !reply.error || self.catalog.is_empty() {
                    self.catalog = reply.items;
                }
            }
        }
        if let Some(reply) = files {
            self.observe(&reply);
            self.file_error = reply.error;
            self.files = reply.items;
        }
        changed
    }

    fn observe(&mut self, reply: &Reply) {
        if !reply.directory.is_empty() {
            self.directory = Some(reply.directory.clone());
        }
    }

    pub(super) fn entries(&self, text: &str, out: &mut Vec<Item>) {
        let root = matches!(text.trim(), "." | "./");
        if root {
            out.push(Item::File(ProjectMatch {
                path: ".".into(),
                kind: EntryKind::Directory,
            }));
        }
        out.extend(self.files.iter().cloned());
        if !root {
            matching(&self.catalog, text, out);
        }
    }

    pub(super) fn choose(
        &self,
        edit: &mut TextEdit,
        draft: &mut Draft,
        range: Range<usize>,
        item: &Item,
        tab: bool,
        mode: Mode,
    ) -> Option<bool> {
        let insertion = match item {
            Item::File(file) => {
                let path = file.path.trim_end_matches('/');
                let folder = file.kind == EntryKind::Directory;
                if tab {
                    let ending = if folder { "/" } else { "" };
                    replace(edit, range, &format!("@{path}{ending}"));
                    return Some(true);
                }
                let normalized = if path == "." {
                    "./".into()
                } else {
                    format!("./{path}")
                };
                if mode == Mode::Text {
                    let ending = if folder && path != "." { "/" } else { "" };
                    replace(edit, range, &format!("{normalized}{ending} "));
                    return Some(false);
                }
                if mode == Mode::Path {
                    draft.attach(Attachment::Path(normalized));
                } else {
                    let directory = self.directory.as_deref()?;
                    let separators = if directory.starts_with('/') {
                        &['/'][..]
                    } else {
                        &['/', '\\'][..]
                    };
                    let directory = directory.trim_end_matches(separators);
                    let absolute = format!("{directory}/{}", if path == "." { "" } else { path });
                    let uri = codenomad_client::server_file_uri(&absolute).ok()?;
                    let label = path.rsplit('/').next().unwrap_or(path);
                    draft.attach(Attachment::Project {
                        name: if folder {
                            format!("{label}/")
                        } else {
                            label.into()
                        },
                        path: normalized,
                        uri,
                        directory: folder,
                    });
                }
                if folder && path != "." {
                    format!("@{path}/ ")
                } else if path == "." {
                    "@./ ".into()
                } else {
                    format!("@./{path} ")
                }
            }
            Item::Agent(agent) => {
                if mode != Mode::Text {
                    draft.attach(Attachment::Agent(agent.name.clone()));
                }
                format!("@{} ", agent.name)
            }
            Item::Skill(skill) => {
                if mode == Mode::Text {
                    return None;
                }
                draft.attach(Attachment::Skill {
                    id: skill.id.clone(),
                    name: skill.name.clone(),
                });
                String::new()
            }
            Item::Command(_) => return None,
        };
        replace(edit, range, &insertion);
        Some(false)
    }
}
