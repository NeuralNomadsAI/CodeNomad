use super::{Backend, Launcher, Reply, State, TextEdit, Tx};

pub fn connect(s: &mut State, _: &mut Tx) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending {
        return;
    }
    l.host = None;
    let address = l.address.text.clone();
    let password = l.password.text.clone();
    l.job("rune.connect_error", async move {
        let b = Backend::connect(&address, &password).await?;
        let server_id = b.server_id().await?;
        let projects = b.projects().await?;
        Ok(Reply::Connected(b, projects, server_id))
    });
}

pub(super) fn poll_boot(l: &mut Launcher) -> bool {
    let mut boot_changed = false;
    if let Some(result) = l
        .boot
        .as_ref()
        .and_then(|receiver| receiver.try_recv().ok())
    {
        l.boot = None;
        l.pending = false;
        boot_changed = true;
        match result {
            Ok((backend, host)) => {
                l.address = TextEdit::new(&backend.base);
                l.host = Some(host);
                // Bootstrap owns the authenticated cookie jar even if project listing fails.
                l.connection = Some(backend.clone());
                l.job("rune.list_error", async move {
                    let server_id = backend.server_id().await?;
                    let projects = backend.projects().await?;
                    Ok(Reply::Connected(backend, projects, server_id))
                });
            }
            Err(_) => l.error = Some("rune.connect_error"),
        }
    }
    boot_changed
}
