use super::Images;
use crate::{settings::providers::attach_picker_keys, strings::t};
use codenomad_client::settings::images::{self, GenerationSelection, Mutation};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

fn generation_label(
    selection: &GenerationSelection,
    models: Option<&[images::ModelOption]>,
) -> String {
    match selection {
        GenerationSelection::Off => t("settings.images.generation.off").to_owned(),
        GenerationSelection::Auto => t("settings.images.generation.auto").to_owned(),
        GenerationSelection::Model(model_ref) => models
            .and_then(|list| list.iter().find(|m| m.model_ref == *model_ref))
            .map(|m| m.name.clone())
            .unwrap_or_else(|| model_ref.clone()),
    }
}

fn generation_options(
    generation: &images::GenerationSettings,
) -> Vec<(GenerationSelection, String, String)> {
    let mut options = vec![
        (
            GenerationSelection::Off,
            t("settings.images.generation.off").to_owned(),
            "off".to_owned(),
        ),
        (
            GenerationSelection::Auto,
            t("settings.images.generation.auto").to_owned(),
            "auto".to_owned(),
        ),
    ];
    if let Some(list) = generation.models.as_deref() {
        for model in list {
            options.push((
                GenerationSelection::Model(model.model_ref.clone()),
                model.name.clone(),
                format!("model-{}", model.model_ref),
            ));
        }
    }
    if let GenerationSelection::Model(saved) = &generation.global
        && !generation
            .models
            .as_deref()
            .is_some_and(|list| list.iter().any(|m| m.model_ref == *saved))
    {
        options.push((
            GenerationSelection::Model(saved.clone()),
            saved.clone(),
            format!("model-{saved}"),
        ));
    }
    options
}

pub(in crate::settings::providers) fn view<S: 'static>(
    state_rc: &Rc<RefCell<Images>>,
    available: bool,
) -> El {
    let state = state_rc.borrow();
    let expanded = state.expanded;
    let busy = state.busy();
    let mut body = col().full_width().separate(Space::Sm);

    if expanded {
        if !available {
            body = body
                .child(chrome::empty_box(t("settings.providers.empty.noInstance")).role("status"));
        } else {
            if state.error {
                let refresh_rc = state_rc.clone();
                body = body.child(
                    layout::action_row()
                        .child(text(t("settings.images.error")).wrap().role("alert"))
                        .child(
                            chrome::secondary_action(
                                t("settings.providers.refresh"),
                                busy,
                                move |_: &mut S| {
                                    refresh_rc.borrow_mut().request_refresh();
                                },
                            )
                            .key("images-refresh"),
                        ),
                );
            }
            if state.snapshot.is_none() && !state.unsupported && busy {
                body = body.child(
                    col()
                        .full_width()
                        .pad(Space::Sm)
                        .inset_surface()
                        .role("status")
                        .key("images-loading")
                        .child(
                            text(t("settings.providers.loading"))
                                .wrap()
                                .text_role(TextRole::Small),
                        ),
                );
            }
            if state.unsupported {
                body =
                    body.child(chrome::empty_box(t("settings.images.unsupported")).role("status"));
            }
            if let Some(snapshot) = &state.snapshot {
                let blocked = snapshot.blocked_by.is_some();
                let disabled = state.mutations_disabled() || blocked;
                if snapshot.generation.is_none() && snapshot.media_storage.is_none() {
                    body = body
                        .child(chrome::empty_box(t("settings.images.unsupported")).role("status"));
                }
                if let Some(blocked_by) = &snapshot.blocked_by {
                    let mut note = text(t("settings.images.blocked"))
                        .wrap()
                        .text_role(TextRole::Small);
                    if let Some(path) = &blocked_by.path {
                        note = note.help(path).description(path);
                    }
                    body = body.child(note);
                }
                if let Some(generation) = &snapshot.generation {
                    body = body.child(generation_section::<S>(
                        &state, generation, state_rc, disabled,
                    ));
                }
                if let Some(storage) = &snapshot.media_storage {
                    body = body.child(media_storage_section::<S>(
                        &state, storage, state_rc, disabled,
                    ));
                }
            }
        }
    }
    drop(state);

    let toggle_rc = state_rc.clone();
    chrome::card(chrome::disclosure(
        t("settings.images.title"),
        expanded,
        body,
        move |_: &mut S| toggle_rc.borrow_mut().toggle(),
    ))
}

