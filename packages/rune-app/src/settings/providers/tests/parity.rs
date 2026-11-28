use super::super::*;
use codenomad_client::settings::{
    images as client_images,
    provider_auth::{
        AccountSelection, AuthMethod, CatalogSnapshot, Connection, FieldOption, FormField,
        FormFieldKind, ListedProvider, OAuthAttempt, OAuthMode, ProviderSource,
    },
    websearch as client_websearch,
};
use rune::{Autofill, Env, InputMode, Runtime, TextEdit, col};
use rune_theme_codenomad::{
    TextRole, field_kit, kit,
    layout::{self, Layout},
    tokens,
};
use std::collections::BTreeMap;

struct ViewHarness {
    catalog: Catalog,
    available: bool,
}

fn render_harness(h: &ViewHarness, cx: &mut rune::Cx<ViewHarness>) -> El {
    crate::strings::with_locale("en", || {
        layout::with_source_palette(|| {
            layout::render(cx, |_| {
                let mut layers = Vec::new();
                let body = render_groups(
                    &h.catalog,
                    h.available,
                    &mut layers,
                    |h: &mut ViewHarness| &mut h.catalog,
                    #[cfg(not(target_arch = "wasm32"))]
                    Some(&h.catalog.websearch_key),
                    #[cfg(not(target_arch = "wasm32"))]
                    Some(|h: &mut ViewHarness| &mut h.catalog.websearch_key),
                    #[cfg(target_arch = "wasm32")]
                    None,
                    #[cfg(target_arch = "wasm32")]
                    None,
                );
                col()
                    .full_width()
                    .full_height()
                    .child(body)
                    .children(layers)
            })
        })
    })
}

fn new_rt(harness: ViewHarness, dark: bool) -> Runtime<ViewHarness> {
    let mut rt = Runtime::new(harness, render_harness, (760.0, 960.0), Env::new(dark, 1.0));
    rt.frame(0.0);
    rt
}

fn sample_snapshot() -> CatalogSnapshot {
    let form_fields = vec![
        FormField {
            key: "base_url".into(),
            title: "Base URL".into(),
            description: Some("Custom API endpoint".into()),
            hidden: false,
            when: Vec::new(),
            kind: FormFieldKind::String {
                required: true,
                placeholder: Some("https://api.example.test/v1".into()),
                default: Some("https://api.example.test/v1".into()),
                format: Some("uri".into()),
                pattern: None,
                min_length: None,
                max_length: None,
                options: Vec::new(),
                custom: false,
            },
        },
        FormField {
            key: "proxy_secret".into(),
            title: "Proxy secret".into(),
            description: None,
            hidden: false,
            when: Vec::new(),
            kind: FormFieldKind::String {
                required: false,
                placeholder: Some("Enter proxy secret".into()),
                default: Some("s3cr3t-value".into()),
                format: Some("password".into()),
                pattern: None,
                min_length: None,
                max_length: None,
                options: Vec::new(),
                custom: false,
            },
        },
        FormField {
            key: "port".into(),
            title: "Port".into(),
            description: None,
            hidden: false,
            when: Vec::new(),
            kind: FormFieldKind::Number {
                integer: true,
                required: false,
                default: Some(443.0),
                min: Some(1.0),
                max: Some(65535.0),
            },
        },
        FormField {
            key: "temperature".into(),
            title: "Scale".into(),
            description: None,
            hidden: false,
            when: Vec::new(),
            kind: FormFieldKind::Number {
                integer: false,
                required: false,
                default: Some(0.5),
                min: None,
                max: None,
            },
        },
        FormField {
            key: "models".into(),
            title: "Models".into(),
            description: None,
            hidden: false,
            when: Vec::new(),
            kind: FormFieldKind::Multiselect {
                required: false,
                default: None,
                min_items: None,
                max_items: None,
                options: vec![FieldOption {
                    value: "gpt-4o".into(),
                    label: "GPT-4o".into(),
                    description: None,
                }],
                custom: true,
            },
        },
    ];

    CatalogSnapshot {
        directory: "/repo/a".into(),
        providers: vec![
            ListedProvider {
                id: "acme".into(),
                name: "Acme".into(),
                model_count: 2,
                source: ProviderSource::Unknown,
                can_connect: true,
                methods: vec![
                    AuthMethod::Key {
                        label: Some("API key".into()),
                        form: form_fields,
                    },
                    AuthMethod::Command {
                        id: "cli".into(),
                        label: "CLI".into(),
                        command: vec!["acme".into(), "auth".into(), "login".into()],
                    },
                    AuthMethod::OAuth {
                        id: "oauth".into(),
                        label: "OAuth".into(),
                        form: Vec::new(),
                    },
                ],
                connections: Vec::new(),
                account_selection: AccountSelection::default(),
            },
            ListedProvider {
                id: "openai".into(),
                name: "OpenAI".into(),
                model_count: 3,
                source: ProviderSource::Api,
                can_connect: true,
                methods: vec![AuthMethod::Key {
                    label: Some("API key".into()),
                    form: Vec::new(),
                }],
                connections: vec![
                    Connection::Credential {
                        id: "cred_1".into(),
                        label: "Work".into(),
                        method: "key".into(),
                        needs_auth: None,
                    },
                    Connection::Credential {
                        id: "cred_2".into(),
                        label: "Personal".into(),
                        method: "key".into(),
                        needs_auth: None,
                    },
                ],
                account_selection: AccountSelection {
                    supported: true,
                    enabled: true,
                    logins: BTreeMap::new(),
                },
            },
        ],
    }
}

