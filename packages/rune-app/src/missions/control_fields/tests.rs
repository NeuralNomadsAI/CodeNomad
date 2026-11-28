use super::*;
use crate::missions::{Lifecycle, detail::Snapshot, task_rows::TaskRows};
use crate::platform::reads::Reads;
use codenomad_client::{
    backend::Backend,
    missions::{ControlRow, MapHeader, ReceiptContent, Window},
};
use rune::{Env, Key, KeyEvent, Mods, Runtime};
use serde_json::{Value, json};
use std::rc::Rc;

fn header(revision: u64) -> MapHeader {
    serde_json::from_value(json!({
        "root":{"version":1,"id":"mission","projectID":"project","projectCanonical":"/fixture",
            "excerpt":"Fixture","template":"custom","status":"active","coordinatorSessionId":"session",
            "revision":revision,"createdAt":1,"updatedAt":1,"historyTruncated":false,"bodies":{}},
        "collections":{},"tasks":{"page":{"order":"","offset":0,"end":0,"total":0,"counts":{},"reports":0},
            "pins":[],"reportPins":[],"version":""},
        "control":{"id":"operation","requestID":"request","action":"pause","expectedRevision":revision - 1,
            "pending":2,"receipts":2,"unconfirmedReceipts":1,"partialDescendants":0}
    }))
    .unwrap()
}

fn receipts_page(id: &str, json: String, total: u64) -> ControlPage {
    ControlPage {
        window: Window {
            order: "order".into(),
            offset: 0,
            end: 1,
            total,
        },
        rows: vec![ControlRow {
            session: "ses-actor".into(),
            known: true,
            receipt: Some(ReceiptContent {
                id: id.into(),
                json,
            }),
        }],
    }
}

fn attested_backend() -> Backend {
    crate::platform::block_on(async {
        let http = crate::files::test_http::Http::new().await;
        let backend = http.backend.clone();
        let attest = tokio::spawn(async move { backend.attest_server().await });
        http.accept()
            .await
            .reply(200, json!({"serverId":"server","apiContract":1}))
            .await;
        assert_eq!(attest.await.unwrap().unwrap(), "server");
        http.backend
    })
}

fn panel_at(revision: u64, json: String) -> (Panel, Source) {
    let mut backend = attested_backend();
    backend.workspace = "workspace".into();
    let header = header(revision);
    let mut panel = Panel::new(
        backend,
        Some("project".into()),
        Reads::default(),
        std::sync::Arc::new(|| {}),
    );
    panel.detail.snapshot = Some(Snapshot {
        header,
        tasks: Rc::new(TaskRows::new(vec![])),
        reports: Default::default(),
        end: 0,
        attention_end: 0,
    });
    panel.control_fields.part = Some(ControlPart::Receipts);
    panel.control_fields.revision = revision;
    panel.control_fields.shown = Some(receipts_page("r1", json, 2));
    let source = panel.control_source("occ").unwrap().0;
    (panel, source)
}

fn find_a11y<'a>(tree: &'a Value, key: &str) -> Option<&'a Value> {
    if tree["key"] == key {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| find_a11y(child, key))
}

fn has_state(tree: &Value, key: &str, state: &str) -> bool {
    find_a11y(tree, key)
        .and_then(|node| node["states"].as_array())
        .is_some_and(|states| states.contains(&Value::from(state)))
}

#[test]
fn receipt_display_pages_reassemble_the_original_without_splitting_unicode() {
    let source = format!(
        "{}🦀{}",
        "a".repeat(RECEIPT_BYTES - 1),
        "é".repeat(RECEIPT_BYTES)
    );
    let mut view = ReceiptView::new("receipt".into(), &source);
    let mut restored = String::new();
    for page in 0..view.starts.len() {
        view.page = page;
        let text = view.text(&source);
        assert!(text.len() <= RECEIPT_BYTES);
        restored.push_str(text);
    }
    assert_eq!(restored, source);
}

