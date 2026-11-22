//! One serialized opening action at a time; HTTP never runs on the UI thread.
pub(crate) mod view;
use crate::{
    Phase, State,
    backend::Backend,
    catalog::{Project, Session, Sessions},
    history::Result,
};
use codenomad_client::{Receiver, bounded};
use rune::{Tx, edit::TextEdit};
use std::future::Future;

pub struct Launcher {
    pub address: TextEdit,
    pub password: TextEdit,
    pub folder: TextEdit,
    pub title: TextEdit,
    pub search: TextEdit,
    pub connection: Option<Backend>,
    pub server_id: Option<String>,
    pub projects: Vec<Project>,
    pub project: Option<Project>,
    pub sessions: Vec<Session>,
    pub next: Option<String>,
    pub pending: bool,
    pub error: Option<&'static str>,
    pub creation_uncertain: bool,
    pub openings: crate::workspace::opening::Openings,
    result: Option<Receiver<Result<Reply>>>,
    boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    host: Option<crate::platform::LocalHost>,
    wake: rune::Waker,
}
enum Reply {
    Connected(Backend, Vec<Project>, String),
    Opened(
        crate::workspace::opening::Opening,
        Sessions,
        Option<(Backend, String)>,
    ),
    Listed(Sessions, bool),
    Bound(Backend, String),
}
impl Launcher {
    #[cfg(test)]
    pub(crate) fn fixture() -> Self {
        Self::with_boot(std::sync::Arc::new(|| {}), None)
    }
    pub fn local_connection(&self) -> bool {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.host.is_some()
        }
        #[cfg(target_arch = "wasm32")]
        {
            false
        }
    }
    pub fn state_directory(&self) -> Option<std::path::PathBuf> {
        #[cfg(not(target_arch = "wasm32"))]
        {
            self.host.as_ref().and_then(|h| h.state_directory())
        }
        #[cfg(target_arch = "wasm32")]
        {
            None
        }
    }
    #[cfg(not(target_arch = "wasm32"))]
    pub fn has_owned_server(&self) -> bool {
        self.host.is_some()
    }
    pub fn new(wake: rune::Waker) -> Self {
        let boot = if crate::platform::setting("RUNE_BACKEND").is_none() {
            crate::platform::start_local(wake.clone())
        } else {
            None
        };
        Self::with_boot(wake, boot)
    }
    fn with_boot(
        wake: rune::Waker,
        boot: Option<Receiver<Result<(Backend, crate::platform::LocalHost)>>>,
    ) -> Self {
        let starting = boot.is_some();
        Self {
            address: TextEdit::new(crate::platform::default_backend()),
            password: TextEdit::new(crate::platform::setting("RUNE_PASSWORD").unwrap_or_default()),
            folder: TextEdit::new(""),
            title: TextEdit::new(""),
            search: TextEdit::new(""),
            connection: None,
            server_id: None,
            projects: vec![],
            project: None,
            sessions: vec![],
            next: None,
            pending: starting,
            error: None,
            creation_uncertain: false,
            openings: Default::default(),
            result: None,
            boot,
            host: None,
            wake,
        }
    }
    fn job(
        &mut self,
        error: &'static str,
        f: impl Future<Output = Result<Reply>> + crate::platform::TaskBound + 'static,
    ) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let (out, input) = bounded(1);
        self.result = Some(input);
        let wake = self.wake.clone();
        crate::platform::spawn(async move {
            // Only the operation label reaches the UI; responses and credentials stay private.
            let result = f.await.map_err(|_| error.into());
            let _ = out.send(result).await;
            wake();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn session_choices_remain_visible_in_the_scrolling_launcher() {
        for viewport in [(320.0, 640.0), (1400.0, 1600.0)] {
            let mut state = crate::init();
            let mut launcher = Launcher::with_boot(std::sync::Arc::new(|| {}), None);
            launcher.connection = Some(Backend {
                client: codenomad_client::http::Http::new().unwrap(),
                base: "http://127.0.0.1:9/".into(),
                workspace: String::new(),
                session: String::new(),
                client_id: "fixture".into(),
                fresh_mode: false,
            });
            launcher.project = Some(Project {
                id: "project".into(),
                path: "/fixture".into(),
            });
            launcher.sessions = vec![Session {
                id: "existing".into(),
                title: "Existing history".into(),
            }];
            state.screen = crate::Screen::Launcher(launcher);
            let mut runtime =
                rune::Runtime::new(state, crate::view, viewport, rune::Env::new(false, 1.0));
            runtime.frame(0.0);
            runtime.update(|_, tx| {
                tx.scroll_into_view("session-existing");
                tx.instant();
            });
            for _ in 0..12 {
                runtime.frame(1.0 / 60.0);
            }
            let choice = runtime
                .elements()
                .into_iter()
                .find(|e| e.path.ends_with("/session-existing"))
                .unwrap();
            let [_, y, _, height] = choice.rect;
            assert!(
                height > 0.0 && y < viewport.1 && y + height > 0.0,
                "session choice must have visible geometry: {:?}",
                choice.rect
            );
            let (x, y) = runtime.find("session-existing").unwrap();
            assert!(x >= 0.0 && x < viewport.0 && y >= 0.0 && y < viewport.1);
        }
    }
    #[test]
    fn bootstrap_failure_reaches_the_rendered_launcher() {
        let (out, input) = bounded(1);
        let mut state = crate::init();
        state.screen =
            crate::Screen::Launcher(Launcher::with_boot(std::sync::Arc::new(|| {}), Some(input)));
        out.try_send(Err("private backend startup detail".into()))
            .unwrap();
        let mut runtime = rune::Runtime::new(
            state,
            crate::view,
            (640.0, 800.0),
            rune::Env::new(false, 1.0),
        );
        runtime.poll = Some(crate::poll);
        runtime.frame(0.0);
        assert_eq!(
            runtime.state.screen.launcher().unwrap().error,
            Some("rune.connect_error")
        );
        let tree = runtime.accessibility_json().to_string();
        assert!(tree.contains(crate::strings::t("rune.connect_error")));
        assert!(!tree.contains("private backend startup detail"));
    }
    #[test]
    fn shared_fields_edit_their_inner_models_and_stale_launcher_input_is_discarded() {
        let mut state = crate::init();
        let mut launcher = Launcher::fixture();
        launcher.address = TextEdit::new("");
        launcher.password = TextEdit::new("");
        state.screen = crate::Screen::Launcher(launcher);
        let mut rt = rune::Runtime::new(
            state,
            crate::view,
            (640.0, 800.0),
            rune::Env::new(false, 1.0),
        );
        rt.frame(0.0);
        for (key, value) in [
            ("server-address", "synthetic-server"),
            ("server-password", "synthetic-password"),
        ] {
            let node = rt
                .elements()
                .into_iter()
                .find(|node| node.key.as_deref() == Some(key))
                .unwrap();
            assert_eq!(node.fill, rune_theme_codenomad::field_kit(false).c.bg_base);
            let (x, y) = rt.find(key).unwrap();
            rt.pointer_down(x, y);
            rt.pointer_up(x, y);
            rt.paste(value);
            rt.frame(0.02);
        }
        assert_eq!(
            rt.state.screen.launcher().unwrap().address.text,
            "synthetic-server"
        );
        assert_eq!(
            rt.state.screen.launcher().unwrap().password.text,
            "synthetic-password"
        );
        rt.state.show_chat();
        rt.state.draft = TextEdit::new("current composer");
        rt.paste("late password edit");
        rt.frame(0.02);
        assert_eq!(
            rt.state.screen.launcher().unwrap().password.text,
            "synthetic-password"
        );
        assert_eq!(rt.state.draft.text, "current composer");
    }
}
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
pub fn choose_project(s: &mut State, path: &str, tx: &mut Tx) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    l.folder = TextEdit::new(path);
    open(s, tx);
}
pub fn open(s: &mut State, tx: &mut Tx) {
    if !crate::workspace::input_ready(s) {
        return;
    }
    if !crate::workspace::prepare_open(s, tx) {
        if let Some(l) = s.screen.launcher_mut() {
            l.error = Some("rune.open_error");
        }
        return;
    }
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_string())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let Some(b) = l.connection.clone() else {
        return;
    };
    if l.pending {
        return;
    }
    let pending = match l.openings.begin(b.clone(), &intent) {
        Ok(pending) => pending,
        Err(_) => {
            l.error = Some("rune.open_error");
            return;
        }
    };
    let folder = l.folder.text.trim().to_string();
    l.job("rune.open_error", async move {
        let opening = pending.create(&folder).await?;
        let rows = b.sessions(&opening.project, None).await?;
        Ok(Reply::Opened(opening, rows, None))
    });
}
pub fn list(s: &mut State, more: bool) {
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let cursor = if more { l.next.clone() } else { None };
    l.job("rune.list_error", async move {
        Ok(Reply::Listed(
            b.sessions(&p, cursor.as_deref()).await?,
            more,
        ))
    });
}
pub fn create(s: &mut State, _: &mut Tx) {
    if !crate::workspace::input_ready(s) {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.creation_uncertain || l.title.text.trim().is_empty() {
        return;
    }
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let title = l.title.text.clone();
    // A create request is never automatically retried. Refresh reconciles a lost response.
    l.job("rune.create_error", async move {
        let session = b.create_session(&p, &title).await?;
        Ok(Reply::Bound(
            b.bind(&p, &session.id, true).await?,
            session.title,
        ))
    });
}
pub fn choose(s: &mut State, id: String, title: String) {
    if !crate::workspace::input_ready(s) {
        return;
    }
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    l.job("rune.open_error", async move {
        Ok(Reply::Bound(b.bind(&p, &id, false).await?, title))
    });
}
pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(l) = s.screen.launcher_mut() else {
        return false;
    };
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
    let Some(result) = l.result.as_ref().and_then(|rx| rx.try_recv().ok()) else {
        if boot_changed {
            tx.instant();
        }
        return boot_changed;
    };
    l.result = None;
    l.pending = false;
    match result {
        Ok(Reply::Connected(b, projects, server_id)) => {
            l.connection = Some(b);
            l.server_id = Some(server_id);
            l.projects = projects;
            l.password = TextEdit::new("");
            crate::workspace::connected(s);
            crate::workspace::resume(s, tx);
        }
        Ok(Reply::Opened(opening, rows, restored)) => {
            let project = opening.project.clone();
            if opening.adopt().is_err() {
                l.error = Some("rune.open_error");
                tx.instant();
                return true;
            }
            l.folder = TextEdit::new(&project.path);
            l.project = Some(project.clone());
            l.sessions = rows.rows;
            l.next = rows.next;
            l.search = TextEdit::new("");
            l.creation_uncertain = false;
            crate::workspace::opened(s, &project);
            if let Some((backend, title)) = restored {
                bind(s, backend, title, tx);
            }
        }
        Ok(Reply::Listed(rows, more)) => {
            if !more {
                l.creation_uncertain = false;
            }
            if !more {
                l.sessions.clear();
            }
            for row in rows.rows {
                if !l.sessions.iter().any(|s| s.id == row.id) {
                    l.sessions.push(row);
                }
            }
            l.next = rows.next;
        }
        Ok(Reply::Bound(b, title)) => {
            bind(s, b, title, tx);
        }
        Err(error) => {
            let key = match error.to_string().as_str() {
                "rune.connect_error" => "rune.connect_error",
                "rune.list_error" => "rune.list_error",
                "rune.create_error" => "rune.create_error",
                "rune.restore_error" => "rune.restore_error",
                _ => "rune.open_error",
            };
            if key == "rune.create_error" {
                l.creation_uncertain = true;
            }
            l.error = Some(key);
        }
    }
    tx.instant();
    true
}
pub fn restore(s: &mut State, saved: crate::workspace::Workspace) {
    let intent = s
        .workspace
        .as_ref()
        .map(|ui| ui.active_key().to_string())
        .unwrap_or_else(|| "launcher".into());
    let Some(l) = s.screen.launcher_mut() else {
        return;
    };
    if l.pending {
        return;
    }
    let Some(backend) = l.connection.clone() else {
        return;
    };
    let local = l.local_connection();
    let identity = if local {
        saved.backend_id.is_none()
    } else {
        saved.backend_id.as_deref()
            == Some(if cfg!(target_arch = "wasm32") {
                "web"
            } else {
                "external"
            })
            && saved.server_id.is_some()
            && saved.server_id == l.server_id
    };
    if !identity {
        l.error = Some("rune.restore_error");
        return;
    }
    let pending = match l.openings.begin(backend.clone(), &intent) {
        Ok(pending) => pending,
        Err(_) => {
            l.error = Some("rune.restore_error");
            return;
        }
    };
    l.job("rune.restore_error", async move {
        let opening = pending.create(&saved.folder).await?;
        let rows = backend.sessions(&opening.project, None).await?;
        let bound = if let Some(id) = &saved.active_session_id {
            let (bound, session) = backend.bind_session(&opening.project, id, false).await?;
            Some((bound, session.title))
        } else {
            None
        };
        Ok(Reply::Opened(opening, rows, bound))
    });
}
fn bind(s: &mut State, b: Backend, title: String, tx: &mut Tx) {
    let draft = crate::workspace::bound(s, &b);
    crate::files::bind(s, &b);
    s.agent = None;
    s.transcript_display.bind(&b.base, &b.workspace, &b.session);
    s.chat_title = title;
    s.messages.clear();
    s.draft = TextEdit::new(draft);
    s.phase = Phase::Loading;
    s.can_older = false;
    s.paging = false;
    s.history_error = false;
    s.revision += 1;
    let (out, incoming) = bounded(64);
    let (commands, input) = bounded(1);
    s.incoming = Some(incoming);
    s.commands = Some(commands);
    let wake = s.wake.clone();
    crate::platform::spawn(async move {
        if crate::transport::run_backend(b, out.clone(), input, wake.clone())
            .await
            .is_err()
        {
            crate::transport::publish(&out, &wake, crate::transport::Event::Failed).await;
        }
    });
    s.show_chat();
    crate::workspace::capture(s);
    tx.scroll_to_bottom_instant("history");
}
pub fn back(s: &mut State) {
    if !matches!(s.phase, Phase::Ready | Phase::Failed)
        || (!s.draft.text.is_empty() && s.workspace.is_none())
        || crate::agent::navigation_blocked(s)
        || s.screen.launcher().is_none()
    {
        return;
    }
    crate::workspace::capture(s);
    s.agent = None;
    s.commands = None;
    s.incoming = None;
    s.files = None;
    s.show_launcher();
    list(s, false);
}
