use super::draft::Attachment;
#[cfg(not(target_arch = "wasm32"))]
use crate::{State, workspace};
#[cfg(not(target_arch = "wasm32"))]
use rune::Tx;
use std::ops::Range;
#[cfg(not(target_arch = "wasm32"))]
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

#[cfg(not(target_arch = "wasm32"))]
pub(super) fn paste(s: &mut State, text: &str, tx: &mut Tx) -> bool {
    if text.len() > MAX_BYTES
        || (text.encode_utf16().nth(150).is_none() && text.split('\n').nth(3).is_none())
    {
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
    if !s.composer.draft.attach(part) {
        return false;
    }
    let prior = s.draft.clone();
    s.draft.paste(&format!("[pasted #{id}]"));
    if !workspace::attachment_draft_admissible(s) {
        s.draft = prior;
        s.composer.draft.attachments.pop();
        return false;
    }
    super::view::changed(s, tx);
    true
}

pub(super) fn expand(text: String, parts: &[Attachment]) -> Option<(String, Vec<Range<usize>>)> {
    let mut result = String::new();
    let mut offset = 0;
    let mut spans = Vec::new();
    for (range, id) in tokens(&text) {
        let Some(Attachment::Pasted { text: pasted, .. }) = parts.iter().find(
            |part| matches!(part, Attachment::Pasted { id: candidate, .. } if *candidate == id),
        ) else {
            continue;
        };
        if result.len() + (range.start - offset) + pasted.len()
            > codenomad_client::prompt::MAX_BODY_BYTES
        {
            return None;
        }
        result.push_str(&text[offset..range.start]);
        spans.push(result.len()..result.len() + pasted.len());
        result.push_str(pasted);
        offset = range.end;
    }
    if offset == 0 {
        return Some((text, spans));
    }
    if result.len() + (text.len() - offset) > codenomad_client::prompt::MAX_BODY_BYTES {
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
    fn saved_pastes_expand_only_as_tokens_and_are_removable() {
        let mut original = Draft::default();
        assert!(original.attach(Attachment::Pasted {
            id: 8,
            text: Arc::from("@./literal @reviewer [pasted #8] 🦀"),
        }));
        let json = SavedParts::capture(&original, false).unwrap().encode();
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
                "[pasted #8] @reviewer",
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
        draft.remove(&mut edit, 0);
        assert!(!draft.can_send(&rune::TextEdit::new("")));
    }
}
