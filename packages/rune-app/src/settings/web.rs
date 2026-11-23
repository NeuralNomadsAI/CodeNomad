use super::{
    Preferences, opencode,
    providers::{self, Catalog, Target},
};
use crate::{State, platform, screen, strings::t};
use codenomad_client::{Receiver, Sender, bounded, settings::opencode_local};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space,
    layout::{self, Layout},
    settings as chrome,
};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Section {
    General,
    OpenCode,
    Providers,
}

impl Section {
    fn label(self) -> &'static str {
        t(match self {
            Self::General => "settings.nav.general",
            Self::OpenCode => "settings.nav.opencode",
            Self::Providers => "settings.nav.providers",
        })
    }
}

impl Default for Section {
    fn default() -> Self {
        Self::General
    }
}

#[derive(Default)]
pub(super) struct Panel {
    shown: bool,
    section: Section,
    contrast_help: bool,
    permissions: super::behavior::Permissions,
    memory_help_failed: bool,
    memory_editor: super::memory::editor::Editor,
    catalog: Catalog,
    scope: Option<HostScope>,
    opencode: opencode::Status,
}

struct HostScope {
    owner: String,
    local: bool,
    probe: Option<(Sender<()>, Receiver<bool>)>,
}

impl Panel {
    pub fn shown(&self) -> bool {
        self.shown
    }

    pub fn poll(&mut self, prefs: &mut Preferences, wake: &rune::Waker, paired: bool) -> bool {
        let scope_changed = self.poll_scope(prefs, wake, paired);
        let opencode = if self.section == Section::OpenCode && self.local(prefs) {
            self.opencode.step(prefs, wake)
        } else {
            false
        };
        let editor = prefs.memory.poll_editor(&mut self.memory_editor);
        editor
            | scope_changed
            | opencode
            | (self.shown
                && self.section == Section::Providers
                && self.catalog.poll(
                    prefs.provider_target.as_ref().filter(|_| prefs.can_retry()),
                    Some(wake),
                ))
    }

    fn poll_scope(&mut self, prefs: &mut Preferences, wake: &rune::Waker, paired: bool) -> bool {
        let backend = prefs
            .backend
            .as_ref()
            .filter(|_| self.shown && paired && prefs.can_retry());
        if backend.map(|b| b.client_id.as_str()) != self.scope.as_ref().map(|s| s.owner.as_str()) {
            prefs.opencode_install.cancel_check();
            self.opencode = opencode::Status::default();
            if self.section == Section::OpenCode {
                self.section = Section::General;
                prefs.memory.show(true);
            }
            self.scope = backend.map(|backend| {
                let (cancel, cancelled) = bounded(1);
                let (out, reply) = bounded(1);
                let (backend, wake) = (backend.clone(), wake.clone());
                let owner = backend.client_id.clone();
                platform::spawn(async move {
                    if let Some(local) =
                        platform::reads::cancellable(&cancelled, opencode_local(&backend)).await
                        && out.send(local.unwrap_or(false)).await.is_ok()
                    {
                        wake();
                    }
                });
                HostScope {
                    owner,
                    local: false,
                    probe: Some((cancel, reply)),
                }
            });
            return true;
        }
        let Some(scope) = &mut self.scope else {
            return false;
        };
        let Some(local) = scope
            .probe
            .as_ref()
            .and_then(|(_, reply)| reply.try_recv().ok())
        else {
            return false;
        };
        scope.probe = None;
        scope.local = local;
        local
    }

    fn local(&self, prefs: &Preferences) -> bool {
        prefs.can_retry()
            && self.scope.as_ref().is_some_and(|scope| {
                scope.local
                    && prefs
                        .backend
                        .as_ref()
                        .is_some_and(|backend| backend.client_id == scope.owner)
            })
    }
}

pub(super) fn entry() -> El {
    layout::button(t("settings.title"), false, |s: &mut State| {
        let target = Target::capture(s);
        let mut prefs = s.settings.shared.borrow_mut();
        prefs.provider_target = target;
        prefs
            .memory
            .show(s.settings.web.section == Section::General);
        s.settings.web.shown = true;
        (s.wake)();
    })
    .key("open-preferences")
}

fn close(s: &mut State) {
    let panel = &mut s.settings.web;
    panel.shown = false;
    panel.contrast_help = false;
    panel.permissions.close();
    panel.catalog.suspend();
    let mut prefs = s.settings.shared.borrow_mut();
    prefs.opencode_install.cancel_check();
    panel.opencode = opencode::Status::default();
    panel.scope = None;
    if panel.section == Section::OpenCode {
        panel.section = Section::General;
    }
    prefs.provider_target = None;
    prefs.memory.show(false);
    panel.memory_help_failed = false;
}

