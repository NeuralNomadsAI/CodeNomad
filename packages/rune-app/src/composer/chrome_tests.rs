use super::draft::Attachment;
use crate::{Message, Phase, State, strings::t, transport::Command};
use rune::{Env, Key, KeyEvent, Mods, Runtime, edit::TextEdit};
use rune_theme_codenomad::catalogue;
use serde_json::{Value, json};
use std::sync::Arc;

fn node<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| node(child, key))
}

fn rect(rt: &Runtime<State>, key: &str) -> [f32; 4] {
    rt.elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(key))
        .unwrap_or_else(|| panic!("missing element {key}"))
        .rect
}

fn help(rt: &Runtime<State>, key: &str) -> Option<String> {
    rt.elements()
        .into_iter()
        .find(|el| el.key.as_deref() == Some(key))
        .and_then(|el| el.help)
}

fn click(rt: &mut Runtime<State>, key: &str) {
    let (x, y) = rt.find(key).unwrap_or_else(|| panic!("missing {key}"));
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.02);
    rt.frame(0.02);
}

fn press_key(rt: &mut Runtime<State>, key: Key) {
    let event = KeyEvent {
        key,
        mods: Mods::default(),
    };
    rt.key(event.clone());
    rt.key_up(event);
    rt.frame(0.02);
}

fn chat_runtime(size: (f32, f32)) -> (Runtime<State>, codenomad_client::Receiver<Command>) {
    let (sender, receiver) = codenomad_client::bounded(8);
    let mut s = crate::init();
    s.phase = Phase::Ready;
    s.commands = Some(sender);
    s.composer.picker.set_attachments_supported(true);
    let mut rt = Runtime::new(s, crate::view, size, Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);
    (rt, receiver)
}

#[test]
fn attachment_bar_sits_above_editor_with_compact_icon_remove_and_visible_details() {
    let (mut rt, _rx) = chat_runtime((960.0, 640.0));
    rt.update(|s, _| {
        s.draft = TextEdit::new("@src/main.rs @planner ");
        assert!(s.composer.draft.attach(Attachment::Project {
            name: "main.rs".into(),
            path: "src/main.rs".into(),
            uri: "file:///repo/src/main.rs".into(),
            directory: false,
        }));
        assert!(s.composer.draft.attach(Attachment::Device {
            name: "preview.png".into(),
            mime: "image/png".into(),
            bytes: Arc::from([1_u8, 2, 3, 4]),
            token: None,
        }));
        assert!(s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        }));
        assert!(s.composer.draft.attach(Attachment::Agent("planner".into())));
    });
    rt.frame(0.0);

    let bar = rect(&rt, "composer-attachments");
    let field = rect(&rt, "composer");
    assert!(
        bar[1] + bar[3] <= field[1] + 0.5,
        "attachments bar must sit above the composer field: bar={bar:?}, field={field:?}"
    );

    let remove = rect(&rt, "remove-0");
    assert!(
        remove[2] <= 36.0 && remove[3] <= 36.0,
        "chip remove control must be a compact icon button, got {remove:?}"
    );
    let remove_label = t("sessionView.attachments.removeAriaLabel");
    assert_eq!(help(&rt, "remove-0").as_deref(), Some(remove_label));
    let tree = rt.accessibility_json();
    let remove_node = node(&tree, "remove-0").expect("remove-0 node");
    assert_eq!(remove_node["role"], "button");
    assert_eq!(remove_node["name"], remove_label);

    let locale = crate::strings::locale();
    let expected_project_detail = catalogue::format(
        locale,
        "promptInput.attachFiles.projectDetail",
        &[("path", "src/main.rs")],
    );
    let project_chip = node(&tree, "attachment-0").expect("project chip node");
    assert!(
        project_chip["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == expected_project_detail),
        "project chip must render shrinkable localized detail: {project_chip}"
    );
    let expected_device_detail = catalogue::format(
        locale,
        "promptInput.attachFiles.deviceDetail",
        &[("name", "preview.png"), ("bytes", "4")],
    );
    let device_chip = node(&tree, "attachment-1").expect("device chip node");
    assert!(
        device_chip["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == expected_device_detail),
        "device chip must render shrinkable localized detail: {device_chip}"
    );
    let skill_node = node(&tree, "attachment-2").expect("skill attachment node");
    assert_eq!(skill_node["description"], t("promptInput.skills.title"));

    // Keyboard Enter on the compact close control removes the attachment and returns focus to composer.
    rt.update(|_, tx| tx.focus("remove-0", true));
    rt.frame(0.0);
    press_key(&mut rt, Key::Enter);
    assert_eq!(rt.state.composer.draft.attachments.len(), 3);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.focused && el.path.contains("/composer/"))
    );
}

