use crate::{State, backend::Backend, platform, screen, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    permission_mode::{Mode, Snapshot, WriteIssue},
};
use rune::{El, col};
use rune_theme_codenomad::{
    Space, attachment,
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
    revalidating: bool,
    visible: bool,
    expanded: bool,
    info: bool,
    dirty: bool,
    failed: bool,
    confirmed: Option<Snapshot>,
    read: Option<(Sender<()>, Receiver<Option<Snapshot>>)>,
    write: Option<(Mode, Receiver<Result<Snapshot, WriteIssue>>)>,
    checking: Option<(Mode, WriteIssue)>,
    issue: Option<WriteIssue>,
    #[cfg(any(test, target_arch = "wasm32"))]
    announced_errors: [Option<&'static str>; 2],
}

impl Permissions {
    pub(crate) fn attach(&mut self, backend: Option<&Backend>) {
        if !self.settling() || backend.is_some_and(|backend| !self.same_session(backend)) {
            *self = Self {
                expanded: self.expanded,
                ..Self::default()
            };
        } else {
            self.online(false);
        }
    }

    pub(crate) fn bind(&mut self, backend: &Backend) {
        if self.backend.as_ref().is_none_or(|previous| {
            previous.session != backend.session
                || previous.workspace != backend.workspace
                || previous.base != backend.base
                || !previous.client.same_connection(&backend.client)
        }) {
            self.attach(Some(backend));
        }
        self.backend = (backend.session.starts_with("ses")
            && backend.session.len() > 3
            && !backend.session.starts_with("ses_cn_schedule_")
            && backend.client.supports("conversation-permissions"))
        .then(|| backend.clone());
    }

    fn same_session(&self, backend: &Backend) -> bool {
        self.backend.as_ref().is_some_and(|previous| {
            previous.session == backend.session
                && previous.base == backend.base
                && (previous.client.same_connection(&backend.client)
                    || previous
                        .client
                        .server_identity()
                        .is_some_and(|id| backend.client.server_identity() == Some(id)))
        })
    }

    pub(crate) fn online(&mut self, online: bool) {
        self.online = online;
        self.dirty = true;
        if !online {
            self.revalidating = true;
            self.read = None;
        }
    }

    pub(crate) fn synchronized(&mut self) {
        if !self.online {
            self.online(true);
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
                if self.checking.is_none() {
                    self.read = None;
                }
            }
        }
    }

    pub(crate) fn writing(&self) -> bool {
        self.write.is_some()
    }

    #[cfg(test)]
    pub(crate) fn fixture_writing(&mut self, writing: bool) {
        self.write = writing.then(|| {
            let (_tx, rx) = bounded(1);
            (Mode::Autonomous, rx)
        });
    }

    #[cfg(test)]
    pub(crate) fn fixture_bind(&mut self, backend: Backend) {
        self.backend = Some(backend);
        self.online = true;
        self.visible = true;
    }

    pub(crate) fn settling(&self) -> bool {
        self.writing()
            || self
                .checking
                .is_some_and(|(_, issue)| !self.failed || matches!(issue, WriteIssue::Unconfirmed))
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
            crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status,
        ) || s.composer.pending()
            || s.screen.launcher().is_some_and(|launcher| launcher.pending)
            || crate::git::placement_unconfirmed(s)
            || !s.status_permissions.available()
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
            && let Some(result) = arrived(reply, Err(WriteIssue::Unconfirmed))
        {
            match result {
                Ok(snapshot) => self.confirmed = Some(snapshot),
                Err(issue) => {
                    self.failed = false;
                    self.checking = Some((*wanted, issue));
                }
            }
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
                    self.revalidating = false;
                    if let Some((wanted, issue)) = self.checking.take() {
                        self.issue = (snapshot.mode != wanted).then_some(issue);
                    }
                    self.confirmed = Some(snapshot);
                } else if let Some((_, issue)) = self.checking {
                    self.issue = Some(issue);
                }
            }
            changed = true;
        }
        if self.dirty
            && (self.visible || self.checking.is_some())
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

    fn unconfirmed(&self) -> bool {
        !self.online || self.revalidating || self.failed
    }

    fn issue_key(&self) -> Option<&'static str> {
        self.issue.as_ref().map(|issue| match issue {
            WriteIssue::Unverified => "permissions.blockUnverified",
            WriteIssue::Unconfirmed => "permissions.changeFailed",
        })
    }

    #[cfg(any(test, target_arch = "wasm32"))]
    fn new_errors(&mut self) -> impl Iterator<Item = &'static str> + use<> {
        let present = [
            self.issue_key(),
            (self.visible && self.failed).then_some("permissions.unconfirmed"),
        ];
        let announced = std::mem::replace(&mut self.announced_errors, present);
        present.into_iter().zip(announced).filter_map(
            |(key, previous)| {
                if key == previous { None } else { key }
            },
        )
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

