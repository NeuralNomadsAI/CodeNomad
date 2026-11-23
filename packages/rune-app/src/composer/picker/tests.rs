use super::lookup::{Read, Reply};
use super::*;
use crate::{Phase, State, composer::draft::Attachment, init, platform, view};
use codenomad_client::{bounded, files::EntryKind, prompt_catalogue::ProjectMatch};
use rune::{Env, Mods, Runtime};

fn runtime() -> Runtime<State> {
    let mut state = init();
    state.phase = Phase::Ready;
    state.composer.picker.set_attachments_supported(true);
    let (send, _receive) = bounded(1);
    state.commands = Some(send);
    let mut rt = Runtime::new(state, view, (680.0, 640.0), Env::new(false, 1.0));
    rt.frame(0.0);
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt
}

#[test]
fn attachment_support_follows_the_window_marker() {
    let mut rt = runtime();
    let (events, incoming) = bounded(1);
    rt.state.incoming = Some(incoming);
    for supported in [false, true] {
        let mut window = serde_json::json!({"status":"window","messages":[],"latest":true});
        if supported {
            window["userFiles"] = serde_json::json!("reference-v1");
        }
        events
            .try_send(crate::transport::Event::Sync(
                crate::history::decode(window).unwrap(),
            ))
            .unwrap();
        rt.update(|s, _| {
            crate::poll_chat(s, 1);
            s.draft.clear();
            s.composer.picker.reset();
        });
        rt.frame(0.0);
        assert_eq!(rt.find("attachments-disabled").is_none(), supported);
        let (x, y) = rt.find("composer").unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        rt.paste("@ref");
        rt.frame(0.0);
        rt.update(|s, _| {
            let picker = &mut s.composer.picker;
            picker.mentions.directory = Some("/project".into());
            picker.mentions.files.push(Item::File(ProjectMatch {
                path: "ref.txt".into(),
                kind: EntryKind::File,
            }));
            picker.refresh_entries();
        });
        press(&mut rt, Key::Enter, Mods::default());
        assert_eq!(
            rt.state.composer.draft.attachments.len(),
            usize::from(supported)
        );
        assert_eq!(
            rt.state.draft.text,
            if supported {
                "@./ref.txt "
            } else {
                "./ref.txt "
            }
        );
    }
}

#[test]
fn tab_cannot_attach_a_sixty_fifth_part() {
    let mut rt = runtime();
    for index in 0..crate::composer::draft::MAX_PARTS {
        assert!(rt.state.composer.draft.attach(Attachment::Skill {
            id: format!("skill-{index}"),
            name: format!("Skill {index}"),
        }));
    }
    rt.paste("@review");
    rt.frame(0.0);
    rt.update(|s, _| {
        s.composer
            .picker
            .mentions
            .catalog
            .push(Item::Skill(named("review")));
        s.composer.picker.refresh_entries();
    });
    press(&mut rt, Key::Tab, Mods::default());
    assert_eq!(rt.state.draft.text, "@review");
    assert_eq!(
        rt.state.composer.draft.attachments.len(),
        crate::composer::draft::MAX_PARTS
    );
}
fn press(rt: &mut Runtime<State>, key: Key, mods: Mods) {
    let event = KeyEvent { key, mods };
    rt.key(event.clone());
    rt.key_up(event);
    rt.frame(0.0);
}
fn named(name: &str) -> Named {
    Named {
        id: name.into(),
        name: name.into(),
        description: String::new(),
        primary: false,
    }
}

#[test]
fn refreshing_the_catalogue_keeps_the_active_command_by_identity() {
    let mut rt = runtime();
    rt.state.composer.picker.commands.items = ["review", "release"]
        .into_iter()
        .map(|name| Item::Command(named(name)))
        .collect();
    rt.paste("/re");
    rt.frame(0.0);
    press(&mut rt, Key::Down, Mods::default());
    let (cancel, _cancelled) = bounded(1);
    let (out, replies) = bounded(1);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        assert_eq!(picker.entries[picker.selected].label(), "release");
        picker.commands.read = Some(Read {
            _cancel: cancel,
            replies,
        });
        out.try_send(Reply {
            directory: "/project".into(),
            items: ["release", "review"]
                .into_iter()
                .map(|name| Item::Command(named(name)))
                .collect(),
            error: false,
        })
        .ok()
        .unwrap();
        assert!(picker.poll(&s.reads, &s.wake));
        assert_eq!(picker.selected, 0);
        assert_eq!(picker.entries[picker.selected].label(), "release");
    });
    rt.frame(0.0);
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "/release ");
}

