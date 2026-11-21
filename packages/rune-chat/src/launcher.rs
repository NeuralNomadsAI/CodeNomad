//! One serialized opening action at a time; HTTP never runs on the UI thread.
use crate::{
    Phase, State,
    backend::Backend,
    catalog::{Project, Session, Sessions},
    history::Result,
};
use rune::{Tx, edit::TextEdit};
use std::sync::mpsc::{self, Receiver};

pub struct Launcher {
    pub address: TextEdit,
    pub password: TextEdit,
    pub folder: TextEdit,
    pub title: TextEdit,
    pub search: TextEdit,
    pub connection: Option<Backend>,
    pub projects: Vec<Project>,
    pub project: Option<Project>,
    pub sessions: Vec<Session>,
    pub next: Option<String>,
    pub pending: bool,
    pub error: Option<&'static str>,
    pub creation_uncertain: bool,
    result: Option<Receiver<Result<Reply>>>,
    wake: rune::Waker,
}
enum Reply {
    Connected(Backend, Vec<Project>),
    Opened(Project, Sessions),
    Listed(Sessions, bool),
    Bound(Backend, String),
}
impl Launcher {
    pub fn new(wake: rune::Waker) -> Self {
        Self {
            address: TextEdit::new(
                std::env::var("RUNE_BACKEND").unwrap_or_else(|_| "http://127.0.0.1:3000/".into()),
            ),
            password: TextEdit::new(std::env::var("RUNE_PASSWORD").unwrap_or_default()),
            folder: TextEdit::new(""),
            title: TextEdit::new(""),
            search: TextEdit::new(""),
            connection: None,
            projects: vec![],
            project: None,
            sessions: vec![],
            next: None,
            pending: false,
            error: None,
            creation_uncertain: false,
            result: None,
            wake,
        }
    }
    fn job(&mut self, error: &'static str, f: impl FnOnce() -> Result<Reply> + Send + 'static) {
        if self.pending {
            return;
        }
        self.pending = true;
        self.error = None;
        let (out, input) = mpsc::sync_channel(1);
        self.result = Some(input);
        let wake = self.wake.clone();
        std::thread::spawn(move || {
            // Only the operation label reaches the UI; responses and credentials stay private.
            let result = f().map_err(|_| error.into());
            let _ = out.send(result);
            wake();
        });
    }
}
pub fn connect(s: &mut State, _: &mut Tx) {
    let Some(l) = &mut s.launcher else {
        return;
    };
    let address = l.address.text.clone();
    let password = l.password.text.clone();
    l.job("connect_error", move || {
        let b = Backend::connect(&address, &password)?;
        let projects = b.projects()?;
        Ok(Reply::Connected(b, projects))
    });
}
pub fn open(s: &mut State, _: &mut Tx) {
    let Some(l) = &mut s.launcher else {
        return;
    };
    let Some(b) = l.connection.clone() else {
        return;
    };
    let folder = l.folder.text.trim().to_string();
    l.job("open_error", move || {
        let p = b.open_project(&folder)?;
        let rows = b.sessions(&p, None)?;
        Ok(Reply::Opened(p, rows))
    });
}
pub fn list(s: &mut State, more: bool) {
    let Some(l) = &mut s.launcher else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    let cursor = if more { l.next.clone() } else { None };
    l.job("list_error", move || {
        Ok(Reply::Listed(b.sessions(&p, cursor.as_deref())?, more))
    });
}
pub fn create(s: &mut State, _: &mut Tx) {
    let Some(l) = &mut s.launcher else {
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
    l.job("create_error", move || {
        let session = b.create_session(&p, &title)?;
        Ok(Reply::Bound(b.bind(&p, &session.id, true)?, session.title))
    });
}
pub fn choose(s: &mut State, id: String, title: String) {
    let Some(l) = &mut s.launcher else {
        return;
    };
    let (Some(b), Some(p)) = (l.connection.clone(), l.project.clone()) else {
        return;
    };
    l.job("open_error", move || {
        Ok(Reply::Bound(b.bind(&p, &id, false)?, title))
    });
}
pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let Some(l) = &mut s.launcher else {
        return false;
    };
    let Some(result) = l.result.as_ref().and_then(|rx| rx.try_recv().ok()) else {
        return false;
    };
    l.result = None;
    l.pending = false;
    match result {
        Ok(Reply::Connected(b, projects)) => {
            l.connection = Some(b);
            l.projects = projects;
            l.password = TextEdit::new("");
        }
        Ok(Reply::Opened(project, rows)) => {
            l.folder = TextEdit::new(&project.path);
            l.project = Some(project);
            l.sessions = rows.rows;
            l.next = rows.next;
            l.search = TextEdit::new("");
            l.creation_uncertain = false;
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
            s.chat_title = title;
            s.messages.clear();
            s.draft = TextEdit::new("");
            s.phase = Phase::Loading;
            s.can_older = false;
            s.paging = false;
            s.history_error = false;
            s.revision += 1;
            let (out, incoming) = mpsc::sync_channel(64);
            let (commands, input) = mpsc::sync_channel(1);
            s.incoming = Some(incoming);
            s.commands = Some(commands);
            let wake = l.wake.clone();
            std::thread::spawn(move || {
                if crate::recovery::run(b, out.clone(), input, wake.clone()).is_err() {
                    crate::transport::publish(&out, &wake, crate::transport::Event::Failed);
                }
            });
            s.launcher_visible = false;
            tx.scroll_to_bottom_instant("history");
        }
        Err(error) => {
            let key = match error.to_string().as_str() {
                "connect_error" => "connect_error",
                "list_error" => "list_error",
                "create_error" => "create_error",
                _ => "open_error",
            };
            if key == "create_error" {
                l.creation_uncertain = true;
            }
            l.error = Some(key);
        }
    }
    tx.instant();
    true
}
pub fn back(s: &mut State) {
    if !matches!(s.phase, Phase::Ready | Phase::Failed)
        || !s.draft.text.is_empty()
        || s.launcher.is_none()
    {
        return;
    }
    s.commands = None;
    s.incoming = None;
    s.launcher_visible = true;
    list(s, false);
}