#[test]
fn receipt_pagination_navigates_and_clears_on_page_part_and_revision_changes() {
    let large = format!("{{\"payload\":\"{}\"}}", "x".repeat(RECEIPT_BYTES + 64));
    let mut fields = Fields {
        part: Some(ControlPart::Receipts),
        revision: 8,
        shown: Some(receipts_page("r1", large.clone(), 2)),
        ..Fields::default()
    };
    fields.show_receipt("r1".into(), None);
    let open = fields.receipt.as_ref().unwrap();
    assert_eq!(open.id, "r1");
    assert_eq!(open.page, 0);
    assert_eq!(open.starts.len(), 2);

    fields.show_receipt("r1".into(), Some(1));
    assert_eq!(fields.receipt.as_ref().unwrap().page, 1);
    fields.show_receipt("r1".into(), Some(9));
    assert_eq!(fields.receipt.as_ref().unwrap().page, 1);
    fields.show_receipt("r1".into(), Some(0));
    assert_eq!(fields.receipt.as_ref().unwrap().page, 0);
    fields.show_receipt("r1".into(), None);
    assert!(fields.receipt.is_none());

    // Page change clears the open receipt.
    fields.show_receipt("r1".into(), None);
    assert!(fields.receipt.is_some());
    let (send, inbox) = bounded(1);
    send.try_send(Ok(receipts_page("r2", "{}".into(), 2)))
        .ok()
        .unwrap();
    fields.flight = Some((CancelToken::new().0, inbox));
    assert!(fields.poll(Some(8)));
    assert!(fields.receipt.is_none());

    // Revision change clears the open receipt and displayed page.
    fields.show_receipt("r2".into(), None);
    assert!(fields.receipt.is_some());
    assert!(fields.poll(Some(9)));
    assert!(fields.receipt.is_none());
    assert!(fields.part.is_none());
    assert!(fields.shown.is_none());

    // Part change clears the open receipt.
    let (mut panel, _) = panel_at(8, large);
    crate::platform::block_on(async {
        panel.control_fields.show_receipt("r1".into(), None);
        assert!(panel.control_fields.receipt.is_some());
        panel.read_control_field(ControlPart::Pending, 0);
        assert!(panel.control_fields.receipt.is_none());
        assert_eq!(panel.control_fields.part, Some(ControlPart::Pending));
    });
}

#[test]
fn stale_revision_and_non_authoritative_state_refuse_control_field_gestures() {
    let mut owner = Lifecycle::default();
    let (mut panel, source) = panel_at(8, "{\"ok\":true}".into());

    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReceiptDetails("r1".into(), 7, None),
    );
    assert!(panel.control_fields.receipt.is_none());

    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReceiptDetails("r1".into(), 8, None),
    );
    assert!(panel.control_fields.receipt.is_some());
    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReceiptDetails("r1".into(), 8, None),
    );
    assert!(panel.control_fields.receipt.is_none());

    // Non-authoritative due to a newer observed revision refuses both gestures.
    panel.detail.observe("mission", 9);
    assert!(!panel.detail.authoritative());
    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReceiptDetails("r1".into(), 8, None),
    );
    assert!(panel.control_fields.receipt.is_none());
    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReadField(ControlPart::Pending, 0),
    );
    assert!(panel.control_fields.flight.is_none());
    assert_eq!(panel.control_fields.part, Some(ControlPart::Receipts));

    // Non-authoritative due to failed detail read also refuses both gestures.
    let (mut panel, source) = panel_at(8, "{\"ok\":true}".into());
    panel.detail.failed = true;
    assert!(!panel.detail.authoritative());
    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReceiptDetails("r1".into(), 8, None),
    );
    assert!(panel.control_fields.receipt.is_none());
    panel.control(
        "occ",
        &mut owner,
        &source,
        Gesture::ReadField(ControlPart::Pending, 0),
    );
    assert!(panel.control_fields.flight.is_none());
    assert_eq!(panel.control_fields.part, Some(ControlPart::Receipts));
}