fn generation_section<S: 'static>(
    state: &Images,
    generation: &images::GenerationSettings,
    state_rc: &Rc<RefCell<Images>>,
    disabled: bool,
) -> El {
    let models = generation.models.as_deref();
    let current = generation_label(&generation.global, models);
    let options = generation_options(generation);
    let first_focus = options
        .iter()
        .find(|(choice, _, _)| *choice == generation.global)
        .or_else(|| options.first())
        .map(|(_, _, suffix)| format!("images-generation-{suffix}"));

    let info_rc = state_rc.clone();
    let info = chrome::info_tip(
        t("settings.images.generation.title"),
        t("settings.images.generation.info"),
        state.generation_info_open,
        move |_: &mut S| {
            let mut img = info_rc.borrow_mut();
            img.generation_info_open = !img.generation_info_open;
        },
    )
    .key("images-generation-info");

    let trigger_rc = state_rc.clone();
    let trigger = layout::button_tx(&current, disabled, move |_: &mut S, tx| {
        let mut img = trigger_rc.borrow_mut();
        if img.generation_picker_open {
            img.generation_picker_open = false;
        } else {
            img.generation_picker_open = true;
            if let Some(key) = &first_focus {
                tx.focus(key.clone(), true);
            }
        }
    })
    .label(format!(
        "{}: {current}",
        t("settings.images.generation.title")
    ))
    .expanded(state.generation_picker_open)
    .key("images-generation-picker");

    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .child(chrome::setting_row_with_info(
            t("settings.images.generation.title"),
            Some(info),
            trigger,
        ));

    if state.generation_picker_open && !disabled {
        let mut option_keys = Vec::with_capacity(options.len());
        let mut list = col()
            .full_width()
            .separate(Space::Xs)
            .role("listbox")
            .label(t("settings.images.generation.title"));
        for (choice, label, suffix) in options {
            let selected = generation.global == choice;
            let opt_key = format!("images-generation-{suffix}");
            option_keys.push(opt_key.clone());
            let save_rc = state_rc.clone();
            list = list.child(
                layout::button_tx(&label, false, move |_: &mut S, tx| {
                    if selected {
                        save_rc.borrow_mut().generation_picker_open = false;
                    } else {
                        save_rc
                            .borrow_mut()
                            .save(Mutation::Generation(choice.clone()));
                    }
                    tx.focus("images-generation-picker", true);
                })
                .role("option")
                .checked(selected)
                .focus_selected(selected)
                .key(opt_key),
            );
        }
        let close_rc = state_rc.clone();
        let esc_rc = state_rc.clone();
        section = section
            .child(attach_picker_keys(
                list,
                "images-generation-picker".into(),
                option_keys,
                move |_: &mut S| close_rc.borrow_mut().generation_picker_open = false,
            ))
            .on_key(move |_: &mut S, event, tx| {
                if event.key == rune::Key::Escape && event.mods == rune::Mods::default() {
                    esc_rc.borrow_mut().generation_picker_open = false;
                    tx.focus("images-generation-picker", true);
                    return true;
                }
                false
            });
    }

    if let Some(overridden) = &generation.overridden {
        let effective = generation_label(&generation.effective, models);
        let mut note =
            text(t("settings.images.generation.override").replace("{value}", &effective))
                .wrap()
                .text_role(TextRole::Small);
        if let Some(path) = &overridden.path {
            note = note.help(path).description(path);
        }
        section = section.child(note);
    }
    if generation.models.is_none() {
        section = section.child(
            text(t("settings.images.generation.modelsUnavailable"))
                .wrap()
                .text_role(TextRole::Small),
        );
    } else if generation.effective != GenerationSelection::Off
        && generation.models.as_ref().is_some_and(Vec::is_empty)
    {
        section = section.child(
            text(t("settings.images.generation.noModels"))
                .wrap()
                .text_role(TextRole::Small),
        );
    }
    section
}

fn media_storage_section<S: 'static>(
    state: &Images,
    storage: &images::MediaStorageSettings,
    state_rc: &Rc<RefCell<Images>>,
    disabled: bool,
) -> El {
    let checked = if storage.project_path.is_some() {
        storage.effective
    } else {
        storage.global
    };
    let next = !checked;
    let info_rc = state_rc.clone();
    let info = chrome::info_tip(
        t("settings.images.storage.title"),
        t("settings.images.storage.info"),
        state.storage_info_open,
        move |_: &mut S| {
            let mut img = info_rc.borrow_mut();
            img.storage_info_open = !img.storage_info_open;
        },
    )
    .key("images-storage-info");

    let save_rc = state_rc.clone();
    let switch = chrome::setting_switch(
        t("settings.images.storage.title"),
        checked,
        disabled,
        move |_: &mut S| {
            save_rc.borrow_mut().save(Mutation::MediaStorage(next));
        },
    )
    .key("images-storage-switch");

    let mut section = col()
        .full_width()
        .separate(Space::Xs)
        .child(chrome::setting_row_with_info(
            t("settings.images.storage.title"),
            Some(info),
            switch,
        ));

    if let Some(overridden) = &storage.overridden {
        let key = if storage.effective {
            "settings.images.storage.override.on"
        } else {
            "settings.images.storage.override.off"
        };
        let mut note = text(t(key)).wrap().text_role(TextRole::Small);
        if let Some(path) = &overridden.path {
            note = note.help(path).description(path);
        }
        section = section.child(note);
    }
    section
}
