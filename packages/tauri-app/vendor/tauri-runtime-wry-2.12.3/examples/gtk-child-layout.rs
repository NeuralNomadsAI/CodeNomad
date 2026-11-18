// Native Linux regression. Run in a graphical session with GDK_BACKEND=x11 and
// GDK_BACKEND=wayland. This example uses the runtime's actual layout helper.
use gtk::prelude::*;
use std::{cell::Cell, time::Duration};
use webkit2gtk::{PermissionRequestExt, WebContextExt, WebViewExt, WebsiteDataManagerExt};
use wry::{
  dpi::{LogicalPosition, LogicalSize},
  Rect, WebContext, WebViewBuilder, WebViewBuilderExtUnix, WebViewExtUnix,
};
#[path = "../src/gtk_child_layout.rs"]
mod gtk_child_layout;

fn main() {
  gtk::init().unwrap();
  let data = std::path::PathBuf::from(std::env::var("XDG_DATA_HOME").unwrap());
  let app_data = data.join("config-A/app");
  let preview_data = data.join("config-A/browser/shared-v1");
  let other_data = data.join("config-B/browser/shared-v1");
  for path in [&app_data, &preview_data, &other_data] {
    std::fs::create_dir_all(path).unwrap();
  }
  let mut app_context = WebContext::new(Some(app_data.clone()));
  let mut preview_context = WebContext::new(Some(preview_data.clone()));
  let mut other_context = WebContext::new(Some(other_data.clone()));
  let window = gtk::Window::new(gtk::WindowType::Toplevel);
  window.set_title("CodeNomad GTK child trial");
  window.set_default_size(800, 600);
  let vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
  let menu = gtk::Label::new(Some("Menu outside content"));
  menu.set_size_request(-1, 40);
  vbox.pack_start(&menu, false, false, 0);
  window.add(&vbox);
  let page = |name: &str| {
    format!(
      r#"<body style="margin:0;background:{}"><h1>{name}</h1><script>document.onclick=e=>window.ipc.postMessage('click {name} '+e.clientX+','+e.clientY)</script>"#,
      if name == "main" { "#ddeeff" } else { "#ffddaa" }
    )
  };
  let main = WebViewBuilder::new_with_web_context(&mut app_context)
    .with_html(page("main"))
    .with_ipc_handler(|r| println!("{}", r.body()))
    .build_gtk(&gtk_child_layout::content(&vbox))
    .unwrap();
  assert_eq!(vbox.children().len(), 2);
  window.show_all();
  // Exercise installation after the primary view has been realized and loaded.
  gtk::glib::timeout_add_local_once(Duration::from_secs(2), gtk::main_quit);
  gtk::main();
  let (content, fixed) = gtk_child_layout::containers(&vbox);
  assert_eq!(fixed, gtk_child_layout::containers(&vbox).1);
  let child = WebViewBuilder::new_with_web_context(&mut preview_context)
    .with_html(page("child"))
    .with_bounds(Rect {
      position: LogicalPosition::new(100, 80).into(),
      size: LogicalSize::new(300, 200).into(),
    })
    .with_ipc_handler(|r| println!("{}", r.body()))
    .with_download_started_handler(|url, path| {
      println!("DOWNLOAD_DENIED {url}");
      println!("DOWNLOAD_DESTINATION {}", path.display());
      false
    })
    .build_gtk(&fixed)
    .unwrap();
  // The application registers a fresh child hidden, then sends separate
  // position/size updates before its first allocation or reveal.
  child.set_visible(false).unwrap();
  let mut pending = child.bounds().unwrap();
  pending.position = LogicalPosition::new(100, 80).into();
  child.set_bounds(pending).unwrap();
  let mut pending = child.bounds().unwrap();
  pending.size = LogicalSize::new(300, 200).into();
  child.set_bounds(pending).unwrap();
  assert_eq!(child.bounds().unwrap().position.to_logical::<i32>(1.0), LogicalPosition::new(100, 80));
  child.webview().connect_permission_request(|_, request| {
    println!("PERMISSION_DENIED {}", request.type_().name());
    request.deny();
    true
  });
  let other_box = gtk::Box::new(gtk::Orientation::Vertical, 0);
  let other = WebViewBuilder::new_with_web_context(&mut other_context)
    .build_gtk(&other_box)
    .unwrap();
  for (view, path) in [
    (&main, &app_data),
    (&child, &preview_data),
    (&other, &other_data),
  ] {
    let manager = view
      .webview()
      .context()
      .unwrap()
      .website_data_manager()
      .unwrap();
    assert_eq!(
      manager.base_data_directory().unwrap().as_str(),
      path.to_str().unwrap()
    );
    assert!(!manager.is_ephemeral());
    println!("PERSISTENT_STORE {}", path.display());
  }
  if let Ok(url) = std::env::var("GTK_TRIAL_URL") {
    child.load_url(&url).unwrap();
  }
  window.show_all();
  let b_window = gtk::Window::new(gtk::WindowType::Toplevel);
  b_window.set_title("CodeNomad GTK independent owner B");
  b_window.set_default_size(700, 500);
  let b_vbox = gtk::Box::new(gtk::Orientation::Vertical, 0);
  let b_menu = gtk::Label::new(Some("Owner B menu"));
  b_menu.set_size_request(-1, 60);
  b_vbox.pack_start(&b_menu, false, false, 0);
  b_window.add(&b_vbox);
  let b_main = WebViewBuilder::new_with_web_context(&mut app_context)
    .with_html(page("main-B"))
    .with_ipc_handler(|r| println!("{}", r.body()))
    .build_gtk(&gtk_child_layout::content(&b_vbox))
    .unwrap();
  let (_, b_fixed) = gtk_child_layout::containers(&b_vbox);
  assert_ne!(fixed, b_fixed);
  let b_child = WebViewBuilder::new_with_web_context(&mut preview_context)
    .with_bounds(Rect {
      position: LogicalPosition::new(400, 200).into(),
      size: LogicalSize::new(100, 80).into(),
    })
    .with_html(page("child-B"))
    .build_gtk(&b_fixed)
    .unwrap();
  b_window.show_all();
  let weak_child = child.webview().downgrade();
  let weak_manager = child.webview().user_content_manager().unwrap().downgrade();
  let mut child = Some(child);
  let step = Cell::new(0);
  gtk::glib::timeout_add_local(Duration::from_secs(2), move || {
    let n = step.get();
    let b_bounds = b_child.bounds().unwrap();
    assert_eq!(
      b_bounds.position.to_logical::<i32>(1.0),
      LogicalPosition::new(400, 200)
    );
    assert_eq!(
      b_bounds.size.to_logical::<i32>(1.0),
      LogicalSize::new(100, 80)
    );
    assert!(b_child.webview().is_visible());
    assert!(b_window.is_visible());
    println!("OWNER_B_STABLE phase={n} {b_bounds:?}");
    if let Some(child) = child.as_ref() {
      let bounds = child.bounds().unwrap();
      println!(
        "phase={n} child={bounds:?} content={:?} fixed={:?}",
        content.allocation(),
        fixed.allocation()
      );
      if n < 6 {
        let expected = if n == 0 {
          (100, 80, 300, 200)
        } else {
          (140, 90, 280, 180)
        };
        assert_eq!(
          bounds.position.to_logical::<i32>(1.0),
          LogicalPosition::new(expected.0, expected.1)
        );
        assert_eq!(
          bounds.size.to_logical::<i32>(1.0),
          LogicalSize::new(expected.2, expected.3)
        );
      }
      match n {
        0 => {
          child
            .set_bounds(Rect {
              position: LogicalPosition::new(140, 90).into(),
              size: LogicalSize::new(280, 180).into(),
            })
            .unwrap();
          assert_eq!(
            child.bounds().unwrap().position.to_logical::<i32>(1.0),
            LogicalPosition::new(140, 90)
          );
        }
        1 => {
          window.resize(900, 650);
          child.set_visible(false).unwrap();
          // Match Tauri's separate SetPosition/SetSize round trips while hidden.
          let mut retained = child.bounds().unwrap();
          retained.position = LogicalPosition::new(140, 90).into();
          child.set_bounds(retained).unwrap();
          let mut retained = child.bounds().unwrap();
          retained.size = LogicalSize::new(280, 180).into();
          child.set_bounds(retained).unwrap();
          assert_eq!(child.bounds().unwrap().position.to_logical::<i32>(1.0), LogicalPosition::new(140, 90));
        }
        2 => {
          child.reparent(&fixed).unwrap();
          child.set_visible(true).unwrap();
          menu.set_size_request(-1, 60);
        }
        3 => {
          window.present();
          window.fullscreen();
          println!("DISPLAY_SCALE {}", child.webview().scale_factor());
          println!("READY_FOR_CLICKS: main=(20,100), child=(180,200)");
        }
        5 => {
          child.set_visible(false).unwrap();
          println!("HIDDEN_FOR_CLICKS");
        }
        _ => {}
      }
    }
    if n == 6 {
      drop(child.take());
      b_window.present();
      b_window.fullscreen();
      println!("WINDOW_B_READY_FOR_CLICKS");
    }
    if n == 7 {
      window.close();
      assert!(
        weak_child.upgrade().is_none(),
        "child WebView retained after destruction"
      );
      assert!(
        weak_manager.upgrade().is_none(),
        "child IPC manager retained after destruction"
      );
      println!("OWNER_A_CHILD_RELEASED");
    }
    if n == 9 {
      let _ = (&main, &b_main);
      b_window.close();
      gtk::main_quit();
      return gtk::glib::ControlFlow::Break;
    }
    step.set(n + 1);
    gtk::glib::ControlFlow::Continue
  });
  gtk::main();
}