#[test]
fn shift_enter_resolves_both_mentions_of_the_same_folder() {
    let mut rt = runtime();
    rt.paste("Voir @docs puis user@docs et @docs2 avant @doc");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.files.push(Item::File(ProjectMatch {
            path: "docs".into(),
            kind: EntryKind::Directory,
        }));
        picker.refresh_entries();
    });
    press(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert_eq!(
        rt.state.draft.text,
        "Voir @docs puis user@docs et @docs2 avant @docs/ "
    );
    assert!(matches!(&rt.state.composer.draft.attachments[..],
        [Attachment::Path(path)] if path == "./docs"));
    let (prompt, _) = rt
        .state
        .composer
        .draft
        .prepare(
            &rt.state.draft,
            "msg_folder",
            codenomad_client::prompt::Delivery::Steer,
        )
        .unwrap();
    assert_eq!(
        prompt.text,
        "Voir ./docs puis user@docs et @docs2 avant ./docs/"
    );
    assert!(prompt.files.is_empty());
}

#[test]
fn a_late_mentions_catalogue_does_not_redirect_enter() {
    let mut rt = runtime();
    rt.paste("@doc");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.files = ["docs/one", "docs/two"]
            .into_iter()
            .map(|path| {
                Item::File(ProjectMatch {
                    path: path.into(),
                    kind: EntryKind::File,
                })
            })
            .collect();
        picker.refresh_entries();
    });
    press(&mut rt, Key::Down, Mods::default());
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        let (cancel, _) = bounded(1);
        let (out, replies) = bounded(1);
        picker.mentions.catalog_read = Some(Read {
            _cancel: cancel,
            replies,
        });
        out.try_send(Reply {
            directory: "/project".into(),
            items: vec![Item::Skill(named("docs"))],
            error: false,
        })
        .ok()
        .unwrap();
        assert!(picker.poll(&s.reads, &s.wake));
    });
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "@./docs/two ");
}

#[test]
fn an_incomplete_catalogue_keeps_the_last_choices_until_recovery() {
    let mut rt = runtime();
    rt.paste("@rev");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.catalog = vec![Item::Skill(named("review-skill"))];
        picker.refresh_entries();
        for error in [true, false] {
            let (cancel, _) = bounded(1);
            let (out, replies) = bounded(1);
            picker.mentions.catalog_read = Some(Read {
                _cancel: cancel,
                replies,
            });
            out.try_send(Reply {
                directory: "/project".into(),
                items: vec![Item::Agent(named("review-agent"))],
                error,
            })
            .ok()
            .unwrap();
            assert!(picker.poll(&s.reads, &s.wake));
            assert_eq!(picker.error(), error);
            assert_eq!(
                picker.entries[0].label(),
                if error {
                    "review-skill"
                } else {
                    "review-agent"
                }
            );
        }
    });
}

#[test]
fn an_automatic_mention_target_follows_the_first_file() {
    let mut rt = runtime();
    rt.paste("@review");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.catalog.push(Item::Skill(named("review")));
        picker.refresh_entries();
        let (cancel, _) = bounded(1);
        let (out, replies) = bounded(1);
        picker.mentions.file_read = Some(Read {
            _cancel: cancel,
            replies,
        });
        out.try_send(Reply {
            directory: "/project".into(),
            items: vec![Item::File(ProjectMatch {
                path: "review.ts".into(),
                kind: EntryKind::File,
            })],
            error: false,
        })
        .ok()
        .unwrap();
        assert!(picker.poll(&s.reads, &s.wake));
    });
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "@./review.ts ");
}

#[test]
fn deleting_a_selected_mention_does_not_leave_a_sendable_attachment() {
    let mut rt = runtime();
    rt.paste("@review");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.directory = Some("/project".into());
        picker.mentions.files.push(Item::File(ProjectMatch {
            path: "review.ts".into(),
            kind: EntryKind::File,
        }));
        picker.refresh_entries();
    });
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    rt.update(|s, _| s.draft.set_selection(0, s.draft.text.len()));
    press(&mut rt, Key::Delete, Mods::default());
    assert!(rt.state.draft.text.is_empty());
    assert!(rt.state.composer.draft.attachments.is_empty());
}

