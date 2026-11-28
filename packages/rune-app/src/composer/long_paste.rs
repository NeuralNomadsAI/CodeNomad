use super::draft::Attachment;
use crate::{State, workspace};
use rune::Tx;
use rune::edit::TextEdit;
use std::ops::Range;
use std::sync::Arc;

pub(super) const MAX_BYTES: usize = 256 * 1024;

pub(super) fn tokens(text: &str) -> impl Iterator<Item = (Range<usize>, u64)> + '_ {
    let mut offset = 0;
    text.split_inclusive(']').filter_map(move |chunk| {
        let end = offset + chunk.len();
        offset = end;
        let content = chunk.strip_suffix(']')?;
        let start = content.rfind('[')?;
        let token = content[start + 1..].trim();
        let (kind, count) = token.split_at_checked(6)?;
        if !kind.eq_ignore_ascii_case("pasted") {
            return None;
        }
        let count = count.trim_start().strip_prefix('#')?.trim();
        if count.is_empty() || !count.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        Some((end - chunk.len() + start..end, count.parse().ok()?))
    })
}

pub(super) fn active_tokens(edit: &TextEdit) -> impl Iterator<Item = (Range<usize>, u64)> + '_ {
    tokens(&edit.text).filter(|(token, _)| {
        super::literal::ranges(edit).all(|span| token.end <= span.start || span.end <= token.start)
    })
}

pub(super) fn paste(s: &mut State, text: &str, tx: &mut Tx) -> bool {
    if text.encode_utf16().nth(150).is_none() && text.split('\n').nth(3).is_none() {
        return false;
    }
    if !compact(s, text) {
        super::literal::paste(&mut s.draft, text);
    }
    super::view::changed(s, tx);
    true
}

fn compact(s: &mut State, text: &str) -> bool {
    if text.len() > MAX_BYTES {
        return false;
    }
    let largest = tokens(&s.draft.text)
        .chain(tokens(text))
        .map(|(_, id)| id)
        .chain(
            s.composer
                .draft
                .attachments
                .iter()
                .filter_map(|part| match part {
                    Attachment::Pasted { id, .. } => Some(*id),
                    _ => None,
                }),
        )
        .max()
        .unwrap_or(0);
    let Some(id) = largest.checked_add(1) else {
        return false;
    };
    let part = Attachment::Pasted {
        id,
        text: Arc::from(text.replace("\r\n", "\n").replace('\r', "\n")),
    };
    if !s.composer.draft.attach_for(&s.draft, part) {
        return false;
    }
    let prior = s.draft.clone();
    s.draft.undo_group(|edit| {
        let (start, _) = edit.range();
        edit.paste(&format!("[pasted #{id}]"));
        let (end, _) = edit.range();
        let inherited: Vec<_> = edit
            .marks()
            .iter()
            .filter(|mark| mark.start < end && start < mark.end)
            .map(|mark| mark.mark.clone())
            .collect();
        if !inherited.is_empty() {
            edit.set_selection(start, end);
            for mark in inherited {
                edit.remove_mark(&mark);
            }
            edit.set_caret(end);
        }
    });
    if !workspace::attachment_draft_admissible(s) {
        s.draft = prior;
        s.composer.draft.attachments.pop();
        return false;
    }
    true
}

pub(super) fn expand(text: String, parts: &[Attachment]) -> Option<(String, Vec<Range<usize>>)> {
    let max_bytes = codenomad_client::prompt::MAX_BODY_BYTES;
    if !tokens(&text).any(|(_, id)| {
        parts.iter().any(
            |part| matches!(part, Attachment::Pasted { id: candidate, .. } if *candidate == id),
        )
    }) {
        return (text.len() <= max_bytes).then_some((text, Vec::new()));
    }
    expand_bounded(&text, parts, max_bytes)
}

