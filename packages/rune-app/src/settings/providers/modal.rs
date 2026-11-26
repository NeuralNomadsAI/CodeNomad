//! Modal Connect dialog for API key, OAuth (auto/code), command, and external provider auth flows.
use super::{
    Catalog, form,
    manager::{AuthStage, PickerId},
};
use crate::strings::t;
use codenomad_client::settings::provider_auth::{AuthMethod, is_http_url};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, field_kit,
    layout::{self, Layout},
    settings as chrome,
};

pub(super) fn view<S: 'static>(
    catalog: &Catalog,
    layers: &mut Vec<El>,
    access: fn(&mut S) -> &mut Catalog,
) {
    let mgr = &catalog.manager;
    let Some(flow) = &mgr.connect else {
        return;
    };
    let provider_name = mgr.provider_name(&flow.provider_id);
    let title = t("settings.providers.auth.title").replace("{provider}", &provider_name);
    let methods = &flow.methods;
    let method = flow.selected_method().cloned().unwrap_or(AuthMethod::Key {
        label: None,
        form: Vec::new(),
    });

    let mut modal_pickers = Vec::new();
    let mut body = col().full_width().separate(Space::Sm);

    if let Some(err) = &flow.error {
        body = body.child(text(err.as_str()).wrap().role("alert"));
    }

    if methods.len() > 1 {
        let raw_method_labels: Vec<String> = methods
            .iter()
            .map(|m| {
                m.display_label(
                    t("settings.providers.method.api"),
                    t("settings.providers.method.oauth"),
                )
                .to_owned()
            })
            .collect();
        let owned_labels = super::manager::unique_labels(&raw_method_labels);
        let method_labels: Vec<&str> = owned_labels.iter().map(String::as_str).collect();
        let current = method_labels
            .get(flow.method_index)
            .copied()
            .or_else(|| method_labels.first().copied());
        let method_disabled = !matches!(flow.stage, AuthStage::Prompts | AuthStage::Error);
        let control = chrome::picker(
            "provider-auth-method",
            t("settings.providers.method.title"),
            &method_labels,
        )
        .current(current)
        .disabled(method_disabled)
        .open(mgr.open_picker == Some(PickerId::AuthMethod))
        .on_toggle(move |s: &mut S| access(s).manager.toggle_picker(PickerId::AuthMethod))
        .on_close(move |s: &mut S| access(s).manager.close_picker())
        .on_choose(move |s: &mut S, chosen, _| {
            let mgr = &mut access(s).manager;
            if mgr.open_picker == Some(PickerId::AuthMethod) {
                mgr.close_picker();
                if let Some(index) = owned_labels.iter().position(|lbl| lbl == chosen) {
                    mgr.select_method(index);
                }
            }
        });
        body = body.child(chrome::setting_row(
            t("settings.providers.method.title"),
            chrome::build_picker(control, &mut modal_pickers),
        ));
    }

    let prompts_disabled = !matches!(flow.stage, AuthStage::Prompts | AuthStage::Error);

    if matches!(
        flow.stage,
        AuthStage::Prompts | AuthStage::Error | AuthStage::Authorizing
    ) {
        match &method {
            AuthMethod::Key { .. } => {
                let input =
                    layout::hinted_field(&flow.api_key, t("settings.providers.apiKey.placeholder"))
                        .label(t("settings.providers.apiKey.label"))
                        .secure()
                        .disabled(prompts_disabled)
                        .on_edit(move |s: &mut S| access(s).manager.connect_api_key_mut())
                        .on_submit(move |s: &mut S, _| {
                            access(s).manager.request_submit_auth();
                        })
                        .build(&field_kit(layout::dark()))
                        .literal_direction()
                        .key("provider-auth-apikey");
                body = body
                    .child(text(t("settings.providers.apiKey.label")).text_role(TextRole::Label))
                    .child(input);
            }
            AuthMethod::Command { command, .. } => {
                let preview = command.join(" ");
                body = body.child(
                    text(preview)
                        .wrap_anywhere()
                        .literal_direction()
                        .help(t("settings.providers.command.description"))
                        .key("provider-auth-command-preview"),
                );
            }
            AuthMethod::OAuth { .. } | AuthMethod::External { .. } => {}
        }

        let form_fields = method.form();
        if !form_fields.is_empty() {
            let effective = form::effective_answers(
                form_fields,
                &flow.form_answers,
                &flow.form_edits,
                &flow.form_touched,
            );
            body = body.child(form::view(
                catalog,
                form_fields,
                &effective,
                prompts_disabled,
                &mut modal_pickers,
                access,
            ));
        }
    }

    if flow.stage == AuthStage::Code {
        let instructions = flow
            .oauth
            .as_ref()
            .map(|a| a.instructions.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| t("settings.providers.oauth.enterCode"));
        body = body.child(text(instructions).wrap().role("status"));
        if let Some(auth) = &flow.oauth
            && is_http_url(&auth.url)
        {
            body = body.child(oauth_link_actions(
                &auth.url,
                flow.link_copied,
                flow.launch_blocked,
                access,
            ));
        }
        let code_input = layout::hinted_field(
            &flow.oauth_code,
            t("settings.providers.oauth.codePlaceholder"),
        )
        .label(t("settings.providers.oauth.codeLabel"))
        .on_edit(move |s: &mut S| access(s).manager.connect_oauth_code_mut())
        .on_submit(move |s: &mut S, _| {
            access(s).manager.request_submit_oauth_code();
        })
        .build(&field_kit(layout::dark()))
        .literal_direction()
        .autofocus()
        .key("provider-auth-oauth-code");
        body = body
            .child(text(t("settings.providers.oauth.codeLabel")).text_role(TextRole::Label))
            .child(code_input);
    }

    if flow.stage == AuthStage::Waiting {
        let is_command = matches!(method, AuthMethod::Command { .. });
        let wait_title = if is_command {
            t("settings.providers.command.waitingTitle")
        } else {
            t("settings.providers.oauth.waitingTitle")
        };
        let wait_detail = if is_command {
            flow.command_status
                .as_deref()
                .unwrap_or_else(|| t("settings.providers.command.waitingMessage"))
        } else {
            flow.oauth
                .as_ref()
                .map(|a| a.instructions.as_str())
                .unwrap_or("")
        };
        let mut wait_box = col()
            .full_width()
            .separate(Space::Xs)
            .role("status")
            .child(text(wait_title).text_role(TextRole::Button));
        if !wait_detail.is_empty() {
            wait_box = wait_box.child(text(wait_detail).wrap());
        }
        body = body.child(wait_box);
        if let Some(auth) = &flow.oauth
            && is_http_url(&auth.url)
        {
            body = body.child(oauth_link_actions(
                &auth.url,
                flow.link_copied,
                flow.launch_blocked,
                access,
            ));
        }
    }

    let footer = match flow.stage {
        AuthStage::Code => layout::action_row()
            .child(
                chrome::primary_action(
                    t("settings.providers.oauth.submitCode"),
                    flow.oauth_code.text.trim().is_empty(),
                    move |s: &mut S| access(s).manager.request_submit_oauth_code(),
                )
                .key("provider-auth-submit-code"),
            )
            .child(
                layout::button(
                    t("settings.providers.oauth.cancelWait"),
                    false,
                    move |s: &mut S| access(s).manager.cancel_active_attempt(),
                )
                .key("provider-auth-cancel-wait"),
            ),
        AuthStage::Waiting => layout::action_row().child(
            layout::button(
                t("settings.providers.oauth.cancelWait"),
                false,
                move |s: &mut S| access(s).manager.cancel_active_attempt(),
            )
            .key("provider-auth-cancel-wait"),
        ),
        AuthStage::Prompts | AuthStage::Error | AuthStage::Authorizing => {
            let label = if flow.stage == AuthStage::Authorizing {
                t("settings.providers.actions.working")
            } else {
                t("settings.providers.actions.continue")
            };
            layout::action_row().child(
                chrome::primary_action(label, !mgr.can_submit_auth(), move |s: &mut S| {
                    access(s).manager.request_submit_auth();
                })
                .key("provider-auth-continue"),
            )
        }
    };
    body = body.child(footer);

    let close_btn = layout::button_tx(
        t("settings.providers.actions.close"),
        false,
        move |s: &mut S, tx| {
            access(s).manager.close_connect_modal(tx);
        },
    )
    .label(t("settings.providers.actions.close"))
    .key("provider-auth-close");

    let dialog = chrome::modal_dialog(
        "provider-auth-dialog",
        &title,
        close_btn,
        body,
        flow.return_focus.as_deref(),
        move |s: &mut S, tx| {
            access(s).manager.close_connect_modal(tx);
        },
    );
    layers.push(dialog);
    layers.extend(modal_pickers);
}

fn oauth_link_actions<S: 'static>(
    url: &str,
    copied: bool,
    blocked: bool,
    access: fn(&mut S) -> &mut Catalog,
) -> El {
    let open_url = url.to_owned();
    let copy_url = url.to_owned();
    let copy_label = if copied {
        t("settings.providers.oauth.linkCopied")
    } else {
        t("settings.providers.oauth.copyLink")
    };
    let mut box_el = col().full_width().separate(Space::Xs).child(
        layout::action_row()
            .child(
                layout::button_tx(
                    t("settings.providers.oauth.openPage"),
                    false,
                    move |s: &mut S, tx| {
                        access(s).manager.open_oauth_url(&open_url, tx, access);
                    },
                )
                .key("provider-auth-open-url"),
            )
            .child(
                layout::button_tx(copy_label, false, move |s: &mut S, tx| {
                    access(s).manager.copy_oauth_link(&copy_url, tx);
                })
                .key("provider-auth-copy-url"),
            ),
    );
    if blocked {
        box_el = box_el.child(
            text(t("settings.providers.oauth.popupBlocked"))
                .wrap()
                .role("alert"),
        );
    }
    box_el
}
