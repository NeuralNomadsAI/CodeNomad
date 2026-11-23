use super::*;

fn hit(session: &str, n: usize) -> Value {
    json!({"sessionID":session,"messageID":format!("m{n}"),"role":"assistant","partIndex":0,
        "kind":"text","excerpt":"Été près de Québec"})
}

#[test]
fn literal_and_ranked_validate_their_distinct_result_bounds() {
    let mut page: Page = serde_json::from_value(json!({
        "hits":[hit("session",0)],"scanned":32,"skipped":1,"cursor":null,
    }))
    .unwrap();
    assert!(
        page.validate(BATCH, LITERAL_CURSOR, Some("session"))
            .is_ok()
    );
    assert!(page.validate(BATCH, LITERAL_CURSOR, Some("other")).is_err());
    page.hits[0].excerpt = "😀".repeat(161);
    assert!(page.validate(BATCH, LITERAL_CURSOR, None).is_err());
    page.hits.clear();
    page.cursor = Some("c".repeat(LITERAL_CURSOR + 1));
    assert!(page.validate(BATCH, LITERAL_CURSOR, None).is_err());
    assert!(page.validate(RANKED_LIMIT, RANKED_CURSOR, None).is_ok());
    assert!(serde_json::from_value::<Page>(json!({"hits":[],"scanned":0,"skipped":0})).is_err());
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn literal_pages_publish_progress_and_preserve_the_last_whole_batch() {
    let route = "POST /api/workspaces/workspace/session-history/query HTTP/1.1";
    let input =
        json!({"sessionID":"session","query":"Été","includeTechnical":false,"purpose":"search"});
    let mut next = input.clone();
    next["cursor"] = json!("second");
    let reply = |range: std::ops::Range<usize>, cursor: &str| {
        json!({
            "status":"page","scanned":120,"skipped":1,"tools":0,"reasoning":0,
            "candidates":[],"cursor":cursor,"hits":range.map(|n| hit("session",n)).collect::<Vec<_>>(),
        })
    };
    crate::timeline::tests::http_probe(
        vec![
            (route, Some(input), reply(0..31, "second"), false),
            (route, Some(next), reply(31..63, "third"), false),
        ],
        async |backend, _| {
            let mut batches = Vec::new();
            let page = backend
                .search_history("  Été ", false, None, |page| {
                    batches.push((page.scanned, page.hits.len()))
                })
                .await
                .unwrap();
            assert_eq!(batches, [(120, 31)]);
            assert_eq!((page.scanned, page.skipped, page.hits.len()), (240, 2, 63));
            assert_eq!(page.hits[62].message, "m62");
            assert_eq!(page.cursor.as_deref(), Some("third"));
        },
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn ranked_keeps_broker_order_and_never_falls_back_to_literal() {
    let route = "POST /api/workspaces/workspace/session-history/ranked HTTP/1.1";
    let input = json!({"version":1,"query":"Été Québec","includeTechnical":true,"limit":40});
    let mut next = input.clone();
    next["cursor"] = json!("older");
    crate::timeline::tests::http_probe(
        vec![
            (
                route,
                Some(input.clone()),
                json!({
                    "status":"ranked","version":1,"capped":true,"examinedBefore":0,"exclusions":["foreign_directory"],
                    "scanned":96,"skipped":0,"cursor":"older","hits":[hit("z",9),hit("a",1),hit("z",2)],
                }),
                false,
            ),
            (route, Some(next), json!({"status":"unsupported"}), false),
            (route, Some(input), json!({"status":"unsupported"}), false),
        ],
        async |backend, _| {
            let Ranked::Ranked {
                page,
                capped,
                exclusions,
                ..
            } = backend
                .rank_history("Été Québec", true, None)
                .await
                .unwrap()
            else {
                panic!("expected broker ranks")
            };
            assert_eq!(
                page.hits
                    .iter()
                    .map(|h| h.message.as_str())
                    .collect::<Vec<_>>(),
                ["m9", "m1", "m2"]
            );
            assert!(capped && exclusions == [Exclusion::ForeignDirectory]);
            assert!(matches!(
                backend
                    .rank_history("Été Québec", true, page.cursor.as_deref())
                    .await
                    .unwrap(),
                Ranked::RestartRequired
            ));
            assert!(matches!(
                backend
                    .rank_history("Été Québec", true, None)
                    .await
                    .unwrap(),
                Ranked::Unsupported
            ));
        },
    );
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn a_repeated_cursor_fails_before_progress() {
    let route = "POST /api/workspaces/workspace/session-history/query HTTP/1.1";
    crate::timeline::tests::http_probe(
        vec![(
            route,
            Some(
                json!({"sessionID":"session","query":"Été","includeTechnical":false,"purpose":"search","cursor":"same"}),
            ),
            json!({"status":"page","hits":[],"scanned":10,"skipped":0,"cursor":"same"}),
            false,
        )],
        async |backend, _| {
            let error = backend
                .search_history("Été", false, Some("same"), |_| {
                    panic!("obsolete progress")
                })
                .await
                .unwrap_err();
            assert_eq!(error.downcast_ref::<Blocked>(), Some(&Blocked::Conflict));
        },
    );
}
