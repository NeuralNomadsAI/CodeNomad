use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    permission_mode::{Mode, Snapshot, WriteIssue},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings,
};

const MODES: [Mode; 2] = [Mode::Autonomous, Mode::Supervised];

fn label(mode: Mode) -> &'static str {
    t(match mode {
        Mode::Autonomous => "permissions.mode.autonomous",
        Mode::Supervised => "permissions.mode.supervised",
    })
}

#[derive(Default)]
pub(crate) struct Permissions {
    backend: Option<Backend>,
    online: bool,
    visible: bool,
    expanded: bool,
    info: bool,
    dirty: bool,
    failed: bool,
    confirmed: Option<Snapshot>,
    read: Option<(Sender<()>, Receiver<Option<Snapshot>>)>,
    write: Option<(Mode, Receiver<Option<WriteIssue>>)>,
    checking: Option<(Mode, Option<WriteIssue>)>,
    issue: Option<WriteIssue>,
}

impl Permissions {
    pub(crate) fn leave_session(&mut self) {
        *self = Self {
            expanded: self.expanded,
            ..Self::default()
        };
    }

    pub(crate) fn bind(&mut self, backend: &Backend) {
        if self.backend.as_ref().is_none_or(|previous| {
            previous.session != backend.session
                || previous.workspace != backend.workspace
                || previous.base != backend.base
                || !previous.client.same_connection(&backend.client)
        }) {
            self.leave_session();
        }
        self.backend = (backend.session.starts_with("ses")
            && backend.session.len() > 3
            && !backend.session.starts_with("ses_cn_schedule_")
            && backend.client.supports("conversation-permissions"))
        .then(|| backend.clone());
    }

    pub(crate) fn online(&mut self, online: bool) {
        self.online = online;
        self.dirty = true;
        if !online {
            self.read = None;
        }
    }

    pub(crate) fn invalidate(&mut self, root: Option<&str>) {
        if let Some(backend) = &self.backend
            && root.is_none_or(|root| {
                self.confirmed.as_ref().is_none_or(|snapshot| {
                    snapshot.root.as_deref().unwrap_or(&backend.session) == root
                })
            })
        {
            self.dirty = true;
        }
    }

    pub(crate) fn show(&mut self, visible: bool) {
        if self.visible != visible {
            self.visible = visible;
            self.dirty = true;
            if !visible {
                self.info = false;
                self.read = None;
            }
        }
    }

    fn available(&self) -> bool {
        self.online
            && self.visible
            && !self.dirty
            && !self.failed
            && self.read.is_none()
            && self.write.is_none()
            && self.checking.is_none()
    }

    fn change(s: &mut State, mode: Mode) {
        if !demand(
            s.screen.is_launcher(),
            s.shell.visible(1),
            crate::workspace::files_tab(s),
        ) || !s.status_permissions.available()
            || s.status_permissions
                .confirmed
                .as_ref()
                .is_none_or(|snapshot| snapshot.mode == mode)
        {
            return;
        }
        s.status_permissions.write(mode, &s.wake);
    }

    fn write(&mut self, mode: Mode, wake: &rune::Waker) {
        let Some(backend) = self.backend.clone() else {
            return;
        };
        let wake = wake.clone();
        let (out, reply) = bounded(1);
        self.issue = None;
        self.write = Some((mode, reply));
        platform::spawn(async move {
            let _ = out.try_send(backend.set_permission_mode(mode).await);
            wake();
        });
    }

