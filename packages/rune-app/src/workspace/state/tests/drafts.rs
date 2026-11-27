use super::*;

#[test]
fn a_late_clipboard_read_cannot_attach_to_another_conversation_in_the_same_tab() {
    use rune::{Mods, PhysicalInput, PhysicalKeyCode, clipboard::ClipboardContent};
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(workspace("alpha", "same")));
    ui.entries[0].binding = Some(backend("alpha"));
    s.workspace = Some(ui);
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("same");
    s.composer.picker.set_attachments_supported(true);
    let mut rt = runtime(s);
    rt.update(|_, tx| tx.focus("composer", false));
    let paste = |rt: &mut rune::Runtime<State>| {
        rt.physical_input(PhysicalInput::Key {
            key: PhysicalKeyCode::KeyV,
            mods: Mods {
                cmd: true,
                ctrl: !cfg!(target_os = "macos"),
                ..Mods::default()
            },
            pressed: true,
            repeat: false,
            text: None,
            consumed_mods: Mods::default(),
        });
        rt.frame(0.0);
    };
    paste(&mut rt);
    assert!(rt.state.composer.device.busy());
    rt.update(|s, tx| {
        let ui = s.workspace.as_mut().unwrap();
        let Tab::Workspace(saved) = &mut ui.entries[0].saved else {
            panic!("workspace")
        };
        saved.drafts.insert("beta".into(), "same".into());
        s.draft = TextEdit::new(bound(s, &backend("beta")));
        s.show_chat();
        s.composer.picker.set_attachments_supported(true);
        tx.focus("composer", false);
    });
    let clipboard = rune::clipboard::memory();
    let png = [
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
    ];
    let image = rune::clipboard::ClipboardImage::from_png(png.as_slice()).unwrap();
    clipboard.set_content(ClipboardContent::default().with_image(image));
    rt.use_clipboard(&clipboard);
    rt.frame(0.0);
    rt.frame(0.0);
    assert_eq!(active_session(&rt.state), Some("beta"));
    assert!(!rt.state.composer.device.busy());
    assert!(rt.state.composer.draft.attachments.is_empty());
    clipboard.set_text("still editing B");
    paste(&mut rt);
    rt.frame(0.0);
    assert!(rt.state.draft.text.contains("still editing B"));
}

#[test]
fn switching_conversation_restores_the_exact_device_bytes() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry(
        "tab-0".into(),
        Tab::Workspace(workspace("alpha", "read it")),
    );
    ui.entries[0].binding = Some(backend("alpha"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("read it");
    let file = crate::composer::draft::Attachment::Device {
        name: "device.txt".into(),
        mime: "text/plain".into(),
        bytes: std::sync::Arc::from(b"device bytes".as_slice()),
        token: None,
    };
    assert!(s.composer.draft.attach(file.clone()));
    s.draft = TextEdit::new(bound(&mut s, &backend("beta")));
    assert!(s.composer.draft.attachments.is_empty());
    s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
    assert_eq!(s.draft.text, "read it");
    assert_eq!(s.composer.draft.attachments, [file]);
    assert!(!s.composer.attachments_missing);
}

#[test]
fn retained_empty_device_files_consume_the_window_file_budget() {
    use crate::composer::draft::{Attachment, MAX_FILES};
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(workspace("alpha", "")));
    ui.entries[0].binding = Some(backend("alpha"));
    let mut other = workspace("beta", "");
    other.folder = "/different".into();
    let mut item = entry("tab-1".into(), Tab::Workspace(other));
    item.binding = Some(backend("beta"));
    ui.entries.push(item);
    s.workspace = Some(ui);
    let empty = Attachment::Device {
        name: "empty.txt".into(),
        mime: "text/plain".into(),
        bytes: std::sync::Arc::from([]),
        token: None,
    };
    for i in 0..crate::workspace::MAX_DRAFTS {
        let session = format!("retained-{i}");
        bound(&mut s, &backend(&session));
        for _ in 0..MAX_FILES {
            assert!(s.composer.draft.attach(empty.clone()));
            assert!(attachment_draft_admissible(&s));
        }
        capture(&mut s);
    }
    s.workspace.as_mut().unwrap().active = 1;
    s.composer = Default::default();
    bound(&mut s, &backend("beta"));
    assert!(s.composer.draft.attach(empty));
    assert!(!attachment_draft_admissible(&s));
}

