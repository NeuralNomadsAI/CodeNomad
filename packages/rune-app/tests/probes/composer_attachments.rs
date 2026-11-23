use crate::{Phase, State, content::Part, init, platform, poll, setup, view};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use std::time::{Duration, Instant};

fn wait(rt: &mut Runtime<State>, label: &str, ready: impl Fn(&State) -> bool) {
    let until = Instant::now() + Duration::from_secs(20);
    while !ready(&rt.state) {
        assert!(Instant::now() < until, "timed out: {label}");
        rt.frame(1.0 / 60.0);
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn enter(rt: &mut Runtime<State>) {
    let key = KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    };
    rt.key(key.clone());
    rt.key_up(key);
    rt.frame(0.0);
}

pub fn run() {
    let mut rt = Runtime::new(init(), view, (960.0, 760.0), Env::new(false, 1.0));
    rt.poll = Some(poll);
    setup(&mut rt.state, std::sync::Arc::new(|| {}));
    wait(&mut rt, "negotiated attachment history", |s| {
        s.phase == Phase::Ready && s.composer.picker.attachments_supported()
    });
    if platform::setting("RUNE_ATTACHMENT_STAGE").as_deref() == Some("reopen") {
        let row = rt
            .state
            .messages
            .iter()
            .find(|row| row.body == "./sample.txt")
            .expect("stored prompt");
        let [Part::File(file)] = row.parts.as_slice() else {
            panic!("one file in the reopened message")
        };
        assert_eq!(file.name.as_deref(), Some("sample.txt"));
        let reference = file.reference.as_ref().expect("stored file reference");
        let bytes = platform::block_on(async {
            let backend = platform::configured_target(false)?;
            let password = platform::setting("RUNE_PASSWORD").unwrap_or_default();
            backend.authenticate(&password, None).await?;
            backend.attachment_bytes(reference).await
        })
        .expect("download through the Rust relay");
        assert_eq!(
            bytes.as_slice(),
            "Rune attachment fixture 🦀\r\n".as_bytes()
        );
        println!("attachment probe: reopened references and downloaded identical bytes");
        return;
    }
    rt.frame(0.0);
    let (x, y) = rt.find("composer").expect("composer");
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt.paste("@sample");
    rt.frame(0.0);
    wait(&mut rt, "file picker lists the real project file", |s| {
        s.composer
            .picker
            .entries
            .iter()
            .any(|item| item.label() == "sample.txt")
    });
    enter(&mut rt);
    assert_eq!(rt.state.composer.draft.attachments.len(), 1);
    enter(&mut rt);
    wait(&mut rt, "authoritative stored reference", |s| {
        s.messages.iter().any(|row| {
            row.parts
                .iter()
                .any(|part| matches!(part, Part::File(file) if file.reference.is_some()))
        })
    });
    println!("attachment probe: sent exactly one project file");
}
