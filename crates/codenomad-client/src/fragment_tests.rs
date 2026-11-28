use crate::{
    Message,
    content::{self, Part, TextEvent, TextFit, TextProvenance},
    history,
    transport::Event,
    wire,
};
use serde_json::{Value, json};

fn row(parts: Value) -> Message {
    history::decode_message(
        &json!({"id":"assistant","type":"assistant","time":{"created":1},"content":parts}),
    )
    .unwrap()
}
fn tool() -> Value {
    json!({"type":"tool","id":"read_one","name":"read","state":{"status":"completed","content":[{"type":"text","text":"passive result"}]}})
}
fn event(kind: &str, ordinal: usize, text: &str) -> TextEvent {
    let native = json!({"type":format!("session.text.{kind}"),"data":{
        "sessionID":"session","assistantMessageID":"assistant","ordinal":ordinal,"text":text,"delta":text}});
    let Some(Event::Text(id, event)) = wire::decode_native(&native) else {
        panic!("native text event")
    };
    assert_eq!(id, "assistant");
    event
}
#[test]
fn text_after_a_native_tool_streams_into_the_parts_and_the_body() {
    let mut live = row(json!([{"type":"text","text":"Before","native":{}},tool()]));
    assert_eq!(
        content::apply_text(&mut live, &event("started", 1, "")).unwrap(),
        TextFit::Applied
    );
    for suffix in ["After ", "MKAA000008K"] {
        assert_eq!(
            content::apply_text(&mut live, &event("delta", 1, suffix)).unwrap(),
            TextFit::Applied
        );
    }
    assert_eq!(live.body, "Before\nAfter MKAA000008K");
    assert!(
        matches!(&live.parts[..],[Part::Text(a),Part::Tool(_),Part::Text(b)]
        if a.text=="Before"&&b.text=="After MKAA000008K")
    );
    let page = vec![row(
        json!([{"type":"text","text":"Before","native":{}},tool(),{"type":"text","text":""}]),
    )];
    let mut page = page
        .into_iter()
        .map(std::sync::Arc::new)
        .collect::<Vec<_>>();
    content::merge_page(&[live.into()], &mut page).unwrap();
    assert_eq!(page[0].body, "Before\nAfter MKAA000008K");
    assert_eq!(
        content::apply_text(
            std::sync::Arc::make_mut(&mut page[0]),
            &event("delta", 1, " continues")
        )
        .unwrap(),
        TextFit::Applied
    );
    assert_eq!(page[0].body, "Before\nAfter MKAA000008K continues");
}
#[test]
fn an_open_shorter_page_preserves_the_live_fragment_and_its_native_neighbours() {
    let live = row(
        json!([{"type":"text","text":"Before MKAA000008K"},tool(),{"type":"text","text":"After"}]),
    );
    let page = vec![row(json!([{"type":"text","text":"Before "},tool()]))];
    let mut page = page
        .into_iter()
        .map(std::sync::Arc::new)
        .collect::<Vec<_>>();
    content::merge_page(&[live.into()], &mut page).unwrap();
    assert_eq!(page[0].body, "Before MKAA000008K\nAfter");
    assert!(
        matches!(&page[0].parts[..],[Part::Text(_),Part::Tool(_),Part::Text(t)] if t.text=="After")
    );
    let mut unrelated = vec![std::sync::Arc::new(row(
        json!([{"type":"text","text":"Authoritative replacement"}]),
    ))];
    content::merge_page(
        &[row(json!([{"type":"text","text":"Old text"}])).into()],
        &mut unrelated,
    )
    .unwrap();
    assert_eq!(unrelated[0].body, "Authoritative replacement");
}
#[test]
fn partial_pages_owe_settlement_and_full_text_endings_resolve_duplicates() {
    let mut live = row(json!([{"type":"text","text":"Prefix"}]));
    assert!(matches!(&live.parts[0],Part::Text(t) if t.provenance==TextProvenance::Partial));
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, " repeated")).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, " new")).unwrap(),
        TextFit::Applied
    );
    assert_eq!(
        content::apply_text(&mut live, &event("ended", 0, "Confirmed native text")).unwrap(),
        TextFit::Applied
    );
    assert_eq!(live.body, "Confirmed native text");
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, " replay")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(live.body, "Confirmed native text");
}
#[test]
fn ordinal_gaps_and_redeliveries_never_edit_another_fragment() {
    let mut live =
        row(json!([{"type":"text","text":"First"},tool(),{"type":"text","text":"Second"}]));
    let initial = live.clone();
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, " late")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(
        content::apply_text(&mut live, &event("started", 1, "")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 2, " missing start")).unwrap(),
        TextFit::Repair
    );
    assert_eq!(live, initial);
}
#[test]
fn committed_page_content_can_shorten_or_remove_live_text() {
    let live = row(
        json!([{"type":"text","text":"Long live text"},tool(),{"type":"text","text":"Other text"}]),
    );
    let terminal = history::decode_message(
        &json!({"id":"assistant","type":"assistant","time":{"created":1,"completed":2},
        "content":[{"type":"text","text":"Final"}]}),
    )
    .unwrap();
    let mut terminal = std::sync::Arc::new(terminal);
    content::merge_page(&[live.into()], std::slice::from_mut(&mut terminal)).unwrap();
    assert_eq!(terminal.body, "Final");
    assert_eq!(terminal.parts.len(), 1);
    assert!(matches!(&terminal.parts[0],Part::Text(t) if t.provenance==TextProvenance::Closed));
}
#[test]
fn native_and_state_commit_text_while_an_unmarked_nonempty_page_is_partial() {
    for (field, value) in [
        ("native", json!({"item":"committed"})),
        ("state", json!({})),
    ] {
        let mut part = json!({"type":"text","text":"Committed"});
        part[field] = value;
        let message = row(json!([part]));
        assert!(matches!(&message.parts[0],Part::Text(t) if t.provenance==TextProvenance::Closed));
    }
    assert!(
        matches!(&row(json!([{"type":"text","text":"Partial"}])).parts[0],Part::Text(t) if t.provenance==TextProvenance::Partial)
    );
    assert!(
        matches!(&row(json!([{"type":"text","text":""}])).parts[0],Part::Text(t) if t.provenance==TextProvenance::Live)
    );
}
#[test]
fn absent_ordinals_keep_the_sdk_latest_fragment_contract_and_bounds_are_atomic() {
    let mut live = row(json!([]));
    content::apply_text(&mut live, &TextEvent::Start { ordinal: None }).unwrap();
    content::apply_text(
        &mut live,
        &TextEvent::Delta {
            ordinal: None,
            text: "first".into(),
        },
    )
    .unwrap();
    content::apply_text(
        &mut live,
        &TextEvent::End {
            ordinal: None,
            text: "final".into(),
        },
    )
    .unwrap();
    assert_eq!(live.body, "final");
    let prior = live.clone();
    assert!(
        content::apply_text(
            &mut live,
            &TextEvent::Start {
                ordinal: Some(usize::MAX)
            }
        )
        .is_err()
    );
    assert_eq!(live, prior);
    assert_eq!(
        content::apply_text(
            &mut live,
            &TextEvent::End {
                ordinal: Some(0),
                text: "x".repeat(256 * 1024 + 1)
            }
        )
        .unwrap(),
        TextFit::Settlement
    );
    assert_eq!(live.body.len(), 256 * 1024);
    assert!(
        matches!(&live.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial && t.text.len() == 256 * 1024)
    );
}

