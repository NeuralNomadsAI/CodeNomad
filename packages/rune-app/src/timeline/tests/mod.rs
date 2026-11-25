use super::*;
use rune::{Cx, El, Env, Runtime, TouchPhase};
use serde_json::json;

mod anchors_and_paging;
mod banners;
mod banners_edges;
mod banners_rail;
mod banners_wheel;
mod disable_timeline;
mod rail_jumps;
mod rail_restore_and_reflow;
mod rail_touch;
mod rail_wheel_handoff;

fn assistant(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"assistant","time":{"completed":1},
        "content":[{"type":"text","text":"Lead"},
            {"type":"tool","id":"inspect","name":"read","state":{"status":"completed","output":"OK"}},
            {"type":"text","text":"Exact destination"}]
    })).unwrap().into()
}

fn user(id: &str) -> crate::history::Row {
    crate::history::decode_message(&json!({
        "id":id,"type":"user","text":"Long transcript below this anchor.\n\n".repeat(10)
    }))
    .unwrap()
    .into()
}

fn view(s: &State, cx: &mut Cx<State>) -> El {
    rune_theme_codenomad::layout::render(cx, |cx| crate::chat::view::chat_view(s, cx))
}

fn settle(rt: &mut Runtime<State>) {
    for _ in 0..45 {
        rt.frame(0.016);
    }
}

pub(crate) fn set_outline_error(s: &mut State, width: f32, error: bool) {
    let t = owner(s);
    t.width = width;
    t.changed = true;
    t.outline_error = error;
}

pub(crate) fn set_filtered_notice(s: &mut State, filtered: bool) {
    owner(s).jump.filtered = filtered;
}

pub(crate) fn rail_scroll_offset(s: &State) -> f32 {
    s.transcript_display.timeline.scroll.get().at.offset[1]
}
