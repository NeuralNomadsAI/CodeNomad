use crate::{Phase, State, history::decode_message};
use serde_json::json;

pub(crate) fn load(s: &mut State) {
    let query = web_sys::window().unwrap().location().search().unwrap();
    let port: u16 = web_sys::UrlSearchParams::new_with_str(&query)
        .unwrap()
        .get("imagePort")
        .unwrap()
        .parse()
        .unwrap();
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWNQSFjwHx9moL0CAFNzQ+EMxFw9AAAAAElFTkSuQmCC";
    let avif = include_str!("../../../fixtures/animated-32.avif.b64").trim();
    let uri = format!(
        "/api/workspaces/owned/session-media/session/result/0/4/{}",
        "a".repeat(64)
    );
    let mut backend = crate::backend::Backend::unauthenticated("/").unwrap();
    backend.workspace = "owned".into();
    backend.session = "session".into();
    s.transcript_display.pictures.bind(backend);
    let rows = [
        json!({"id":"upload","type":"user","text":"Image attachment","files":[
            {"name":"Attached PNG","mime":"image/png","source":{"type":"inline"},"data":png}
        ]}),
        json!({"id":"result","type":"assistant","time":{"completed":1},"content":[
            {"id":"render","type":"tool","name":"read","state":{"status":"completed","content":[
                {"type":"file","name":"Animated AVIF","mime":"image/avif","uri":format!("data:image/avif;base64,{avif}")},
                {"type":"file","name":"Cross-origin PNG","mime":"image/png","uri":format!("http://127.0.0.1:{port}/cors.png")},
                {"type":"file","name":"PNG without CORS","mime":"image/png","uri":format!("http://127.0.0.1:{port}/no-cors.png")},
                {"type":"file","name":"HTML rejected","mime":"image/png","uri":"data:image/png;base64,PGh0bWw+"},
                {"type":"file","name":"Deferred PNG","mime":"image/png","uri":uri}
            ]}}
        ]}),
    ];
    s.messages = rows
        .iter()
        .map(|row| decode_message(row).unwrap().into())
        .collect();
    crate::settings::fixture_transcript(
        s,
        json!({"toolCallExpansionDefaults":{"tools":{"read":"expanded"}}}),
    );
    s.phase = Phase::Ready;
}