#[test]
fn oversized_inline_edit_keeps_the_last_valid_draft_and_the_same_tab_sibling() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    let mut saved = workspace("alpha", "last valid version");
    saved.drafts.insert("beta".into(), "other draft".into());
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(saved));
    ui.entries[0].binding = Some(backend("alpha"));
    s.workspace = Some(ui);
    s.phase = Phase::Ready;
    s.draft = TextEdit::new("last valid version");
    let mut rt = runtime(s);
    rt.frame(0.0);
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    let long = "🦀".repeat(crate::workspace::MAX_DRAFT / 2 + 1);
    rt.update(|s, tx| {
        s.draft.paste(&long);
        draft_changed(s, tx);
    });
    rt.update(|s, _| {
        assert!(s.draft.text.contains(&long));
        let ui = s.workspace.as_ref().unwrap();
        assert_eq!(crate::workspace::status(s), Some("rune.save_error"));
        assert!(super::super::tabs::close_blocked(s, 0));
        let snapshot =
            crate::workspace::decode(&crate::workspace::encode(&ui.snapshot()).unwrap()).unwrap();
        assert!(matches!(&snapshot.tabs[0], Tab::Workspace(tab) if
            tab.drafts["alpha"] == "last valid version" && tab.drafts["beta"] == "other draft"));
        s.draft = TextEdit::new(bound(s, &backend("beta")));
        assert_eq!(s.draft.text, "other draft");
        s.draft = TextEdit::new(bound(s, &backend("alpha")));
        assert!(s.draft.text.contains(&long));
        s.draft = TextEdit::new("small again");
        capture(s);
        assert_eq!(crate::workspace::status(s), None);
    });
}

#[test]
fn reopening_a_saved_draft_without_its_files_blocks_every_send() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(workspace("alpha", "")));
    ui.entries[0].binding = Some(backend("alpha"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("from the attached file");
    s.composer.attachments_missing = true;
    capture(&mut s);
    let bytes = crate::workspace::encode(&s.workspace.as_ref().unwrap().snapshot()).unwrap();

    let mut restored = init();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes).unwrap());
    ui.ready = true;
    restored.workspace = Some(ui);
    restored.draft = TextEdit::new(bound(&mut restored, &backend("alpha")));
    restored.composer.picker.set_attachments_supported(true);
    restored.phase = Phase::Ready;
    let (out, commands) = bounded(1);
    restored.commands = Some(out);
    let mut rt = runtime(restored);
    rt.update(crate::send);
    rt.frame(0.0);
    assert!(rt.state.composer.attachments_missing);
    assert!(!crate::composer::can_send(&rt.state));
    assert!(commands.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "from the attached file");
    assert!(rt.find("keep-draft-text").is_some());
    rt.update(|s, tx| {
        s.composer
            .draft
            .attach(crate::composer::draft::Attachment::Path(
                "./other.txt".into(),
            ));
        s.draft = TextEdit::new(bound(s, &backend("alpha")));
        s.composer.picker.set_attachments_supported(true);
        crate::send(s, tx);
    });
    assert!(rt.state.composer.attachments_missing);
    assert!(commands.try_recv().is_err());
}

#[test]
fn attachment_only_drafts_reserve_a_slot_before_the_picker_can_attach() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    let mut saved = workspace("next", "");
    saved.attachment_drafts = (0..crate::workspace::MAX_DRAFTS)
        .map(|i| format!("old-{i}"))
        .collect();
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(saved));
    ui.entries[0].binding = Some(backend("next"));
    s.workspace = Some(ui);
    assert!(!attachment_draft_admissible(&s));
    s.draft = TextEdit::new("a plain draft still saves");
    capture(&mut s);
    assert!(crate::workspace::encode(&s.workspace.as_ref().unwrap().snapshot()).is_ok());
}

