use crate::{State, backend::Backend, content::Reference, platform, strings::t};
use codenomad_client::{Receiver, Sender, bounded};
use rune::Tx;
use std::sync::Arc;

#[derive(Default)]
pub struct Reader {
    backend: Option<Backend>,
    pending: Option<Request>,
    pub saving: bool,
    pub write: Option<Receiver<bool>>,
    pub error: bool,
}
struct Request {
    _cancel: Sender<()>,
    result: Receiver<crate::history::Result<Arc<Vec<u8>>>>,
    name: String,
    reference: Reference,
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
    pub fn available(&self) -> bool {
        platform::attachment_export_available()
            && self.backend.is_some()
            && self.pending.is_none()
            && !self.saving
    }
    pub fn request(s: &mut State, reference: &Reference, name: &str) {
        if !contains(s, reference) {
            return;
        }
        let reader = &mut s.attachments;
        if !reader.available() {
            return;
        }
        let Some(backend) = reader.backend.clone() else {
            return;
        };
        let (cancel, cancelled) = bounded(1);
        let (out, result) = bounded(1);
        let reference = reference.clone();
        let wake = s.wake.clone();
        let reads = s.reads.clone();
        reader.error = false;
        reader.pending = Some(Request {
            _cancel: cancel,
            result,
            name: name.into(),
            reference: reference.clone(),
        });
        platform::spawn(async move {
            let Some(_slot) = reads.preview(&cancelled).await else {
                return;
            };
            let Some(answer) =
                platform::reads::cancellable(&cancelled, backend.attachment_bytes(&reference))
                    .await
            else {
                return;
            };
            if out.send(answer).await.is_ok() {
                wake();
            }
        });
    }
}

fn contains(s: &State, reference: &Reference) -> bool {
    s.messages.iter().any(|row| {
        row.id == reference.message
            && row.parts.iter().any(|part| {
                matches!(part, crate::content::Part::File(file)
            if file.reference.as_ref() == Some(reference))
            })
    })
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
    if !contains(s, &request.reference) {
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
    s.attachments.error.then(|| {
        rune::text(t("rune.open_error"))
            .role("alert")
            .key("attachment-error")
    })
}

pub fn skill_chip(skill: &crate::content::Skill) -> rune::El {
    rune_theme_codenomad::attachment::chip(&skill.name, None, None)
        .key(skill.id.clone())
        .description_static(t("promptInput.skills.title"))
}

pub fn file_chip(s: &State, file: &crate::content::File) -> rune::El {
    file_chip_inner(s, file, true)
}

pub fn file_chip_static(s: &State, file: &crate::content::File) -> rune::El {
    file_chip_inner(s, file, false)
}

fn file_chip_inner(s: &State, file: &crate::content::File, downloadable: bool) -> rune::El {
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
    let button = file
        .reference
        .clone()
        .filter(|_| downloadable && platform::attachment_export_available())
        .map(|reference| {
            let label = download_label(name);
            let name = name.to_owned();
            crate::components::button(
                &format!("download-{}", file.id),
                &label,
                !s.attachments.available(),
                crate::screen::action(&s.input_scope, move |s| {
                    Reader::request(s, &reference, &name)
                }),
            )
        });
    let chip = attachment::chip(name, Some(icon), button);
    if let Some(picture) = &file.picture
        && (downloadable
            || (file.reference.is_none()
                && !matches!(picture, crate::content::PictureSource::Attachment(_))))
    {
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
