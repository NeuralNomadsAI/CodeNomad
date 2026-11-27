//! Browser delivery and the notification wake independent of painting.
use super::{Presented, collect, poll};
use crate::{State, platform::notifications};
use rune::Waker;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering::Relaxed},
};

pub(super) use notifications::focused;

pub(super) fn present(
    title: &str,
    body: &str,
    action: impl FnOnce() + 'static,
) -> Option<Presented> {
    (!cfg!(feature = "test-support"))
        .then(|| notifications::show(title, body, action))
        .flatten()
        .map(|_presented| Presented::Native { _presented })
}

pub(crate) fn with_background_wake(s: &mut State, wake: Waker) -> Waker {
    let Some(handle) = s.notifications.background.take() else {
        return wake;
    };
    let scheduled = Arc::new(AtomicBool::new(false));
    Arc::new(move || {
        if !notifications::hidden() {
            wake();
        } else if !scheduled.swap(true, Relaxed) {
            let scheduled = scheduled.clone();
            // On Web, AppHandle updates are drained by the user event, before the RAF.
            handle.update_if(move |s, tx| {
                scheduled.store(false, Relaxed);
                crate::strings::with_locale(crate::settings::app_locale(s), || {
                    let mut changed = crate::poll_chat(s, 64);
                    changed |= crate::launcher::poll(s, tx);
                    changed |= crate::files::poll_notices(s);
                    changed |= crate::git::poll_notices(s, tx);
                    changed |= crate::settings::poll(s, tx);
                    collect(s, crate::workspace::notification_target);
                    changed |= crate::workspace::poll_cached_notifications(s, tx);
                    changed |= crate::settings::poll(s, tx);
                    changed | poll(s, tx)
                })
            });
        }
    })
}
