use crate::{Phase, State, history};

pub fn load(s: &mut State) {
    let native = serde_json::from_str(include_str!("../../fixtures/transcript.json"))
        .expect("transcript fixture JSON");
    s.messages = vec![
        history::decode_message(&native)
            .expect("transcript fixture record")
            .into(),
    ];
    s.phase = Phase::Ready;
    crate::settings::fixture_message_usage(s, "collapsed");
}
