//! Real native guests and production parent framing with an isolated fixture child.
#[cfg(not(windows))]
#[path = "../src/browser_controller.rs"]
mod browser_controller;
#[cfg(not(windows))]
#[path = "../src/embedded_view.rs"]
mod embedded_view;
#[cfg(not(windows))]
#[path = "../src/identity/local_window.rs"]
mod identity;
#[cfg(not(windows))]
#[path = "../src/native_request.rs"]
mod native_request;

// Only the shell's owning-window inventory is fixture-supplied. Browser target
// claims, generations, leases, native loads, visibility and captures are real.
#[cfg(not(windows))]
mod local_windows {
    #[derive(Clone)]
    pub(crate) struct Record {
        pub(crate) label: String,
    }
    pub(crate) struct LocalWindows(pub(crate) Vec<Record>);
    impl LocalWindows {
        pub(crate) fn records(&self) -> Vec<Record> {
            self.0.clone()
        }
    }
}
#[cfg(not(windows))]
use browser_controller::{BrowserController, BrowserTargetRegistration, BrowserTargetUpdate};
#[cfg(not(windows))]
use serde_json::{json, Value};
#[cfg(not(windows))]
use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
#[cfg(not(windows))]
use tauri::{Listener, Manager};
#[cfg(not(windows))]
const OWNER: &str = "local-11111111-1111-4111-8111-111111111111";
#[cfg(not(windows))]
const OTHER: &str = "local-22222222-2222-4222-8222-222222222222";
#[cfg(not(windows))]
const SESSION: &str = "fixture-session";

#[cfg(not(windows))]
fn bounds() -> Value {
    json!({"x":10,"y":60,"width":600,"height":400})
}
#[cfg(not(windows))]
fn create_primary(app: &tauri::App, label: &str, base: &str) {
    let window = tauri::WindowBuilder::new(app, label)
        .title("Native parent qualification")
        .inner_size(740.0, 560.0)
        .focused(false)
        .build()
        .unwrap();
    window
        .add_child(
            tauri::webview::WebviewBuilder::new(
                label,
                tauri::WebviewUrl::External(format!("{base}/renderer").parse().unwrap()),
            )
            .focused(false),
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(740.0, 560.0),
        )
        .unwrap();
}
#[cfg(not(windows))]
fn register(
    app: &tauri::AppHandle,
    controller: &BrowserController,
    owner: &str,
    id: &str,
    url: &str,
) -> Result<(), String> {
    let input: BrowserTargetRegistration = serde_json::from_value(json!({"sessionId":SESSION,"registrationId":id,"url":url,"bounds":bounds(),"visible":false})).unwrap();
    controller.register(&app.get_window(owner).ok_or("Fixture owner closed")?, input)?;
    update(app, controller, owner, id, true)
}
#[cfg(not(windows))]
fn update(
    app: &tauri::AppHandle,
    controller: &BrowserController,
    owner: &str,
    id: &str,
    visible: bool,
) -> Result<(), String> {
    let input: BrowserTargetUpdate =
        serde_json::from_value(json!({"registrationId":id,"bounds":bounds(),"visible":visible}))
            .unwrap();
    controller.update(app, owner, input)
}

#[cfg(not(windows))]
fn capture_at_revocation(
    app: &tauri::AppHandle,
    controller: &BrowserController,
    id: &str,
    close: bool,
    deadline_ms: u64,
    fence: native_request::RequestFence,
) -> Result<Value, String> {
    use std::sync::atomic::AtomicUsize;
    let prefix = format!("browser-{id}-");
    let view = app
        .webviews()
        .into_values()
        .find(|view| view.label().starts_with(&prefix))
        .ok_or("Fixture preview missing")?;
    let controller = controller.clone();
    let app = app.clone();
    let id = id.to_string();
    let reads = AtomicUsize::new(0);
    // The third guard runs in the actual native PNG completion callback, after
    // admission and dispatch. Revoke authority at that acceptance boundary.
    embedded_view::input::read(
        &view,
        embedded_view::input::Read::Capture,
        std::time::Instant::now() + Duration::from_secs(15),
        move || {
            fence.check()?;
            if reads.fetch_add(1, Ordering::SeqCst) == 2 {
                if close {
                    controller.unregister(&app, OWNER, &id)?;
                } else {
                    update(&app, &controller, OWNER, &id, false)?;
                }
            }
            controller
                .handle_native(
                    &app,
                    "browser.probe",
                    Some(json!({"sessionID":SESSION})),
                    deadline_ms,
                    fence.clone(),
                )
                .map(|_| ())
        },
    )
    .map(|_| Value::Null)
}

