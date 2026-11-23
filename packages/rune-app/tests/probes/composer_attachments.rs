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
        assert_eq!(row.parts.len(), 5);
        let capture = std::fs::read("capture.png").unwrap();
        platform::block_on(async {
            let backend = platform::configured_target(false)?;
            let password = platform::setting("RUNE_PASSWORD").unwrap_or_default();
            backend.authenticate(&password, None).await?;
            for (part, name) in row
                .parts
                .iter()
                .zip(["sample.txt", "selected.txt", "dropped.txt", "pasted.txt", "clipboard.png"])
            {
                let Part::File(file) = part else {
                    panic!("expected file")
                };
                assert_eq!(file.name.as_deref(), Some(name));
                let reference = file.reference.as_ref().expect("stored file reference");
                let bytes = backend.attachment_bytes(reference).await?;
                let expected = if name == "clipboard.png" { capture.as_slice() } else {
                    "Rune attachment fixture 🦀\r\n".as_bytes()
                };
                assert_eq!(bytes.as_slice(), expected);
            }
            Ok::<_, crate::history::Error>(())
        })
        .expect("download through the Rust relay");
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
    for _ in 0..24 {
        rt.frame(1.0 / 60.0);
    }
    let here = std::env::current_dir().expect("private fixture directory");
    let (button_x, button_y) = rt
        .find("attach-device-files")
        .expect("enabled device chooser");
    rt.pointer_down(button_x, button_y);
    rt.pointer_up(button_x, button_y);
    rt.frame(1.0 / 60.0);
    assert_eq!(
        rt.file_dialog().map(|(kind, _)| kind),
        Some(rune::file_dialog::FileDialogKind::Open),
        "the device button opens the owned file dialog",
    );
    assert!(!crate::composer::can_send(&rt.state));
    rt.resolve_file_dialog(Some(here.join("selected.txt")))
        .unwrap();
    wait(&mut rt, "selected device bytes", |s| {
        s.composer.draft.attachments.len() == 2
    });
    let (x, y) = rt.find("composer").expect("composer drop target");
    rt.drop_files(vec![here.join("dropped.txt")], Some((x, y)));
    rt.frame(0.0);
    wait(&mut rt, "dropped device bytes", |s| {
        s.composer.draft.attachments.len() == 3 && !s.composer.device.busy()
    });
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    rt.frame(0.0);
    rt.paste_content(rune::ClipboardContent::new("must not replace the draft")
        .with_files([here.join("pasted.txt")]));
    rt.frame(0.0);
    wait(&mut rt, "native clipboard file", |s| s.composer.draft.attachments.len() == 4);
    let capture = rune::clipboard::ClipboardImage::from_png(std::fs::read(here.join("capture.png")).unwrap()).unwrap();
    rt.paste_content(rune::ClipboardContent::default().with_image(capture));
    rt.frame(0.0);
    wait(&mut rt, "native clipboard capture", |s| s.composer.draft.attachments.len() == 5);
    assert_eq!(rt.state.draft.text, "@./sample.txt ");
    enter(&mut rt);
    wait(&mut rt, "authoritative stored reference", |s| {
        s.messages.iter().any(|row| {
            row.parts
                .iter()
                .any(|part| matches!(part, Part::File(file) if file.reference.is_some()))
        })
    });
    println!("attachment probe: sent project, chooser, drop, clipboard file and capture");
}
