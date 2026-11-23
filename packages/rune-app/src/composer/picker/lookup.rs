use super::Item;
use crate::{
    backend::Backend,
    platform::{
        self,
        reads::{Reads, cancellable},
    },
};
use codenomad_client::{Receiver, Sender, bounded, prompt_catalogue::Catalogue};
use rune::Waker;
use std::time::Duration;

pub(super) enum Lookup {
    Commands,
    Mentions,
    Files(String),
}

pub(super) struct Read {
    pub(super) _cancel: Sender<()>,
    pub(super) replies: Receiver<Reply>,
}

pub(super) struct Reply {
    pub(super) directory: String,
    pub(super) items: Vec<Item>,
    pub(super) error: bool,
}

impl Read {
    pub(super) fn start(
        backend: &Backend,
        directory: Option<String>,
        lookup: Lookup,
        reads: &Reads,
        wake: &Waker,
    ) -> Self {
        let (out, replies) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        let (backend, reads, wake) = (backend.clone(), reads.clone(), wake.clone());
        platform::spawn(async move {
            if matches!(&lookup, Lookup::Files(search) if !search.is_empty())
                && cancellable(&cancelled, platform::sleep(Duration::from_millis(200)))
                    .await
                    .is_none()
            {
                return;
            }
            let Some(_slot) = reads.background(&cancelled).await else {
                return;
            };
            let Some(result) = cancellable(&cancelled, fetch(backend, directory, lookup)).await
            else {
                return;
            };
            if out
                .send(result.unwrap_or(Reply {
                    directory: String::new(),
                    items: vec![],
                    error: true,
                }))
                .await
                .is_ok()
            {
                wake();
            }
        });
        Self {
            _cancel: cancel,
            replies,
        }
    }

    pub(super) fn take(read: &mut Option<Self>) -> Option<Reply> {
        let reply = read.as_ref()?.replies.try_recv().ok()?;
        *read = None;
        Some(reply)
    }
}

async fn fetch(
    backend: Backend,
    directory: Option<String>,
    lookup: Lookup,
) -> crate::history::Result<Reply> {
    let directory = if let Some(directory) = directory {
        directory
    } else {
        backend.prompt_directory().await?
    };
    let mut reply = Reply {
        directory,
        items: vec![],
        error: false,
    };
    if let Lookup::Files(search) = lookup {
        let query = search.trim().trim_start_matches("./");
        match backend.prompt_files(&reply.directory, query).await {
            Ok(files) => reply.items.extend(files.into_iter().map(Item::File)),
            Err(_) => reply.error = true,
        }
    } else {
        let kinds = match lookup {
            Lookup::Commands => &[Catalogue::Commands][..],
            _ => &[Catalogue::Agents, Catalogue::Skills],
        };
        for &kind in kinds {
            match backend.prompt_catalogue(&reply.directory, kind).await {
                Ok(rows) => reply.items.extend(rows.into_iter().map(match kind {
                    Catalogue::Agents => Item::Agent,
                    Catalogue::Skills => Item::Skill,
                    Catalogue::Commands => Item::Command,
                })),
                Err(_) => reply.error = true,
            }
        }
    }
    Ok(reply)
}