pub(super) fn view(s: &State, prefs: &Preferences, system_more: bool) -> Option<El> {
    let panel = &s.settings.web;
    if !panel.shown || crate::platform::pairing::required(s) {
        return None;
    }
    let local = panel.local(prefs);
    let sections = if local {
        &[Section::General, Section::OpenCode, Section::Providers][..]
    } else {
        &[Section::General, Section::Providers][..]
    };
    let labels: Vec<_> = sections.iter().map(|section| section.label()).collect();
    let navigation = chrome::segments(
        t("settings.navigationAriaLabel"),
        &labels,
        sections
            .iter()
            .position(|section| *section == panel.section),
        false,
        move |s: &mut State, index| {
            let panel = &mut s.settings.web;
            let mut prefs = s.settings.shared.borrow_mut();
            let section = sections[index];
            if !panel.shown || (section == Section::OpenCode && !panel.local(&prefs)) {
                return;
            }
            panel.section = section;
            if section != Section::OpenCode {
                prefs.opencode_install.cancel_check();
                panel.opencode = opencode::Status::default();
            }
            if panel.section != Section::Providers {
                panel.catalog.suspend();
            }
            panel.contrast_help = false;
            panel.permissions.close();
            panel.memory_help_failed = false;
            prefs.memory.show(panel.section == Section::General);
        },
    );
    let mut layers = Vec::new();
    let body = match panel.section {
        Section::General => col()
            .full_width()
            .child(general(panel, prefs, system_more))
            .child(super::memory::view(
                prefs,
                panel.memory_help_failed,
                |s: &mut State, desired| {
                    super::memory::action(&mut s.settings.shared.borrow_mut(), desired)
                },
                |s: &mut State, failed| s.settings.web.memory_help_failed = failed,
                |s: &mut State, edit| s.settings.web.memory_editor.open(edit),
                |s: &mut State, action| {
                    super::memory::review_action(&mut s.settings.shared.borrow_mut(), action);
                },
            ))
            .child(
                panel
                    .permissions
                    .view(&s.settings.shared, &mut layers, |s: &mut State| {
                        &mut s.settings.web.permissions
                    }),
            ),
        Section::Providers => {
            let available =
                prefs.can_retry() && prefs.provider_target.as_ref().is_some_and(Target::online);
            providers::content(&panel.catalog, available, |s: &mut State| {
                s.settings.web.catalog.toggle()
            })
        }
        Section::OpenCode if local => opencode::view(
            &panel.opencode,
            prefs,
            |s: &mut State| {
                let panel = &s.settings.web;
                let mut prefs = s.settings.shared.borrow_mut();
                if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs) {
                    panel.opencode.start(&mut prefs, Some(s.wake.clone()));
                }
            },
            |s: &mut State| {
                let panel = &mut s.settings.web;
                let mut prefs = s.settings.shared.borrow_mut();
                if panel.shown && panel.section == Section::OpenCode && panel.local(&prefs) {
                    panel.opencode.read(&mut prefs, Some(&s.wake), Some(true));
                }
            },
            |s| &mut s.settings.web.opencode,
        ),
        Section::OpenCode => rune::el(),
    };
    if let Some(editor) = prefs.memory.editor_view(
        &panel.memory_editor,
        |s: &mut State| &mut s.settings.web.memory_editor,
        |s: &mut State, action| {
            super::memory::review_action(&mut s.settings.shared.borrow_mut(), action)
        },
    ) {
        layers.push(editor);
    }
    Some(
        chrome::embedded_section(
            t("settings.title"),
            col()
                .full_width()
                .separate(Space::Md)
                .child(navigation)
                .child(body),
            layout::button(
                t("settings.close"),
                false,
                screen::action(&s.input_scope, close),
            )
            .key("close-preferences"),
            close,
        )
        .children(layers),
    )
}

fn general(panel: &Panel, prefs: &Preferences, system_more: bool) -> El {
    chrome::card(
        col()
            .full_width()
            .separate(Space::Sm)
            .child(text(t("settings.appearance.colorScheme.title")).role("heading"))
            .child(super::contrast::view(
                prefs,
                system_more,
                panel.contrast_help,
                |s: &mut State| s.settings.web.contrast_help = !s.settings.web.contrast_help,
                |s: &mut State, choice| s.settings.shared.borrow_mut().set_contrast(choice),
            ))
            .children(prefs.error().map(|error| {
                layout::action_row()
                    .child(text(t(error)).wrap().role("alert"))
                    .child(layout::button(
                        t("sessionList.loadError.retry"),
                        !prefs.can_retry(),
                        |s: &mut State| {
                            s.settings.shared.borrow_mut().retry();
                        },
                    ))
            })),
    )
}
