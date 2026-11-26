use super::{Mode, Ui, changes::Id};
use crate::State;
use rune::{El, Tx};
use rune_theme_codenomad::{
    action_menu::{self, Item, Menu},
    catalogue, git_panel,
};
use std::rc::Rc;

fn state(s: &mut State) -> Option<&mut action_menu::State<State>> {
    s.git.owner.as_mut().map(|ui| &mut ui.menu)
}

pub(super) fn control(
    ui: &Ui,
    id: &Id,
    width: f32,
    name: &str,
    select: impl Fn(&mut State, &mut Tx) + 'static,
) -> (El, Option<El>) {
    let label = catalogue::format(
        crate::strings::locale(),
        "instanceShell.filesShell.actions.more",
        &[("name", &id.path)],
    );
    let key = id.action_key("menu");
    let mut item = Item::new("stage", name, select);
    item.disabled = !ui.can_change_index();
    item.select_before_close = true;
    let mut menu = Menu::new(&key, &label, vec![Rc::new(item)]);
    let id = id.clone();
    let scope = ui.scope.clone();
    menu.on_open_change = Some(Rc::new(move |s, open, _| {
        if let Some(ui) = s
            .git
            .owner
            .as_mut()
            .filter(|ui| Rc::ptr_eq(&scope, &ui.scope))
        {
            if open {
                ui.open_menu = Some(id.clone());
            } else if ui.open_menu.as_ref() == Some(&id) {
                ui.open_menu = None;
            }
        }
    }));
    action_menu::view(
        &ui.menu,
        state,
        Rc::new(menu),
        git_panel::overflow_trigger(&label),
        width,
    )
}

pub(super) fn clear(s: &mut State, tx: &mut Tx) {
    let open = s.git.owner.as_ref().and_then(|ui| ui.open_menu.clone());
    if let Some(id) = open {
        action_menu::clear(s, state, &id.action_key("menu"), tx);
        if let Some(ui) = &mut s.git.owner {
            ui.open_menu = None;
        }
    }
}

pub(super) fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let gone = s.git.owner.as_ref().and_then(|ui| {
        ui.open_menu
            .as_ref()
            .filter(|id| {
                !ui.active
                    || !ui.shown
                    || !ui.online
                    || ui.mode != Mode::Changes
                    || !ui.changes.open[super::changes::index(id.section)]
                    || !ui.changes.visible(id.section).any(|row| row.id == **id)
            })
            .cloned()
    });
    if let Some(id) = gone {
        action_menu::clear(s, state, &id.action_key("menu"), tx);
        if let Some(ui) = &mut s.git.owner {
            ui.open_menu = None;
        }
    }
    action_menu::poll(s, state, tx)
}
