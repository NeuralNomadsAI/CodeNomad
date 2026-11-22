#[cfg(not(target_arch = "wasm32"))]
use {
    super::Panel,
    crate::{State, platform::servo::Guest, strings},
    rune::{Cx, El, Ime, Key, KeyEvent, Tx},
    rune_theme_codenomad::{
        Space,
        layout::{self, Layout, input},
    },
    serde_json::json,
    std::sync::atomic::Ordering,
};

const PAGE: &str = "servo-page";

fn submit(s: &mut State, _: &mut Tx) {
    if let Some(page) = &mut s.preview.panel {
        page.navigate(false);
    }
}

pub fn toolbar(s: &State) -> El {
    if s.preview.panel.is_none() && Guest::available() && s.commands.is_some() {
        return layout::button(strings::t("sessionPreview.open.button"), false)
            .key("servo-open")
            .on_press(|s: &mut State| {
                s.preview.panel = Guest::start(s.wake.clone()).map(Panel::new);
            });
    }
    rune::el()
}

pub fn viewport(s: &State, cx: &mut Cx<State>) -> El {
    let Some(panel) = &s.preview.panel else {
        return rune::el();
    };
    let dpi = rune_theme_codenomad::preview::dpi(cx);
    rune_theme_codenomad::preview::panel()
        .child(layout::action_row().full_width().pad(Space::Sm).separate(Space::Sm)
            .child(input(&panel.address).key("servo-address")
                .label(strings::t("sessionPreview.open.label"))
                .full_width().field_surface()
                .on_edit(|s: &mut State| &mut s.preview.panel.as_mut().expect("address mounted").address)
                .on_submit(submit))
            .child(layout::button(strings::t("window.menu.native.reload"), !panel.loaded).key("servo-reload")
                .on_press(|s: &mut State| {
                    if let Some(page) = &mut s.preview.panel { page.navigate(true); }
                }))
            .child(layout::button(strings::t("sessionPreview.close"), false)
                .on_press(|s: &mut State| { s.preview.close(); })))
        .child(if panel.error {
            rune::text(strings::t("failed"))
        } else {
            rune::el()
        })
        .child(rune_theme_codenomad::preview::surface(&panel.surface).key(PAGE)
            .label(strings::t("sessionPreview.title"))
            .focusable(true)
            .on_layout_tx(move |s: &mut State, [_, _, w, h], tx| {
                if let Some(page) = &mut s.preview.panel {
                    let size = ((w * dpi).round() as u32, (h * dpi).round() as u32, dpi);
                    if page.viewport_px != size {
                        page.viewport_px = size;
                        page.send(json!({"op":"resize","w":size.0,"h":size.1,
                            "dpi":dpi,"generation":page.generation}));
                    }
                }
                tx.live_only();
            })
            .on_pointer_move_local(|s: &mut State, e, tx| {
                if let Some(p) = &mut s.preview.panel {
                    p.send(json!({"op":"move","x":e.x * p.viewport_px.2,"y":e.y * p.viewport_px.2}));
                }
                tx.live_only();
            })
            .on_drag(|s: &mut State, d, tx| {
                use rune::Phase as DragPhase;
                if let Some(p) = &mut s.preview.panel {
                    if d.phase == DragPhase::Down { focus(p, true); }
                    p.send(json!({"op":if d.phase == DragPhase::Move {"move"} else {"pointer"},
                        "x":d.x * p.viewport_px.2,"y":d.y * p.viewport_px.2,"down":d.phase == DragPhase::Down}));
                }
                tx.live_only();
            })
            .on_wheel(|s: &mut State, e, tx| {
                tx.live_only();
                s.preview.panel.as_mut().is_some_and(|p| p.send(json!({"op":"wheel",
                    "x":e.x * p.viewport_px.2,"y":e.y * p.viewport_px.2,"dx":-e.dx * p.viewport_px.2,"dy":-e.dy * p.viewport_px.2})))
            })
            .on_key(|s: &mut State, e, tx| key(s, e, tx, true))
            .on_key_up(|s: &mut State, e, tx| key(s, e, tx, false)))
}

fn focus(p: &mut Panel, focused: bool) {
    if p.focused != focused && p.send(json!({"op":"focus","focused":focused})) {
        p.focused = focused;
    }
}

