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

#[test]
fn missing_session_recovers_text_attachments_and_overflow_into_local_drafts() {
    use crate::composer::draft::Attachment;
    use crate::shell::notifications::Category;
    use crate::workspace::{
        NO_SESSION_DRAFT_ID, is_recovered_draft_id, is_uuid_recovered_draft_id,
    };

    let mut s = init();
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(backend(""));
    s.screen = crate::Screen::Chat { launcher: Some(l) };
    let mut ui = Ui::new();
    ui.ready = true;
    let mut saved = workspace("ses_gone_1", "first draft");
    saved
        .drafts
        .insert("ses_gone_2".into(), "second draft".into());
    saved
        .drafts
        .insert("ses_existing".into(), "keep existing".into());
    ui.entries[0] = entry("tab-0".into(), Tab::Workspace(saved));
    ui.entries[0].binding = Some(backend("ses_gone_1"));
    s.workspace = Some(ui);
    s.draft = TextEdit::new("first latest");
    let device = Attachment::Device {
        name: "note.txt".into(),
        mime: "text/plain".into(),
        bytes: std::sync::Arc::from(b"payload".as_slice()),
        token: None,
    };
    let agent = Attachment::Agent("reviewer".into());
    assert!(s.composer.draft.attach(device.clone()));
    assert!(s.composer.draft.attach(agent.clone()));

    // Confirm ses_gone_1 missing: captures latest text + attachments and moves them to __no_session_draft__.
    assert!(unselect_missing(&mut s, "ses_gone_1"));
    let expected_toast = crate::strings::t("sessionState.cleanup.draftRecovered").to_owned();
    assert_eq!(
        s.notifications.queued_messages(),
        vec![(Category::Projects, expected_toast.clone())]
    );
    s.draft = TextEdit::new("");
    s.composer = Default::default();
    s.show_launcher();
    // Simulate launcher binding with empty session ID and verify capture() never wipes __no_session_draft__.
    s.workspace.as_mut().unwrap().entries[0].binding = Some(backend(""));
    capture(&mut s);

    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(after_first) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(after_first.active_session_id, None);
    assert!(!after_first.drafts.contains_key("ses_gone_1"));
    assert!(!after_first.attachment_drafts.contains("ses_gone_1"));
    assert!(!after_first.attachment_parts.contains_key("ses_gone_1"));
    assert_eq!(
        after_first
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("first latest")
    );
    assert!(after_first.attachment_drafts.contains(NO_SESSION_DRAFT_ID));

    // Confirm a second missing session: spills into strict UUID v4 __recovered_draft__<uuid>.
    assert!(recover_missing_session_draft(&mut s, "ses_gone_2"));
    assert!(!recover_missing_session_draft(&mut s, "ses_empty"));
    assert_eq!(
        s.notifications.queued_messages(),
        vec![
            (Category::Projects, expected_toast.clone()),
            (Category::Projects, expected_toast),
        ]
    );

    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(after_second) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert!(!after_second.drafts.contains_key("ses_gone_2"));
    assert_eq!(
        after_second
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("first latest")
    );
    let recovered_keys: Vec<_> = after_second
        .drafts
        .keys()
        .filter(|id| is_recovered_draft_id(id))
        .cloned()
        .collect();
    assert_eq!(recovered_keys.len(), 1);
    assert!(is_uuid_recovered_draft_id(&recovered_keys[0]));
    assert!(!recovered_keys[0].contains("00000000-0000-4000-8000-"));
    assert_eq!(after_second.drafts[&recovered_keys[0]], "second draft");

    // Snapshot round-trip preserves both recovered slots cleanly with no dead session keys.
    let encoded = crate::workspace::encode(&snap).unwrap();
    let decoded = crate::workspace::decode(&encoded).unwrap();
    assert_eq!(decoded, snap);

    // Binding an existing session preserves its own draft and does NOT steal __no_session_draft__.
    assert_eq!(bound(&mut s, &backend("ses_existing")), "keep existing");
    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(still_waiting) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        still_waiting
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("first latest")
    );

    // Creating/adopting a new blank session restores text + device + agent attachments and promotes queued recovered draft.
    assert!(adopt_recovered_draft(&mut s, "ses_new_1"));
    s.draft = TextEdit::new(bound(&mut s, &backend("ses_new_1")));
    assert_eq!(s.draft.text, "first latest");
    assert_eq!(s.composer.draft.attachments, [device, agent]);
    assert!(!s.composer.attachments_missing);

    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(after_adopt_1) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        after_adopt_1
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("second draft")
    );
    assert!(
        after_adopt_1
            .drafts
            .keys()
            .all(|id| !is_recovered_draft_id(id))
    );

    // Next new blank session adopts the promoted second recovered draft, leaving zero recovered leftovers.
    assert!(adopt_recovered_draft(&mut s, "ses_new_2"));
    s.draft = TextEdit::new(bound(&mut s, &backend("ses_new_2")));
    assert_eq!(s.draft.text, "second draft");
    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(after_adopt_2) = &snap.tabs[0] else {
        panic!("expected workspace tab");
    };
    assert!(!after_adopt_2.drafts.contains_key(NO_SESSION_DRAFT_ID));
    assert!(
        after_adopt_2
            .drafts
            .keys()
            .all(|id| !is_recovered_draft_id(id))
    );
}

