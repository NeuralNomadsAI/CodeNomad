use std::collections::{HashMap, VecDeque};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct PreviewOwner {
    pub(super) window: String,
    pub(super) instance_id: String,
    pub(super) revision: u64,
}

#[derive(Default)]
pub(super) struct BrowserPreviewOwners {
    owners: HashMap<String, PreviewOwner>,
    recent: VecDeque<(String, String, String)>,
    revision: u64,
}

impl BrowserPreviewOwners {
    pub(super) fn get(&self, session_id: &str) -> Option<&PreviewOwner> {
        self.owners.get(session_id)
    }

    pub(super) fn last_used<'a>(
        &'a self,
        session_id: &'a str,
    ) -> impl Iterator<Item = (&'a str, &'a str)> {
        self.recent
            .iter()
            .filter(move |(session, _, _)| session == session_id)
            .map(|(_, window, instance)| (window.as_str(), instance.as_str()))
    }

    pub(super) fn used(&mut self, session_id: String, window: &str, instance_id: String) {
        self.recent.retain(|(session, owner, id)| {
            session != &session_id || owner != window || id != &instance_id
        });
        self.recent
            .push_front((session_id, window.into(), instance_id));
        self.recent.truncate(512);
    }

    /// The controller holds its registry lock for the entire decision.
    pub(super) fn request(
        &mut self,
        session_id: &str,
        window: &str,
        instance_id: &str,
        transfer_revision: Option<u64>,
    ) -> (PreviewOwner, Option<PreviewOwner>) {
        let previous = self.owners.get(session_id);
        if let Some(owner) = previous {
            if owner.window != window
                || owner.instance_id == instance_id
                || Some(owner.revision) != transfer_revision
            {
                return (owner.clone(), None);
            }
        }
        self.revision += 1;
        let owner = PreviewOwner {
            window: window.into(),
            instance_id: instance_id.into(),
            revision: self.revision,
        };
        let previous = self.owners.insert(session_id.into(), owner.clone());
        (owner, previous)
    }

    pub(super) fn release(
        &mut self,
        window: &str,
        instance_id: Option<&str>,
    ) -> Vec<(String, PreviewOwner, u64)> {
        self.recent.retain(|(_, owner, id)| {
            owner != window || instance_id.is_some_and(|instance| id != instance)
        });
        let revision = &mut self.revision;
        let mut released = Vec::new();
        self.owners.retain(|session_id, owner| {
            if owner.window != window || instance_id.is_some_and(|id| owner.instance_id != id) {
                return true;
            }
            *revision += 1;
            released.push((session_id.clone(), owner.clone(), *revision));
            false
        });
        released
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Barrier, Mutex};

    #[test]
    fn simultaneous_requests_commit_one_owner() {
        let owners = Mutex::new(BrowserPreviewOwners::default());
        let start = Barrier::new(2);
        std::thread::scope(|scope| {
            let open = |window| {
                start.wait();
                owners
                    .lock()
                    .unwrap()
                    .request("session", window, "tab", None)
                    .0
            };
            let first = scope.spawn(move || open("first"));
            let second = scope.spawn(move || open("second"));
            assert_eq!(first.join().unwrap(), second.join().unwrap());
        });
    }

    #[test]
    fn closing_a_recent_tab_keeps_the_previous_occurrence() {
        let mut owners = BrowserPreviewOwners::default();
        owners.used("session".into(), "first-window", "first-tab".into());
        owners.used("session".into(), "second-window", "second-tab".into());
        owners.release("second-window", Some("second-tab"));
        assert_eq!(
            owners.last_used("session").next(),
            Some(("first-window", "first-tab"))
        );
    }

    #[test]
    fn transfer_is_same_window_and_exact_then_close_releases_it() {
        let mut owners = BrowserPreviewOwners::default();
        let (first, _) = owners.request("session", "window", "first", None);
        assert_eq!(
            owners
                .request("session", "other", "second", Some(first.revision))
                .0,
            first
        );
        let (second, previous) =
            owners.request("session", "window", "second", Some(first.revision));
        assert_eq!(previous, Some(first.clone()));
        assert_eq!(
            owners
                .request("session", "window", "first", Some(first.revision))
                .0,
            second
        );
        assert!(owners.release("window", Some("first")).is_empty());
        assert_eq!(owners.release("window", Some("second"))[0].1, second);
        assert_eq!(
            owners
                .request("session", "window", "first", None)
                .0
                .instance_id,
            "first"
        );
    }
}