pub fn window_focus(s: &mut State, focused: bool, tx: &mut Tx) {
    if let Some(p) = &mut s.preview.panel {
        focus(p, focused && tx.focused() == Some(PAGE));
    }
}

pub fn visibility(s: &mut State, visible: bool, _: &mut Tx) {
    s.preview.hidden = !visible;
    if !visible {
        s.preview.close();
    }
}

fn key(s: &mut State, e: &KeyEvent, tx: &mut Tx, down: bool) -> bool {
    let Some(p) = &mut s.preview.panel else {
        return false;
    };
    let key = match &e.key {
        Key::Text(s) => s.clone(),
        Key::Command(c) => c.to_string(),
        Key::Left => "ArrowLeft".into(),
        Key::Right => "ArrowRight".into(),
        Key::Up => "ArrowUp".into(),
        Key::Down => "ArrowDown".into(),
        Key::Function(n) => format!("F{n}"),
        Key::Enter
        | Key::Backspace
        | Key::Delete
        | Key::Home
        | Key::End
        | Key::PageDown
        | Key::PageUp
        | Key::Escape
        | Key::Tab => format!("{:?}", e.key),
        _ => return false,
    };
    focus(p, true);
    tx.live_only();
    p.send(
        json!({"op":"key","key":key,"down":down,"repeat":tx.key_repeat(),
        "code":tx.physical_key().map(|c|format!("{c:?}")),
        "shift":e.mods.shift,"ctrl":e.mods.ctrl,"alt":e.mods.alt,"meta":e.mods.logo}),
    )
}

pub fn ime(s: &mut State, event: &Ime, tx: &mut Tx) -> bool {
    let Some(p) = &mut s.preview.panel else {
        return false;
    };
    if tx.focused() != Some(PAGE) && !p.composing {
        return false;
    }
    if let Ime::Preedit(text, ..) | Ime::Commit(text) = event {
        let preedit = matches!(event, Ime::Preedit(..)) && !text.is_empty();
        if !p.composing {
            p.send(json!({"op":"ime","phase":"start"}));
        }
        if matches!(event, Ime::Commit(_)) && !text.is_empty() {
            p.send(json!({"op":"ime","phase":"update","text":text}));
        }
        p.composing = preedit;
        return p.send(json!({"op":"ime","phase":if preedit {"update"} else {"end"},"text":text}));
    }
    if matches!(event, Ime::Disabled) && p.composing {
        p.composing = false;
        return p.send(json!({"op":"ime","phase":"end","text":""}));
    }
    false
}

pub fn poll(s: &mut State, tx: &mut Tx) -> bool {
    let native = super::automation::poll(s);
    let Some(p) = &mut s.preview.panel else {
        return native;
    };
    let mut changed = false;
    if p.focused && tx.focused() != Some(PAGE) {
        focus(p, false);
    }
    if p.guest.offline.load(Ordering::Acquire) && !p.error {
        p.error = true;
        changed = true;
    }
    let (state, frame) = match p.guest.output.lock() {
        Ok(mut out) => (out.state.take(), out.frame.take()),
        Err(_) => return changed,
    };
    if let Some(state) = state
        && state["generation"].as_u64() == Some(p.generation)
    {
        let loaded = state["ready"] == true;
        changed |= p.loaded != loaded;
        p.loaded = loaded;
        p.epoch = state["epoch"].as_u64().unwrap_or_default();
        p.url = state["url"].as_str().unwrap_or_default().to_owned();
    }
    if let Some(frame) = frame
        && let Some(id) = frame.header["frame"].as_u64()
        && id > p.last_frame
        && frame.header["generation"].as_u64() == Some(p.generation)
        && frame.header["epoch"].as_u64() == Some(p.epoch)
        && frame.header["w"].as_u64() == Some(p.viewport_px.0.into())
        && frame.header["h"].as_u64() == Some(p.viewport_px.1.into())
    {
        p.last_frame = id;
        if rune_theme_codenomad::preview::push(
            &p.surface,
            p.viewport_px.0,
            p.viewport_px.1,
            frame.bytes,
        )
        .is_err()
        {
            p.error = true;
            changed = true;
        }
        #[cfg(feature = "test-support")]
        if crate::platform::has_flag("--probe-servo") {
            super::test_metrics::receive(frame.header);
        }
    }
    changed | native | super::automation::poll(s)
}
