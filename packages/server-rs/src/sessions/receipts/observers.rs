//! Occurrences that received an unanchored native settlement.
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::Workspace;

static FALLBACKS: Mutex<VecDeque<(PathBuf, Vec<Workspace>)>> = Mutex::new(VecDeque::new());

pub(super) fn remember(file: &Path, recipients: Vec<Workspace>) {
    let mut recent = FALLBACKS.lock().unwrap();
    if let Some((_, saved)) = recent.iter_mut().find(|(path, _)| path == file) {
        for workspace in recipients {
            if !saved.iter().any(|w| w.id == workspace.id) && saved.len() < 128 {
                saved.push(workspace);
            }
        }
    } else {
        if recent.len() >= 1024 {
            recent.pop_front();
        }
        recent.push_back((file.into(), recipients));
    }
}

pub(super) fn take(file: &Path) -> Vec<Workspace> {
    let mut recent = FALLBACKS.lock().unwrap();
    recent
        .iter()
        .position(|(path, _)| path == file)
        .and_then(|index| recent.remove(index))
        .map_or_else(Vec::new, |(_, workspaces)| workspaces)
}

pub(super) fn forget(folder: &Path) {
    FALLBACKS.lock().unwrap().retain(|(file, _)| file.parent() != Some(folder));
}