#[cfg(windows)]
fn main() {}
#[cfg(not(windows))]
fn main() {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    assert_eq!(args.len(), 4, "node fixture.mjs base-url profile");
    let controller = BrowserController::new(args[3].clone().into());
    let live = Arc::new(Mutex::new(String::new()));
    let generation = Arc::new(AtomicU64::new(1));
    tauri::Builder::default()
        .manage(local_windows::LocalWindows(vec![local_windows::Record {
            label: OWNER.into(),
        }]))
        .manage(embedded_view::StorageIdentity::new(
            "parent-fixture".into(),
            args[3].clone(),
        ))
        .setup(move |app| {
            #[cfg(target_os = "linux")]
            {
                use gtk::glib::object::ObjectExt;
                eprintln!(
                    "native-display={}",
                    gtk::gdk::Display::default().unwrap().type_().name()
                );
            }
            create_primary(app, OWNER, &args[2]);
            create_primary(app, OTHER, &args[2]);
            let open_app = app.handle().clone();
            let open_controller = controller.clone();
            let open_live = live.clone();
            app.listen("browser-target:open", move |event| {
                let payload: Value = serde_json::from_str(event.payload()).unwrap();
                let request = payload["requestID"].as_str().unwrap().to_string();
                if !open_controller.claim_open(OWNER, &request) {
                    return;
                }
                let app = open_app.clone();
                let controller = open_controller.clone();
                let live = open_live.clone();
                std::thread::spawn(move || {
                    let id = format!("fixture-{}", uuid::Uuid::new_v4());
                    let result = register(
                        &app,
                        &controller,
                        OWNER,
                        &id,
                        payload["url"].as_str().unwrap(),
                    );
                    if result.is_ok() {
                        *live.lock().unwrap() = id;
                    } else {
                        eprintln!("open fixture failed: {result:?}");
                        controller.release_open(&app, OWNER, &request);
                    }
                });
            });
            let app = app.handle().clone();
            std::thread::spawn(move || {
                // Allow the primary documents' initial loads to settle; no daemon starts.
                std::thread::sleep(Duration::from_millis(500));
                let mut child = Command::new(&args[0])
                    .arg(&args[1])
                    .arg(&args[2])
                    .arg(&args[3])
                    .env("CODENOMAD_NATIVE_PARENT", "1")
                    .env("CODENOMAD_TAURI_WEBKIT", "1")
                    .env("CODENOMAD_NATIVE_BROWSER_AUTOMATION", "0")
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::inherit())
                    .spawn()
                    .unwrap();
                let mut input = child.stdin.take().unwrap();
                let mut reader = BufReader::new(child.stdout.take().unwrap());
                let mut line = String::new();
                loop {
                    line.clear();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let Some(request) = native_request::parse(line.trim_end()) else {
                        panic!("Unexpected child output: {line}");
                    };
                    let current = generation.clone();
                    let fence = native_request::RequestFence::new(request.deadline, move || {
                        current.load(Ordering::SeqCst) == 1
                    });
                    let response = native_request::dispatch(request, fence, |request, fence| {
                        let id = live.lock().unwrap().clone();
                        match request.method.as_str() {
                            "fixture.read-mutation" => {
                                let script = match request.params.as_ref().and_then(|value| value["kind"].as_str()) {
                                    Some("pushstate") => "history.pushState({}, '', '?same-document')",
                                    Some("reinsert") => "{ const item=document.querySelector('#aria-button');item.remove();document.querySelector('main').append(item); }",
                                    Some("recreate") => "document.open();document.write('<button>Recreated document</button>');document.close()",
                                    _ => return Err("Invalid read fixture mutation".into()),
                                };
                                let view = app.webviews().into_values().find(|view| view.label().starts_with(&format!("browser-{id}-"))).ok_or("Fixture preview missing")?;
                                view.eval(script).map_err(|error| error.to_string())?;
                                // eval is queued; the next isolated read observes its completion.
                                std::thread::sleep(Duration::from_millis(100));
                                Ok(Value::Null)
                            }
                            "fixture.hide" => {
                                update(&app, &controller, OWNER, &id, false).map(|()| Value::Null)
                            }
                            "fixture.overlay" => {
                                app.get_webview(OWNER)
                                    .ok_or("Fixture renderer missing")?
                                    .eval("document.querySelector('dialog').showModal()")
                                    .map_err(|error| error.to_string())?;
                                update(&app, &controller, OWNER, &id, false).map(|()| Value::Null)
                            }
                            "fixture.show" => {
                                app.get_webview(OWNER)
                                    .ok_or("Fixture renderer missing")?
                                    .eval("document.querySelector('dialog').close()")
                                    .map_err(|error| error.to_string())?;
                                update(&app, &controller, OWNER, &id, true).map(|()| Value::Null)
                            }
                            "fixture.duplicate" => register(
                                &app,
                                &controller,
                                OTHER,
                                "fixture-duplicate",
                                &format!("{}/ok", args[2]),
                            )
                            .map(|()| Value::Null),
                            "fixture.removeDuplicate" => controller
                                .unregister(&app, OTHER, "fixture-duplicate")
                                .map(|()| Value::Null),
                            "fixture.close" => controller
                                .unregister(&app, OWNER, &id)
                                .map(|()| Value::Null),
                            "fixture.capture-hide" | "fixture.capture-close" => {
                                capture_at_revocation(
                                    &app,
                                    &controller,
                                    &id,
                                    request.method == "fixture.capture-close",
                                    request.deadline,
                                    fence,
                                )
                            }
                            "fixture.late" => {
                                std::thread::sleep(Duration::from_millis(100));
                                Ok(json!({"stale":true}))
                            }
                            "fixture.retire" => {
                                generation.store(2, Ordering::SeqCst);
                                Ok(json!({"stale":true}))
                            }
                            _ => controller.handle_native(
                                &app,
                                &request.method,
                                request.params.clone(),
                                request.deadline,
                                fence,
                            ),
                        }
                    });
                    if let Some(response) = response {
                        input.write_all(response.as_bytes()).unwrap();
                        input.flush().unwrap();
                    }
                }
                let status = child.wait().unwrap();
                app.exit(if status.success() { 0 } else { 1 });
            });
            Ok(())
        })
        .run(tauri::test::mock_context(tauri::test::noop_assets()))
        .unwrap();
}