#[test]
fn boundary_pagination_keeps_keyboard_focus_and_non_authoritative_disables_controls() {
    struct Scene {
        fields: Fields,
        control: ControlReceipt,
        ready: bool,
        source: Source,
    }
    fn act(scene: &mut Scene, _: &Source, gesture: Gesture) {
        if let Gesture::ReceiptDetails(id, _, page) = gesture {
            scene.fields.show_receipt(id, page);
        }
    }
    let large = format!("{{\"payload\":\"{}\"}}", "x".repeat(RECEIPT_BYTES + 64));
    let (mut panel, source) = panel_at(8, large);
    let control = panel
        .detail
        .snapshot
        .take()
        .unwrap()
        .header
        .control
        .unwrap();
    let mut fields = std::mem::take(&mut panel.control_fields);
    fields.show_receipt("r1".into(), None);

    let mut rt = Runtime::new(
        Scene {
            fields,
            control,
            ready: true,
            source,
        },
        |s, _| {
            crate::strings::with_locale("en", || {
                view(&s.fields, &s.control, s.ready, &s.source, act)
            })
        },
        (480.0, 16000.0),
        Env::new(false, 1.0),
    );
    rt.frame(1.0 / 60.0);
    assert!(
        rt.elements()
            .iter()
            .any(|el| el.key.as_deref() == Some("receipt-body-r1")),
        "receipt code block carries a stable key"
    );

    let dimmed = |rt: &Runtime<Scene>, key: &str| {
        let [x, y, w, h] = rt
            .elements()
            .into_iter()
            .find(|el| el.key.as_deref() == Some(key))
            .unwrap()
            .rect;
        rt.instances.iter().any(|i| {
            let [ix, iy, iw, ih] = i.rect;
            ix <= x + 1.0
                && iy <= y + 1.0
                && ix + iw >= x + w - 1.0
                && iy + ih >= y + h - 1.0
                && iw <= w + 32.0
                && ih <= h + 32.0
                && i.fill[0..3] == [0.0, 0.0, 0.0]
                && i.fill[3] > 0.0
                && i.fill[3] < 1.0
        })
    };
    let tree = rt.accessibility_json();
    assert!(has_state(&tree, "receipt-prev-r1", "disabled"));
    assert!(dimmed(&rt, "receipt-prev-r1"));
    assert!(!has_state(&tree, "receipt-next-r1", "disabled"));
    assert!(!dimmed(&rt, "receipt-next-r1"));

    // Keyboard Next to last page disables Next while keeping focus on it.
    rt.update(|_, tx| tx.focus("receipt-next-r1", true));
    rt.frame(1.0 / 60.0);
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.fields.receipt.as_ref().unwrap().page, 1);
    let tree = rt.accessibility_json();
    assert!(!has_state(&tree, "receipt-prev-r1", "disabled"));
    assert!(!dimmed(&rt, "receipt-prev-r1"));
    assert!(has_state(&tree, "receipt-next-r1", "disabled"));
    assert!(dimmed(&rt, "receipt-next-r1"));
    assert!(has_state(&tree, "receipt-next-r1", "focused"));

    // Pressing Enter again on the disabled Next button does nothing.
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.fields.receipt.as_ref().unwrap().page, 1);

    // Keyboard Previous back to first page disables Previous while keeping focus on it.
    rt.update(|_, tx| tx.focus("receipt-prev-r1", true));
    rt.frame(1.0 / 60.0);
    rt.key(KeyEvent {
        key: Key::Enter,
        mods: Mods::default(),
    });
    rt.frame(1.0 / 60.0);
    assert_eq!(rt.state.fields.receipt.as_ref().unwrap().page, 0);
    let tree = rt.accessibility_json();
    assert!(has_state(&tree, "receipt-prev-r1", "disabled"));
    assert!(has_state(&tree, "receipt-prev-r1", "focused"));
    assert!(!has_state(&tree, "receipt-next-r1", "disabled"));

    // Non-authoritative state disables every control field action and announces it.
    rt.update(|s, _| s.ready = false);
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json();
    for key in [
        "control.receipts",
        "control.pending",
        "receipt-r1",
        "receipt-prev-r1",
        "receipt-next-r1",
        "mission-control-fields-more",
    ] {
        assert!(
            has_state(&tree, key, "disabled"),
            "{key} must be disabled when detail is non-authoritative"
        );
    }

    rt.update(|s, _| s.fields.failed = Some(1));
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json();
    assert!(has_state(&tree, "mission-control-fields-retry", "disabled"));

    rt.update(|s, _| s.ready = true);
    rt.frame(1.0 / 60.0);
    let tree = rt.accessibility_json();
    assert!(!has_state(
        &tree,
        "mission-control-fields-retry",
        "disabled"
    ));
}
