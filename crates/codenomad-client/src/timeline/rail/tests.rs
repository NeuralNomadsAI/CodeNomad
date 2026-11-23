use super::*;
use MarkerKind::*;
use serde_json::json;

fn row(id: &str, seq: u64, kind: Kind) -> Entry {
    Entry {
        id: id.into(),
        seq,
        kind,
        tools: 0,
        reasoning: 0,
        text: Some(0),
        tool_name: None,
        layout: None,
        omitted: None,
    }
}

#[test]
fn projection_keeps_resident_order_and_never_reinstates_a_hidden_row() {
    let index = [
        row("z", 0, Kind::User),
        row("hidden", 2, Kind::System),
        row("a", 8, Kind::Assistant),
        row("middle", 14, Kind::User),
        row("b", 16, Kind::Assistant),
        row("tail", 18, Kind::Compaction),
    ];
    let message = |message, ordinal| Marker {
        message,
        kind: Assistant,
        ordinal,
        continued: false,
        omitted_before: false,
        tool_name: None,
    };
    let a = [message("a", 9), message("a", 11)];
    let b = [message("b", 7)];
    let resident = [
        Resident {
            message: "hidden",
            markers: &[],
        },
        Resident {
            message: "a",
            markers: &a,
        },
        Resident {
            message: "b",
            markers: &b,
        },
    ];
    let rail = project(&index, &resident, WindowPosition::Historical).unwrap();
    assert_eq!(
        rail.iter()
            .map(|x| (x.message, x.ordinal))
            .collect::<Vec<_>>(),
        [
            ("z", 0),
            ("a", 9),
            ("a", 11),
            ("middle", 0),
            ("b", 7),
            ("tail", 0)
        ]
    );
}

#[test]
fn omitted_runs_keep_the_native_anchor_ordinals() {
    for (skipped, ordinal, continued) in [(0, 0, true), (3, 3, false)] {
        let record = serde_json::from_value(json!({
            "id":"step","seq":33,"type":"assistant","tools":5,"reasoning":0,
            "toolName":" read ","layout":"XT-TX",
            "omitted":{"text":skipped,"reasoning":0,"continues":true}
        }))
        .unwrap();
        let index = [record];
        let rail = project(&index, &[], WindowPosition::Latest).unwrap();
        assert_eq!(
            rail.iter()
                .map(|x| (x.kind, x.ordinal, x.continued, x.omitted_before))
                .collect::<Vec<_>>(),
            [
                (Tool, 0, false, false),
                (Assistant, 0, false, false),
                (Assistant, ordinal, continued, true),
                (Tool, 4, false, false)
            ]
        );
        assert_eq!(rail[3].tool_name, Some("read"));
    }
}

#[test]
fn counts_only_keep_unknown_text_and_bound_the_tool_fallback() {
    let index = [Entry {
        tools: u64::MAX,
        reasoning: 15,
        text: None,
        ..row("old", 1, Kind::Assistant)
    }];
    let rail = project(&index, &[], WindowPosition::Latest).unwrap();
    assert_eq!(rail.len(), 1002);
    assert_eq!(rail[0].kind, Reasoning);
    assert_eq!(rail[1].kind, Assistant);
    assert_eq!(rail[1001].ordinal, 999);
}

#[test]
fn a_complete_latest_roll_keeps_the_old_outline_before_the_new_rows() {
    let index = [row("z2", 20, Kind::User), row("z1", 30, Kind::User)];
    let ids: Vec<_> = (0..200).rev().map(|i| format!("a{i:03}")).collect();
    let markers: Vec<_> = ids
        .iter()
        .map(|id| Marker {
            message: id,
            kind: User,
            ordinal: 0,
            continued: false,
            omitted_before: false,
            tool_name: None,
        })
        .collect();
    let resident: Vec<_> = markers
        .iter()
        .map(|marker| Resident {
            message: marker.message,
            markers: std::slice::from_ref(marker),
        })
        .collect();
    let rail = project(&index, &resident, WindowPosition::Latest).unwrap();
    assert_eq!(
        rail[..2].iter().map(|m| m.message).collect::<Vec<_>>(),
        ["z2", "z1"]
    );
    assert_eq!(rail[2..], markers);
    let error = project(&index, &resident, WindowPosition::Historical).unwrap_err();
    assert!(error.is::<UnplacedWindow>());
}
