use crate::{Phase, State, init, poll, setup, view};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::time::{Duration, Instant};

fn wait(rt: &mut Runtime<State>, label: &str, ready: impl Fn(&State) -> bool) {
    let until = Instant::now() + Duration::from_secs(15);
    while !ready(&rt.state) {
        assert!(Instant::now() < until, "timed out: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

pub fn run() {
    let mut rt = Runtime::new(init(), view, (960.0, 760.0), Env::new(false, 1.0));
    rt.poll = Some(poll);
    setup(&mut rt.state, std::sync::Arc::new(|| {}));
    wait(&mut rt, "ready with Location command catalogue", |s| {
        s.phase == Phase::Ready
            && !s.composer.picker.command_pending("/review")
            && s.composer.picker.selected_command("/review").is_some()
    });
    rt.frame(0.0);
    let (x, y) = rt.find("composer").expect("composer");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    assert!(rt.find("attachments-disabled").is_some());
    let files = [std::path::PathBuf::from("not-read.txt")];
    rt.drop_files(files.to_vec(), Some((x, y)));
    rt.paste_content(rune::ClipboardContent::default().with_files(files));
    rt.frame(0.0);
    assert!(rt.state.draft.text.is_empty());
    assert!(rt.state.composer.draft.attachments.is_empty());
    rt.paste("/review résumé 🦀");
    rt.frame(0.0);
    assert_eq!(rt.state.draft.text, "/review résumé 🦀");
    assert!(crate::composer::can_send(&rt.state));
    let enter = KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    };
    rt.key(enter.clone());
    rt.key_up(enter);
    wait(&mut rt, "Rust relay command acknowledgement", |s| {
        s.draft.text.is_empty() || s.composer.send_error || s.composer.command_unconfirmed.is_some()
    });
    assert!(
        rt.state.draft.text.is_empty(),
        "command was not confirmed by the Rust relay"
    );
    println!("slash probe: command confirmed through the Rust relay");
}
