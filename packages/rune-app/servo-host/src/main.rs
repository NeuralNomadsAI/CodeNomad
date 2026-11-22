use servo::{
    CompositionEvent, CompositionState, DeviceIntPoint, DeviceIntRect, DeviceIntSize,
    EventLoopWaker, ImeEvent, InputEvent, Key, KeyState, KeyboardEvent, LoadStatus, Modifiers,
    MouseButton, MouseButtonAction, MouseButtonEvent, MouseMoveEvent, NavigationRequest,
    RenderingContext, ServoBuilder, SoftwareRenderingContext, WebView, WebViewBuilder,
    WebViewDelegate, WheelDelta, WheelEvent, WheelMode,
};
use serde_json::{Value, json};
use std::{
    cell::{Cell, RefCell},
    io::{self, BufRead, Write},
    rc::Rc,
    sync::mpsc::{self, RecvTimeoutError, SyncSender},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use url::Url;
mod automation;

const MAX_EDGE: u32 = 2560;

fn now_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_micros() as u64)
}

fn local(url: &Url) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "[::1]" | "localhost"))
            && url.username().is_empty() && url.password().is_none())
        || (url.scheme() == "file"
            && std::env::var("RUNE_SERVO_TEST_FILE").as_deref() == Ok(url.as_str()))
}

fn write_message(header: Value, bytes: &[u8]) -> io::Result<()> {
    let mut out = io::stdout().lock();
    serde_json::to_writer(&mut out, &header)?;
    out.write_all(b"\n")?;
    out.write_all(bytes)?;
    out.flush()
}

#[derive(Default)]
struct Delegate {
    new_frame: Cell<bool>,
    ready: Cell<bool>,
    epoch: Cell<u64>,
    ax: RefCell<std::collections::HashMap<u64, servo::accesskit::Node>>,
}

impl WebViewDelegate for Delegate {
    fn notify_new_frame_ready(&self, _: WebView) {
        self.new_frame.set(true);
    }
    fn notify_load_status_changed(&self, _view: WebView, status: LoadStatus) {
        if status == LoadStatus::Started {
            self.epoch.set(self.epoch.get() + 1);
            self.ax.borrow_mut().clear();
        }
        self.ready.set(status == LoadStatus::Complete);
    }
    fn request_navigation(&self, _: WebView, nav: NavigationRequest) {
        if local(&nav.url) { nav.allow() } else { nav.deny() }
    }
    fn notify_accessibility_tree_update(&self, _: WebView, update: servo::accesskit::TreeUpdate) {
        let mut nodes = self.ax.borrow_mut();
        if nodes.len().saturating_add(update.nodes.len()) > 20_000 {
            nodes.clear();
            return;
        }
        nodes.extend(update.nodes.into_iter().map(|(id, node)| (id.0, node)));
    }
    fn show_console_message(&self, _: WebView, level: servo::ConsoleLogLevel, message: String) {
        if std::env::var_os("RUNE_SERVO_CONSOLE").is_some() {
            eprintln!("Servo {level:?}: {}", message.chars().take(500).collect::<String>());
        }
    }
}

