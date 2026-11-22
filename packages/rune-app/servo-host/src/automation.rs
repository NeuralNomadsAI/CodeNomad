use super::*;
use base64::Engine as _;
use image::ImageEncoder;

const DOM: &str = include_str!("automation.js");

fn outline(view: &WebView, delegate: &Delegate, query: Option<&str>) -> String {
    let trees = delegate.ax.borrow();
    let mut text = String::new();
    let Some(tree) = view.accesskit_tree_id() else {
        return text;
    };
    let Some(root) = trees.get(&tree).and_then(|t| t.root) else {
        return text;
    };
    let mut frontier = vec![(tree, root, 0)];
    let mut seen = std::collections::HashSet::new();
    let needle = query.map(str::to_lowercase);
    while let Some((tree, id, depth)) = frontier.pop() {
        if depth >= 24 || !seen.insert((tree, id)) {
            continue;
        }
        if seen.len() > 3000 || text.len() > 12_000 {
            text.push_str("  (+ more)\n");
            break;
        }
        let Some(n) = trees.get(&tree).and_then(|t| t.nodes.get(&id)) else {
            continue;
        };
        if let Some(label) = n.label() {
            let line = format!(
                "{:?} {:?}",
                n.role(),
                label.chars().take(120).collect::<String>()
            );
            if needle
                .as_ref()
                .is_none_or(|q| line.to_lowercase().contains(q))
            {
                text.push_str(&format!("{:indent$}{line}\n", "", indent = 2 + depth * 2));
            }
        }
        if let Some(child) = n.tree_id()
            && let Some(root) = trees.get(&child).and_then(|t| t.root)
        {
            frontier.push((child, root, depth + 1));
        }
        frontier.extend(
            n.children()
                .iter()
                .rev()
                .take(1000)
                .map(|id| (tree, *id, depth + 1)),
        );
    }
    text
}

