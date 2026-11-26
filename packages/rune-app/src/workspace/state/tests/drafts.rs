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

#[test]
fn independent_sibling_edit_survives_restart_clear_oversized_attachment_close_deferral_and_adopt() {
    use crate::workspace::NO_SESSION_DRAFT_ID;

    // 1. Bloquant 1: Tab A writes an independent draft, Tab B clears its own draft, app restarts:
    // deleting the session must recover Tab A's independent draft (never drop it).
    let mut s = draft_state();
    {
        let ui = s.workspace.as_mut().unwrap();
        let mut tab_a = closed("ses_indep_r3", "");
        tab_a.drafts.clear();
        tab_a.active_session_id = Some("ses_indep_r3".into());
        let mut tab_b = closed("ses_indep_r3", "");
        tab_b.drafts.clear();
        tab_b.occurrence = 1;
        tab_b.active_session_id = Some("ses_indep_r3".into());
        ui.entries = vec![
            entry("tab-0".into(), Tab::Workspace(tab_a)),
            entry("tab-1".into(), Tab::Workspace(tab_b)),
        ];
        ui.entries[0].binding = Some(backend("ses_indep_r3"));
        ui.entries[1].binding = Some(backend("ses_indep_r3"));
        ui.active = 0;
    }
    s.draft = TextEdit::new("independent draft from A");
    capture(&mut s);
    s.workspace.as_mut().unwrap().active = 1;
    s.draft = TextEdit::new("temporary draft in B");
    capture(&mut s);
    s.draft = TextEdit::new("");
    capture(&mut s);
    let snap = s.workspace.as_ref().unwrap().snapshot();
    let bytes = crate::workspace::encode(&snap).unwrap();
    let mut restarted = draft_state();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes).unwrap());
    ui.ready = true;
    restarted.workspace = Some(ui);
    restarted.show_launcher();
    assert!(recover_missing_session_draft(
        &mut restarted,
        "ses_indep_r3"
    ));
    let Tab::Workspace(after_a) = &restarted.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected tab A");
    };
    assert_eq!(
        after_a.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("independent draft from A")
    );

    // 2. Bloquant 2: oversized (>32 KiB UTF-16) live edit AND removing the last attachment both
    // drop restored_drafts so a sibling Persisted clear cannot discard them.
    let mut over_s = draft_state();
    let mut tab_a = closed("ses_over", "restored baseline");
    tab_a.attachment_drafts.insert("ses_att_rm".into());
    tab_a.drafts.insert("ses_att_rm".into(), "keep text".into());
    let mut tab_b = closed("ses_over", "");
    tab_b.occurrence = 1;
    tab_b.active_session_id = None;
    tab_b.drafts.insert("ses_att_rm".into(), "".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(tab_a), Tab::Workspace(tab_b)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_over"));
    over_s.workspace = Some(ui);
    let huge = "x".repeat(crate::workspace::MAX_DRAFT + 10);
    over_s.draft = TextEdit::new(huge.clone());
    capture(&mut over_s);
    // Removing the last attachment while keeping text must also mark `ses_att_rm` as live-edited.
    over_s.draft = TextEdit::new(bound(&mut over_s, &backend("ses_att_rm")));
    over_s.composer.draft.attachments.clear();
    over_s.composer.attachments_missing = false;
    capture(&mut over_s);
    over_s.show_launcher();
    assert!(recover_missing_session_draft(&mut over_s, "ses_over"));
    assert!(recover_missing_session_draft(&mut over_s, "ses_att_rm"));
    assert!(adopt_recovered_draft(&mut over_s, "ses_check_over"));
    assert_eq!(bound(&mut over_s, &backend("ses_check_over")), huge);
    assert!(adopt_recovered_draft(&mut over_s, "ses_check_att"));
    assert_eq!(bound(&mut over_s, &backend("ses_check_att")), "keep text");

    // 3. Moyen 1: B clears a restored copy then CLOSES, AND A is still displaying the conversation
    // when deletion arrives; when A later leaves, A's untouched restored copy must NOT resurrect.
    let mut m1 = draft_state();
    let mut a_tab = closed("ses_m1", "stale copy");
    a_tab.active_session_id = Some("ses_m1".into());
    let mut b_tab = closed("ses_m1", "stale copy");
    b_tab.occurrence = 1;
    b_tab.active_session_id = Some("ses_m1".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a_tab), Tab::Workspace(b_tab)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_m1"));
    ui.entries[1].binding = Some(backend("ses_m1"));
    m1.workspace = Some(ui);
    m1.show_chat();
    m1.draft = TextEdit::new("stale copy");
    let mut tx = rune::Tx::default();
    // Switch to tab-1 so tab-0 stashes its live chat with its untouched restored copy.
    select(&mut m1, "tab-1", &mut tx);
    if let Some(l) = m1.screen.launcher_mut() {
        l.pending = false;
    }
    m1.draft = TextEdit::new("");
    capture(&mut m1);
    close(&mut m1, "tab-1", &mut tx);
    // Tab A is now active again (index 0) and still viewing `ses_m1` in chat.
    assert!(!m1.screen.is_launcher());
    assert!(!recover_missing_session_draft(&mut m1, "ses_m1"));
    assert!(unselect_session(&mut m1, "ses_m1"));
    let Tab::Workspace(after_m1) = &m1.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected tab A");
    };
    assert!(!after_m1.drafts.contains_key("ses_m1"));
    assert!(!after_m1.drafts.contains_key(NO_SESSION_DRAFT_ID));

    // 4. Moyen 2 & 4: queued SessionDeleted is drained on unselect_session (close_session) AND
    // direct new-session binding via bound_with_adopt captures, recovers, and adopts the outgoing
    // deleted session's draft into the newly created blank session.
    let mut m4 = draft_state();
    m4.draft = TextEdit::new(bound(&mut m4, &backend("ses_del_live")));
    m4.show_chat();
    m4.draft = TextEdit::new("typed right before new blank");
    let (ev_tx, ev_rx) = bounded(2);
    ev_tx
        .try_send(crate::transport::Event::SessionDeleted)
        .unwrap();
    m4.incoming = Some(ev_rx);
    let adopted_text = bound_with_adopt(&mut m4, &backend("ses_brand_new"), true);
    assert_eq!(adopted_text, "typed right before new blank");
    let Tab::Workspace(after_m4) = &m4.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace");
    };
    assert_eq!(
        after_m4.drafts.get("ses_brand_new").map(String::as_str),
        Some("typed right before new blank")
    );
    assert!(!after_m4.drafts.contains_key("ses_del_live"));

    // And unselect_session drains queued Event::SessionDeleted before dropping s.incoming.
    let mut m2 = draft_state();
    m2.draft = TextEdit::new(bound(&mut m2, &backend("ses_close_conv")));
    m2.show_chat();
    m2.draft = TextEdit::new("draft before close_session");
    let (ev_tx2, ev_rx2) = bounded(2);
    ev_tx2
        .try_send(crate::transport::Event::SessionDeleted)
        .unwrap();
    m2.incoming = Some(ev_rx2);
    assert!(unselect_session(&mut m2, "ses_close_conv"));
    let Tab::Workspace(after_m2) = &m2.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace");
    };
    assert_eq!(
        after_m2.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("draft before close_session")
    );

    // 5. Moyen 3: deferred pending_deleted proof retries via poll_pending_deleted even after
    // reopening a closed project carrying pending deletion proof.
    let mut m3 = draft_state();
    {
        let ui = m3.workspace.as_mut().unwrap();
        let closed_ws = closed("ses_retry_close", "survives close");
        let scope = super::ProjectScope::from_workspace(&closed_ws);
        ui.closed = vec![closed_ws];
        ui.closed_pending_deleted = vec![(scope, "ses_retry_close".into())];
    }
    reopen(&mut m3);
    assert!(super::super::drafts::poll_pending_deleted(&mut m3));
    let Tab::Workspace(after_m3) = &m3.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace");
    };
    assert_eq!(
        after_m3.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("survives close")
    );
    assert!(!after_m3.drafts.contains_key("ses_retry_close"));
    assert!(
        m3.workspace
            .as_ref()
            .unwrap()
            .closed_pending_deleted
            .is_empty()
    );
}