#[test]
fn missing_session_recovers_undelivered_closed_draft_and_unselect_session_keeps_live_draft() {
    use crate::workspace::NO_SESSION_DRAFT_ID;

    let mut s = draft_state();
    s.workspace.as_mut().unwrap().closed = vec![closed("ses_closed_gone", "from closed tab")];
    reopen(&mut s);

    assert!(recover_missing_session_draft(&mut s, "ses_closed_gone"));
    let ui = s.workspace.as_ref().unwrap();
    assert!(
        ui.closed
            .iter()
            .all(|w| !w.drafts.contains_key("ses_closed_gone"))
    );
    let Tab::Workspace(saved) = &ui.entries[0].saved else {
        panic!("expected workspace tab");
    };
    assert!(!saved.drafts.contains_key("ses_closed_gone"));
    assert_eq!(
        saved.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("from closed tab")
    );

    // Manual unselect_session (close-session shortcut) keeps the draft under the live session ID.
    s.draft = TextEdit::new(bound(&mut s, &backend("ses_live")));
    s.draft = TextEdit::new("live draft");
    assert!(unselect_session(&mut s, "ses_live"));
    let Tab::Workspace(after_close) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace tab");
    };
    assert_eq!(after_close.active_session_id, None);
    assert_eq!(
        after_close.drafts.get("ses_live").map(String::as_str),
        Some("live draft")
    );
    assert_eq!(
        after_close
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("from closed tab")
    );
}

