use super::{Backend, Launcher, Reply, State, TextEdit, Tx};

pub(super) fn watch_catalogue(l: &mut Launcher) {
    if l.catalogue_watch.is_none()
        && let Some(backend) = &l.connection
    {
        let (watch, task) =
            codenomad_client::stream::CatalogueWatch::new(backend.clone(), l.wake.clone());
        l.catalogue_watch = Some(watch);
        l.workspace_stream_generation = 0;
        crate::platform::spawn(task);
    }
}

pub fn connect(s: &mut State, _: &mut Tx) {
    #[cfg(target_arch = "wasm32")]
    if crate::platform::pairing::required(s) {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending {
        return;
    }
    let address = if l.authentication_required {
        let Some(backend) = &l.connection else { return };
        backend.base.clone()
    } else {
        l.host = None;
        l.address.text.clone()
    };
    let password = l.password.text.clone();
    let expected_server = l
        .authentication_required
        .then(|| l.server_id.clone())
        .flatten();
    l.job("rune.connect_error", async move {
        let b = Backend::connect(&address, &password).await?;
        let server_id = b.attest_server().await?;
        if expected_server.is_some_and(|expected| expected != server_id) {
            return Err("Server identity changed during authentication".into());
        }
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
                    let server_id = backend.attest_server().await?;
                    let projects = backend.projects().await?;
                    Ok(Reply::Connected(backend, projects, server_id))
                });
            }
            Err(_) => l.error = Some("rune.connect_error"),
        }
    }
    boot_changed
}