#[test]
fn reopening_a_draft_restores_its_project_reference_before_sending() {
    let mut s = init();
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(workspace("alpha", "")));
    ui.entries[0].binding = Some(backend("alpha"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("read @./report.txt");
    let file = crate::composer::draft::Attachment::Project {
        name: "report.txt".into(),
        path: "./report.txt".into(),
        uri: "file:///fixture/report.txt".into(),
        directory: false,
    };
    s.composer.draft.attach(file.clone());
    capture(&mut s);
    s.draft = TextEdit::new(bound(&mut s, &backend("beta")));
    assert!(s.composer.draft.attachments.is_empty());
    let bytes = crate::workspace::encode(&s.workspace.as_ref().unwrap().snapshot()).unwrap();
    let mut restored = init();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes).unwrap());
    ui.ready = true;
    restored.workspace = Some(ui);
    restored.draft = TextEdit::new(bound(&mut restored, &backend("alpha")));
    assert_eq!(restored.composer.draft.attachments, [file]);
    assert!(!restored.composer.attachments_missing);
    restored.phase = Phase::Ready;
    let (sender, commands) = bounded(1);
    restored.commands = Some(sender);
    let mut rt = runtime(restored);
    rt.update(crate::send);
    assert!(commands.try_recv().is_err(), "wait for server capability");
    rt.update(|s, tx| {
        s.composer.picker.set_attachments_supported(true);
        crate::send(s, tx);
    });
    let crate::transport::Command::Prompt(prompt) = commands.try_recv().unwrap() else {
        panic!("native prompt");
    };
    assert_eq!(prompt.text, "read ./report.txt");
    assert_eq!(prompt.files.len(), 1);
    assert_eq!(prompt.files[0].uri, "file:///fixture/report.txt");
}

fn closed(session: &str, text: &str) -> Workspace {
    let mut w = workspace(session, text);
    w.backend_id = Some("external".into());
    w.server_id = Some("trial-server".into());
    w
}

fn reopen(s: &mut State) {
    s.workspace.as_mut().unwrap().entries[0] = entry("tab-0".into(), Tab::Blank);
    opened(
        s,
        &Project {
            id: "reopened".into(),
            path: "/fixture".into(),
            temporary: false,
        },
    );
}

#[test]
fn closed_occurrences_merge_each_session_with_latest_clear_authority() {
    let mut s = draft_state();
    s.workspace.as_mut().unwrap().closed = vec![
        closed("alpha", "Alpha"),
        closed("beta", "Beta"),
        closed("alpha", ""),
    ];
    reopen(&mut s);
    assert_eq!(bound(&mut s, &backend("alpha")), "");
    s.draft = TextEdit::new(bound(&mut s, &backend("beta")));
    assert_eq!(s.draft.text, "Beta");
    assert!(
        s.workspace.as_ref().unwrap().entries[0]
            .cleared
            .contains("alpha")
    );
    let mut rt = runtime(s);
    rt.update(|s, tx| close(s, "tab-0", tx));
    opened(
        &mut rt.state,
        &Project {
            id: "successor".into(),
            path: "/fixture".into(),
            temporary: false,
        },
    );
    assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
    assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
}

#[test]
fn clearing_or_sending_an_inherited_draft_retires_older_closed_text() {
    for clear in [true, false] {
        let mut s = draft_state();
        s.workspace.as_mut().unwrap().closed =
            vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
        reopen(&mut s);
        s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
        assert_eq!(s.draft.text, "Old Alpha");
        if clear {
            s.draft = TextEdit::new("");
            capture(&mut s);
        } else {
            let (commands, input) = bounded(1);
            s.commands = Some(commands);
            s.phase = Phase::Ready;
            let mut rt = runtime(s);
            rt.update(crate::send);
            assert!(
                matches!(input.try_recv(), Ok(crate::transport::Command::Prompt(body)) if body.text == "Old Alpha")
            );
            s = rt.state;
        }
        s.phase = Phase::Ready;
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "successor".into(),
                path: "/fixture".into(),
                temporary: false,
            },
        );
        assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
        assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
    }
}

#[test]
fn closed_drafts_cannot_cross_backend_installation_or_folder() {
    let mut s = draft_state();
    let mut wrong_server = closed("server", "foreign");
    wrong_server.server_id = Some("another-server".into());
    let mut wrong_backend = closed("backend", "foreign");
    wrong_backend.backend_id = None;
    wrong_backend.server_id = None;
    let mut wrong_folder = closed("folder", "foreign");
    wrong_folder.folder = "/other".into();
    s.workspace.as_mut().unwrap().closed = vec![
        wrong_server,
        wrong_backend,
        wrong_folder,
        closed("owned", "Own"),
    ];
    reopen(&mut s);
    for id in ["server", "backend", "folder"] {
        assert_eq!(bound(&mut s, &backend(id)), "");
    }
    assert_eq!(bound(&mut s, &backend("owned")), "Own");
}

