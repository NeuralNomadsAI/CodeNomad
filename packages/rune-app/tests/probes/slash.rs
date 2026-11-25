use crate::{Phase, State, init, poll, setup, view};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::time::{Duration, Instant};

fn wait(rt: &mut Runtime<State>, label: &str, ready: impl Fn(&State) -> bool) {
    let seconds = if crate::platform::setting("RUNE_HISTORY_WORKTREE").is_some() {
        40
    } else {
        15
    };
    let until = Instant::now() + Duration::from_secs(seconds);
    while !ready(&rt.state) {
        let s = &rt.state;
        assert!(
            Instant::now() < until,
            "timed out: {label}; ready={}, picker={}/{}, agent={:?}, reader={:?}, history_detached={}, command_lane={}, draft={:?}",
            matches!(s.phase, Phase::Ready | Phase::Streaming),
            s.composer.picker.open(),
            s.composer.picker.command_pending(&s.draft.text),
            s.agent.as_ref().map(|a| (a.known, a.online, a.blocked())),
            s.reader.as_ref().map(|r| r.blocks_send()),
            s.history_detached,
            s.commands.as_ref().is_some_and(|pipe| !pipe.is_closed()),
            s.draft.text,
        );
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn run() {
    let mut rt = Runtime::new(init(), view, (960.0, 760.0), Env::new(false, 1.0));
    rt.poll = Some(poll);
    setup(&mut rt.state, std::sync::Arc::new(|| {}));
    let stage = crate::platform::setting("RUNE_PROMPT_HISTORY_STAGE");
    let linked = crate::platform::setting("RUNE_HISTORY_WORKTREE").is_some();
    let input = if linked {
        "Historique lié 🦀"
    } else {
        "/review résumé 🦀"
    };
    wait(&mut rt, "ready to qualify prompt history", |s| {
        matches!(s.phase, Phase::Ready | Phase::Streaming)
            && (linked
                || !s.composer.picker.command_pending(input)
                    && s.composer.picker.selected_command(input).is_some())
    });
    rt.frame(0.0);
    let (x, y) = rt.find("composer").expect("composer");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    if stage.as_deref() == Some("read") {
        let until = Instant::now() + Duration::from_secs(15);
        while !crate::composer::recall::available(&rt.state) {
            assert!(
                Instant::now() < until,
                "history did not load on the second launch"
            );
            rt.frame(0.02);
            std::thread::sleep(Duration::from_millis(5));
        }
        let up = KeyEvent {
            key: Key::Up,
            mods: Mods::default(),
        };
        rt.key(up.clone());
        rt.key_up(up);
        rt.frame(0.02);
        assert_eq!(rt.state.draft.text, input);
        println!("history probe: second process recalls the stored text");
        return;
    }
    let supported = rt.state.composer.picker.attachments_supported();
    if !supported {
        let files = [std::path::PathBuf::from("not-read.txt")];
        rt.drop_files(files.to_vec(), Some((x, y)));
        rt.paste_content(rune::ClipboardContent::default().with_files(files));
        rt.frame(0.0);
        assert!(rt.state.draft.text.is_empty());
        assert!(rt.state.composer.draft.attachments.is_empty());
    }
    rt.paste(input);
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, input);
    wait(&mut rt, "send is admitted", crate::composer::can_send);
    let enter = KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    };
    rt.key(enter.clone());
    rt.key_up(enter);
    rt.frame(0.0);
    wait(&mut rt, "Rust relay acknowledgement", |s| {
        !s.composer.pending()
            && (s.draft.text.is_empty()
                || s.composer.send_error
                || crate::composer::command_held(s))
    });
    assert!(
        rt.state.draft.text.is_empty()
            && !rt.state.composer.send_error
            && rt.state.composer.unconfirmed_id().is_none(),
        "input was not confirmed by the Rust relay"
    );
    println!("history probe: input confirmed through the Rust relay");
    if stage.as_deref() == Some("write") {
        let backend = crate::settings::bound_backend(&rt.state).expect("bound server");
        wait(&mut rt, "prompt history written by the composer", |_| {
            crate::platform::block_on(codenomad_client::prompt_history::read(&backend))
                .is_ok_and(|history| history.first().is_some_and(|text| text == input))
        });
    }
}