pub(super) fn expand_bounded(
    text: &str,
    parts: &[Attachment],
    max_bytes: usize,
) -> Option<(String, Vec<Range<usize>>)> {
    let mut result = String::new();
    let mut offset = 0;
    let mut spans = Vec::new();
    for (range, id) in tokens(text) {
        let Some(Attachment::Pasted { text: pasted, .. }) = parts.iter().find(
            |part| matches!(part, Attachment::Pasted { id: candidate, .. } if *candidate == id),
        ) else {
            continue;
        };
        if result
            .len()
            .saturating_add(range.start - offset)
            .saturating_add(pasted.len())
            > max_bytes
        {
            return None;
        }
        result.push_str(&text[offset..range.start]);
        spans.push(result.len()..result.len() + pasted.len());
        result.push_str(pasted);
        offset = range.end;
    }
    if offset == 0 {
        return (text.len() <= max_bytes).then(|| (text.to_owned(), spans));
    }
    if result.len().saturating_add(text.len() - offset) > max_bytes {
        return None;
    }
    result.push_str(&text[offset..]);
    Some((result, spans))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::composer::{draft::Draft, draft_storage::SavedParts};
    use rune::{Env, Key, KeyEvent, Mods, PhysicalInput, PhysicalKeyCode, Runtime};

    #[test]
    fn native_paste_replaces_the_selection_and_sends_one_inline_expansion() {
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        s.draft = rune::TextEdit::new("before selection after");
        let (out, input) = codenomad_client::bounded(1);
        s.commands = Some(out);
        let mut rt = Runtime::new(s, crate::view, (800.0, 600.0), Env::new(false, 1.0));
        rt.update(|s, tx| {
            s.draft.set_selection(7, 16);
            tx.focus("composer", false);
        });
        let clipboard = rune::clipboard::memory();
        let text = "first\r\n@./literal [pasted #8]\r\nthird\r\nlast 🦀";
        clipboard.set_text(text);
        rt.use_clipboard(&clipboard);
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
        rt.frame(0.0);
        assert_eq!(rt.state.draft.text, "before [pasted #9] after");
        assert!(rt.find("attachment-0").is_some());
        rt.update(|s, _| s.draft.undo());
        rt.frame(0.0);
        assert_eq!(rt.state.draft.text, "before selection after");
        assert!(rt.find("attachment-0").is_none());
        rt.update(|s, _| s.draft.redo());
        rt.frame(0.0);
        assert!(rt.find("attachment-0").is_some());
        let enter = KeyEvent {
            key: Key::Enter,
            mods: Mods::default(),
        };
        rt.key(enter);
        rt.frame(0.0);
        let crate::transport::Command::Prompt(prompt) = input.try_recv().unwrap() else {
            panic!("expected ordinary prompt");
        };
        assert_eq!(
            prompt.text,
            format!("before {} after", text.replace("\r\n", "\n"))
        );
        assert!(prompt.files.is_empty());
        assert!(input.try_recv().is_err());
    }

    #[test]
    fn removing_a_chip_refocuses_the_editor_for_keyboard_undo() {
        let mut s = crate::init();
        s.phase = crate::Phase::Ready;
        let mut rt = Runtime::new(s, crate::view, (800.0, 650.0), Env::new(false, 1.0));
        rt.update(|_, tx| tx.focus("composer", false));
        let long = "line 1\nline 2\nline 3\nline 4";
        rt.paste(long);
        for _ in 0..20 {
            rt.frame(1.0 / 60.0);
        }
        let (x, y) = rt.find("remove-0").expect("visible chip control");
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        rt.frame(0.0);
        assert!(rt.state.draft.text.is_empty());
        assert!(
            rt.elements()
                .iter()
                .any(|node| node.focused && node.path.contains("/composer/"))
        );
        rt.key(KeyEvent {
            key: Key::Command('z'),
            mods: Mods {
                cmd: true,
                ctrl: !cfg!(target_os = "macos"),
                ..Mods::default()
            },
        });
        rt.frame(0.0);
        assert!(rt.find("attachment-0").is_some());
        assert_eq!(
            rt.state
                .composer
                .draft
                .resolve_text(&rt.state.draft.text)
                .as_deref(),
            Some(long)
        );
    }

    #[test]
    fn detached_pastes_leave_room_for_pasted_text_and_other_parts() {
        use crate::composer::draft::MAX_PARTS;
        let mut s = crate::init();
        let mut tx = Tx::default();
        let text = "test\nexisting\nclipboard\ncontents";
        for _ in 0..MAX_PARTS {
            assert!(paste(&mut s, text, &mut tx));
        }
        assert_eq!(s.composer.draft.active_count(&s.draft), MAX_PARTS);
        s.composer.draft.remove(&mut s.draft, 0);
        assert!(s.composer.draft.attach_for(
            &s.draft,
            Attachment::Device {
                name: "device.txt".into(),
                mime: "text/plain".into(),
                bytes: Arc::from([]),
                token: None,
            }
        ));
        assert_eq!(s.composer.draft.active_count(&s.draft), MAX_PARTS);
        s.composer.draft.remove(&mut s.draft, 1);
        assert!(paste(&mut s, text, &mut tx));
        assert!(s.draft.text.contains("[pasted #65]"));
        assert_eq!(s.composer.draft.active_count(&s.draft), MAX_PARTS);
        assert_eq!(s.composer.draft.attachments.len(), MAX_PARTS + 2);
    }

    #[test]
    fn compact_paste_at_the_end_of_inline_paste_keeps_its_own_marker() {
        let mut s = crate::init();
        let large = "x".repeat(MAX_BYTES - 180);
        let inline = format!(" @./literal {}", "y".repeat(180));
        let small = "\nline 1\nline 2\nline 3";
        let mut tx = Tx::default();
        for text in [&large, &inline, small] {
            assert!(paste(&mut s, text, &mut tx));
        }
        assert_eq!(s.draft.text, format!("[pasted #1]{inline}[pasted #2]"));
        assert_eq!(
            active_tokens(&s.draft)
                .map(|(_, id)| id)
                .collect::<Vec<_>>(),
            [1, 2]
        );
        let expected = format!("{large}{inline}{small}");
        let saved = SavedParts::capture(&s.composer.draft, false, &s.draft)
            .unwrap()
            .encode();
        let (restored, missing) = SavedParts::decode(&saved).unwrap().restore();
        assert!(!missing);
        let mut edit = TextEdit::new(&s.draft.text);
        super::super::literal::restore(&mut edit, &restored.literal_spans);
        assert_eq!(
            restored
                .prepare(
                    &edit,
                    "msg-adjacent",
                    codenomad_client::prompt::Delivery::Steer
                )
                .unwrap()
                .0
                .text,
            expected
        );
        s.draft.undo();
        assert_eq!(s.draft.text, format!("[pasted #1]{inline}"));
        s.draft.redo();
        assert_eq!(
            s.composer
                .draft
                .prepare(
                    &s.draft,
                    "msg-adjacent",
                    codenomad_client::prompt::Delivery::Steer
                )
                .unwrap()
                .0
                .text,
            expected
        );
    }

    #[test]
    fn raw_fallback_protects_literals_but_resolves_the_real_mentions_around_it() {
        use codenomad_client::prompt::Delivery;
        let mut s = crate::init();
        assert!(
            s.composer
                .draft
                .attach(Attachment::Path("./project".into()))
        );
        assert!(
            s.composer
                .draft
                .attach(Attachment::Agent("reviewer".into()))
        );
        assert!(s.composer.draft.attach(Attachment::Pasted {
            id: 1,
            text: Arc::from("must stay literal")
        }));
        s.draft = rune::TextEdit::new("@./project INSERT @reviewer @project");
        s.draft.set_selection(11, 17);
        let raw = format!(
            "@./project @project @reviewer [pasted #1]\n{}",
            "x".repeat(MAX_BYTES)
        );
        assert!(paste(&mut s, &raw, &mut Tx::default()));
        assert!(s.draft.text.contains(&raw));
        assert_eq!(s.composer.draft.attachments.len(), 3);
        let draft = &s.composer.draft;
        let (prompt, _) = draft.prepare(&s.draft, "msg-raw", Delivery::Steer).unwrap();
        let before = format!("./project {raw} ");
        assert_eq!(prompt.text, format!("{before}@reviewer ./project"));
        assert_eq!(
            prompt.agents[0].mention.as_ref().unwrap().start,
            before.encode_utf16().count()
        );
        s.draft.undo();
        assert_eq!(s.draft.text, "@./project INSERT @reviewer @project");
        s.draft.redo();
        assert_eq!(
            draft
                .prepare(&s.draft, "msg-raw", Delivery::Steer)
                .unwrap()
                .0,
            prompt
        );
    }

    #[test]
    fn inline_provenance_survives_draft_serialization() {
        let mut s = crate::init();
        assert!(s.composer.draft.attach(Attachment::Pasted {
            id: 1,
            text: Arc::from("x".repeat(MAX_BYTES))
        }));
        let raw = "@./literal\n\n\n[ pasted #1 ]";
        assert!(paste(&mut s, raw, &mut Tx::default()));
        let saved = SavedParts::capture(&s.composer.draft, false, &s.draft)
            .unwrap()
            .encode();
        let (draft, missing) = SavedParts::decode(&saved).unwrap().restore();
        assert!(!missing);
        let mut reopened = rune::TextEdit::new(&s.draft.text);
        super::super::literal::restore(&mut reopened, &draft.literal_spans);
        let (prompt, _) = draft
            .prepare(
                &reopened,
                "msg-raw",
                codenomad_client::prompt::Delivery::Steer,
            )
            .unwrap();
        assert_eq!(prompt.text, raw);
    }

    #[test]
    fn saved_pastes_expand_only_as_tokens_and_are_removable() {
        let mut original = Draft::default();
        assert!(original.attach(Attachment::Pasted {
            id: 8,
            text: Arc::from("@./literal @reviewer [pasted #8] 🦀"),
        }));
        let json = SavedParts::capture(&original, false, &rune::TextEdit::new("[pasted #8]"))
            .unwrap()
            .encode();
        let parts = SavedParts::decode(&json).unwrap();
        assert!(parts.valid());
        let (mut draft, missing) = parts.restore();
        assert!(!missing);
        assert_eq!(
            draft
                .resolve_text("see [ PASTED # 8 ] and [pasted #1]")
                .as_deref(),
            Some("see @./literal @reviewer [pasted #8] 🦀 and [pasted #1]")
        );
        assert!(draft.attach(Attachment::Agent("reviewer".into())));
        let (prompt, _) = draft
            .prepare(
                &rune::TextEdit::new("[pasted #8] @reviewer"),
                "msg-test",
                codenomad_client::prompt::Delivery::Steer,
            )
            .unwrap();
        let mention = prompt.agents[0].mention.as_ref().unwrap();
        let prefix = "@./literal @reviewer [pasted #8] 🦀 ";
        assert_eq!(prompt.text, format!("{prefix}@reviewer"));
        assert_eq!(mention.start, prefix.encode_utf16().count());
        let mut edit = rune::TextEdit::new("left [pasted #8] right");
        draft.remove(&mut edit, 0);
        assert_eq!(edit.text, "left  right");
        let (saved, _) = SavedParts::capture(&draft, false, &edit).unwrap().restore();
        assert_eq!(saved.attachments, [Attachment::Agent("reviewer".into())]);
        edit.undo();
        assert_eq!(edit.text, "left [pasted #8] right");
        assert_eq!(
            draft.resolve_text(&edit.text).as_deref(),
            Some("left @./literal @reviewer [pasted #8] 🦀 right")
        );
        edit.redo();
        assert_eq!(
            draft.resolve_text(&edit.text).as_deref(),
            Some("left  right")
        );
        draft.remove(&mut edit, 1);
        assert!(!draft.can_send(&rune::TextEdit::new("")));
    }
}
