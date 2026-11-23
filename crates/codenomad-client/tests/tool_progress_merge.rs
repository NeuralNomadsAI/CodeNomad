use codenomad_client::{
    Message,
    content::{Part, Tool, merge_page},
    history::decode_message,
};
use serde_json::{Value, json};

#[cfg_attr(not(target_arch = "wasm32"), test)]
pub fn reconnect_preserves_running_progress_until_an_authoritative_update() {
    let row = |state: Value| {
        decode_message(&json!({"id":"reply","type":"assistant","content":[
            {"type":"tool","id":"call","name":"bash","state":state}
        ]}))
        .map(std::sync::Arc::new)
        .unwrap()
    };
    fn tool(row: &Message) -> &Tool {
        let Part::Tool(tool) = &row.parts[0] else {
            panic!("tool part")
        };
        tool
    }

    let progress = json!({"output":"\u{1b}[31mAlready displayed"});
    let mut live =
        row(json!({"status":"running","input":{"command":"initial"},"metadata":progress}));
    for metadata in [json!({}), Value::Null] {
        let mut fetched = [row(
            json!({"status":"running","input":{"command":"verified"},"metadata":metadata}),
        )];
        merge_page(&[live], &mut fetched).unwrap();
        assert_eq!(tool(&fetched[0]).metadata, progress);
        assert_eq!(tool(&fetched[0]).input, json!({"command":"verified"}));
        [live] = fetched;
    }
    let newer = json!({"output":"More recent"});
    let mut fetched = [row(json!({"status":"running","metadata":newer}))];
    merge_page(std::slice::from_ref(&live), &mut fetched).unwrap();
    assert_eq!(tool(&fetched[0]).metadata, newer);

    let mut fetched = [row(
        json!({"status":"completed","metadata":{},"content":[{"type":"text","text":"Final"}]}),
    )];
    merge_page(&[live], &mut fetched).unwrap();
    let settled = tool(&fetched[0]);
    assert_eq!(settled.status, "completed");
    assert_eq!(settled.output, "Final");
    assert_eq!(settled.metadata, json!({}));
}
