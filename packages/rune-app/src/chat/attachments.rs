use crate::{
    State,
    backend::Backend,
    content::{PictureSource, Reference},
    platform,
    strings::t,
};
use codenomad_client::{Receiver, Sender, bounded};
use rune::Tx;
use std::sync::Arc;

#[cfg(test)]
mod tests;

#[derive(Default)]
pub struct Reader {
    backend: Option<Backend>,
    pending: Option<Request>,
    pub saving: bool,
    pub write: Option<Receiver<bool>>,
    pub error: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum DownloadSource {
    Reference(Reference),
    Picture {
        file_id: String,
        source: PictureSource,
        mime: String,
    },
}

impl DownloadSource {
    fn needs_backend(&self) -> bool {
        match self {
            Self::Reference(_) => true,
            Self::Picture { source, .. } => {
                matches!(
                    source,
                    PictureSource::Attachment(_) | PictureSource::Deferred(_)
                )
            }
        }
    }
}

struct Request {
    _cancel: Sender<()>,
    result: Receiver<crate::history::Result<Arc<Vec<u8>>>>,
    name: String,
    source: DownloadSource,
}

impl Reader {
    pub fn bind(&mut self, backend: Backend) {
        *self = Self {
            backend: Some(backend),
            ..Self::default()
        };
    }
    pub fn cancel(&mut self) {
        self.pending = None;
        self.saving = false;
        self.write = None;
        self.error = false;
    }
    fn available_for(&self, source: &DownloadSource) -> bool {
        platform::attachment_export_available()
            && (!source.needs_backend() || self.backend.is_some())
            && self.pending.is_none()
            && !self.saving
    }
    fn request_source(s: &mut State, source: DownloadSource, name: &str) {
        if !contains(s, &source) {
            return;
        }
        let reader = &mut s.attachments;
        if !reader.available_for(&source) {
            return;
        }
        let backend = if source.needs_backend() {
            let Some(backend) = reader.backend.clone() else {
                return;
            };
            Some(backend)
        } else {
            None
        };
        let (cancel, cancelled) = bounded(1);
        let (out, result) = bounded(1);
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        let task_source = source.clone();
        reader.error = false;
        reader.pending = Some(Request {
            _cancel: cancel,
            result,
            name: name.into(),
            source,
        });
        platform::spawn(async move {
            let Some(_slot) = reads.preview(&cancelled).await else {
                return;
            };
            let Some(answer) = (match &task_source {
                DownloadSource::Reference(reference) => {
                    let Some(backend) = backend.as_ref() else {
                        return;
                    };
                    platform::reads::cancellable(&cancelled, backend.attachment_bytes(reference))
                        .await
                }
                DownloadSource::Picture { source, mime, .. } => {
                    platform::reads::cancellable(&cancelled, source.bytes(backend.as_ref(), mime))
                        .await
                }
            }) else {
                return;
            };
            if out.send(answer).await.is_ok() {
                wake();
            }
        });
    }
}

fn download_source(file: &crate::content::File) -> Option<DownloadSource> {
    if let Some(reference) = &file.reference {
        return Some(DownloadSource::Reference(reference.clone()));
    }
    let source = file.picture.as_ref()?;
    if matches!(source, PictureSource::Unavailable) {
        return None;
    }
    Some(DownloadSource::Picture {
        file_id: file.id.clone(),
        source: source.clone(),
        mime: file.mime.clone(),
    })
}

fn contains(s: &State, target: &DownloadSource) -> bool {
    match target {
        DownloadSource::Reference(reference) => s.messages.iter().any(|row| {
            row.id == reference.message
                && row.parts.iter().any(|part| {
                    matches!(part, crate::content::Part::File(file)
                        if file.reference.as_ref() == Some(reference))
                })
        }),
        DownloadSource::Picture {
            file_id,
            source,
            mime,
        } => s.messages.iter().any(|row| {
            row.parts.iter().any(|part| {
                matches!(part, crate::content::Part::File(file)
                    if file.id == *file_id
                        && file.mime == *mime
                        && file.picture.as_ref() == Some(source))
            })
        }),
    }
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    if let Some(ok) = s
        .attachments
        .write
        .as_ref()
        .and_then(|receiver| receiver.try_recv().ok())
    {
        s.attachments.saving = false;
        s.attachments.write = None;
        s.attachments.error = !ok;
        return true;
    }
    let Some(request) = s.attachments.pending.as_ref() else {
        return false;
    };
    if !contains(s, &request.source) {
        s.attachments.cancel();
        return true;
    }
    let Ok(result) = request.result.try_recv() else {
        return false;
    };
    let Some(request) = s.attachments.pending.take() else {
        return false;
    };
    match result {
        Ok(bytes) => {
            s.attachments.saving = true;
            platform::export_attachment(s, tx, &request.name, bytes);
        }
        Err(_) => s.attachments.error = true,
    }
    true
}

pub fn download_label(name: &str) -> String {
    rune_theme_codenomad::catalogue::format(
        crate::strings::locale(),
        "messageItem.attachment.downloadAriaLabel",
        &[("name", name)],
    )
}

pub fn error(s: &State) -> Option<rune::El> {
    s.attachments
        .error
        .then(|| rune::text(t("rune.open_error")).role("alert"))
}

pub fn skill_chip(skill: &crate::content::Skill) -> rune::El {
    rune_theme_codenomad::attachment::chip(&skill.name, None, None)
        .key(skill.id.clone())
        .description_static(t("promptInput.skills.title"))
}

pub fn file_chip(s: &State, file: &crate::content::File) -> rune::El {
    use rune_theme_codenomad::{Space, attachment, layout::Layout, workspace_tree::icons};
    let icon = if file.mime.starts_with("image/") {
        &icons::IMAGE
    } else {
        &icons::FILE
    };
    let name = file
        .name
        .as_deref()
        .unwrap_or_else(|| t("messageItem.attachment.defaultName"));
    let button = download_source(file)
        .filter(|_| platform::attachment_export_available())
        .map(|source| {
            let label = download_label(name);
            let name = name.to_owned();
            let disabled = !s.attachments.available_for(&source);
            crate::components::button(
                &format!("download-{}", file.id),
                &label,
                disabled,
                crate::screen::action(&s.input_scope, move |s| {
                    Reader::request_source(s, source.clone(), &name)
                }),
            )
        });
    let chip = attachment::chip(name, Some(icon), button);
    if let Some(picture) = &file.picture {
        rune::col()
            .full_width()
            .separate(Space::Sm)
            .key(file.id.clone())
            .child(chip)
            .child(super::media::view(
                s,
                format!("{}-image", file.id),
                picture,
                name,
                &file.mime,
                true,
            ))
    } else {
        chip.key(file.id.clone())
    }
}