    fn poll(&mut self, reads: &platform::reads::Reads, wake: &rune::Waker) -> bool {
        let mut changed = false;
        if let Some((wanted, reply)) = &self.write
            && let Some(issue) = arrived(reply, Some(WriteIssue::Unconfirmed))
        {
            self.checking = Some((*wanted, issue));
            self.write = None;
            self.dirty = true;
            changed = true;
        }
        if let Some((_, reply)) = &self.read
            && let Some(snapshot) = arrived(reply, None)
        {
            self.read = None;
            if !self.dirty {
                self.failed = snapshot.is_none();
                if let Some(snapshot) = snapshot {
                    if let Some((wanted, issue)) = self.checking.take() {
                        self.issue = (snapshot.mode != wanted)
                            .then(|| issue.unwrap_or(WriteIssue::Unconfirmed));
                    }
                    self.confirmed = Some(snapshot);
                }
            }
            changed = true;
        }
        if self.dirty
            && self.visible
            && self.online
            && self.read.is_none()
            && self.write.is_none()
            && let Some(backend) = self.backend.clone()
        {
            let (cancel, cancelled) = bounded(1);
            let (out, reply) = bounded(1);
            self.dirty = false;
            self.read = Some((cancel, reply));
            let (reads, wake) = (reads.clone(), wake.clone());
            platform::spawn(async move {
                let Some(_slot) = reads.background(&cancelled).await else {
                    return;
                };
                if let Some(result) =
                    platform::reads::cancellable(&cancelled, backend.permission_mode()).await
                {
                    let _ = out.try_send(result.ok());
                    wake();
                }
            });
            changed = true;
        }
        changed
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests;

fn arrived<T>(reply: &Receiver<T>, fallback: T) -> Option<T> {
    match reply.try_recv() {
        Ok(value) => Some(value),
        Err(codenomad_client::TryRecvError::Closed) => Some(fallback),
        Err(codenomad_client::TryRecvError::Empty) => None,
    }
}

fn demand(launcher: bool, panel: bool, files: bool) -> bool {
    !launcher && panel && !files
}

pub(crate) fn poll(s: &mut State) -> bool {
    s.status_permissions.show(demand(
        s.screen.is_launcher(),
        s.shell.visible(1),
        crate::workspace::files_tab(s),
    ));
    s.status_permissions.poll(&s.reads, &s.wake)
}

pub(super) fn view(s: &State) -> Option<El> {
    let owner = &s.status_permissions;
    owner.backend.as_ref()?;
    let title = t("permissions.title");
    let mode = owner.confirmed.as_ref().map(|snapshot| snapshot.mode);
    let applying = owner.write.is_some() || owner.checking.is_some();
    let status = if !owner.online || owner.failed {
        Some(t("permissions.unconfirmed"))
    } else if applying {
        Some(t("permissions.applying"))
    } else {
        None
    };
    let summary = [
        Some(title),
        mode.map(label),
        (!owner.expanded).then_some(status).flatten(),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let mut body = col().separate(Space::Xs);
    if mode.is_some() {
        body = body.child(
            settings::segments(
                title,
                &MODES.map(label),
                MODES.iter().position(|candidate| Some(*candidate) == mode),
                !owner.available(),
                {
                    let scope = s.input_scope.clone();
                    move |s: &mut State, index| {
                        if s.current_scope(&scope)
                            && s.status_permissions.expanded
                            && let Some(&mode) = MODES.get(index)
                        {
                            Permissions::change(s, mode);
                        }
                    }
                },
            )
            .key("permission-mode"),
        );
    }
    if let Some(status) = status {
        body = body.child(text(status).role("status"));
    }
    if owner.failed {
        body = body.child(
            layout::button(
                t("permissions.retry"),
                !owner.online,
                screen::action(&s.input_scope, |s| {
                    s.status_permissions.dirty = true;
                }),
            )
            .key("permission-mode-retry"),
        );
    }
    if let Some(issue) = &owner.issue {
        body = body.child(
            text(t(match issue {
                WriteIssue::Unverified => "permissions.blockUnverified",
                WriteIssue::Unconfirmed => "permissions.changeFailed",
            }))
            .role("alert"),
        );
    }
    let info = t("permissions.info.label");
    let help = format!(
        "{}: {}\n{}: {}\n{}",
        label(Mode::Autonomous),
        t("permissions.info.autonomous"),
        label(Mode::Supervised),
        t("permissions.info.supervised"),
        t("permissions.info.scope")
    );
    body = body.child(
        layout::button(
            "?",
            false,
            screen::action(&s.input_scope, |s| {
                s.status_permissions.info = !s.status_permissions.info;
            }),
        )
        .key("permission-mode-info")
        .label(info)
        .help(help)
        .help_open(owner.info),
    );
    Some(
        settings::disclosure(
            &summary,
            owner.expanded,
            body,
            screen::action(&s.input_scope, |s| {
                s.status_permissions.expanded = !s.status_permissions.expanded;
                s.status_permissions.info = false;
            }),
        )
        .key("status-permissions"),
    )
}