#[test]
fn live_delta_crossing_256k_bounds_on_utf8_boundary_marks_partial_and_drops_trailing_deltas() {
    let mut live = row(json!([]));
    assert_eq!(
        content::apply_text(&mut live, &event("started", 0, "")).unwrap(),
        TextFit::Applied
    );
    // Leave exactly 2 bytes before the 256 KiB ceiling so a 4-byte emoji cannot fit.
    let prefix = "a".repeat(256 * 1024 - 2);
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, &prefix)).unwrap(),
        TextFit::Applied
    );
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, "🦀é!")).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(live.body, prefix);
    assert!(
        matches!(&live.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial && t.text == prefix)
    );
    // A subsequent 1-byte ASCII delta must NOT stitch past the dropped multi-byte char.
    assert_eq!(
        content::apply_text(&mut live, &event("delta", 0, "!")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(live.body, prefix);
    assert!(matches!(&live.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial));

    // A mid-stream history page carrying the exact truncated prefix must preserve `bounded`
    // so a following short delta still drops instead of stitching past the omitted codepoint.
    let mut page_equal = std::sync::Arc::new(
        history::decode_message(&json!({
            "id": "assistant",
            "type": "assistant",
            "time": {"created": 1},
            "content": [{"type": "text", "text": prefix}]
        }))
        .unwrap(),
    );
    content::merge_page(
        &[live.clone().into()],
        std::slice::from_mut(&mut page_equal),
    )
    .unwrap();
    let mut merged = (*page_equal).clone();
    assert_eq!(
        content::apply_text(&mut merged, &event("delta", 0, "!")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(merged.body, prefix);
    assert!(matches!(&merged.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial));

    // A partial UTF-8 prefix of a delta that crosses 256 KiB keeps complete codepoints only.
    let mut partial_fit = row(json!([]));
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("started", 0, "")).unwrap(),
        TextFit::Applied
    );
    let prefix3 = "b".repeat(256 * 1024 - 3);
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("delta", 0, &prefix3)).unwrap(),
        TextFit::Applied
    );
    // "é" (2 bytes) fits in 3 bytes; "🦀" (4 bytes) does not fit in the remaining 1 byte.
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("delta", 0, "é🦀tail")).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(partial_fit.body, format!("{prefix3}é"));
    assert_eq!(partial_fit.body.len(), 256 * 1024 - 1);
    assert!(
        matches!(&partial_fit.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial)
    );

    // Starting a second fragment when 1 byte remains fits the "\n" separator (exact 256 KiB),
    // its first delta hits the zero-room ceiling without error, and a third fragment starts exhausted.
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("started", 1, "")).unwrap(),
        TextFit::Applied
    );
    assert_eq!(partial_fit.body.len(), 256 * 1024);
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("delta", 1, "overflow")).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("delta", 1, "more")).unwrap(),
        TextFit::Drop
    );
    assert_eq!(
        content::apply_text(&mut partial_fit, &event("started", 2, "")).unwrap(),
        TextFit::Settlement
    );
    assert!(matches!(
        &partial_fit.parts[..],
        [Part::Text(a), Part::Text(b), Part::Text(c)]
            if a.provenance == TextProvenance::Partial
                && b.provenance == TextProvenance::Partial
                && b.text.is_empty()
                && c.provenance == TextProvenance::Partial
                && c.text.is_empty()
    ));
}