fn demand(launcher: bool, panel: bool, status: bool) -> bool {
    !launcher && panel && status
}

pub(crate) fn poll(s: &mut State, _tx: &mut rune::Tx) -> bool {
    #[cfg(target_arch = "wasm32")]
    let locale = crate::settings::locale(s);
    s.status_permissions.show(demand(
        s.screen.is_launcher(),
        s.shell.visible(1),
        crate::workspace::right_panel_tab(s) == crate::workspace::RightPanelTab::Status,
    ));
    let owner = &mut s.status_permissions;
    let changed = owner.poll(&s.reads, &s.wake);
    #[cfg(target_arch = "wasm32")]
    {
        let words = crate::strings::with_locale(locale, || {
            owner.new_errors().map(t).collect::<Vec<_>>().join("\n")
        });
        if !words.is_empty() {
            layout::announce_polite(_tx, words);
        }
    }
    changed
}

pub(crate) fn confirmation(s: &State) -> Option<El> {
    let owner = &s.status_permissions;
    if !owner.settling() {
        return None;
    }
    if !owner.unconfirmed() {
        return Some(
            attachment::status_badge(t("permissions.applying"))
                .key("permission-confirmation-status"),
        );
    }
    Some(
        layout::action_row()
            .child(
                attachment::status_badge(t("permissions.unconfirmed"))
                    .key("permission-confirmation-status"),
            )
            .child(retry(s)),
    )
}

fn retry(s: &State) -> El {
    layout::button(
        t("permissions.retry"),
        !s.status_permissions.online || s.status_permissions.read.is_some(),
        screen::action(&s.input_scope, |s| s.status_permissions.dirty = true),
    )
}

pub(super) fn view(s: &State) -> Option<El> {
    let owner = &s.status_permissions;
    owner.backend.as_ref()?;
    let title = t("permissions.title");
    let mode = owner.confirmed.as_ref().map(|snapshot| snapshot.mode);
    let applying = owner.writing() || (owner.checking.is_some() && !owner.failed);
    let status = if owner.unconfirmed() {
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
    let info = t("permissions.info.label");
    let help = format!(
        "{} — {}\n{} — {}\n{}",
        label(Mode::Autonomous),
        t("permissions.info.autonomous"),
        label(Mode::Supervised),
        t("permissions.info.supervised"),
        t("permissions.info.scope")
    );
    let info_button = settings::info_tip(
        info,
        &help,
        owner.info,
        screen::action(&s.input_scope, |s| {
            s.status_permissions.info = !s.status_permissions.info;
        }),
    )
    .key("permission-mode-info");
    let mut body = col().full_width().separate(Space::Xs);
    if mode.is_some() {
        body = body.child(
            layout::action_row()
                .child(
                    settings::committing_segments(
                        title,
                        &MODES.map(label),
                        MODES.iter().position(|candidate| Some(*candidate) == mode),
                        crate::strings::locale(),
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
                    .key("permission-mode")
                    .aria_disabled(!owner.available()),
                )
                .child(info_button),
        );
    } else {
        let mut row = layout::action_row().child(info_button);
        if owner.failed {
            row = row.child(retry(s).key("permission-mode-retry"));
        }
        body = body.child(row);
    }
    if let Some(status) = status {
        body = body.child(attachment::status_badge(status).key("permission-mode-status"));
    }
    if owner.failed && mode.is_some() {
        body = body.child(retry(s).key("permission-mode-retry"));
    }
    if let Some(key) = owner.issue_key() {
        body = body.child(settings::palette::save_error(t(key)).key("permission-mode-error"));
    }
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