#[test]
fn closed_clear_preserves_independent_closed_draft_snapshot_legacy_marker_and_hook_proof() {
    use crate::workspace::NO_SESSION_DRAFT_ID;
    let mut tx = rune::Tx::default();

    // 1. R4 Bloquant: Tab A closes with its independent draft, then Tab B closes after clearing
    // a different copy for the same session. Both reopen and 404 recovery must keep Tab A's draft.
    for test_404 in [false, true] {
        let mut s = draft_state();
        let mut tab_a = closed("ses_close_indep", "");
        tab_a.drafts.clear();
        tab_a.active_session_id = Some("ses_close_indep".into());
        let mut tab_b = closed("ses_close_indep", "older copy in B");
        tab_b.occurrence = 1;
        tab_b.active_session_id = Some("ses_close_indep".into());
        let mut ui = Ui::new();
        ui.hydrate(crate::workspace::Snapshot {
            revision: 1,
            saved_at: 1,
            panel_widths: [None; 2],
            file_wrap: None,
            tabs: vec![Tab::Workspace(tab_a), Tab::Workspace(tab_b)],
            active: Some(0),
        });
        ui.ready = true;
        ui.entries[0].binding = Some(backend("ses_close_indep"));
        ui.entries[1].binding = Some(backend("ses_close_indep"));
        s.workspace = Some(ui);
        s.show_chat();
        s.draft = TextEdit::new("independent draft from A");
        capture(&mut s);
        close(&mut s, "tab-0", &mut tx);
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = false;
        }
        s.draft = TextEdit::new("");
        capture(&mut s);
        close(&mut s, "tab-1", &mut tx);
        if let Some(l) = s.screen.launcher_mut() {
            l.pending = false;
        }
        reopen(&mut s);
        if test_404 {
            s.show_launcher();
            assert!(recover_missing_session_draft(&mut s, "ses_close_indep"));
            let Tab::Workspace(after) = &s.workspace.as_ref().unwrap().entries[0].saved else {
                panic!("expected reopened workspace");
            };
            assert_eq!(
                after.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
                Some("independent draft from A")
            );
        } else {
            assert_eq!(
                bound(&mut s, &backend("ses_close_indep")),
                "independent draft from A"
            );
        }
    }

    // 2. R4 Moyen 1: B clears a restored copy then closes while A keeps its untouched restored
    // copy; saving a snapshot and restarting must NOT resurrect the cleared draft on 404.
    let mut snap_s = draft_state();
    let mut a_tab = closed("ses_closed_snap", "stale copy");
    a_tab.active_session_id = Some("ses_closed_snap".into());
    let mut b_tab = closed("ses_closed_snap", "stale copy");
    b_tab.occurrence = 1;
    b_tab.active_session_id = Some("ses_closed_snap".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a_tab), Tab::Workspace(b_tab)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_closed_snap"));
    ui.entries[1].binding = Some(backend("ses_closed_snap"));
    snap_s.workspace = Some(ui);
    snap_s.show_chat();
    snap_s.draft = TextEdit::new("stale copy");
    select(&mut snap_s, "tab-1", &mut tx);
    if let Some(l) = snap_s.screen.launcher_mut() {
        l.pending = false;
    }
    snap_s.draft = TextEdit::new("");
    capture(&mut snap_s);
    close(&mut snap_s, "tab-1", &mut tx);
    let bytes = crate::workspace::encode(&snap_s.workspace.as_ref().unwrap().snapshot()).unwrap();
    let mut restarted = draft_state();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes).unwrap());
    ui.ready = true;
    restarted.workspace = Some(ui);
    restarted.show_launcher();
    assert!(!recover_missing_session_draft(
        &mut restarted,
        "ses_closed_snap"
    ));

    // 3. R4 Moyen 4: Opening a legacy v1 attachment-only marker without attachmentParts payload
    // materializes SavedParts::missing() without stripping restored provenance, so a sibling
    // targeted clear still suppresses that untouched restored copy.
    let mut legacy_s = draft_state();
    let mut a_leg = closed("ses_legacy_marker", "with marker");
    a_leg.attachment_drafts.insert("ses_legacy_marker".into());
    a_leg.active_session_id = None;
    let mut b_leg = closed("ses_legacy_marker", "with marker");
    b_leg.occurrence = 1;
    b_leg.attachment_drafts.insert("ses_legacy_marker".into());
    b_leg.active_session_id = Some("ses_legacy_marker".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a_leg), Tab::Workspace(b_leg)],
        active: Some(0),
    });
    ui.ready = true;
    legacy_s.workspace = Some(ui);
    // Open `ses_legacy_marker` in Tab A (which runs bound + capture and materializes SavedParts::missing()).
    legacy_s.draft = TextEdit::new(bound(&mut legacy_s, &backend("ses_legacy_marker")));
    legacy_s.show_chat();
    capture(&mut legacy_s);
    // Switch to Tab B and clear the restored copy completely.
    select(&mut legacy_s, "tab-1", &mut tx);
    if let Some(l) = legacy_s.screen.launcher_mut() {
        l.pending = false;
    }
    legacy_s.workspace.as_mut().unwrap().entries[1].binding = Some(backend("ses_legacy_marker"));
    legacy_s.draft = TextEdit::new("");
    legacy_s.composer.draft.attachments.clear();
    legacy_s.composer.attachments_missing = false;
    capture(&mut legacy_s);
    // Leave active chat in Tab A and trigger 404: untouched legacy marker copy must stay suppressed.
    select(&mut legacy_s, "tab-0", &mut tx);
    legacy_s.show_launcher();
    assert!(!recover_missing_session_draft(
        &mut legacy_s,
        "ses_legacy_marker"
    ));

    // 4. R4 Moyen 3: session_deleted_hook delivers deletion proof independently of s.incoming
    // receiver lifetime (even after the conversation receiver is dropped or replaced).
    let mut hook_s = draft_state();
    hook_s.draft = TextEdit::new(bound(&mut hook_s, &backend("ses_hook_race")));
    hook_s.show_chat();
    hook_s.draft = TextEdit::new("draft during receiver replacement");
    capture(&mut hook_s);
    let hook = session_deleted_hook(&hook_s, "ses_hook_race").expect("hook created");
    // Drop receiver and switch to another session before late hook fires.
    hook_s.incoming = None;
    let _ = bound(&mut hook_s, &backend("ses_other_session"));
    hook();
    assert!(super::super::drafts::drain_window_deleted_sessions(
        &mut hook_s
    ));
    let Tab::Workspace(after_hook) = &hook_s.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected workspace");
    };
    assert_eq!(
        after_hook
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("draft during receiver replacement")
    );
    assert!(!after_hook.drafts.contains_key("ses_hook_race"));

    // 5. R5 Bloquant: A closes with independent draft, B closes with restored copy, C (still open)
    // clears that restored copy and receives 404 before closing -> A's independent closed draft
    // must be recovered and B's cleared copy must NOT overwrite or purge it.
    let mut r5_b = draft_state();
    let mut a_ind = closed("ses_r5_bloq", "");
    a_ind.drafts.clear();
    a_ind.active_session_id = Some("ses_r5_bloq".into());
    let mut b_res = closed("ses_r5_bloq", "stale restored");
    b_res.occurrence = 1;
    b_res.active_session_id = None;
    let mut c_clr = closed("ses_r5_bloq", "stale restored");
    c_clr.occurrence = 2;
    c_clr.active_session_id = Some("ses_r5_bloq".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![
            Tab::Workspace(a_ind),
            Tab::Workspace(b_res),
            Tab::Workspace(c_clr),
        ],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r5_bloq"));
    ui.entries[2].binding = Some(backend("ses_r5_bloq"));
    r5_b.workspace = Some(ui);
    r5_b.show_chat();
    r5_b.draft = TextEdit::new("independent from closed A");
    capture(&mut r5_b);
    close(&mut r5_b, "tab-0", &mut tx);
    if let Some(l) = r5_b.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r5_b, "tab-1", &mut tx);
    if let Some(l) = r5_b.screen.launcher_mut() {
        l.pending = false;
    }
    // Tab C is now active (index 0); clear its restored copy and receive 404 before closing.
    r5_b.draft = TextEdit::new("");
    capture(&mut r5_b);
    r5_b.show_launcher();
    assert!(recover_missing_session_draft(&mut r5_b, "ses_r5_bloq"));
    let Tab::Workspace(after_c) = &r5_b.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected tab C");
    };
    assert_eq!(
        after_c.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("independent from closed A")
    );

    // 6. R5 Moyen 2: After manual unselect_session (previous == None), a late session_deleted_hook
    // proof queued in the same frame is drained BEFORE adopt_recovered_draft on bound_with_adopt.
    let mut r5_m2 = draft_state();
    r5_m2.draft = TextEdit::new(bound(&mut r5_m2, &backend("ses_manual_then_del")));
    r5_m2.show_chat();
    r5_m2.draft = TextEdit::new("draft after manual close");
    let late_hook = session_deleted_hook(&r5_m2, "ses_manual_then_del").expect("hook");
    assert!(unselect_session(&mut r5_m2, "ses_manual_then_del"));
    r5_m2.show_launcher();
    late_hook();
    let adopted = bound_with_adopt(&mut r5_m2, &backend("ses_fresh_blank"), true);
    assert_eq!(adopted, "draft after manual close");

    // 7. R5 Moyen 3: Tab A is on the launcher with a restored copy (+ attachment marker);
    // Tab B clears that copy and closes; opening the session in Tab A must open EMPTY.
    let mut r5_m3 = draft_state();
    let mut a_wait = closed("ses_open_empty", "cleared elsewhere");
    a_wait.attachment_drafts.insert("ses_open_empty".into());
    a_wait.active_session_id = None;
    let mut b_clear = closed("ses_open_empty", "cleared elsewhere");
    b_clear.occurrence = 1;
    b_clear.attachment_drafts.insert("ses_open_empty".into());
    b_clear.active_session_id = Some("ses_open_empty".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a_wait), Tab::Workspace(b_clear)],
        active: Some(1),
    });
    ui.ready = true;
    ui.entries[1].binding = Some(backend("ses_open_empty"));
    r5_m3.workspace = Some(ui);
    r5_m3.draft = TextEdit::new("");
    r5_m3.composer.draft.attachments.clear();
    r5_m3.composer.attachments_missing = false;
    capture(&mut r5_m3);
    close(&mut r5_m3, "tab-1", &mut tx);
    if let Some(l) = r5_m3.screen.launcher_mut() {
        l.pending = false;
    }
    // Tab A is now active on launcher; opening `ses_open_empty` must NOT reload cleared text/attachments.
    let loaded = bound(&mut r5_m3, &backend("ses_open_empty"));
    assert_eq!(loaded, "");
    assert!(!r5_m3.composer.attachments_missing);

    // 8. R6 Bloquant: A closes with independent draft, B closes with restored copy, C (still open)
    // clears that restored copy, then 4th tab D opens & binds the session -> D must receive A's
    // independent draft (not B's cleared copy), and a subsequent 404 must recover A's draft.
    let mut r6_b = draft_state();
    let mut a6 = closed("ses_r6_bloq", "");
    a6.drafts.clear();
    a6.active_session_id = Some("ses_r6_bloq".into());
    let mut b6 = closed("ses_r6_bloq", "stale copy");
    b6.occurrence = 1;
    b6.active_session_id = None;
    let mut c6 = closed("ses_r6_bloq", "stale copy");
    c6.occurrence = 2;
    c6.active_session_id = Some("ses_r6_bloq".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a6), Tab::Workspace(b6), Tab::Workspace(c6)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r6_bloq"));
    ui.entries[2].binding = Some(backend("ses_r6_bloq"));
    r6_b.workspace = Some(ui);
    r6_b.show_chat();
    r6_b.draft = TextEdit::new("independent closed A");
    capture(&mut r6_b);
    close(&mut r6_b, "tab-0", &mut tx);
    if let Some(l) = r6_b.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r6_b, "tab-1", &mut tx);
    if let Some(l) = r6_b.screen.launcher_mut() {
        l.pending = false;
    }
    // Tab C clears its restored copy without closing.
    r6_b.draft = TextEdit::new("");
    capture(&mut r6_b);
    // Open a 4th tab D for the same project and bind `ses_r6_bloq`.
    new_tab(&mut r6_b, &mut tx);
    if let Some(l) = r6_b.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r6_b,
        &Project {
            id: "proj-d".into(),
            path: "/fixture".into(),
        },
    );
    let delivered = bound(&mut r6_b, &backend("ses_r6_bloq"));
    assert_eq!(delivered, "independent closed A");
    r6_b.show_launcher();
    assert!(recover_missing_session_draft(&mut r6_b, "ses_r6_bloq"));
    let Tab::Workspace(after_d) = &r6_b.workspace.as_ref().unwrap().entries[1].saved else {
        panic!("expected tab D");
    };
    assert_eq!(
        after_d.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("independent closed A")
    );

    // 9. R6 Moyen 1: Clearing tab already holds MAX_DRAFTS (24) recovered drafts -> snapshot
    // directly prunes the sibling's targeted restored copy so per-tab shedding cannot undo the clear.
    let mut r6_m1 = draft_state();
    let mut a_full = closed("ses_full_clr", "stale copy");
    a_full.active_session_id = None;
    let mut b_full = closed("ses_full_clr", "stale copy");
    b_full.occurrence = 1;
    b_full.active_session_id = Some("ses_full_clr".into());
    for i in 0..crate::workspace::MAX_DRAFTS {
        b_full.drafts.insert(
            format!(
                "{}{i:08x}-1234-4234-8234-123456789abc",
                crate::workspace::RECOVERED_DRAFT_PREFIX
            ),
            format!("rec-{i}"),
        );
    }
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a_full), Tab::Workspace(b_full)],
        active: Some(1),
    });
    ui.ready = true;
    ui.entries[1].binding = Some(backend("ses_full_clr"));
    r6_m1.workspace = Some(ui);
    r6_m1.draft = TextEdit::new("");
    capture(&mut r6_m1);
    let (bytes, _) =
        crate::workspace::encode_for_save(&r6_m1.workspace.as_ref().unwrap().snapshot()).unwrap();
    let mut restarted_full = draft_state();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes).unwrap());
    ui.ready = true;
    restarted_full.workspace = Some(ui);
    restarted_full.show_launcher();
    assert!(!recover_missing_session_draft(
        &mut restarted_full,
        "ses_full_clr"
    ));

    // 10. R7 Bloquant: Tab A closes with text-only, then Tab B closes with attachment-only for the
    // same session -> reopening / 404 recovery must deliver B's atomic attachment-only bundle
    // without stitching A's old text onto B's attachments.
    let mut r7_b = draft_state();
    let mut tab_a = closed("ses_r7_atomic", "old text from A");
    tab_a.active_session_id = Some("ses_r7_atomic".into());
    let mut tab_b = closed("ses_r7_atomic", "");
    tab_b.drafts.clear();
    tab_b.occurrence = 1;
    tab_b.active_session_id = Some("ses_r7_atomic".into());
    tab_b.attachment_drafts.insert("ses_r7_atomic".into());
    tab_b.attachment_parts.insert(
        "ses_r7_atomic".into(),
        crate::composer::draft_storage::SavedParts::missing(),
    );
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(tab_a), Tab::Workspace(tab_b)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r7_atomic"));
    ui.entries[1].binding = Some(backend("ses_r7_atomic"));
    r7_b.workspace = Some(ui);
    r7_b.show_chat();
    r7_b.draft = TextEdit::new("old text from A");
    capture(&mut r7_b);
    close(&mut r7_b, "tab-0", &mut tx);
    if let Some(l) = r7_b.screen.launcher_mut() {
        l.pending = false;
    }
    r7_b.draft = TextEdit::new("");
    r7_b.composer.attachments_missing = true;
    capture(&mut r7_b);
    close(&mut r7_b, "tab-1", &mut tx);
    if let Some(l) = r7_b.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r7_b,
        &Project {
            id: "proj-r7b".into(),
            path: "/fixture".into(),
        },
    );
    let delivered = bound(&mut r7_b, &backend("ses_r7_atomic"));
    assert_eq!(
        delivered, "",
        "must not stitch A's text onto B's attachments"
    );
    assert!(r7_b.composer.attachments_missing);

    // 11. R7 Moyen 1: Tab B closes with restored copy, Tab C clears it open, Tab D reopens
    // (filtering out B's copy), THEN Tab E closes with an independent draft before D binds ->
    // binding in D still revalidates `ui.closed` and delivers E's independent draft.
    let mut r7_m1 = draft_state();
    let mut b7 = closed("ses_r7_pend", "stale restored");
    b7.active_session_id = None;
    let mut c7 = closed("ses_r7_pend", "stale restored");
    c7.occurrence = 1;
    c7.active_session_id = Some("ses_r7_pend".into());
    let mut e7 = closed("ses_r7_pend", "");
    e7.drafts.clear();
    e7.occurrence = 2;
    e7.active_session_id = Some("ses_r7_pend".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(b7), Tab::Workspace(c7), Tab::Workspace(e7)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[1].binding = Some(backend("ses_r7_pend"));
    ui.entries[2].binding = Some(backend("ses_r7_pend"));
    r7_m1.workspace = Some(ui);
    r7_m1.show_chat();
    close(&mut r7_m1, "tab-0", &mut tx);
    if let Some(l) = r7_m1.screen.launcher_mut() {
        l.pending = false;
    }
    // Tab C (now index 0) clears its restored copy without closing.
    r7_m1.draft = TextEdit::new("");
    capture(&mut r7_m1);
    // Open Tab D for the same project (B's closed copy is filtered out by C's clear).
    new_tab(&mut r7_m1, &mut tx);
    if let Some(l) = r7_m1.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r7_m1,
        &Project {
            id: "proj-r7m1".into(),
            path: "/fixture".into(),
        },
    );
    // Switch to Tab E (index 1), author an independent draft, and close Tab E before D binds.
    select(&mut r7_m1, "tab-2", &mut tx);
    if let Some(l) = r7_m1.screen.launcher_mut() {
        l.pending = false;
    }
    r7_m1.show_chat();
    r7_m1.draft = TextEdit::new("independent from E");
    capture(&mut r7_m1);
    close(&mut r7_m1, "tab-2", &mut tx);
    if let Some(l) = r7_m1.screen.launcher_mut() {
        l.pending = false;
    }
    // Now switch to Tab D (the opened tab) and bind `ses_r7_pend`: must receive E's draft.
    select(&mut r7_m1, "tab-3", &mut tx);
    assert_eq!(r7_m1.workspace.as_ref().unwrap().entries.len(), 2);
    assert_eq!(r7_m1.workspace.as_ref().unwrap().active_key(), "tab-3");
    let delivered = bound(&mut r7_m1, &backend("ses_r7_pend"));
    assert_eq!(delivered, "independent from E");

    // 12. R7 Moyen 2: Snapshot already at MAX_STRINGS with stale sibling copy in Tab A and a clear
    // in Tab B (< MAX_DRAFTS) -> Ui::snapshot() prunes Tab A directly instead of emitting a
    // sheddable "" tombstone, so encode_for_save + restart + 404 cannot resurrect Tab A's copy.
    let mut r7_m2 = draft_state();
    let mut a_str = closed("ses_r7_str", "stale copy");
    a_str.active_session_id = Some("ses_r7_str".into());
    let mut b_str = closed("ses_r7_str", "stale copy");
    b_str.occurrence = 1;
    b_str.active_session_id = Some("ses_r7_str".into());
    b_str
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), "b".repeat(144));
    let mut tabs_str = vec![Tab::Workspace(a_str), Tab::Workspace(b_str)];
    for i in 0..24 {
        let mut filler = closed("ses_fill", "");
        filler.drafts.clear();
        filler.active_session_id = None;
        filler.occurrence = (i + 2) as u64;
        filler.folder = format!("/s{i:02}/{}", "m".repeat(4_060));
        tabs_str.push(Tab::Workspace(filler));
    }
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: tabs_str,
        active: Some(1),
    });
    ui.ready = true;
    ui.entries[1].binding = Some(backend("ses_r7_str"));
    r7_m2.workspace = Some(ui);
    r7_m2.draft = TextEdit::new("");
    capture(&mut r7_m2);
    let snap_m2 = r7_m2.workspace.as_ref().unwrap().snapshot();
    assert!(
        matches!(&snap_m2.tabs[0], Tab::Workspace(w) if !w.drafts.contains_key("ses_r7_str")),
        "tombstone overflow must directly prune Tab A's stale copy"
    );
    let (bytes_m2, _) = crate::workspace::encode_for_save(&snap_m2).unwrap();
    let mut restarted_m2 = draft_state();
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::decode(&bytes_m2).unwrap());
    ui.ready = true;
    restarted_m2.workspace = Some(ui);
    restarted_m2.show_launcher();
    assert!(!recover_missing_session_draft(
        &mut restarted_m2,
        "ses_r7_str"
    ));

    // 13. R8 Bloquant: Tab A closes with independent text, then Tab B closes with an untouched
    // restored attachment-only copy for the same session -> reopen AND 404 recovery must prefer
    // A's independent draft rather than clobbering it with B's restored copy.
    let mut r8_b = draft_state();
    let mut tab_a8 = closed("ses_r8_indep", "");
    tab_a8.drafts.clear();
    tab_a8.active_session_id = Some("ses_r8_indep".into());
    let mut tab_b8 = closed("ses_r8_indep", "");
    tab_b8.drafts.clear();
    tab_b8.occurrence = 1;
    tab_b8.active_session_id = None;
    tab_b8.attachment_drafts.insert("ses_r8_indep".into());
    tab_b8.attachment_parts.insert(
        "ses_r8_indep".into(),
        crate::composer::draft_storage::SavedParts::missing(),
    );
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(tab_a8), Tab::Workspace(tab_b8)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r8_indep"));
    r8_b.workspace = Some(ui);
    r8_b.show_chat();
    r8_b.draft = TextEdit::new("independent text from A");
    capture(&mut r8_b);
    close(&mut r8_b, "tab-0", &mut tx);
    if let Some(l) = r8_b.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r8_b, "tab-1", &mut tx);
    if let Some(l) = r8_b.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r8_b,
        &Project {
            id: "proj-r8b".into(),
            path: "/fixture".into(),
        },
    );
    assert!(recover_missing_session_draft(&mut r8_b, "ses_r8_indep"));
    let Tab::Workspace(after_r8) = &r8_b.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected reopened tab");
    };
    assert_eq!(
        after_r8.drafts.get(NO_SESSION_DRAFT_ID).map(String::as_str),
        Some("independent text from A")
    );
    assert!(!after_r8.attachment_drafts.contains(NO_SESSION_DRAFT_ID));
    assert!(
        after_r8
            .attachment_drafts
            .iter()
            .any(|k| crate::workspace::is_recovered_draft_id(k)),
        "R9 Bloquant 1a: B's distinct restored attachment-only draft must also be recovered separately"
    );

    // 14. R8 Moyen 1: A valid v1 snapshot where Tab B has drafts[id] = "" alongside an attachment
    // marker and Tab A has text for the same session must NOT treat Tab B as a clear tombstone or
    // prune Tab A's text even when snapshot budgets are exceeded.
    let mut r8_m1 = draft_state();
    let mut a8_m1 = closed("ses_r8_att_empty", "text from A");
    a8_m1.active_session_id = Some("ses_r8_att_empty".into());
    let mut b8_m1 = closed("ses_r8_att_empty", "");
    b8_m1.occurrence = 1;
    b8_m1.active_session_id = Some("ses_r8_att_empty".into());
    b8_m1.attachment_drafts.insert("ses_r8_att_empty".into());
    b8_m1
        .drafts
        .insert(NO_SESSION_DRAFT_ID.into(), "b".repeat(160));
    let mut tabs_r8 = vec![Tab::Workspace(a8_m1), Tab::Workspace(b8_m1)];
    for i in 0..24 {
        let mut filler = closed("ses_fill", "");
        filler.drafts.clear();
        filler.active_session_id = None;
        filler.occurrence = (i + 2) as u64;
        filler.folder = format!("/r{i:02}/{}", "m".repeat(4_060));
        tabs_r8.push(Tab::Workspace(filler));
    }
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: tabs_r8,
        active: Some(1),
    });
    ui.ready = true;
    r8_m1.workspace = Some(ui);
    let snap_r8 = r8_m1.workspace.as_ref().unwrap().snapshot();
    assert_eq!(
        match &snap_r8.tabs[0] {
            Tab::Workspace(w) => w.drafts.get("ses_r8_att_empty").map(String::as_str),
            _ => None,
        },
        Some("text from A")
    );

    // 15. R9 Bloquant 1b: Same distinct A (independent text) + B (restored attachment-only)
    // closed scenario, but user reopens and binds the session first -> A is delivered while B
    // remains intact in ui.closed; a subsequent 404 recovers BOTH A and B into separate slots.
    let mut r9_b1 = draft_state();
    let mut a9_1 = closed("ses_r9_keep_b", "");
    a9_1.drafts.clear();
    a9_1.active_session_id = Some("ses_r9_keep_b".into());
    let mut b9_1 = closed("ses_r9_keep_b", "");
    b9_1.drafts.clear();
    b9_1.occurrence = 1;
    b9_1.active_session_id = None;
    b9_1.attachment_drafts.insert("ses_r9_keep_b".into());
    b9_1.attachment_parts.insert(
        "ses_r9_keep_b".into(),
        crate::composer::draft_storage::SavedParts::missing(),
    );
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a9_1), Tab::Workspace(b9_1)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r9_keep_b"));
    r9_b1.workspace = Some(ui);
    r9_b1.show_chat();
    r9_b1.draft = TextEdit::new("independent A on bind");
    capture(&mut r9_b1);
    close(&mut r9_b1, "tab-0", &mut tx);
    if let Some(l) = r9_b1.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r9_b1, "tab-1", &mut tx);
    if let Some(l) = r9_b1.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r9_b1,
        &Project {
            id: "proj-r9b1".into(),
            path: "/fixture".into(),
        },
    );
    let delivered = bound(&mut r9_b1, &backend("ses_r9_keep_b"));
    assert_eq!(delivered, "independent A on bind");
    r9_b1.show_launcher();
    assert!(recover_missing_session_draft(&mut r9_b1, "ses_r9_keep_b"));
    let Tab::Workspace(after_r9_1) = &r9_b1.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected reopened tab");
    };
    let has_a = after_r9_1
        .drafts
        .values()
        .any(|v| v == "independent A on bind");
    let has_b = after_r9_1.attachment_drafts.iter().any(|k| {
        (k == NO_SESSION_DRAFT_ID || crate::workspace::is_recovered_draft_id(k))
            && !after_r9_1.drafts.contains_key(k)
    });
    assert!(has_a && has_b, "both A and B must survive 404 after bind");

    // 16. R9 Bloquant 2: Restore X in A, B, D. In A, edit X -> Y -> X (becomes independent while
    // retaining derived_from = X). Close A, close B, leave D open. Reopen in C & bind -> C gets A
    // WITH derived_from = X; clearing C yields Copy(X) so a 404 suppresses D's copy X.
    let mut r9_b2 = draft_state();
    let mut a9_2 = closed("ses_r9_deriv", "draft X");
    a9_2.active_session_id = Some("ses_r9_deriv".into());
    let mut b9_2 = closed("ses_r9_deriv", "draft X");
    b9_2.occurrence = 1;
    b9_2.active_session_id = None;
    let mut d9_2 = closed("ses_r9_deriv", "draft X");
    d9_2.occurrence = 2;
    d9_2.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![
            Tab::Workspace(a9_2),
            Tab::Workspace(b9_2),
            Tab::Workspace(d9_2),
        ],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r9_deriv"));
    r9_b2.workspace = Some(ui);
    r9_b2.show_chat();
    r9_b2.draft = TextEdit::new("draft Y");
    capture(&mut r9_b2);
    r9_b2.draft = TextEdit::new("draft X");
    capture(&mut r9_b2);
    close(&mut r9_b2, "tab-0", &mut tx);
    if let Some(l) = r9_b2.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r9_b2, "tab-1", &mut tx);
    if let Some(l) = r9_b2.screen.launcher_mut() {
        l.pending = false;
    }
    new_tab(&mut r9_b2, &mut tx);
    if let Some(l) = r9_b2.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r9_b2,
        &Project {
            id: "proj-r9b2".into(),
            path: "/fixture".into(),
        },
    );
    let delivered = bound(&mut r9_b2, &backend("ses_r9_deriv"));
    assert_eq!(delivered, "draft X");
    r9_b2.show_chat();
    r9_b2.draft = TextEdit::new("");
    capture(&mut r9_b2);
    r9_b2.show_launcher();
    assert!(
        !recover_missing_session_draft(&mut r9_b2, "ses_r9_deriv"),
        "clearing C must carry derived_from = X and suppress D's untouched copy on 404"
    );

    // 17. R10 Bloquant: Restore X in two tabs with attachment_drafts marker and NO attachment_parts.
    // Edit X -> Y in Tab 0, close both tabs, reopen and hit 404 -> must recover ONLY Y and never
    // resurrect X despite None vs Some(SavedParts::missing()) representation difference.
    let mut r10_b = draft_state();
    let mut a10 = closed("ses_r10_norm", "draft X");
    a10.active_session_id = Some("ses_r10_norm".into());
    a10.attachment_drafts.insert("ses_r10_norm".into());
    let mut b10 = closed("ses_r10_norm", "draft X");
    b10.occurrence = 1;
    b10.active_session_id = None;
    b10.attachment_drafts.insert("ses_r10_norm".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a10), Tab::Workspace(b10)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r10_norm"));
    r10_b.workspace = Some(ui);
    r10_b.show_chat();
    r10_b.draft = TextEdit::new("draft Y");
    r10_b.composer.attachments_missing = true;
    capture(&mut r10_b);
    close(&mut r10_b, "tab-0", &mut tx);
    if let Some(l) = r10_b.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r10_b, "tab-1", &mut tx);
    if let Some(l) = r10_b.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r10_b,
        &Project {
            id: "proj-r10b".into(),
            path: "/fixture".into(),
        },
    );
    assert!(recover_missing_session_draft(&mut r10_b, "ses_r10_norm"));
    let Tab::Workspace(after_r10) = &r10_b.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected reopened tab");
    };
    assert_eq!(
        after_r10
            .drafts
            .get(NO_SESSION_DRAFT_ID)
            .map(String::as_str),
        Some("draft Y")
    );
    assert!(
        !after_r10.drafts.values().any(|v| v == "draft X"),
        "normalized provenance must suppress superseded X instead of resurrecting it"
    );

    // 18. R10 Moyen 1: Close two tabs with distinct drafts for the same session, then open C and D
    // before binding. Binding in C delivers the first draft while rearming D's pending_drafts so
    // binding in D delivers the second remaining closed draft.
    let mut r10_m1 = draft_state();
    let mut a10_1 = closed("ses_r10_order", "");
    a10_1.drafts.clear();
    a10_1.active_session_id = Some("ses_r10_order".into());
    let mut b10_1 = closed("ses_r10_order", "");
    b10_1.drafts.clear();
    b10_1.occurrence = 1;
    b10_1.active_session_id = Some("ses_r10_order".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a10_1), Tab::Workspace(b10_1)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r10_order"));
    ui.entries[1].binding = Some(backend("ses_r10_order"));
    r10_m1.workspace = Some(ui);
    r10_m1.show_chat();
    r10_m1.draft = TextEdit::new("distinct first");
    capture(&mut r10_m1);
    close(&mut r10_m1, "tab-0", &mut tx);
    if let Some(l) = r10_m1.screen.launcher_mut() {
        l.pending = false;
    }
    r10_m1.show_chat();
    r10_m1.draft = TextEdit::new("distinct second");
    capture(&mut r10_m1);
    close(&mut r10_m1, "tab-1", &mut tx);
    if let Some(l) = r10_m1.screen.launcher_mut() {
        l.pending = false;
    }
    // Open C (tab-2) and D (tab-3) before binding the session in either tab.
    opened(
        &mut r10_m1,
        &Project {
            id: "proj-r10-c".into(),
            path: "/fixture".into(),
        },
    );
    new_tab(&mut r10_m1, &mut tx);
    if let Some(l) = r10_m1.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r10_m1,
        &Project {
            id: "proj-r10-d".into(),
            path: "/fixture".into(),
        },
    );
    select(&mut r10_m1, "tab-2", &mut tx);
    if let Some(l) = r10_m1.screen.launcher_mut() {
        l.pending = false;
    }
    let first_delivered = bound(&mut r10_m1, &backend("ses_r10_order"));
    assert_eq!(first_delivered, "distinct second");
    // R11 Bloquant: snapshot taken BEFORE D binds must already carry the remaining closed draft
    // on D so a restart before D binds never loses "distinct first".
    let snap_before_d = r10_m1.workspace.as_ref().unwrap().snapshot();
    assert_eq!(
        match &snap_before_d.tabs[1] {
            Tab::Workspace(w) => w.drafts.get("ses_r10_order").map(String::as_str),
            _ => None,
        },
        Some("distinct first"),
        "rearmed sibling D must hold the remaining closed draft in its snapshot before binding"
    );
    select(&mut r10_m1, "tab-3", &mut tx);
    if let Some(l) = r10_m1.screen.launcher_mut() {
        l.pending = false;
    }
    let second_delivered = bound(&mut r10_m1, &backend("ses_r10_order"));
    assert_eq!(second_delivered, "distinct first");

    // 19. R12 Bloquant + Moyen 1:
    // (a) Close 3 tabs with 3 distinct drafts, open 3 tabs (C, D, E), bind C -> snapshot before
    // D or E binds must project ONE distinct remaining draft onto D and ONE onto E (all 3 survive).
    // (b) Open an extra 4th tab F for the same project before restarting -> F must NOT duplicate
    // any projected closed draft in the snapshot (1 projection per closed source).
    let mut r12 = draft_state();
    let mut t0 = closed("ses_r12_three", "");
    t0.drafts.clear();
    t0.active_session_id = Some("ses_r12_three".into());
    let mut t1 = closed("ses_r12_three", "");
    t1.drafts.clear();
    t1.occurrence = 1;
    t1.active_session_id = Some("ses_r12_three".into());
    let mut t2 = closed("ses_r12_three", "");
    t2.drafts.clear();
    t2.occurrence = 2;
    t2.active_session_id = Some("ses_r12_three".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(t0), Tab::Workspace(t1), Tab::Workspace(t2)],
        active: Some(0),
    });
    ui.ready = true;
    for i in 0..3 {
        ui.entries[i].binding = Some(backend("ses_r12_three"));
    }
    r12.workspace = Some(ui);
    for (key, text) in [
        ("tab-0", "draft one"),
        ("tab-1", "draft two"),
        ("tab-2", "draft three"),
    ] {
        r12.show_chat();
        r12.draft = TextEdit::new(text);
        capture(&mut r12);
        close(&mut r12, key, &mut tx);
        if let Some(l) = r12.screen.launcher_mut() {
            l.pending = false;
        }
    }
    // Open C (tab-3), D (tab-4), E (tab-5).
    for id in ["proj-r12-c", "proj-r12-d", "proj-r12-e"] {
        if id != "proj-r12-c" {
            new_tab(&mut r12, &mut tx);
            if let Some(l) = r12.screen.launcher_mut() {
                l.pending = false;
            }
        }
        opened(
            &mut r12,
            &Project {
                id: id.into(),
                path: "/fixture".into(),
            },
        );
    }
    // Bind C (tab-3): receives "draft three", while D and E project "draft two" and "draft one".
    select(&mut r12, "tab-3", &mut tx);
    if let Some(l) = r12.screen.launcher_mut() {
        l.pending = false;
    }
    r12.show_chat();
    r12.draft = TextEdit::new(bound(&mut r12, &backend("ses_r12_three")));
    assert_eq!(r12.draft.text, "draft three");
    capture(&mut r12);
    let snap_3 = r12.workspace.as_ref().unwrap().snapshot();
    let texts_3: Vec<&str> = snap_3
        .tabs
        .iter()
        .filter_map(|t| match t {
            Tab::Workspace(w) => w.drafts.get("ses_r12_three").map(String::as_str),
            _ => None,
        })
        .collect();
    assert_eq!(texts_3.len(), 3);
    assert!(texts_3.contains(&"draft three"));
    assert!(texts_3.contains(&"draft two"));
    assert!(texts_3.contains(&"draft one"));

    // Open a 4th tab F before restart: still only 3 snapshot entries (zero duplication!).
    new_tab(&mut r12, &mut tx);
    if let Some(l) = r12.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r12,
        &Project {
            id: "proj-r12-f".into(),
            path: "/fixture".into(),
        },
    );
    let snap_4 = r12.workspace.as_ref().unwrap().snapshot();
    let bytes_4 = crate::workspace::encode(&snap_4).unwrap();
    let mut hydrated_4 = Ui::new();
    hydrated_4.hydrate(crate::workspace::decode(&bytes_4).unwrap());
    let mut texts_4: Vec<&str> = hydrated_4
        .entries
        .iter()
        .filter_map(|e| match &e.saved {
            Tab::Workspace(w) => w.drafts.get("ses_r12_three").map(String::as_str),
            _ => None,
        })
        .collect();
    texts_4.sort_unstable();
    assert_eq!(
        texts_4,
        vec!["draft one", "draft three", "draft two"],
        "extra reopened tab must not duplicate or displace any of the 3 distinct drafts across restart"
    );

    // 20. R13 Bloquant 1: Closing two tabs with distinct restored drafts A then B and reopening
    // a single tab must project B (newest, matching direct delivery), not A.
    let mut r13_b1 = draft_state();
    let mut a13 = closed("ses_r13_order", "restored A");
    a13.active_session_id = None;
    let mut b13 = closed("ses_r13_order", "restored B");
    b13.occurrence = 1;
    b13.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a13), Tab::Workspace(b13)],
        active: Some(0),
    });
    ui.ready = true;
    r13_b1.workspace = Some(ui);
    close(&mut r13_b1, "tab-0", &mut tx);
    if let Some(l) = r13_b1.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r13_b1, "tab-1", &mut tx);
    if let Some(l) = r13_b1.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r13_b1,
        &Project {
            id: "proj-r13-b1".into(),
            path: "/fixture".into(),
        },
    );
    let snap_b1 = r13_b1.workspace.as_ref().unwrap().snapshot();
    let bytes_b1 = crate::workspace::encode(&snap_b1).unwrap();
    let mut hydrated_b1 = Ui::new();
    hydrated_b1.hydrate(crate::workspace::decode(&bytes_b1).unwrap());
    let Tab::Workspace(reopened_b1) = &hydrated_b1.entries[0].saved else {
        panic!("expected workspace");
    };
    assert_eq!(
        reopened_b1.drafts.get("ses_r13_order").map(String::as_str),
        Some("restored B"),
        "single reopened tab must project newest restored draft B matching direct delivery"
    );

    // 21. R13 Bloquant 2:
    // (a) Closing tab E (which never had pending_drafts) with a new draft must immediately
    // project onto already-open pending tab D so restarting before D binds keeps E's draft.
    // (b) Clearing a restored copy on open sibling C via capture must immediately promote the
    // next eligible closed candidate onto pending tab D before restart.
    let mut r13_b2 = draft_state();
    let mut b2_res = closed("ses_r13_sync", "stale restored");
    b2_res.active_session_id = None;
    let mut c2_clr = closed("ses_r13_sync", "stale restored");
    c2_clr.occurrence = 1;
    c2_clr.active_session_id = Some("ses_r13_sync".into());
    let mut e2_ind = closed("ses_r13_sync", "");
    e2_ind.drafts.clear();
    e2_ind.occurrence = 2;
    e2_ind.active_session_id = Some("ses_r13_sync".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![
            Tab::Workspace(b2_res),
            Tab::Workspace(c2_clr),
            Tab::Workspace(e2_ind),
        ],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[1].binding = Some(backend("ses_r13_sync"));
    ui.entries[2].binding = Some(backend("ses_r13_sync"));
    r13_b2.workspace = Some(ui);
    r13_b2.show_chat();
    // Close B (restored), open D (projects B's restored copy initially), then close E with an
    // independent draft (E has no pending_drafts) -> D must project E's independent draft.
    close(&mut r13_b2, "tab-0", &mut tx);
    if let Some(l) = r13_b2.screen.launcher_mut() {
        l.pending = false;
    }
    new_tab(&mut r13_b2, &mut tx);
    if let Some(l) = r13_b2.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r13_b2,
        &Project {
            id: "proj-r13-d".into(),
            path: "/fixture".into(),
        },
    );
    // Switch to E (tab-2), author independent draft, and close E before D binds.
    select(&mut r13_b2, "tab-2", &mut tx);
    if let Some(l) = r13_b2.screen.launcher_mut() {
        l.pending = false;
    }
    r13_b2.show_chat();
    r13_b2.draft = TextEdit::new("from E without pending");
    capture(&mut r13_b2);
    close(&mut r13_b2, "tab-2", &mut tx);
    if let Some(l) = r13_b2.screen.launcher_mut() {
        l.pending = false;
    }
    // Verify D immediately projects E's draft right after E closes, before any other capture.
    let snap_b2_immediate = r13_b2.workspace.as_ref().unwrap().snapshot();
    let bytes_b2_immediate = crate::workspace::encode(&snap_b2_immediate).unwrap();
    let mut hydrated_b2_immediate = Ui::new();
    hydrated_b2_immediate.hydrate(crate::workspace::decode(&bytes_b2_immediate).unwrap());
    assert!(
        hydrated_b2_immediate.entries.iter().any(|e| matches!(
            &e.saved,
            Tab::Workspace(w) if w.drafts.get("ses_r13_sync").map(String::as_str) == Some("from E without pending")
        )),
        "closing E without pending_drafts must immediately project E's draft onto pending tab D"
    );
    // Switch to C (tab-1) and clear its restored copy -> D still keeps E's independent draft.
    select(&mut r13_b2, "tab-1", &mut tx);
    if let Some(l) = r13_b2.screen.launcher_mut() {
        l.pending = false;
    }
    r13_b2.show_chat();
    r13_b2.draft = TextEdit::new("");
    capture(&mut r13_b2);
    let snap_b2 = r13_b2.workspace.as_ref().unwrap().snapshot();
    let bytes_b2 = crate::workspace::encode(&snap_b2).unwrap();
    let mut hydrated_b2 = Ui::new();
    hydrated_b2.hydrate(crate::workspace::decode(&bytes_b2).unwrap());
    assert!(
        hydrated_b2.entries.iter().any(|e| matches!(
            &e.saved,
            Tab::Workspace(w) if w.drafts.get("ses_r13_sync").map(String::as_str) == Some("from E without pending")
        )),
        "closing E without pending_drafts must project E's draft onto pending tab D before restart"
    );

    // 21b. R13 Bloquant 2b: Pending tab D initially projects newest closed restored copy while an
    // older restored copy sits behind it; clearing the projected copy on open sibling C via
    // capture must immediately shift D's projection to the next candidate before restart.
    let mut r13_b2c = draft_state();
    let mut r_old = closed("ses_r13_clrshift", "restored old");
    r_old.active_session_id = None;
    let mut r_new = closed("ses_r13_clrshift", "restored new");
    r_new.occurrence = 1;
    r_new.active_session_id = None;
    let mut c_clr2 = closed("ses_r13_clrshift", "restored new");
    c_clr2.occurrence = 2;
    c_clr2.active_session_id = Some("ses_r13_clrshift".into());
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![
            Tab::Workspace(r_old),
            Tab::Workspace(r_new),
            Tab::Workspace(c_clr2),
        ],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[2].binding = Some(backend("ses_r13_clrshift"));
    r13_b2c.workspace = Some(ui);
    close(&mut r13_b2c, "tab-0", &mut tx);
    if let Some(l) = r13_b2c.screen.launcher_mut() {
        l.pending = false;
    }
    close(&mut r13_b2c, "tab-1", &mut tx);
    if let Some(l) = r13_b2c.screen.launcher_mut() {
        l.pending = false;
    }
    new_tab(&mut r13_b2c, &mut tx);
    if let Some(l) = r13_b2c.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r13_b2c,
        &Project {
            id: "proj-r13-clrshift".into(),
            path: "/fixture".into(),
        },
    );
    // D initially projects "restored new"; now switch to C (tab-2) and clear "restored new".
    select(&mut r13_b2c, "tab-2", &mut tx);
    if let Some(l) = r13_b2c.screen.launcher_mut() {
        l.pending = false;
    }
    r13_b2c.show_chat();
    r13_b2c.draft = TextEdit::new("");
    capture(&mut r13_b2c);
    let snap_b2c = r13_b2c.workspace.as_ref().unwrap().snapshot();
    let bytes_b2c = crate::workspace::encode(&snap_b2c).unwrap();
    let mut hydrated_b2c = Ui::new();
    hydrated_b2c.hydrate(crate::workspace::decode(&bytes_b2c).unwrap());
    assert!(
        hydrated_b2c.entries.iter().any(|e| matches!(
            &e.saved,
            Tab::Workspace(w) if w.drafts.get("ses_r13_clrshift").map(String::as_str) == Some("restored old")
        )),
        "clearing projected restored copy on open sibling C must shift pending tab D to next closed candidate"
    );

    // 22. R13 Bloquant 3: Active-chat tab A has a pending deletion alongside closed drafts and
    // eligible sibling tab B. Closing A before the next poll must recover both closed drafts and
    // A's own draft onto surviving sibling B (not onto closing A in ui.closed), surviving restart.
    let mut r13_b3 = draft_state();
    let mut a3 = closed("ses_r13_close", "from closing A");
    a3.active_session_id = Some("ses_r13_close".into());
    let mut b3 = closed("ses_r13_close", "");
    b3.drafts.clear();
    b3.occurrence = 1;
    b3.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a3), Tab::Workspace(b3)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r13_close"));
    ui.entries[0].pending_deleted.insert("ses_r13_close".into());
    ui.closed = vec![closed("ses_r13_close", "from closed slot")];
    ui.closed_restored = vec![Default::default()];
    ui.closed_derived_from = vec![Default::default()];
    r13_b3.workspace = Some(ui);
    r13_b3.show_chat();
    r13_b3.draft = TextEdit::new("from closing A");
    close(&mut r13_b3, "tab-0", &mut tx);
    let snap_b3 = r13_b3.workspace.as_ref().unwrap().snapshot();
    let bytes_b3 = crate::workspace::encode(&snap_b3).unwrap();
    let mut hydrated_b3 = Ui::new();
    hydrated_b3.hydrate(crate::workspace::decode(&bytes_b3).unwrap());
    let Tab::Workspace(surviving_b) = &hydrated_b3.entries[0].saved else {
        panic!("expected surviving workspace B");
    };
    let mut recovered_b3: Vec<&str> = surviving_b
        .drafts
        .iter()
        .filter(|(k, _)| crate::workspace::is_local_draft_id(k))
        .map(|(_, v)| v.as_str())
        .collect();
    recovered_b3.sort_unstable();
    assert_eq!(
        recovered_b3,
        vec!["from closed slot", "from closing A"],
        "closing A with pending_deleted must land recovered drafts on surviving sibling B"
    );

    // 23. R13 Moyen 1: Two tabs restore X; tab A edits X -> Y and closes so tab C projects Y
    // while tab B still holds untouched restored X. After restart, clearing Y and getting a 404
    // must NOT resurrect superseded ancestor X from tab B.
    let mut r13_m1 = draft_state();
    let mut ma = closed("ses_r13_anc", "ancestor X");
    ma.active_session_id = Some("ses_r13_anc".into());
    let mut mb = closed("ses_r13_anc", "ancestor X");
    mb.occurrence = 1;
    mb.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(ma), Tab::Workspace(mb)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r13_anc"));
    r13_m1.workspace = Some(ui);
    r13_m1.show_chat();
    r13_m1.draft = TextEdit::new("edited Y");
    capture(&mut r13_m1);
    close(&mut r13_m1, "tab-0", &mut tx);
    if let Some(l) = r13_m1.screen.launcher_mut() {
        l.pending = false;
    }
    new_tab(&mut r13_m1, &mut tx);
    if let Some(l) = r13_m1.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r13_m1,
        &Project {
            id: "proj-r13-m1".into(),
            path: "/fixture".into(),
        },
    );
    let snap_m1 = r13_m1.workspace.as_ref().unwrap().snapshot();
    let bytes_m1 = crate::workspace::encode(&snap_m1).unwrap();
    let mut restarted_m1 = draft_state();
    let mut ui_m1 = Ui::new();
    ui_m1.hydrate(crate::workspace::decode(&bytes_m1).unwrap());
    ui_m1.ready = true;
    // Verify rehydrated snapshot kept Y on C and pruned superseded ancestor X from B.
    let Tab::Workspace(rehydrated_b) = &ui_m1.entries[0].saved else {
        panic!("expected workspace B");
    };
    assert!(
        !rehydrated_b.drafts.contains_key("ses_r13_anc"),
        "snapshot must prune superseded ancestor X from B"
    );
    let Tab::Workspace(rehydrated_c) = &ui_m1.entries[1].saved else {
        panic!("expected workspace C");
    };
    assert_eq!(
        rehydrated_c.drafts.get("ses_r13_anc").map(String::as_str),
        Some("edited Y"),
        "snapshot must keep projected edit Y on C"
    );
    // Active tab is C (index 1, holding Y); bind, clear Y, and delete session -> X must not return.
    ui_m1.entries[1].binding = Some(backend("ses_r13_anc"));
    if let Tab::Workspace(w) = &mut ui_m1.entries[1].saved {
        w.active_session_id = Some("ses_r13_anc".into());
    }
    restarted_m1.workspace = Some(ui_m1);
    restarted_m1.show_chat();
    restarted_m1.draft = TextEdit::new("");
    capture(&mut restarted_m1);
    restarted_m1.show_launcher();
    assert!(
        !crate::workspace::recover_missing_session_draft(&mut restarted_m1, "ses_r13_anc"),
        "clearing projected edit Y after restart must not resurrect superseded ancestor X"
    );

    // 24. R14 Bloquant: Tab A (index 0, launcher) is closing while Tab B (index 1) stays open;
    // a queued window deletion notification in `ui.deleted_sessions` must recover both closed
    // drafts and A's own draft onto surviving Tab B rather than onto closing Tab A.
    let mut r14_b = draft_state();
    let mut a14 = closed("ses_r14_q", "from closing A");
    a14.active_session_id = None;
    let mut b14 = closed("ses_r14_q", "");
    b14.drafts.clear();
    b14.occurrence = 1;
    b14.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a14.clone()), Tab::Workspace(b14)],
        active: Some(0),
    });
    ui.ready = true;
    ui.closed = vec![closed("ses_r14_q", "from closed q")];
    ui.closed_restored = vec![Default::default()];
    ui.closed_derived_from = vec![Default::default()];
    let scope_r14 = crate::workspace::state::ProjectScope::from_workspace(&a14);
    let _ = ui
        .deleted_sessions
        .0
        .try_send((scope_r14, "ses_r14_q".into()));
    r14_b.workspace = Some(ui);
    r14_b.show_launcher();
    close(&mut r14_b, "tab-0", &mut tx);
    let snap_r14_b = r14_b.workspace.as_ref().unwrap().snapshot();
    let bytes_r14_b = crate::workspace::encode(&snap_r14_b).unwrap();
    let mut hydrated_r14_b = Ui::new();
    hydrated_r14_b.hydrate(crate::workspace::decode(&bytes_r14_b).unwrap());
    let Tab::Workspace(surviving_r14_b) = &hydrated_r14_b.entries[0].saved else {
        panic!("expected surviving workspace B");
    };
    let mut texts_r14_b: Vec<&str> = surviving_r14_b
        .drafts
        .iter()
        .filter(|(k, _)| crate::workspace::is_local_draft_id(k))
        .map(|(_, v)| v.as_str())
        .collect();
    texts_r14_b.sort_unstable();
    assert_eq!(
        texts_r14_b,
        vec!["from closed q", "from closing A"],
        "queued window deletion during tab close must route drafts onto surviving sibling B"
    );

    // 25. R14 Moyen 1: Two closed drafts require a UUID slot; if UUID reservation fails during
    // closing Tab A while Tab B has no projection for the session, close must be deferred so
    // neither the closed drafts nor retry state are stranded and lost across restart.
    let mut r14_m1 = draft_state();
    let mut a14m = closed("ses_r14_def", "from A deferred");
    a14m.active_session_id = Some("ses_r14_def".into());
    let mut b14m = closed("ses_r14_def", "");
    b14m.drafts.clear();
    b14m.occurrence = 1;
    b14m.active_session_id = None;
    let mut ui = Ui::new();
    ui.hydrate(crate::workspace::Snapshot {
        revision: 1,
        saved_at: 1,
        panel_widths: [None; 2],
        file_wrap: None,
        tabs: vec![Tab::Workspace(a14m), Tab::Workspace(b14m)],
        active: Some(0),
    });
    ui.ready = true;
    ui.entries[0].binding = Some(backend("ses_r14_def"));
    ui.entries[0].pending_deleted.insert("ses_r14_def".into());
    ui.closed = vec![
        closed("ses_r14_def", "closed def 1"),
        closed("ses_r14_def", "closed def 2"),
    ];
    ui.closed_restored = vec![Default::default(), Default::default()];
    ui.closed_derived_from = vec![Default::default(), Default::default()];
    r14_m1.workspace = Some(ui);
    r14_m1.show_chat();
    r14_m1.draft = TextEdit::new("from A deferred");
    crate::workspace::state::tabs::close_with_uuid(&mut r14_m1, "tab-0", &mut tx, || None);
    assert_eq!(
        r14_m1.workspace.as_ref().unwrap().entries.len(),
        2,
        "close must be deferred while deletion recovery cannot reserve UUID slots"
    );
    assert!(
        r14_m1.workspace.as_ref().unwrap().entries[0]
            .pending_deleted
            .contains("ses_r14_def"),
        "deferred close must keep pending_deleted armed on A"
    );
    // Once UUID allocation works again, closing A succeeds and lands all 3 drafts on B.
    close(&mut r14_m1, "tab-0", &mut tx);
    assert_eq!(r14_m1.workspace.as_ref().unwrap().entries.len(), 1);
    let Tab::Workspace(surviving_m1) = &r14_m1.workspace.as_ref().unwrap().entries[0].saved else {
        panic!("expected surviving workspace B");
    };
    let mut texts_m1: Vec<&str> = surviving_m1
        .drafts
        .iter()
        .filter(|(k, _)| crate::workspace::is_local_draft_id(k))
        .map(|(_, v)| v.as_str())
        .collect();
    texts_m1.sort_unstable();
    assert_eq!(
        texts_m1,
        vec!["closed def 1", "closed def 2", "from A deferred"],
        "retry close after UUID recovery must deliver every draft onto surviving sibling B"
    );

    // 26. R14 Moyen 2: Legacy closed order [A, "", B] masks A and delivers B on first bind;
    // consuming the tombstone must also prune masked A so a second bind never resurrects A.
    let mut r14_m2 = draft_state();
    let mut ui = Ui::new();
    ui.fixture_ready();
    ui.closed = vec![
        closed("ses_r14_tomb", "masked A"),
        closed("ses_r14_tomb", ""),
        closed("ses_r14_tomb", "live B"),
    ];
    ui.closed_restored = vec![Default::default(), Default::default(), Default::default()];
    ui.closed_derived_from = vec![Default::default(), Default::default(), Default::default()];
    r14_m2.workspace = Some(ui);
    opened(
        &mut r14_m2,
        &Project {
            id: "proj-r14-c".into(),
            path: "/fixture".into(),
        },
    );
    new_tab(&mut r14_m2, &mut tx);
    if let Some(l) = r14_m2.screen.launcher_mut() {
        l.pending = false;
    }
    opened(
        &mut r14_m2,
        &Project {
            id: "proj-r14-d".into(),
            path: "/fixture".into(),
        },
    );
    select(&mut r14_m2, "tab-0", &mut tx);
    if let Some(l) = r14_m2.screen.launcher_mut() {
        l.pending = false;
    }
    assert_eq!(bound(&mut r14_m2, &backend("ses_r14_tomb")), "live B");
    select(&mut r14_m2, "tab-1", &mut tx);
    if let Some(l) = r14_m2.screen.launcher_mut() {
        l.pending = false;
    }
    assert_eq!(
        bound(&mut r14_m2, &backend("ses_r14_tomb")),
        "",
        "second bind must not resurrect A masked by consumed tombstone"
    );
}