#[test]
fn cross_tab_recovery_preserves_closed_pending_and_independent_drafts_without_uuid_collision() {
    use crate::shell::notifications::Category;
    use crate::workspace::{
        NO_SESSION_DRAFT_ID, is_recovered_draft_id, is_uuid_recovered_draft_id,
    };

    // Setup: closed tab holds a draft for `ses_closed_only`, and a later closed tab cleared `ses_closed_cleared`.
    let mut s = draft_state();
    s.screen.launcher_mut().unwrap().connection = Some(backend(""));
    let mut c_old = closed("ses_closed_only", "closed draft preserved");
    c_old
        .drafts
        .insert("ses_closed_cleared".into(), "stale closed".into());
    let mut c_clear = closed("ses_other", "other");
    c_clear
        .drafts
        .insert("ses_closed_cleared".into(), "".into());
    s.workspace.as_mut().unwrap().closed = vec![c_old, c_clear];

    // Tab 0 (A) has no pending_drafts for `ses_closed_only`; Tab 1 (B) reopens and gets pending_drafts
    // plus an independent draft under `ses_sibling_indep`.
    {
        let Tab::Workspace(tab_a) = &mut s.workspace.as_mut().unwrap().entries[0].saved else {
            panic!("expected tab A");
        };
        tab_a.active_session_id = None;
        tab_a.drafts.insert("ses_alive".into(), "alive".into());
        tab_a
            .drafts
            .insert("ses_a_overflow".into(), "from A".into());
    }
    let mut tx = rune::Tx::default();
    new_tab(&mut s, &mut tx);
    opened(
        &mut s,
        &Project {
            id: "project-b".into(),
            path: "/fixture".into(),
        },
    );
    {
        let ui = s.workspace.as_mut().unwrap();
        let Tab::Workspace(tab_b) = &mut ui.entries[1].saved else {
            panic!("expected tab B");
        };
        tab_b
            .drafts
            .insert("ses_sibling_indep".into(), "independent B".into());
        tab_b
            .drafts
            .insert("ses_b_overflow".into(), "from B".into());
        // Switch back to Tab 0 (A) as the active tab receiving proof.
        ui.active = 0;
    }

    // 1. Tab A receives deletion for `ses_closed_cleared`: latest closed clear wins, 0 toasts.
    assert!(!recover_missing_session_draft(&mut s, "ses_closed_cleared"));
    assert!(s.notifications.queued_messages().is_empty());

    // 2. Tab A receives deletion for `ses_closed_only` (only Tab B had pending_drafts):
    // closed draft is recovered (NOT lost!), ui.closed is purged, Tab B's pending copy is cleaned.
    assert!(recover_missing_session_draft(&mut s, "ses_closed_only"));
    assert_eq!(s.notifications.queued_messages().len(), 1);
    assert_eq!(s.notifications.queued_messages()[0].0, Category::Projects);
    {
        let ui = s.workspace.as_ref().unwrap();
        assert!(
            ui.closed
                .iter()
                .all(|w| !w.drafts.contains_key("ses_closed_only"))
        );
        let Tab::Workspace(a) = &ui.entries[0].saved else {
            panic!("expected tab A");
        };
        let Tab::Workspace(b) = &ui.entries[1].saved else {
            panic!("expected tab B");
        };
        assert_eq!(
            a.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
            Some("closed draft preserved")
        );
        assert!(!b.drafts.contains_key("ses_closed_only"));
        assert!(!ui.entries[1].pending_drafts.contains("ses_closed_only"));
    }

    // 3. Tab A receives deletion for `ses_sibling_indep` (independent edit in Tab B):
    // Tab B's independent edit is preserved under a unique recovered UUID without dead ID leak.
    assert!(recover_missing_session_draft(&mut s, "ses_sibling_indep"));
    assert!(recover_missing_session_draft(&mut s, "ses_a_overflow"));
    assert!(recover_missing_session_draft(&mut s, "ses_b_overflow"));

    // 4. Close both Tab A and Tab B, then reopen the project: all 4 recovered drafts survive merge!
    let keys_before: Vec<String> = s
        .workspace
        .as_ref()
        .unwrap()
        .entries
        .iter()
        .flat_map(|e| match &e.saved {
            Tab::Workspace(w) => w.drafts.keys().cloned().collect::<Vec<_>>(),
            Tab::Blank => Vec::new(),
        })
        .filter(|id| is_recovered_draft_id(id))
        .collect();
    assert_eq!(keys_before.len(), 3);
    assert!(keys_before.iter().all(|id| is_uuid_recovered_draft_id(id)));
    let unique: std::collections::HashSet<_> = keys_before.iter().collect();
    assert_eq!(
        unique.len(),
        3,
        "recovered UUIDs must never collide across tabs"
    );

    close(&mut s, "tab-0", &mut tx);
    // Closing tab-0 activates tab-1; clear any background restore job before closing tab-1.
    if let Some(l) = s.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut s, "tab-1", &mut tx);
    assert_eq!(s.workspace.as_ref().unwrap().entries.len(), 1);
    assert!(matches!(
        s.workspace.as_ref().unwrap().entries[0].saved,
        Tab::Blank
    ));
    reopen(&mut s);

    let snap = s.workspace.as_ref().unwrap().snapshot();
    let Tab::Workspace(reopened) = &snap.tabs[0] else {
        panic!("expected reopened tab");
    };
    let mut values: Vec<&str> = reopened.drafts.values().map(String::as_str).collect();
    values.sort_unstable();
    assert!(values.contains(&"closed draft preserved"));
    assert!(values.contains(&"independent B"));
    assert!(values.contains(&"from A"));
    assert!(values.contains(&"from B"));
    assert!(!reopened.drafts.contains_key("ses_closed_only"));
    assert!(!reopened.drafts.contains_key("ses_sibling_indep"));
    assert!(!reopened.drafts.contains_key("ses_a_overflow"));
    assert!(!reopened.drafts.contains_key("ses_b_overflow"));
}