#[test]
fn footer_separates_compact_navigation_from_trailing_stop_and_primary_send() {
    let (mut rt, rx) = chat_runtime((960.0, 640.0));
    rt.update(|s, _| {
        s.phase = Phase::Streaming;
        let backend = crate::backend::Backend::unauthenticated("http://127.0.0.1:9/").unwrap();
        let mut agent = crate::agent::Ui::new(crate::agent::start(backend, Arc::new(|| {})));
        agent.known = true;
        agent.online = true;
        agent.running = true;
        s.agent = Some(agent);
        s.messages = vec![
            Message {
                usage: None,
                completed: true,
                id: "m1".into(),
                role: "user".into(),
                body: "hello".into(),
                parts: vec![],
            }
            .into(),
        ];
        s.draft = TextEdit::new("follow-up");
    });
    rt.frame(0.0);

    let composer = rect(&rt, "session-composer");
    let footer = rect(&rt, "composer-footer");
    let oldest = rect(&rt, "oldest");
    let latest = rect(&rt, "latest");
    let more = rect(&rt, "composer-more:trigger");
    let stop = rect(&rt, "composer-stop");
    let send = rect(&rt, "send");

    assert!(
        oldest[2] <= 36.0 && latest[2] <= 36.0,
        "history navigation controls must stay compact icons: oldest={oldest:?}, latest={latest:?}"
    );
    assert!(
        oldest[0] < latest[0]
            && oldest[1] + oldest[3] <= composer[1] + 0.5
            && latest[1] + latest[3] <= composer[1] + 0.5,
        "floating scroll controls must sit above the composer: oldest={oldest:?}, latest={latest:?}, composer={composer:?}"
    );
    assert!(
        more[0] > footer[0] + footer[2] * 0.5,
        "spacer must push trailing composer actions to the trailing edge: footer={footer:?}, more={more:?}"
    );
    assert!(
        more[0] < stop[0] && stop[0] < send[0],
        "trailing action order must match Solid (more < stop < send): more={more:?}, stop={stop:?}, send={send:?}"
    );
    assert!(
        (footer[0] + footer[2] - (send[0] + send[2])).abs() <= 4.0,
        "send button must anchor at the trailing edge of the footer: footer={footer:?}, send={send:?}"
    );

    let tree = rt.accessibility_json();
    let oldest_node = node(&tree, "oldest").expect("oldest node");
    assert_eq!(
        oldest_node["name"],
        t("messageSection.scroll.toFirstAriaLabel")
    );
    let latest_node = node(&tree, "latest").expect("latest node");
    assert_eq!(latest_node["name"], t("rune.latest"));
    let stop_node = node(&tree, "composer-stop").expect("stop node");
    assert_eq!(stop_node["name"], t("rune.stop"));
    assert_eq!(
        stop_node["description"],
        t("promptInput.stopSession.ariaLabel")
    );
    assert_eq!(
        help(&rt, "composer-stop").as_deref(),
        Some(t("promptInput.stopSession.title"))
    );
    let send_node = node(&tree, "send").expect("send node");
    assert_eq!(send_node["name"], t("promptInput.overlay.send"));
    assert_eq!(send_node["description"], t("promptInput.send.ariaLabel"));
    assert!(
        help(&rt, "send")
            .as_deref()
            .is_some_and(|h| h.starts_with(t("promptInput.send.ariaLabel")))
    );

    // Queue follow-up preference keeps the visible Label in Name ("Send") and updates description/tooltip.
    rt.update(|s, _| {
        crate::settings::fixture_settings(s, json!({ "followUpBehavior": "queue" }));
    });
    rt.frame(0.0);
    let queued_tree = rt.accessibility_json();
    let queued_send = node(&queued_tree, "send").expect("send node");
    assert_eq!(queued_send["name"], t("promptInput.overlay.send"));
    assert_eq!(
        queued_send["description"],
        t("promptInput.send.queueAriaLabel")
    );
    assert!(
        help(&rt, "send")
            .as_deref()
            .is_some_and(|h| h.starts_with(t("promptInput.send.queueAriaLabel")))
    );

    // Keyboard Enter on the primary Send button submits the prompt.
    rt.update(|_, tx| tx.focus("send", true));
    rt.frame(0.0);
    press_key(&mut rt, Key::Enter);
    let Command::Prompt(prompt) = rx.try_recv().expect("submitted prompt") else {
        panic!("expected prompt command");
    };
    assert_eq!(prompt.text, "follow-up");
    assert!(
        rx.try_recv().is_err(),
        "Enter on Send must activate exactly once"
    );
}