#[test]
fn held_enter_completes_a_command_without_executing_it() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.paste("/rev");
    rt.frame(0.0);
    let enter = KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    };
    rt.key(enter.clone());
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, "/review ");
    rt.repeat_key(enter.clone());
    rt.key_up(enter);
    rt.frame(0.0);
    assert!(receiver.try_recv().is_err());
    press(&mut rt, Key::Enter, Mods::default());
    assert!(matches!(
        receiver.try_recv(),
        Ok(crate::transport::Command::Slash { .. })
    ));
}

#[test]
fn tab_navigates_a_directory_with_spaces_without_sending() {
    let mut rt = runtime();
    rt.paste("@rel");
    rt.frame(0.0);
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.files.push(Item::File(ProjectMatch {
            path: "release notes".into(),
            kind: EntryKind::Directory,
        }));
        picker.refresh_entries();
    });
    press(&mut rt, Key::Tab, Mods::default());
    assert_eq!(rt.state.draft.text, "@release notes/");
    assert!(rt.state.composer.picker.open());
    assert!(!crate::composer::can_send(&rt.state));
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.files.push(Item::File(ProjectMatch {
            path: "release notes/today.md".into(),
            kind: EntryKind::File,
        }));
        picker.refresh_entries();
    });
    press(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert_eq!(rt.state.draft.text, "@./release notes/today.md ");
}

#[test]
fn real_field_consumes_picker_keys_and_commits_the_selected_skill() {
    let mut rt = runtime();
    rt.paste("🦀 @review");
    rt.frame(0.0);
    assert!(rt.state.composer.picker.open());
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "🦀 @review");
    rt.update(|s, _| {
        let picker = &mut s.composer.picker;
        picker.mentions.directory = Some("D:/test".into());
        picker.mentions.files.push(Item::File(ProjectMatch {
            path: "review.md".into(),
            kind: EntryKind::File,
        }));
        picker
            .mentions
            .catalog
            .push(Item::Agent(named("review-agent")));
        picker
            .mentions
            .catalog
            .push(Item::Skill(named("review-skill")));
        picker.refresh_entries();
    });
    for _ in 0..12 {
        rt.frame(1.0 / 60.0);
    }
    let tree = rt.accessibility_json().to_string();
    for label in ["review.md", "review-agent", "review-skill"] {
        assert!(tree.contains(label), "missing {label}: {tree}");
    }
    press(&mut rt, Key::Down, Mods::default());
    press(&mut rt, Key::Down, Mods::default());
    press(&mut rt, Key::Down, Mods::default());
    assert_eq!(rt.state.composer.picker.selected, 2);
    press(
        &mut rt,
        Key::Enter,
        Mods {
            ctrl: true,
            cmd: true,
            ..Mods::default()
        },
    );
    assert_eq!(rt.state.draft.text, "🦀 @review");
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "🦀 ");
    assert!(matches!(&rt.state.composer.draft.attachments[..],
        [Attachment::Skill{id, ..}] if id == "review-skill"));
    assert!(!rt.state.composer.picker.open());
    assert!(rt.state.draft.focused);
    assert!(rt.state.messages.is_empty());
    let (out, submitted) = bounded(1);
    rt.state.commands = Some(out);
    press(&mut rt, Key::Enter, Mods::default());
    let crate::transport::Command::Prompt(prompt) = submitted.try_recv().unwrap() else {
        panic!("expected native prompt")
    };
    assert_eq!(prompt.text, "🦀");
    assert_eq!(prompt.skills[0].id, "review-skill");
}

#[test]
fn tab_only_completes_and_shift_enter_records_a_path_without_a_file() {
    let mut rt = runtime();
    rt.paste("@a");
    rt.frame(0.0);
    let seed = |s: &mut State, _: &mut Tx| {
        let p = &mut s.composer.picker;
        p.mentions.directory = Some("D:/test".into());
        p.mentions.files.push(Item::File(ProjectMatch {
            path: "a #%.txt".into(),
            kind: EntryKind::File,
        }));
        p.refresh_entries();
    };
    rt.update(seed);
    press(&mut rt, Key::Tab, Mods::default());
    assert_eq!(rt.state.draft.text, "@a #%.txt");
    assert!(rt.state.composer.draft.attachments.is_empty());

    let mut rt = runtime();
    rt.paste("@a");
    rt.frame(0.0);
    rt.update(seed);
    press(
        &mut rt,
        Key::Enter,
        Mods {
            shift: true,
            ..Mods::default()
        },
    );
    assert_eq!(rt.state.draft.text, "@./a #%.txt ");
    let (prompt, _) = rt
        .state
        .composer
        .draft
        .prepare(
            &rt.state.draft,
            "msg_x",
            codenomad_client::prompt::Delivery::Steer,
        )
        .unwrap();
    assert_eq!(prompt.text, "./a #%.txt");
    assert!(prompt.files.is_empty());
}