fn eval(
    engine: &servo::Servo,
    view: &WebView,
    epoch: &Delegate,
    until: Instant,
    args: Value,
) -> Result<Value, String> {
    let generation = epoch.epoch.get();
    let received = Rc::new(RefCell::new(None));
    let deliver = received.clone();
    let literal = Value::from(args.to_string());
    view.evaluate_javascript(
        format!("(() => {{ const arg = JSON.parse({literal}); return (\n{DOM}\n); }})()"),
        move |answer| *deliver.borrow_mut() = Some(answer),
    );
    loop {
        engine.spin_event_loop();
        if generation != epoch.epoch.get() {
            return Err("Browser document changed".into());
        }
        if let Some(answer) = received.borrow_mut().take() {
            let servo::JSValue::String(raw) =
                answer.map_err(|e| format!("DOM operation failed: {e:?}"))?
            else {
                return Err("DOM operation returned a non-string value".into());
            };
            if raw.len() > 250_000 {
                return Err("DOM response too large".into());
            }
            let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
            return if let Some(error) = v["error"].as_str() {
                Err(error.into())
            } else {
                Ok(v)
            };
        }
        if Instant::now() >= until {
            return Err("DOM operation timed out".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

fn keyboard(view: &WebView, chord: &str) -> Result<(), String> {
    let mut parts = chord.rsplit('+');
    let key = parts
        .next()
        .filter(|s| !s.is_empty())
        .ok_or("Missing key")?;
    let key = if key == "Space" { " " } else { key };
    let mut mods = Modifiers::empty();
    for part in parts {
        mods |= match part.to_ascii_lowercase().as_str() {
            "mod" | "control" | "ctrl" => Modifiers::CONTROL,
            "shift" => Modifiers::SHIFT,
            "alt" | "option" => Modifiers::ALT,
            "meta" | "cmd" | "command" => Modifiers::META,
            _ => return Err("Unsupported modifier".into()),
        };
    }
    for state in [KeyState::Down, KeyState::Up] {
        let mut event = KeyboardEvent::from_state_and_key(
            state,
            key.parse().unwrap_or_else(|_| Key::Character(key.into())),
        );
        event.event.modifiers = mods;
        view.notify_input_event(InputEvent::Keyboard(event));
    }
    Ok(())
}

fn send_ime(
    engine: &servo::Servo,
    view: &WebView,
    delegate: &Delegate,
    until: Instant,
    event: InputEvent,
) -> Result<(), String> {
    let epoch = delegate.epoch.get();
    let id = view.notify_input_event(event);
    delegate.waiting.set(Some(id));
    loop {
        engine.spin_event_loop();
        if delegate.epoch.get() != epoch {
            return Err("Browser document changed".into());
        }
        if delegate.handled.take() == Some(id) {
            return Ok(());
        }
        if Instant::now() >= until {
            return Err("Text insertion outcome is unknown".into());
        }
        std::thread::sleep(Duration::from_millis(2));
    }
}

pub fn execute(
    engine: &servo::Servo,
    view: &WebView,
    context: &dyn RenderingContext,
    delegate: &Delegate,
    input: &Value,
) -> Result<Value, String> {
    let epoch = delegate.epoch.get();
    if input["epoch"].as_u64() != Some(epoch) || !delegate.ready.get() {
        return Err("Browser document changed or is still loading".into());
    }
    let mut command = input["command"].clone();
    let prefix = format!("{epoch}-");
    if let Some(id) = command["ref"].as_str() {
        let id = id
            .strip_prefix(&prefix)
            .ok_or("Browser ref is stale")?
            .to_owned();
        command["ref"] = id.into();
    }
    let c = &command;
    let deadline = input["deadline"].as_u64().ok_or("Missing deadline")?;
    let now = super::now_us() / 1000;
    if deadline <= now {
        return Err("Browser request expired".into());
    }
    let budget = (deadline - now).min(16_000);
    let until = Instant::now() + Duration::from_millis(budget);
    let dom = |args| eval(engine, view, delegate, until, args);
    let action = c["action"].as_str().unwrap_or_default();
    let aim = |is_type| {
        dom(json!({"action":"point","ref":c["ref"],"type":is_type,"scroll":action != "scroll"}))
    };
    let point = |value: Value| {
        servo::WebViewPoint::from(servo::DevicePoint::new(
            (value["x"].as_f64().unwrap_or_default() as f32) * view.hidpi_scale_factor().get(),
            (value["y"].as_f64().unwrap_or_default() as f32) * view.hidpi_scale_factor().get(),
        ))
    };
    let click = |p, button| {
        view.set_focused(true);
        view.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(p)));
        for a in [MouseButtonAction::Down, MouseButtonAction::Up] {
            view.notify_input_event(InputEvent::MouseButton(MouseButtonEvent::new(a, button, p)));
        }
    };
    match action {
        "snapshot" => {
            let out = dom(c.clone())?;
            let mut snapshot = format!("Document {}\n", out["title"]);
            if c["ref"].is_null() {
                snapshot.push_str(&outline(view, delegate, c["query"].as_str()));
            }
            for node in out["controls"].as_array().into_iter().flatten() {
                snapshot.push_str(&format!(
                    "  [{prefix}{}] {} {} {}\n",
                    node[0].as_str().unwrap_or_default(),
                    node[1],
                    node[2],
                    node[3]
                ));
                if snapshot.len() > 26_000 {
                    snapshot.push_str("  (+ more)\n");
                    break;
                }
            }
            Ok(
                json!({"url":view.url().map(|u|u.to_string()).unwrap_or_default(),"snapshot":snapshot}),
            )
        }
        "click" => {
            click(
                point(aim(false)?),
                if c["button"] == "right" {
                    MouseButton::Secondary
                } else {
                    MouseButton::Primary
                },
            );
            Ok(json!({"clicked":true}))
        }
        "type" => {
            let s = c["text"]
                .as_str()
                .filter(|s| s.len() <= 32_768)
                .ok_or("Invalid text length")?;
            click(point(aim(true)?), MouseButton::Primary);
            dom(json!({"action":"prepare","ref":c["ref"],"clear":c["clear"]}))?;
            for (state, data) in [
                (CompositionState::Start, ""),
                (CompositionState::Update, s),
                (CompositionState::End, s),
            ] {
                send_ime(
                    engine,
                    view,
                    delegate,
                    until,
                    InputEvent::Ime(ImeEvent::Composition(CompositionEvent {
                        state,
                        data: data.into(),
                    })),
                )?;
            }
            dom(json!({"action":"value","ref":c["ref"]}))
        }
        "press" => {
            view.set_focused(true);
            if !c["ref"].is_null() {
                aim(false)?;
                dom(json!({"action":"focus","ref":c["ref"]}))?;
            }
            keyboard(view, c["key"].as_str().unwrap_or_default())?;
            Ok(json!({"pressed":true}))
        }
        "scroll" => {
            let a = c["amount"].as_f64().unwrap_or(600.0);
            let (x, y) = match c["direction"].as_str() {
                Some("up") => (0., a),
                Some("left") => (a, 0.),
                Some("right") => (-a, 0.),
                _ => (0., -a),
            };
            let p = if c["ref"].is_null() {
                let v = dom(json!({"action":"viewport"}))?;
                point(
                    json!({"x":v["w"].as_f64().unwrap_or_default()/2., "y":v["h"].as_f64().unwrap_or_default()/2.}),
                )
            } else {
                point(aim(false)?)
            };
            view.notify_input_event(InputEvent::Wheel(WheelEvent::new(
                WheelDelta {
                    x,
                    y,
                    z: 0.,
                    mode: WheelMode::DeltaPixel,
                },
                p,
            )));
            Ok(json!({"scrolled":true}))
        }
        "wait" => {
            let until = until
                .min(Instant::now() + Duration::from_millis(c["timeout"].as_u64().unwrap_or(5000)));
            loop {
                if dom(c.clone())?["matched"] == true {
                    return Ok(json!({"matched":true}));
                }
                if Instant::now() >= until {
                    return Err("Text wait timed out".into());
                }
                std::thread::sleep(Duration::from_millis(35));
            }
        }
        "screenshot" => {
            view.paint();
            let size = context.size();
            let rect = DeviceIntRect::from_origin_and_size(
                DeviceIntPoint::zero(),
                DeviceIntSize::new(size.width as i32, size.height as i32),
            );
            let frame = context
                .read_to_image(rect)
                .ok_or("Servo screenshot unavailable")?;
            let mut png = Vec::new();
            image::codecs::png::PngEncoder::new(&mut png)
                .write_image(
                    frame.as_raw(),
                    size.width,
                    size.height,
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| e.to_string())?;
            if png.len() > 620_000 {
                return Err("Prototype screenshot exceeds its private pipe limit".into());
            }
            Ok(
                json!({"image":{"data":base64::engine::general_purpose::STANDARD.encode(png),"mime":"image/png"}}),
            )
        }
        _ => Err("Unsupported Servo action".into()),
    }
}