#[test]
fn snapshot_preserves_needed_clear_authority_and_untouched_sibling_absence() {
    for mode in ["untouched", "cleared", "sent"] {
        let cleared = mode != "untouched";
        let mut s = draft_state();
        let ui = s.workspace.as_mut().unwrap();
        ui.entries = vec![
            entry("tab-0".into(), Tab::Workspace(closed("alpha", "Old Alpha"))),
            entry(
                "tab-1".into(),
                Tab::Workspace(closed("alpha", if cleared { "Old Alpha" } else { "" })),
            ),
        ];
        // A never-edited empty occurrence has no clear authority.
        if !cleared {
            ui.entries[1].cleared.clear();
        }
        ui.active = 1;
        ui.entries[1].binding = Some(backend("alpha"));
        if mode == "sent" {
            s.draft = TextEdit::new("Old Alpha");
            let (commands, input) = bounded(1);
            s.commands = Some(commands);
            s.phase = Phase::Ready;
            let mut rt = runtime(s);
            rt.update(crate::send);
            assert!(
                matches!(input.try_recv(), Ok(crate::transport::Command::Prompt(body)) if body.text == "Old Alpha")
            );
            s = rt.state;
        } else {
            s.draft = TextEdit::new("");
            capture(&mut s);
        }
        let before = s.workspace.as_ref().unwrap().snapshot();
        let Tab::Workspace(b) = &before.tabs[1] else {
            panic!()
        };
        assert_eq!(b.drafts.get("alpha"), cleared.then_some(&String::new()));
        let bytes = crate::workspace::encode(&before).unwrap();
        let mut restored = Ui::new();
        restored.hydrate(crate::workspace::decode(&bytes).unwrap());
        restored.ready = true;
        s.workspace = Some(restored);
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        rt.update(|s, tx| close(s, "tab-1", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "successor".into(),
                path: "/fixture".into(),
                temporary: false,
            },
        );
        assert_eq!(
            bound(&mut rt.state, &backend("alpha")),
            if cleared { "" } else { "Old Alpha" }
        );
    }
}

#[test]
fn delivered_bundles_follow_live_edits_and_sends_without_retiring_other_sessions() {
    for mode in ["cleared", "sent", "edited"] {
        for restart in [false, true] {
            let mut s = draft_state();
            s.workspace.as_mut().unwrap().closed =
                vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
            reopen(&mut s);
            s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
            assert_eq!(s.draft.text, "Old Alpha");
            let mut rt = runtime(s);
            if mode == "sent" {
                let (commands, input) = bounded(1);
                rt.state.commands = Some(commands);
                rt.state.phase = Phase::Ready;
                rt.update(crate::send);
                assert!(
                    matches!(input.try_recv(), Ok(crate::transport::Command::Prompt(body)) if body.text == "Old Alpha")
                );
            } else {
                rt.state.draft = TextEdit::new(if mode == "edited" { "New Alpha" } else { "" });
                capture(&mut rt.state);
            }
            if restart {
                let snapshot = rt.state.workspace.as_ref().unwrap().snapshot();
                let bytes = crate::workspace::encode(&snapshot).unwrap();
                let mut ui = Ui::new();
                ui.hydrate(crate::workspace::decode(&bytes).unwrap());
                ui.ready = true;
                rt.state.workspace = Some(ui);
            }
            rt.update(new_tab);
            opened(
                &mut rt.state,
                &Project {
                    id: "third".into(),
                    path: "/fixture".into(),
                    temporary: false,
                },
            );
            rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
            assert!(
                rt.state.draft.text.is_empty(),
                "a live owner reserves its delivered bundle"
            );
            rt.update(|s, tx| close(s, "tab-0", tx));
            rt.update(|s, tx| close(s, "tab-1", tx));
            opened(
                &mut rt.state,
                &Project {
                    id: "fourth".into(),
                    path: "/fixture".into(),
                    temporary: false,
                },
            );
            rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
            assert_eq!(
                rt.state.draft.text,
                if mode == "edited" { "New Alpha" } else { "" }
            );
            assert_eq!(
                bound(&mut rt.state, &backend("beta")),
                "Beta",
                "undelivered sessions survive"
            );
        }
    }
}