#[test]
fn selected_slash_uses_command_lane_without_draining_attachments() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    rt.paste("/rev");
    rt.frame(0.0);
    rt.update(|s, _| {
        s.composer.draft.attach(Attachment::Skill {
            id: "review".into(),
            name: "Review".into(),
        });
        s.composer
            .picker
            .commands
            .items
            .push(Item::Command(named("review")));
        s.composer.picker.refresh_entries();
    });
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "/review ");
    rt.paste("🦀 @./notes.txt @docs2 ensuite");
    rt.frame(0.0);
    rt.state
        .composer
        .draft
        .attach(Attachment::Path("./docs".into()));
    press(&mut rt, Key::Enter, Mods::default());
    let crate::transport::Command::Slash {
        attempt,
        name,
        text,
    } = receiver.try_recv().unwrap()
    else {
        panic!("expected native command")
    };
    assert_eq!(
        (name.as_str(), text.as_str()),
        ("review", "🦀 ./notes.txt @docs2 ensuite")
    );
    assert!(rt.state.messages.is_empty());
    assert_eq!(rt.state.composer.draft.attachments.len(), 2);
    crate::composer::acknowledge(
        &mut rt.state,
        &attempt,
        crate::transport::PromptOutcome::Rejected,
    );
    assert_eq!(
        rt.state.draft.text,
        "/review 🦀 @./notes.txt @docs2 ensuite"
    );
    assert_eq!(rt.state.composer.draft.attachments.len(), 2);
}

#[test]
fn pasted_known_command_uses_current_catalogue_without_requiring_picker_selection() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.paste("/review 🦀");
    rt.frame(0.0);
    assert!(!rt.state.composer.picker.open());
    press(&mut rt, Key::Enter, Mods::default());
    let crate::transport::Command::Slash {
        attempt,
        name,
        text,
    } = receiver.try_recv().unwrap()
    else {
        panic!("expected native command")
    };
    assert_eq!((name.as_str(), text.as_str()), ("review", "🦀"));
    crate::composer::acknowledge(
        &mut rt.state,
        &attempt,
        crate::transport::PromptOutcome::Unconfirmed,
    );
    assert!(rt.state.composer.command_unconfirmed.is_some());
    assert_eq!(rt.state.draft.text, "/review 🦀");
    press(&mut rt, Key::Enter, Mods::default());
    assert!(receiver.try_recv().is_err());
    rt.state.draft = TextEdit::new("/review  🦀");
    assert!(!crate::composer::can_send(&rt.state));
    rt.state.draft = TextEdit::new("a different prompt");
    assert!(crate::composer::can_send(&rt.state));
}

#[test]
fn editing_or_sending_a_dismissed_command_releases_its_picker_marker() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.paste("/rev");
    rt.frame(0.0);
    press(&mut rt, Key::Escape, Mods::default());
    assert!(!rt.state.composer.picker.open());
    rt.paste("iew");
    rt.frame(0.0);
    assert!(rt.state.composer.picker.open());
    press(&mut rt, Key::Enter, Mods::default());
    press(&mut rt, Key::Enter, Mods::default());
    let crate::transport::Command::Slash { attempt, .. } = receiver.try_recv().unwrap() else {
        panic!("expected command")
    };
    crate::composer::acknowledge(
        &mut rt.state,
        &attempt,
        crate::transport::PromptOutcome::Confirmed(attempt.clone()),
    );
    rt.frame(0.0);
    let (x, y) = rt.find("composer").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt.paste("/");
    rt.frame(0.0);
    assert!(rt.state.composer.picker.open());
}

#[test]
fn catalogue_failure_cannot_fall_through_to_prompt() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    let (cancel, _cancelled) = bounded(1);
    let (out, replies) = bounded(1);
    rt.state.composer.picker.commands.read = Some(Read {
        _cancel: cancel,
        replies,
    });
    out.try_send(Reply {
        directory: String::new(),
        items: vec![],
        error: true,
    })
    .ok()
    .unwrap();
    assert!(
        rt.state
            .composer
            .picker
            .poll(&rt.state.reads, &rt.state.wake)
    );
    rt.paste("/review 🦀");
    rt.frame(0.0);
    press(&mut rt, Key::Enter, Mods::default());
    assert!(receiver.try_recv().is_err());
    assert_eq!(rt.state.draft.text, "/review 🦀");
    assert!(rt.find("refresh-command-catalogue").is_some());
}