#[test]
fn deferred_active_chat_deletion_recovers_on_leave_and_direct_recovered_adopt_promotes_next() {
    use crate::workspace::{NO_SESSION_DRAFT_ID, RECOVERED_DRAFT_PREFIX, is_recovered_draft_id};

    let mut s = init();
    let mut l = crate::launcher::Launcher::fixture();
    l.connection = Some(backend(""));
    s.screen = crate::Screen::Chat { launcher: Some(l) };
    let mut ui = Ui::new();
    ui.ready = true;
    ui.entries[0] = entry(
        "tab-0".into(),
        Tab::Workspace(workspace("ses_live_del", "initial")),
    );
    ui.entries[0].binding = Some(backend("ses_live_del"));
    s.workspace = Some(ui);
    s.show_chat();
    s.draft = TextEdit::new("typing when deleted");

    // Native deletion arrives while user is actively in chat: deferred until leaving.
    note_session_deleted(&mut s);
    let Tab::Workspace(mid) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace tab");
    };
    assert_eq!(mid.active_session_id.as_deref(), Some("ses_live_del"));
    assert!(!mid.drafts.contains_key(NO_SESSION_DRAFT_ID));

    // Leaving via unselect_session captures latest typing and immediately recovers it.
    assert!(unselect_session(&mut s, "ses_live_del"));
    let Tab::Workspace(after_leave) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace tab");
    };
    assert_eq!(after_leave.active_session_id, None);
    assert!(!after_leave.drafts.contains_key("ses_live_del"));
    assert_eq!(
        after_leave
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("typing when deleted")
    );

    // Direct adoption when __no_session_draft__ is empty promotes the next queued recovered draft.
    {
        let Tab::Workspace(saved) = &mut s.workspace.as_mut().unwrap().entries[0].saved else {
            panic!("expected workspace tab");
        };
        saved.drafts.remove(NO_SESSION_DRAFT_ID);
        saved.drafts.insert(
            format!("{RECOVERED_DRAFT_PREFIX}11111111-1111-4111-8111-111111111111"),
            "first queued".into(),
        );
        saved.drafts.insert(
            format!("{RECOVERED_DRAFT_PREFIX}22222222-2222-4222-8222-222222222222"),
            "second queued".into(),
        );
    }
    assert!(adopt_recovered_draft(&mut s, "ses_brand_new"));
    let Tab::Workspace(after_adopt) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace tab");
    };
    assert_eq!(
        after_adopt.drafts.get("ses_brand_new").map(String::as_str),
        Some("first queued")
    );
    assert_eq!(
        after_adopt
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("second queued")
    );
    assert!(
        after_adopt
            .drafts
            .keys()
            .all(|id| !is_recovered_draft_id(id))
    );
}