#[test]
fn footer_shows_reading_status_badge_and_keeps_narrow_mobile_layout_unclipped() {
    let (mut rt, _rx) = chat_runtime((320.0, 568.0));
    rt.update(|s, _| {
        s.messages = vec![
            Message {
                usage: None,
                completed: true,
                id: "m1".into(),
                role: "assistant".into(),
                body: "ready".into(),
                parts: vec![],
            }
            .into(),
        ];
        assert!(s.composer.draft.attach(Attachment::Project {
            name: "view.rs".into(),
            path: "packages/rune-app/src/composer/very/deep/nested/path/view.rs".into(),
            uri: "file:///repo/packages/rune-app/src/composer/very/deep/nested/path/view.rs".into(),
            directory: false,
        }));
        s.composer.device.choosing = true;
    });
    rt.frame(0.0);

    let tree = rt.accessibility_json();
    let reading = node(&tree, "composer-reading-files").expect("reading files badge");
    assert_eq!(reading["role"], "status");
    assert!(
        reading["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == t("promptInput.attachFiles.reading"))
            || reading["name"] == t("promptInput.attachFiles.reading")
    );

    // Every footer control and long-path attachment remove button stays within the 320px viewport.
    for key in [
        "attachment-0",
        "remove-0",
        "oldest",
        "latest",
        "composer-more:trigger",
        "send",
    ] {
        let r = rect(&rt, key);
        assert!(
            r[0] >= -0.5 && r[0] + r[2] <= 320.5,
            "{key} clipped outside 320px viewport: {r:?}"
        );
    }
}

#[test]
fn composer_menu_exposes_icons_and_localized_attach_help() {
    let (mut rt, _rx) = chat_runtime((960.0, 640.0));
    click(&mut rt, "composer-more:trigger");
    let tree = rt.accessibility_json();
    let attach = node(&tree, "composer-more:item:attach").expect("attach menu item");
    assert_eq!(attach["description"], t("promptInput.attachFiles.help"));
    for item_key in [
        "composer-more:item:queue",
        "composer-more:item:attach",
        "composer-more:item:clear",
    ] {
        assert!(
            rt.find(item_key).is_some(),
            "expected menu row {item_key} to be mounted"
        );
    }
    press_key(&mut rt, Key::Escape);

    rt.update(|s, _| s.composer.picker.set_attachments_supported(false));
    rt.frame(0.0);
    click(&mut rt, "composer-more:trigger");
    let unsupported_tree = rt.accessibility_json();
    let unsupported_attach =
        node(&unsupported_tree, "composer-more:item:attach").expect("attach menu item");
    assert_eq!(
        unsupported_attach["description"],
        t("rune.attachments_unavailable")
    );
}

#[test]
fn composer_alerts_render_as_structured_field_errors() {
    let (mut rt, _rx) = chat_runtime((960.0, 640.0));
    rt.update(|s, _| {
        s.composer.send_error = true;
        s.composer.device.notice = Some("report.bin: exceeds 5 MiB per file.".into());
    });
    rt.frame(0.0);

    let tree = rt.accessibility_json();
    let send_err = node(&tree, "composer-send-error").expect("send error alert");
    assert_eq!(send_err["role"], "alert");
    assert_eq!(send_err["name"], t("promptInput.send.errorTitle"));

    let device_err = node(&tree, "composer-device-notice").expect("device notice alert");
    assert_eq!(device_err["role"], "alert");
    assert_eq!(device_err["name"], "report.bin: exceeds 5 MiB per file.");
}

#[test]
fn hebrew_rtl_attachment_details_render_localized_and_before_close() {
    fn hebrew(s: &State, cx: &mut rune::Cx<State>) -> rune::El {
        crate::strings::with_locale("he", || crate::view(s, cx))
    }

    let mut s = crate::init();
    s.phase = Phase::Ready;
    s.composer.picker.set_attachments_supported(true);
    s.composer.draft.attachments.push(Attachment::Project {
        name: "main.rs".into(),
        path: "src/main.rs".into(),
        uri: "file:///repo/src/main.rs".into(),
        directory: false,
    });
    s.composer.draft.attachments.push(Attachment::Device {
        name: "preview.png".into(),
        mime: "image/png".into(),
        bytes: Arc::from([1u8, 2, 3, 4]),
        token: None,
    });
    let mut rt = Runtime::new(s, hebrew, (960.0, 640.0), Env::new(false, 1.0));
    rt.poll = Some(crate::poll);
    rt.frame(0.0);

    let tree = rt.accessibility_json();
    let expected_project = catalogue::format(
        "he",
        "promptInput.attachFiles.projectDetail",
        &[("path", "src/main.rs")],
    );
    let expected_device = catalogue::format(
        "he",
        "promptInput.attachFiles.deviceDetail",
        &[("name", "preview.png"), ("bytes", "4")],
    );
    let project_chip = node(&tree, "attachment-0").expect("hebrew project chip");
    assert!(
        project_chip["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == expected_project),
        "hebrew project chip must render localized detail: {project_chip}"
    );
    let device_chip = node(&tree, "attachment-1").expect("hebrew device chip");
    assert!(
        device_chip["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|child| child["name"] == expected_device),
        "hebrew device chip must render localized detail: {device_chip}"
    );

    // In RTL, the trailing close button sits on the left edge of each chip.
    for (chip_key, remove_key) in [("attachment-0", "remove-0"), ("attachment-1", "remove-1")] {
        let chip_rect = rect(&rt, chip_key);
        let remove_rect = rect(&rt, remove_key);
        assert!(
            remove_rect[0] >= chip_rect[0] - 0.5
                && remove_rect[0] + remove_rect[2] < chip_rect[0] + chip_rect[2] * 0.5,
            "RTL close button {remove_key} must trail on the left side of {chip_key}: chip={chip_rect:?}, remove={remove_rect:?}"
        );
    }
}
