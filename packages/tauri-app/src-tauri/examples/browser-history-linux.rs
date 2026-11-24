//! Run with scripts/test-webkit-history-linux.py on a Linux graphical session.
#[path = "../src/browser_history.rs"]
#[cfg(target_os = "linux")]
mod browser_history;
#[path = "../src/browser_history_linux.rs"]
#[cfg(target_os = "linux")]
mod browser_history_linux;

#[cfg(target_os = "linux")]
use browser_history::{bounded, HistoryIds};
#[cfg(target_os = "linux")]
use browser_history_linux::{go, observe, snapshot, Entry};
#[cfg(target_os = "linux")]
use gtk::prelude::*;
#[cfg(target_os = "linux")]
use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};
#[cfg(target_os = "linux")]
use webkit2gtk::WebViewExt;

#[cfg(target_os = "linux")]
fn until(label: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        while gtk::events_pending() {
            gtk::main_iteration_do(false);
        }
        if condition() {
            return;
        }
        assert!(Instant::now() < deadline, "timeout: {label}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(target_os = "linux")]
fn script(view: &webkit2gtk::WebView, source: &str) {
    let result = Rc::new(RefCell::new(None));
    let done = result.clone();
    #[allow(deprecated)]
    view.run_javascript(source, None::<&gtk::gio::Cancellable>, move |value| {
        *done.borrow_mut() = Some(value.map(|_| ()).map_err(|error| error.to_string()));
    });
    until(source, || result.borrow().is_some());
    result.borrow_mut().take().unwrap().unwrap();
}

#[cfg(target_os = "linux")]
struct History {
    allocator: HistoryIds,
    entries: Vec<Entry>,
    ids: Vec<i64>,
    current: usize,
}

#[cfg(target_os = "linux")]
impl History {
    fn read(&mut self, view: &webkit2gtk::WebView) {
        let (entries, current) = snapshot(view);
        let entries = bounded(entries, current, Entry::token);
        // Keep the preceding native objects alive through reconciliation.
        let ids = self.allocator.reconcile(entries.iter().map(Entry::token));
        self.current = entries
            .iter()
            .position(|entry| Some(entry.token()) == current)
            .expect("current native object retained in snapshot");
        self.entries = entries;
        self.ids = ids;
    }

    fn current_id(&self) -> i64 {
        self.ids[self.current]
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {}

#[cfg(target_os = "linux")]
fn main() {
    gtk::init().unwrap();
    let base = std::env::args().nth(1).expect("fixture URL");
    let view = webkit2gtk::WebView::new();
    let window = gtk::Window::new(gtk::WindowType::Toplevel);
    window.add(&view);
    window.set_default_size(400, 240);
    // Realize without presenting or stealing focus from the desktop user.
    window.set_accept_focus(false);
    window.show_all();
    let events = Rc::new(RefCell::new(Vec::new()));
    let observed = events.clone();
    observe(&view, move |uri| observed.borrow_mut().push(uri));
    let mut history = History {
        allocator: HistoryIds::default(),
        entries: Vec::new(),
        ids: Vec::new(),
        current: 0,
    };

    view.load_uri(&format!("{base}/start"));
    until("initial page", || {
        !view.is_loading() && view.uri().as_deref() == Some(&format!("{base}/start"))
    });
    history.read(&view);
    let start_id = history.current_id();
    view.load_uri(&format!("{base}/redirect"));
    until("HTTP redirect", || {
        !view.is_loading() && view.uri().as_deref() == Some(&format!("{base}/target"))
    });
    history.read(&view);
    assert_eq!(
        history.entries.len(),
        2,
        "redirect must not create an intermediate entry"
    );
    assert_eq!(history.ids[0], start_id);
    assert!(history
        .entries
        .iter()
        .all(|entry| !entry.url().ends_with("/redirect")));
    println!("PASS redirect: final URL and retained initial identity");

    for (source, suffix) in [
        ("location.hash = 'fragment'", "/target#fragment"),
        ("history.pushState({step: 1}, '', '/same')", "/same"),
        ("history.pushState({step: 2}, '', '/same')", "/same"),
    ] {
        let previous = history.ids.clone();
        let count = events.borrow().len();
        script(&view, source);
        until(source, || {
            snapshot(&view).0.len() == previous.len() + 1 && events.borrow().len() > count
        });
        history.read(&view);
        assert_eq!(&history.ids[..previous.len()], previous.as_slice());
        assert!(!previous.contains(&history.current_id()));
        assert_eq!(
            history.entries[history.current].url(),
            format!("{base}{suffix}")
        );
        println!("PASS same-document observed: {source}");
    }
    let duplicate_ids = history.ids.clone();
    let duplicate_entries = history.entries.clone();
    assert_eq!(duplicate_entries[3].url(), duplicate_entries[4].url());
    assert_ne!(duplicate_entries[3].token(), duplicate_entries[4].token());
    assert_ne!(duplicate_ids[3], duplicate_ids[4]);

    for (source, changes_url) in [
        ("history.replaceState({step: 3}, '', '/same')", false),
        ("history.replaceState({step: 4}, '', '/replaced')", true),
    ] {
        let count = events.borrow().len();
        script(&view, source);
        if changes_url {
            until(source, || events.borrow().len() > count);
        }
        history.read(&view);
        assert_eq!(
            history.ids, duplicate_ids,
            "replaceState preserves object identity"
        );
        assert_eq!(history.entries[4].token(), duplicate_entries[4].token());
        println!(
            "PASS replaceState identity ({} callbacks): {source}",
            events.borrow().len() - count
        );
    }
    assert_eq!(history.entries[4].url(), format!("{base}/replaced"));

    for index in [3, 4, 2] {
        let count = events.borrow().len();
        go(&view, &duplicate_entries[index]).unwrap();
        until("native back/forward", || {
            snapshot(&view).1 == Some(duplicate_entries[index].token())
                && events.borrow().len() > count
        });
        history.read(&view);
        assert_eq!(history.ids, duplicate_ids);
        assert_eq!(history.current_id(), duplicate_ids[index]);
    }
    println!("PASS native back/forward: identity and same-document callbacks");

    let count = events.borrow().len();
    script(&view, "history.pushState({}, '', '/branch')");
    until("branch callback", || events.borrow().len() > count);
    history.read(&view);
    assert_eq!(history.ids.len(), 4);
    assert_eq!(&history.ids[..3], &duplicate_ids[..3]);
    assert!(!history.ids.contains(&duplicate_ids[3]));
    assert!(!history.ids.contains(&duplicate_ids[4]));
    assert!(!duplicate_ids.contains(&history.current_id()));
    println!("PASS branch: stale forward IDs absent and new object gets new ID");

    script(
        &view,
        "for (let i = 0; i < 50; i++) history.pushState({i}, '', '/bounded-' + i)",
    );
    history.read(&view);
    assert_eq!(history.ids.len(), 32, "numeric handles bounded to 32");
    assert_eq!(
        history.entries[history.current].url(),
        format!("{base}/bounded-49")
    );
    let bounded_ids = history.ids.clone();
    history.read(&view);
    assert_eq!(history.ids, bounded_ids);
    let middle = history.entries[16].clone();
    go(&view, &middle).unwrap();
    until("middle of bounded history", || {
        snapshot(&view).1 == Some(middle.token())
    });
    let (wide, current) = snapshot(&view);
    assert!(
        wide.len() > 32,
        "exercise allocator with an oversized native snapshot"
    );
    let history_window = bounded(wide, current, Entry::token);
    assert!(history_window
        .iter()
        .any(|entry| Some(entry.token()) == current));
    let mut allocator = HistoryIds::default();
    let ids = allocator.reconcile(history_window.iter().map(Entry::token));
    assert_eq!(ids.len(), 32);
    assert_eq!(
        allocator.reconcile(history_window.iter().map(Entry::token)),
        ids
    );
    println!(
        "PASS bound: {} retained entries, current entry present, stable IDs",
        history.ids.len()
    );
    println!(
        "PASS WebKitGTK history regression ({} native observation callbacks)",
        events.borrow().len()
    );
    window.close();
}