#[test]
fn an_unbound_or_failed_open_keeps_its_source_and_binding_revalidates_pending_text() {
    for bind in [false, true] {
        let mut s = draft_state();
        s.workspace.as_mut().unwrap().closed =
            vec![closed("alpha", "Old Alpha"), closed("beta", "Beta")];
        reopen(&mut s);
        s.workspace
            .as_mut()
            .unwrap()
            .closed
            .push(closed("alpha", "New Alpha"));
        if bind {
            s.draft = TextEdit::new(bound(&mut s, &backend("alpha")));
            assert_eq!(
                s.draft.text, "New Alpha",
                "successful binding admits the current source"
            );
        }
        // Failed native admission never calls bound; closing returns no obsolete pending copy.
        let mut rt = runtime(s);
        rt.update(|s, tx| close(s, "tab-0", tx));
        opened(
            &mut rt.state,
            &Project {
                id: "retry".into(),
                path: "/fixture".into(),
                temporary: false,
            },
        );
        rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
        assert_eq!(rt.state.draft.text, "New Alpha");
        assert_eq!(bound(&mut rt.state, &backend("beta")), "Beta");
    }
}

#[test]
fn delivery_retires_pending_copies_but_preserves_independent_occurrence_authority() {
    let mut s = draft_state();
    s.workspace.as_mut().unwrap().closed = vec![closed("alpha", "Source Alpha")];
    reopen(&mut s);
    let mut rt = runtime(s);
    rt.update(new_tab);
    opened(
        &mut rt.state,
        &Project {
            id: "pending".into(),
            path: "/fixture".into(),
            temporary: false,
        },
    );
    let ui = rt.state.workspace.as_mut().unwrap();
    ui.entries.push(entry(
        "independent".into(),
        Tab::Workspace(closed("alpha", "Own Alpha")),
    ));
    rt.state.draft = TextEdit::new(bound(&mut rt.state, &backend("alpha")));
    assert_eq!(rt.state.draft.text, "Source Alpha");
    let ui = rt.state.workspace.as_ref().unwrap();
    assert!(matches!(&ui.entries[0].saved, Tab::Workspace(w) if !w.drafts.contains_key("alpha")));
    assert!(matches!(&ui.entries[2].saved, Tab::Workspace(w) if w.drafts["alpha"] == "Own Alpha"));
    assert!(ui.closed.iter().all(|w| !w.drafts.contains_key("alpha")));
    rt.update(|s, tx| select(s, "tab-0", tx));
    assert_eq!(bound(&mut rt.state, &backend("alpha")), "");
}

#[test]
fn delivery_hidden_interruptions_keep_the_active_close_guard_and_button() {
    for kind in ["form", "reason", "busy", "stopping"] {
        let mut s = draft_state();
        let mut a = crate::agent::Ui::new(crate::agent::start(backend("alpha"), s.wake.clone()));
        match kind {
            "form" => {
                a.forms.push(crate::agent_api::Form {
                    tool: None,
                    infer_websearch: false,
                    owner: Default::default(),
                    id: "request".into(),
                    title: "Question".into(),
                    fields: vec![serde_json::json!({"key":"answer","type":"string"})],
                });
                a.selected = "request".into();
                let mut d = crate::agent::forms::Draft::default();
                d.choose("UNSENT FORM RESPONSE");
                a.drafts.insert(("request".into(), "answer".into()), d);
            }
            "reason" => {
                a.permissions.push(crate::agent_api::Permission {
                    tool: None,
                    id: "request".into(),
                    action: "read".into(),
                    resources: vec!["/fixture".into()],
                    message: String::new(),
                    supported: true,
                });
                a.selected = "request".into();
                a.reasons
                    .insert("request".into(), TextEdit::new("UNSENT REASON"));
            }
            "busy" => a.busy = true,
            _ => a.stopping = true,
        }
        s.agent = Some(a);
        let mut rt = runtime(s);
        rt.frame(0.0);
        assert!(rt.find("c-tab-0").is_none());
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 1);
        rt.update(new_tab);
        rt.frame(0.0);
        assert!(
            rt.find("c-tab-0").is_none(),
            "hidden {kind} must retain the same rendered guard"
        );
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
        rt.update(|s, tx| select(s, "tab-0", tx));
        let a = rt.state.agent.as_mut().unwrap();
        a.busy = false;
        a.stopping = false;
        a.drafts.clear();
        a.reasons.clear();
        rt.update(new_tab);
        rt.frame(0.0);
        assert!(rt.find("c-tab-0").is_some());
        rt.update(|s, tx| close(s, "tab-0", tx));
        assert_eq!(rt.state.workspace.as_ref().unwrap().entries.len(), 2);
    }
}