#[test]
fn provider_input_modes_and_autofill_contracts_cover_every_field_kind() {
    // Search & static fields
    assert_eq!(manager::SEARCH_INPUT_MODE, InputMode::Search);
    assert_eq!(manager::SEARCH_INPUT_MODE.as_html(), "search");
    assert_eq!(manager::SEARCH_AUTOFILL, Autofill::Off);
    assert_eq!(manager::SEARCH_AUTOFILL.as_html(), "off");

    assert_eq!(modal::API_KEY_AUTOFILL, Autofill::Off);
    assert_eq!(modal::OAUTH_CODE_AUTOFILL, Autofill::OneTimeCode);
    assert_eq!(modal::OAUTH_CODE_AUTOFILL.as_html(), "one-time-code");
    assert_eq!(websearch::API_KEY_AUTOFILL, Autofill::Off);
    assert_eq!(accounts::RENAME_AUTOFILL, Autofill::Off);
    assert_eq!(form::CUSTOM_VALUES_AUTOFILL, Autofill::Off);

    // Dynamic form String fields: explicit formats
    assert_eq!(
        form::string_field_semantics("custom", Some("uri"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Url,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("custom", Some("URL"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Url,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("account", Some("email"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Email,
            autofill: Autofill::Email,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("phone", Some("tel"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Tel,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("filter", Some("search"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Search,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("token", Some("password"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Text,
            autofill: Autofill::Off,
            secure: true,
        }
    );
    assert_eq!(
        form::string_field_semantics("client_secret", Some("secret"), None),
        form::StringFieldSemantics {
            input_mode: InputMode::Text,
            autofill: Autofill::Off,
            secure: true,
        }
    );

    // Dynamic form String fields: unformatted endpoint/URL heuristics & technical identifiers
    assert_eq!(
        form::string_field_semantics("endpoint", None, None),
        form::StringFieldSemantics {
            input_mode: InputMode::Url,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("baseUrl", None, None),
        form::StringFieldSemantics {
            input_mode: InputMode::Url,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("host", None, Some("https://gateway.example.test/v1")),
        form::StringFieldSemantics {
            input_mode: InputMode::Url,
            autofill: Autofill::Off,
            secure: false,
        }
    );
    assert_eq!(
        form::string_field_semantics("deployment_id", None, Some("my-model-deployment")),
        form::StringFieldSemantics {
            input_mode: InputMode::Text,
            autofill: Autofill::Off,
            secure: false,
        }
    );

    // Dynamic form Number fields: integer vs decimal
    assert_eq!(
        form::number_field_semantics(true),
        (InputMode::Numeric, Autofill::Off)
    );
    assert_eq!(
        form::number_field_semantics(false),
        (InputMode::Decimal, Autofill::Off)
    );
}

#[test]
fn providers_surfaces_corners_secure_forms_and_inset_cards_match_solid_parity() {
    for dark in [true, false] {
        let field_bg = layout::with_source_palette(|| field_kit(dark).c.bg_base);
        let inset_bg = layout::with_source_palette(|| kit(dark).c.bg_deep);
        let overlay_bg = layout::with_source_palette(|| kit(dark).c.layer_02);
        let small_line =
            layout::with_source_palette(|| tokens(dark).text(TextRole::Small).line_px());
        let mono_line = layout::with_source_palette(|| tokens(dark).text(TextRole::Mono).line_px());

        // 1. Models section + account rename + dynamic form fields (URI, password, integer, decimal, custom)
        let mut catalog = Catalog::default();
        catalog.manager.snapshot = Some(sample_snapshot());
        catalog.manager.start_rename("openai", "cred_1", "Work");
        let mut rt = new_rt(
            ViewHarness {
                catalog,
                available: true,
            },
            dark,
        );

        let elements = rt.elements();
        for key in ["providers-search", "provider-account-rename-input-openai"] {
            let box_el = elements
                .iter()
                .find(|el| el.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing element key {key}"));
            assert_eq!(
                box_el.fill, field_bg,
                "{key} must use surface-field (dark={dark})"
            );
            assert_eq!(box_el.radius, 0.0, "{key} must have square corners");
        }
        let provider_card = elements
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-openai"))
            .expect("missing provider-openai");
        assert_eq!(provider_card.radius, 0.0, "provider card must stay square");

        // Open connect modal for Acme -> API key + dynamic form
        rt.update(|h, tx| {
            h.catalog
                .manager
                .open_connect_modal("acme".into(), None, tx);
        });
        rt.frame(0.02);
        let modal_els = rt.elements();
        let dialog = modal_els
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-auth-dialog"))
            .expect("missing provider-auth-dialog");
        assert_eq!(
            dialog.fill, overlay_bg,
            "connect modal must use surface-overlay"
        );
        assert_eq!(dialog.radius, 0.0, "connect modal must have square corners");

        for key in [
            "provider-auth-apikey",
            "provider-form-text-base_url",
            "provider-form-text-proxy_secret",
            "provider-form-num-port",
            "provider-form-num-temperature",
            "provider-form-custom-models",
        ] {
            let field = modal_els
                .iter()
                .find(|el| el.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing element key {key}"));
            assert_eq!(field.fill, field_bg, "{key} must use surface-field");
            assert_eq!(field.radius, 0.0, "{key} must have square corners");
        }
        // Password-formatted dynamic form field must mask its text, while URI field stays readable.
        let secret_textbox = modal_els
            .iter()
            .find(|el| {
                el.key.as_deref() == Some("input")
                    && el.path.contains("/provider-form-text-proxy_secret/")
            })
            .expect("missing proxy_secret inner text_input");
        assert_eq!(
            secret_textbox.text, None,
            "password-formatted form field must be secure and hide text"
        );
        let uri_textbox = modal_els
            .iter()
            .find(|el| {
                el.key.as_deref() == Some("input")
                    && el.path.contains("/provider-form-text-base_url/")
            })
            .expect("missing base_url inner text_input");
        assert_eq!(
            uri_textbox.text.as_deref(),
            Some("https://api.example.test/v1"),
            "URI-formatted form field must remain readable"
        );

        // 2. Command method preview uses inset surface + square corners + monospace + help tooltip
        rt.update(|h, _| h.catalog.manager.select_method(1));
        rt.frame(0.04);
        let cmd_els = rt.elements();
        let preview = cmd_els
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-auth-command-preview"))
            .expect("missing provider-auth-command-preview");
        assert_eq!(
            preview.fill, inset_bg,
            "command preview must use surface-inset"
        );
        assert_eq!(
            preview.radius, 0.0,
            "command preview must have square corners"
        );
        assert!(
            preview.help.as_deref().is_some_and(|h| !h.is_empty()),
            "command preview must keep description tooltip"
        );
        let preview_text = cmd_els
            .iter()
            .find(|el| {
                el.path.contains("/provider-auth-command-preview/")
                    && el.text.as_deref() == Some("acme auth login")
            })
            .expect("command preview monospace text");
        assert_eq!(
            preview_text.text_style.as_ref().map(|s| s.line_height),
            Some(mono_line),
            "command preview must render with TextRole::Mono"
        );

        // 3. OAuth Code stage -> inset instructions card + surface-field code input
        rt.update(|h, _| {
            h.catalog.manager.select_method(2);
            let flow = h.catalog.manager.connect.as_mut().unwrap();
            flow.stage = manager::AuthStage::Code;
            flow.oauth = Some(OAuthAttempt {
                attempt_id: "att_1".into(),
                url: "https://auth.example.test/authorize".into(),
                instructions: "Finish sign-in and paste code.".into(),
                mode: OAuthMode::Code,
            });
        });
        rt.frame(0.06);
        let code_els = rt.elements();
        let instr = code_els
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-auth-oauth-instructions"))
            .expect("missing provider-auth-oauth-instructions");
        assert_eq!(instr.role, "status");
        assert_eq!(
            instr.fill, inset_bg,
            "OAuth instructions must use surface-inset"
        );
        assert_eq!(instr.radius, 0.0);
        let code_field = code_els
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-auth-oauth-code"))
            .expect("missing provider-auth-oauth-code");
        assert_eq!(code_field.fill, field_bg);
        assert_eq!(code_field.radius, 0.0);

        // 4. Waiting stage -> inset status card with small detail caption
        rt.update(|h, _| {
            let flow = h.catalog.manager.connect.as_mut().unwrap();
            flow.stage = manager::AuthStage::Waiting;
        });
        rt.frame(0.08);
        let wait_els = rt.elements();
        let wait_card = wait_els
            .iter()
            .find(|el| el.key.as_deref() == Some("provider-auth-waiting-card"))
            .expect("missing provider-auth-waiting-card");
        assert_eq!(wait_card.role, "status");
        assert_eq!(
            wait_card.fill, inset_bg,
            "waiting card must use surface-inset"
        );
        assert_eq!(wait_card.radius, 0.0);
        let wait_detail = wait_els
            .iter()
            .find(|el| {
                el.path.contains("/provider-auth-waiting-card/")
                    && el.text.as_deref() == Some("Finish sign-in and paste code.")
            })
            .expect("waiting card detail text");
        assert_eq!(
            wait_detail.text_style.as_ref().map(|s| s.line_height),
            Some(small_line),
            "waiting detail must use TextRole::Small"
        );

        // 5. Loading states across Models, Web search, and Images use inset status cards
        let mut loading_catalog = Catalog::default();
        loading_catalog.manager.set_loading_for_test(true);
        loading_catalog
            .websearch
            .borrow_mut()
            .seed_for_view_test(true, None, "", true);
        loading_catalog
            .images
            .borrow_mut()
            .seed_for_view_test(true, None, true);
        let loading_rt = new_rt(
            ViewHarness {
                catalog: loading_catalog,
                available: true,
            },
            dark,
        );
        let loading_els = loading_rt.elements();
        for key in ["providers-loading", "websearch-loading", "images-loading"] {
            let card = loading_els
                .iter()
                .find(|el| el.key.as_deref() == Some(key))
                .unwrap_or_else(|| panic!("missing element key {key}"));
            assert_eq!(card.role, "status", "{key} must expose status role");
            assert_eq!(card.fill, inset_bg, "{key} must use surface-inset");
            assert_eq!(card.radius, 0.0, "{key} must have square corners");
        }

        // 6. Web search connect panel API key field + configured metadata & Images override captions
        let mut ws_img_catalog = Catalog::default();
        ws_img_catalog.manager.expanded = false;
        #[cfg(not(target_arch = "wasm32"))]
        {
            ws_img_catalog.websearch_key = TextEdit::new("secret-search-key");
        }
        ws_img_catalog.websearch.borrow_mut().seed_for_view_test(
            true,
            Some(client_websearch::Snapshot {
                directory: "/repo/a".into(),
                catalog_available: true,
                providers: vec![client_websearch::SearchProvider {
                    id: "tavily".into(),
                    name: "Tavily".into(),
                }],
                integrations: vec![client_websearch::SearchIntegration {
                    id: "tavily".into(),
                    name: "Tavily".into(),
                    supports_key: true,
                    connections: vec![client_websearch::SearchConnection::Credential {
                        id: "ws_1".into(),
                        label: "Default".into(),
                    }],
                }],
                defaults: Some(client_websearch::DefaultsSnapshot {
                    effective: client_websearch::Selection::Provider("tavily".into()),
                    scopes: Vec::new(),
                }),
            }),
            "tavily",
            false,
        );
        ws_img_catalog.images.borrow_mut().seed_for_view_test(
            true,
            Some(client_images::Snapshot {
                directory: "/repo/a".into(),
                generation: Some(client_images::GenerationSettings {
                    global: client_images::GenerationSelection::Auto,
                    effective: client_images::GenerationSelection::Off,
                    overridden: Some(client_images::SettingOverride {
                        path: Some("/repo/a/opencode.jsonc".into()),
                    }),
                    models: Some(Vec::new()),
                }),
                media_storage: None,
                blocked_by: None,
            }),
            false,
        );
        let ws_img_rt = new_rt(
            ViewHarness {
                catalog: ws_img_catalog,
                available: true,
            },
            dark,
        );
        let ws_img_els = ws_img_rt.elements();
        #[cfg(not(target_arch = "wasm32"))]
        {
            let ws_key = ws_img_els
                .iter()
                .find(|el| el.key.as_deref() == Some("websearch-api-key"))
                .expect("missing websearch-api-key");
            assert_eq!(
                ws_key.fill, field_bg,
                "websearch-api-key must use surface-field"
            );
            assert_eq!(
                ws_key.radius, 0.0,
                "websearch-api-key must have square corners"
            );
            let ws_textbox = ws_img_els
                .iter()
                .find(|el| {
                    el.key.as_deref() == Some("input") && el.path.contains("/websearch-api-key/")
                })
                .expect("missing websearch-api-key inner text_input");
            assert_eq!(
                ws_textbox.text, None,
                "websearch-api-key must be secure and hide text"
            );
        }
        let ws_meta = ws_img_els
            .iter()
            .find(|el| {
                el.path.contains("/websearch-configured-tavily/")
                    && el.text.as_deref() == Some("tavily • Default")
            })
            .expect("websearch configured card metadata");
        assert_eq!(
            ws_meta.text_style.as_ref().map(|s| s.line_height),
            Some(small_line),
            "websearch card metadata must use TextRole::Small"
        );
        let override_caption = ws_img_els
            .iter()
            .find(|el| {
                el.text
                    .as_deref()
                    .is_some_and(|txt| txt.contains("Another OpenCode configuration"))
            })
            .expect("images override caption");
        assert_eq!(
            override_caption.text_style.as_ref().map(|s| s.line_height),
            Some(small_line),
            "images override caption must use TextRole::Small"
        );
    }
}