#[test]
fn sibling_clear_suppresses_restored_copy_project_promotion_avoids_collision_and_close_drains_delete()
 {
    use crate::workspace::{NO_SESSION_DRAFT_ID, RECOVERED_DRAFT_PREFIX};

    // 1. Restored snapshot has stale text in Tab A and explicit clear ("") in Tab B:
    // deleting the session must NOT resurrect Tab A's stale restored text.
    let mut s = draft_state();
    let mut tab_a_saved = closed("ses_cleared_res", "stale restored text");
    tab_a_saved.active_session_id = None;
    tab_a_saved
        .drafts
        .insert("ses_live_indep".into(), "live edited in A".into());
    let mut tab_b_saved = closed("ses_cleared_res", "");
    tab_b_saved.occurrence = 1;
    tab_b_saved.active_session_id = None;
    tab_b_saved
        .drafts
        .insert("ses_live_indep".into(), "".into());
    let snap = crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(tab_a_saved), Tab::Workspace(tab_b_saved)],
        active: Some(0),
    };
    let mut ui = Ui::new();
    ui.hydrate(snap);
    ui.ready = true;
    // Mark `ses_live_indep` as genuinely edited in Tab A after restore (not a stale restored copy).
    ui.entries[0].restored_drafts.remove("ses_live_indep");
    s.workspace = Some(ui);
    s.show_launcher();

    assert!(!recover_missing_session_draft(&mut s, "ses_cleared_res"));
    assert!(s.notifications.queued_messages().is_empty());
    assert!(recover_missing_session_draft(&mut s, "ses_live_indep"));
    assert_eq!(s.notifications.queued_messages().len(), 1);
    let Tab::Workspace(after_a) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected tab A");
    };
    assert_eq!(
        after_a.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("live edited in A")
    );
    assert!(!after_a.drafts.contains_key("ses_cleared_res"));

    // 2. Direct UUID adoption in Tab B when Tab A already holds __no_session_draft__:
    // Tab B must NOT promote its next UUID into __no_session_draft__, avoiding collision on reopen.
    let uuid_1 = format!("{RECOVERED_DRAFT_PREFIX}11111111-1111-4111-8111-111111111111");
    let uuid_2 = format!("{RECOVERED_DRAFT_PREFIX}22222222-2222-4222-8222-222222222222");
    {
        let ui = s.workspace.as_mut().unwrap();
        let Tab::Workspace(tab_b) = &mut ui.entries[1].saved else {
            panic!("expected tab B");
        };
        tab_b.drafts.insert(uuid_1.clone(), "b first".into());
        tab_b.drafts.insert(uuid_2.clone(), "b second".into());
        ui.active = 1;
    }
    assert!(adopt_recovered_draft(&mut s, "ses_new_b"));
    {
        let Tab::Workspace(tab_b) = &s.workspace.as_ref().unwrap().entries[1].saved else {
            panic!("expected tab B");
        };
        assert_eq!(
            tab_b.drafts.get("ses_new_b").map(String::as_str),
            Some("b first")
        );
        assert!(
            !tab_b.drafts.contains_key(NO_SESSION_DRAFT_ID),
            "must not occupy __no_session_draft__ when sibling tab A already holds it"
        );
        assert_eq!(
            tab_b.drafts.get(&uuid_2).map(String::as_str),
            Some("b second")
        );
    }

    // Closing both tabs and reopening preserves BOTH Tab A's __no_session_draft__ and Tab B's uuid_2!
    let mut tx = rune::Tx::default();
    close(&mut s, "tab-1", &mut tx);
    if let Some(l) = s.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut s, "tab-0", &mut tx);
    reopen(&mut s);
    let Tab::Workspace(merged) = &s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected reopened tab");
    };
    assert_eq!(
        merged.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("live edited in A")
    );
    assert_eq!(
        merged.drafts.get(&uuid_2).map(String::as_str),
        Some("b second")
    );

    // 3. Closing an active tab when Event::SessionDeleted is queued in `incoming` (not yet polled)
    // drains the proof before dropping the cache and recovers the draft before pushing to `ui.closed`.
    let mut close_s = draft_state();
    close_s.draft = TextEdit::new(bound(&mut close_s, &backend("ses_queued_del")));
    close_s.show_chat();
    close_s.draft = TextEdit::new("unsent before close");
    let (ev_tx, ev_rx) = bounded(2);
    ev_tx
        .try_send(crate::transport::Event::SessionDeleted)
        .unwrap();
    close_s.incoming = Some(ev_rx);
    close(&mut close_s, "tab-0", &mut tx);
    let closed_entry = close_s
        .workspace
        .as_ref()
        .unwrap()
        .closed
        .last()
        .expect("closed tab recorded");
    assert!(!closed_entry.drafts.contains_key("ses_queued_del"));
    assert_eq!(
        closed_entry
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("unsent before close")
    );
}