#[derive(Clone)]
struct Wake(SyncSender<Option<Value>>);
impl EventLoopWaker for Wake {
    fn clone_box(&self) -> Box<dyn EventLoopWaker> { Box::new(self.clone()) }
    fn wake(&self) { let _ = self.0.try_send(None); }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    rustls::crypto::aws_lc_rs::default_provider().install_default()
        .map_err(|_| "could not install TLS provider")?;
    let (send, recv) = mpsc::sync_channel(32);
    let wake = Wake(send.clone());
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            let Ok(line) = line else { return };
            if line.len() > 65_536 { return }
            if let Ok(command) = serde_json::from_str(&line) {
                if send.send(Some(command)).is_err() { return }
            }
        }
        let _ = send.send(Some(json!({"op":"close"})));
    });
    let context = Rc::new(SoftwareRenderingContext::new(dpi::PhysicalSize::new(320, 240))
        .map_err(|e| format!("offscreen context: {e:?}"))?);
    let engine = ServoBuilder::default().event_loop_waker(Box::new(wake)).build();
    let delegate = Rc::new(Delegate::default());
    let view = WebViewBuilder::new(&engine, context.clone()).delegate(delegate.clone()).build();
    view.set_focused(false);
    view.set_accessibility_active(true);
    let mut generation = 0;
    let mut frame = 0;
    let mut state = (false, 0);
    loop {
        engine.spin_event_loop();
        let current = (delegate.ready.get(), delegate.epoch.get());
        if state != current {
            state = current;
            write_message(json!({"ready":state.0,"epoch":state.1,"generation":generation,
                "url":view.url().map(|url| url.to_string())}), &[])?;
        }
        if delegate.new_frame.replace(false) && generation != 0 {
            let start = Instant::now();
            let at = now_us();
            view.paint();
            let size = context.size();
            let rect = DeviceIntRect::from_origin_and_size(DeviceIntPoint::zero(),
                DeviceIntSize::new(size.width as i32, size.height as i32));
            let read = Instant::now();
            if let Some(image) = context.read_to_image(rect) {
                let read_us = read.elapsed().as_micros() as u64;
                let mut bytes = image.into_raw();
                for pixel in bytes.chunks_exact_mut(4) { pixel.swap(0, 2); }
                frame += 1;
                write_message(json!({"frame":frame,"generation":generation,
                    "w":size.width,"h":size.height,"at":at,"read_us":read_us,
                    "paint_read_convert_us":start.elapsed().as_micros() as u64}), &bytes)?;
            }
        }
        let c = match recv.recv_timeout(Duration::from_millis(if view.animating() { 16 } else { 500 })) {
            Ok(Some(command)) => command,
            Ok(None) | Err(RecvTimeoutError::Timeout) => continue,
            Err(RecvTimeoutError::Disconnected) => break,
        };
        let text = |k: &str| c[k].as_str().unwrap_or_default();
        let n = |k: &str| c[k].as_f64().unwrap_or_default();
        let point = || servo::WebViewPoint::Device(servo::DevicePoint::new(n("x") as f32, n("y") as f32));
        let mut reply = json!({});
        match text("op") {
            "close" => break,
            "resize" => {
                generation = c["generation"].as_u64().unwrap_or(generation);
                view.set_hidpi_scale_factor(euclid::Scale::new(n("dpi").clamp(1.0, 4.0) as f32));
                let edge = |key| (n(key) as u32).clamp(1, MAX_EDGE);
                view.resize(dpi::PhysicalSize::new(edge("w"), edge("h")));
            }
            "navigate" => match Url::parse(text("url")) {
                Ok(url) if local(&url) => {
                    generation = c["generation"].as_u64().unwrap_or(generation);
                    delegate.ready.set(false);
                    view.load(url);
                }
                _ => reply = json!({"error":"Only credential-free loopback HTTP is supported"}),
            },
            "reload" => {
                generation = c["generation"].as_u64().unwrap_or(generation);
                delegate.ready.set(false);
                view.reload();
            }
            "focus" => view.set_focused(c["focused"] == true),
            "move" => { view.notify_input_event(InputEvent::MouseMove(MouseMoveEvent::new(point()))); }
            "pointer" => {
                let action = if c["down"] == true { MouseButtonAction::Down } else { MouseButtonAction::Up };
                view.notify_input_event(InputEvent::MouseButton(MouseButtonEvent::new(action,
                    MouseButton::from(c["button"].as_i64().unwrap_or(0)), point())));
            }
            "wheel" => {
                let delta = WheelDelta { x: n("dx"), y: n("dy"), z: 0.0, mode: WheelMode::DeltaPixel };
                view.notify_input_event(InputEvent::Wheel(WheelEvent::new(delta, point())));
            }
            "key" => {
                let key = text("key").parse().unwrap_or_else(|_| Key::Character(text("key").into()));
                let state = if c["down"] == true { KeyState::Down } else { KeyState::Up };
                let mut event = KeyboardEvent::from_state_and_key(state, key);
                event.event.code = text("code").parse().unwrap_or_default();
                event.event.repeat = c["repeat"] == true;
                event.event.modifiers.set(Modifiers::CONTROL, c["ctrl"] == true);
                event.event.modifiers.set(Modifiers::SHIFT, c["shift"] == true);
                event.event.modifiers.set(Modifiers::ALT, c["alt"] == true);
                event.event.modifiers.set(Modifiers::META, c["meta"] == true);
                view.notify_input_event(InputEvent::Keyboard(event));
            }
            "ime" => {
                let s = text("text").to_owned();
                let event = match text("phase") {
                    "start" => CompositionEvent { state: CompositionState::Start, data: s },
                    "update" => CompositionEvent { state: CompositionState::Update, data: s },
                    _ => CompositionEvent { state: CompositionState::End, data: s },
                };
                view.notify_input_event(InputEvent::Ime(ImeEvent::Composition(event)));
            }
            "automation" => reply = automation::execute(&engine, &view, &*context, &delegate, &c)
                .unwrap_or_else(|e|json!({"error":e})),
            _ => reply = json!({"error":"Unknown operation"}),
        }
        if let Some(id) = c["id"].as_u64() {
            write_message(json!({"id":id,"result":reply}), &[])?;
        }
    }
    Ok(())
}