#[test]
fn oversized_live_end_bounds_utf8_with_partial_provenance_while_history_stays_fail_closed() {
    let mut live = row(json!([]));
    assert_eq!(
        content::apply_text(&mut live, &event("started", 0, "")).unwrap(),
        TextFit::Applied
    );
    // 256 KiB - 1 bytes of 'a', then a 4-byte emoji + tail: floor_char_boundary keeps 256 KiB - 1.
    let oversized_end = format!("{}🦀tail", "a".repeat(256 * 1024 - 1));
    assert_eq!(
        content::apply_text(&mut live, &event("ended", 0, &oversized_end)).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(live.body.len(), 256 * 1024 - 1);
    assert!(live.body.chars().all(|c| c == 'a'));
    assert!(matches!(&live.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial));

    // Completed history page reconciles the full text (within history::MAX_BYTES) as Closed.
    let mut authoritative = std::sync::Arc::new(
        history::decode_message(&json!({
            "id": "assistant",
            "type": "assistant",
            "time": {"created": 1, "completed": 2},
            "content": [{"type": "text", "text": oversized_end}]
        }))
        .unwrap(),
    );
    content::merge_page(&[live.into()], std::slice::from_mut(&mut authoritative)).unwrap();
    assert_eq!(authoritative.body, oversized_end);
    assert!(
        matches!(&authoritative.parts[0], Part::Text(t) if t.provenance == TextProvenance::Closed)
    );

    // An oversized End matching an already-Closed history fragment does not shrink or reopen it.
    let mut closed_row = (*authoritative).clone();
    assert_eq!(
        content::apply_text(&mut closed_row, &event("ended", 0, &oversized_end)).unwrap(),
        TextFit::Applied
    );
    assert_eq!(closed_row.body, oversized_end);
    assert!(
        matches!(&closed_row.parts[0], Part::Text(t) if t.provenance == TextProvenance::Closed)
    );

    // An oversized End extending a >256 KiB Partial history prefix does not shrink what is already shown.
    let mut partial_history = history::decode_message(&json!({
        "id": "assistant",
        "type": "assistant",
        "time": {"created": 1},
        "content": [{"type": "text", "text": oversized_end}]
    }))
    .unwrap();
    let extended_end = format!("{oversized_end}more");
    assert_eq!(
        content::apply_text(&mut partial_history, &event("ended", 0, &extended_end)).unwrap(),
        TextFit::Settlement
    );
    assert_eq!(partial_history.body, oversized_end);
    assert!(
        matches!(&partial_history.parts[0], Part::Text(t) if t.provenance == TextProvenance::Partial)
    );

    // History decode_message and history::check remain strictly fail-closed above MAX_BYTES (8 MiB).
    let huge = "x".repeat(history::MAX_BYTES + 1);
    assert!(
        history::decode_message(&json!({
            "id": "huge",
            "type": "assistant",
            "time": {"created": 1, "completed": 2},
            "content": [{"type": "text", "text": huge}]
        }))
        .is_err()
    );
    let mut overflow_row = row(json!([]));
    overflow_row.body = huge;
    assert!(history::check(&[std::sync::Arc::new(overflow_row)]).is_err());
}
