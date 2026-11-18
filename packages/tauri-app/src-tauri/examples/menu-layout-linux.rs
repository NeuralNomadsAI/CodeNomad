//! Linux native regression: a window whose menu bar stays visible (remote windows)
//! keeps its page inside the space below the menu, initially, after maximizing and
//! after a child webview (browser preview) joins it at its requested rectangle.
//! Run in an unlocked graphical session with `GDK_BACKEND=x11` and
//! `GDK_BACKEND=wayland`: `cargo run --example menu-layout-linux`. Exits 1 when the
//! page viewport differs from the webview's GTK allocation or that allocation
//! leaves the window.

#[cfg(not(target_os = "linux"))]
fn main() {}

/// WebKit views below `widget`, depth first: the primary view precedes children.
#[cfg(target_os = "linux")]
fn webkit_views(widget: &gtk::Widget, found: &mut Vec<gtk::Widget>) {
    use gtk::prelude::*;
    if widget.is::<webkit2gtk::WebView>() {
        found.push(widget.clone());
    } else if let Some(container) = widget.downcast_ref::<gtk::Container>() {
        for child in container.children() {
            webkit_views(&child, found);
        }
    }
}

/// Serves `body` on a loopback port for the trial's lifetime; returns its URL.
#[cfg(target_os = "linux")]
fn serve(body: &'static str) -> String {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("loopback listener");
    let url = format!(
        "http://{}/",
        listener.local_addr().expect("listener address")
    );
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.read(&mut [0; 4096]);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
        }
    });
    url
}

#[cfg(target_os = "linux")]
fn main() {
    use gtk::prelude::*;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    const CHILD: (i32, i32, i32, i32) = (10, 20, 200, 100);
    let viewport = Arc::new(AtomicI32::new(-1));
    let page = serve("<script>setInterval(()=>document.title='h'+innerHeight,50)</script>");
    tauri::Builder::default()
        .setup(move |app| {
            let item = tauri::menu::MenuItem::with_id(app, "noop", "Noop", true, None::<&str>)?;
            let file = tauri::menu::Submenu::with_items(app, "File", true, &[&item])?;
            app.set_menu(tauri::menu::Menu::with_items(app, &[&file])?)?;
            let reported = viewport.clone();
            let url: tauri::Url = page.parse()?;
            let window = tauri::WebviewWindowBuilder::new(
                app,
                "menu-layout",
                tauri::WebviewUrl::External(url.clone()),
            )
            .title("CodeNomad menu layout")
            .inner_size(760.0, 540.0)
            .on_document_title_changed(move |_, title| {
                if let Some(height) = title.strip_prefix('h').and_then(|h| h.parse().ok()) {
                    reported.store(height, Ordering::Release);
                }
            })
            .build()?;
            let deadline = Instant::now() + Duration::from_secs(30);
            let (mut phase, mut stable, mut first_height) = ("initial", 0, 0);
            gtk::glib::timeout_add_local(Duration::from_millis(100), move || {
                let vbox = window.default_vbox().expect("GTK content box");
                let menu = vbox
                    .children()
                    .into_iter()
                    .find(|child| child.is::<gtk::MenuBar>() && child.is_visible())
                    .map_or(0, |bar| bar.allocated_height());
                let mut views = Vec::new();
                webkit_views(vbox.upcast_ref(), &mut views);
                let view = views.first().expect("primary WebKit view");
                let (_, top) = view.translate_coordinates(&vbox, 0, 0).unwrap_or((0, -1));
                let (height, total) = (view.allocated_height(), vbox.allocated_height());
                let page = viewport.load(Ordering::Acquire);
                // The child rectangle is relative to the content below the menu bar.
                let child = views.get(1).map(|child| {
                    let (x, y) = child.translate_coordinates(&vbox, 0, 0).unwrap_or((-1, -1));
                    (x, y - menu, child.allocated_width(), child.allocated_height())
                });
                let state = format!(
                    "menu {menu}, view y {top} h {height}, content {total}, page {page}, child {child:?}"
                );
                let fits = menu > 0 && top >= menu && top + height <= total && page == height;
                let ready = match phase {
                    "initial" => fits,
                    "maximized" => fits && total > first_height,
                    _ => fits && child == Some(CHILD),
                };
                stable = if ready { stable + 1 } else { 0 };
                if stable >= 3 {
                    println!("PASS {phase}: {state}");
                    stable = 0;
                    match phase {
                        "initial" => {
                            first_height = total;
                            // Wayland compositors may ignore client size requests,
                            // never maximization; both reach Tauri's auto-resize.
                            let _ = window.maximize();
                            phase = "maximized";
                        }
                        "maximized" => {
                            let builder = tauri::webview::WebviewBuilder::new(
                                "menu-layout-child",
                                tauri::WebviewUrl::External(url.clone()),
                            );
                            window
                                .as_ref()
                                .window()
                                .add_child(
                                    builder,
                                    tauri::LogicalPosition::new(CHILD.0, CHILD.1),
                                    tauri::LogicalSize::new(CHILD.2, CHILD.3),
                                )
                                .expect("child webview");
                            phase = "child";
                        }
                        _ => std::process::exit(0),
                    }
                } else if Instant::now() > deadline {
                    eprintln!("FAIL {phase}: {state}");
                    std::process::exit(1);
                }
                gtk::glib::ControlFlow::Continue
            });
            Ok(())
        })
        .run(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("menu layout trial");
}