#[test]
fn delivery_folder_spelling_preserves_only_the_same_server_project_scope() {
    for (saved, path, server, backend_id, preserve) in [
        (
            "D:/Fixture",
            r"d:\FIXTURE",
            "trial-server",
            "external",
            true,
        ),
        (
            r"\\Host\Share\Fixture",
            r"\\host/SHARE/fixture",
            "trial-server",
            "external",
            true,
        ),
        ("/Fixture", "/fixture", "trial-server", "external", false),
        (
            "D:/Fixture",
            "E:/Fixture",
            "trial-server",
            "external",
            false,
        ),
        (
            "D:/Fixture",
            "d:/fixture",
            "another-server",
            "external",
            false,
        ),
        (
            "D:/Fixture",
            "d:/fixture",
            "trial-server",
            "another-backend",
            false,
        ),
    ] {
        let mut s = draft_state();
        let mut saved_project = closed("alpha", "RESTORED UNSENT TEXT");
        saved_project.folder = saved.into();
        saved_project.server_id = Some(server.into());
        saved_project.backend_id = Some(backend_id.into());
        s.workspace.as_mut().unwrap().entries[0] =
            entry("tab-0".into(), Tab::Workspace(saved_project));
        opened(
            &mut s,
            &Project {
                id: "fresh-record".into(),
                path: path.into(),
                temporary: false,
            },
        );
        assert_eq!(
            bound(&mut s, &backend("alpha")),
            if preserve { "RESTORED UNSENT TEXT" } else { "" },
            "scope {saved} -> {path}, {server}, {backend_id}"
        );
    }
}

#[test]
fn delivery_inactive_close_preserves_the_active_reader_and_focus() {
    for before in [false, true] {
        let mut s = init();
        s.phase = Phase::Ready;
        s.messages = crate::transport::synthetic();
        let mut ui = Ui::new();
        ui.ready = true;
        ui.entries.push(entry("tab-1".into(), Tab::Blank));
        ui.active = usize::from(before);
        s.workspace = Some(ui);
        let mut rt = runtime(s);
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        let (x, y) = rt.find("composer").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.paste("KEEP FOCUS 🦀");
        rt.wheel(400.0, 300.0, 1200.0);
        for _ in 0..90 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        let focus = rt
            .elements()
            .into_iter()
            .find(|e| e.focused)
            .map(|e| (e.path, e.edit_range));
        assert!(
            focus
                .as_ref()
                .is_some_and(|(path, range)| path.contains("/composer/") && range.is_some())
        );
        let anchor = rt
            .elements()
            .into_iter()
            .find(|e| {
                e.visible[3] > 0.0 && e.key.as_deref().is_some_and(|key| key.starts_with("body-"))
            })
            .map(|e| (e.key, e.rect));
        assert!(anchor.is_some());
        let active = rt
            .state
            .workspace
            .as_ref()
            .unwrap()
            .active_key()
            .to_string();
        rt.update(|s, tx| close(s, if before { "tab-0" } else { "tab-1" }, tx));
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        assert_eq!(rt.state.workspace.as_ref().unwrap().active_key(), active);
        assert_eq!(rt.scroll_at_bottom("history"), Some(false));
        assert_eq!(rt.state.draft.text, "KEEP FOCUS 🦀");
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|e| e.focused)
                .map(|e| (e.path, e.edit_range)),
            focus
        );
        assert_eq!(
            rt.elements()
                .into_iter()
                .find(|e| e.visible[3] > 0.0
                    && e.key.as_deref().is_some_and(|key| key.starts_with("body-")))
                .map(|e| (e.key, e.rect)),
            anchor
        );
    }
}
