use crate::{State, launcher::Launcher};
use rune::edit::TextEdit;
use std::rc::Rc;

pub enum Screen {
    Launcher(Box<Launcher>),
    Chat { launcher: Option<Box<Launcher>> },
}
impl Screen {
    pub fn launcher(&self) -> Option<&Launcher> {
        match self {
            Self::Launcher(l) => Some(l),
            Self::Chat { launcher } => launcher.as_deref(),
        }
    }
    pub fn launcher_mut(&mut self) -> Option<&mut Launcher> {
        match self {
            Self::Launcher(l) => Some(l),
            Self::Chat { launcher } => launcher.as_deref_mut(),
        }
    }
    pub fn is_launcher(&self) -> bool {
        matches!(self, Self::Launcher(_))
    }
    pub fn show_launcher(&mut self) {
        let previous = std::mem::replace(self, Screen::Chat { launcher: None });
        *self = match previous {
            Screen::Launcher(l) | Screen::Chat { launcher: Some(l) } => Screen::Launcher(l),
            other => other,
        };
    }
    pub fn show_chat(&mut self) {
        let previous = std::mem::replace(self, Screen::Chat { launcher: None });
        *self = Screen::Chat {
            launcher: match previous {
                Screen::Launcher(l) => Some(l),
                Screen::Chat { launcher } => launcher,
            },
        };
    }
}
#[derive(Clone)]
pub enum Editor {
    Address,
    Password,
    #[cfg(not(target_arch = "wasm32"))]
    DirectUsername,
    #[cfg(not(target_arch = "wasm32"))]
    DirectPassword,
    Folder,
    Title,
    Search,
    Model,
    Composer,
    Reason(String),
    Form((String, String)),
    Custom((String, String)),
}
pub fn edit(scope: &Rc<()>, target: Editor) -> impl Fn(&mut State) -> &mut TextEdit + 'static {
    let scope = scope.clone();
    move |s| s.editor(&scope, target.clone())
}
pub fn action(scope: &Rc<()>, run: impl Fn(&mut State) + 'static) -> impl Fn(&mut State) + 'static {
    let scope = scope.clone();
    move |s| {
        if s.current_scope(&scope) {
            crate::strings::with_locale(crate::settings::app_locale(s), || run(s));
        }
    }
}
pub fn action_tx(
    scope: &Rc<()>,
    run: impl Fn(&mut State, &mut rune::Tx) + 'static,
) -> impl Fn(&mut State, &mut rune::Tx) + 'static {
    let scope = scope.clone();
    move |s, tx| {
        if s.current_scope(&scope) {
            crate::strings::with_locale(crate::settings::app_locale(s), || run(s, tx));
        }
    }
}
impl State {
    pub fn renew_scope(&mut self) {
        self.input_scope = Rc::new(());
        self.composer.menu = Default::default();
        if let Some(l) = self.screen.launcher_mut() {
            l.recent_menu = Default::default();
            l.open_recent_menu = None;
        }
        self.command_palette.dismiss();
        self.tab_rename.dismiss();
        self.temporary.dismiss_dialog();
        self.blank_cleanup.dismiss_dialog();
        self.workspace_open.cancel();
        #[cfg(target_arch = "wasm32")]
        self.rotate_composer_input();
    }
    #[cfg(target_arch = "wasm32")]
    pub fn rotate_composer_input(&mut self) {
        // The web clipboard binds deferred images to the focused field's Rune path.
        self.web_composer_input_epoch = self.web_composer_input_epoch.wrapping_add(1);
    }
    pub fn current_scope(&self, scope: &Rc<()>) -> bool {
        Rc::ptr_eq(&self.input_scope, scope)
    }
    pub(crate) fn no_session_composer_active(&self) -> bool {
        #[cfg(target_arch = "wasm32")]
        if crate::platform::pairing::required(self) {
            return false;
        }
        matches!(
            &self.screen,
            Screen::Launcher(l) if l.project.is_some() && !l.authentication_required
        ) && crate::workspace::active_session(self).is_none()
            && self.commands.is_none()
            && !crate::git::has_preview(self)
            && !crate::workspace::mission_has_reader(self)
    }
    pub(crate) fn composer_active(&self) -> bool {
        !self.screen.is_launcher() || self.no_session_composer_active()
    }
    pub(crate) fn composer_editing_locked(&self) -> bool {
        self.composer.editing_locked() || self.pending_auto_session.is_some()
    }
    pub fn show_launcher(&mut self) {
        self.screen.show_launcher();
        self.tool_diff_preferences.reset_history_size();
        self.renew_scope();
    }
    pub fn show_chat(&mut self) {
        self.screen.show_chat();
        self.renew_scope();
    }
    pub fn editor(&mut self, scope: &Rc<()>, target: Editor) -> &mut TextEdit {
        self.rejected_edit = TextEdit::new("");
        if !self.current_scope(scope) {
            return &mut self.rejected_edit;
        }
        let edit = match target {
            #[cfg(not(target_arch = "wasm32"))]
            Editor::DirectUsername => Some(&mut self.direct_authentication.username),
            #[cfg(not(target_arch = "wasm32"))]
            Editor::DirectPassword => Some(&mut self.direct_authentication.password),
            Editor::Address
            | Editor::Password
            | Editor::Folder
            | Editor::Title
            | Editor::Search => {
                if let Some(l) = self.screen.launcher_mut()
                    && (matches!(target, Editor::Title | Editor::Search)
                        || l.project.is_none()
                        || matches!(target, Editor::Password) && l.authentication_required)
                {
                    Some(match target {
                        Editor::Address => &mut l.address,
                        Editor::Password => &mut l.password,
                        Editor::Folder => &mut l.folder,
                        Editor::Title => &mut l.title,
                        _ => &mut l.search,
                    })
                } else {
                    None
                }
            }
            Editor::Model => self.agent.as_mut().map(|a| &mut a.search),
            Editor::Composer => (self.composer_active() && !self.composer_editing_locked())
                .then_some(&mut self.draft),
            Editor::Reason(id) => self.agent.as_mut().and_then(|a| a.reasons.get_mut(&id)),
            Editor::Form(id) => self
                .agent
                .as_mut()
                .filter(|a| !a.forms_mutating())
                .and_then(|a| a.drafts.get_mut(&id))
                .map(|d| d.editor()),
            Editor::Custom(id) => self
                .agent
                .as_mut()
                .filter(|a| !a.forms_mutating())
                .and_then(|a| {
                    a.reconcile_custom_focus();
                    a.drafts
                        .get_mut(&id)
                        .filter(|d| !d.oversized_multiselect_default)
                        .map(|d| {
                            d.custom_was_focused = true;
                            d.custom_editor()
                        })
                }),
        };
        edit.unwrap_or(&mut self.rejected_edit)
    }
}