#[test]
fn removed_selected_command_never_degrades_to_a_prompt() {
    let mut rt = runtime();
    let (sender, receiver) = bounded(1);
    rt.state.commands = Some(sender);
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.state
        .composer
        .draft
        .attach(Attachment::Path("./docs".into()));
    rt.paste("/rev");
    rt.frame(0.0);
    press(&mut rt, Key::Enter, Mods::default());
    rt.paste("résumé");
    rt.frame(0.0);
    rt.update(|s, _| s.composer.picker.commands.items.clear());
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "/review résumé");
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    assert!(receiver.try_recv().is_err());
    assert!(rt.find("refresh-command-catalogue").is_some());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn reconnection_replaces_a_stale_catalogue_read_before_dispatch() {
    let mut rt = runtime();
    let backend = platform::block_on(Backend::connect("http://127.0.0.1:1/", "")).unwrap();
    let picker = &mut rt.state.composer.picker;
    picker.bind(backend);
    let (cancel, cancelled) = bounded(1);
    let (_out, replies) = bounded(1);
    picker.commands.read = Some(Read {
        _cancel: cancel,
        replies,
    });
    let (events, incoming) = bounded(1);
    rt.state.incoming = Some(incoming);
    events
        .try_send(crate::transport::Event::AgentHint(true))
        .unwrap();
    crate::poll_chat(&mut rt.state, 1);
    assert!(cancelled.is_closed());
    assert!(rt.state.composer.picker.command_pending("/new argument"));
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn live_command_updates_coalesce_and_fence_a_stale_catalogue() {
    use codenomad_client::transport::{Event, WorkspaceEvent};
    let mut rt = runtime();
    let backend = platform::block_on(Backend::connect("http://127.0.0.1:1/", "")).unwrap();
    let picker = &mut rt.state.composer.picker;
    picker.bind(backend);
    let (cancel, cancelled) = bounded(1);
    let (results, replies) = bounded(1);
    picker.commands.read = Some(Read {
        _cancel: cancel,
        replies,
    });
    let (events, incoming) = bounded(2);
    rt.state.incoming = Some(incoming);
    for _ in 0..2 {
        events
            .try_send(Event::Workspace(WorkspaceEvent::CommandsChanged))
            .unwrap();
    }
    crate::poll_chat(&mut rt.state, 2);
    assert!(!cancelled.is_closed());
    results
        .try_send(Reply {
            directory: "/stale".into(),
            items: vec![Item::Command(named("obsolete"))],
            error: false,
        })
        .ok()
        .unwrap();
    let picker = &mut rt.state.composer.picker;
    assert!(picker.poll(&rt.state.reads, &rt.state.wake));
    assert!(!picker.commands.dirty);
    assert!(picker.command_pending("/new argument"));
    assert!(picker.selected_command("/obsolete").is_none());
}

#[test]
fn literal_space_is_the_only_command_argument_separator() {
    let mut p = Picker::default();
    p.commands.items.push(Item::Command(named("review")));
    assert_eq!(p.selected_command("/review @./a"), Some(("review", "@./a")));
    assert!(p.selected_command("/review\targument").is_none());
    assert!(p.selected_command("/review\nargument").is_none());
}

#[test]
fn caret_motion_does_not_disable_the_visible_command() {
    let mut rt = runtime();
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.paste("/review");
    rt.frame(0.0);
    press(&mut rt, Key::Left, Mods::default());
    press(&mut rt, Key::Enter, Mods::default());
    assert_eq!(rt.state.draft.text, "/review ");
    assert!(!rt.state.composer.picker.open());
}

#[test]
fn changing_text_after_the_caret_reopens_a_dismissed_command() {
    let mut rt = runtime();
    rt.state
        .composer
        .picker
        .commands
        .items
        .push(Item::Command(named("review")));
    rt.paste("/reiew argument");
    rt.frame(0.0);
    press(&mut rt, Key::Home, Mods::default());
    for _ in 0..3 {
        press(&mut rt, Key::Right, Mods::default());
    }
    rt.paste("v");
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, "/review argument");
    assert!(rt.state.composer.picker.open());
    press(&mut rt, Key::Escape, Mods::default());
    press(&mut rt, Key::Delete, Mods::default());
    assert_eq!(rt.state.draft.text, "/revew argument");
    assert!(rt.state.composer.picker.open());
}
