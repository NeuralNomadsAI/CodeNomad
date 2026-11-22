//! Offscreen-only gallery of the public shared component, without backend or user state.
use rune::{Cx, El};
use rune_theme_codenomad::{
    catalogue, layout,
    tabs::{self, ProjectTab},
    tokens,
};

struct Gallery {
    locale: String,
    rows: Vec<(String, String)>,
    active: String,
    next: usize,
}
fn init() -> Gallery {
    let locale = std::env::var("RUNE_PARITY_LOCALE").unwrap_or_else(|_| "en".into());
    assert!(catalogue::SUPPORTED_LOCALES.contains(&locale.as_str()));
    let overflow = std::env::var("RUNE_PARITY_CASE").as_deref() == Ok("overflow");
    let names = if overflow {
        (0..8)
            .map(|i| format!("Project {} · long synthetic folder name", i + 1))
            .collect()
    } else {
        vec!["Alpha".into(), "Beta".into()]
    };
    let rows: Vec<_> = names
        .into_iter()
        .enumerate()
        .map(|(i, title)| (format!("tab-{i}"), title))
        .collect();
    Gallery {
        locale,
        active: "tab-0".into(),
        next: rows.len(),
        rows,
    }
}
fn view(s: &Gallery, cx: &mut Cx<Gallery>) -> El {
    layout::render(cx, |cx| {
        let items: Vec<_> = s
            .rows
            .iter()
            .map(|(id, title)| ProjectTab {
                id,
                title,
                status: None,
                closable: true,
            })
            .collect();
        let strip = tabs::strip(
            cx,
            &s.locale,
            &items,
            Some(&s.active),
            |s, id, _| {
                s.active = id.into();
                println!("project-tabs-select:{id}");
            },
            |s, id, _| {
                s.rows.retain(|(key, _)| key != id);
                println!("project-tabs-close:{id}");
            },
            |s, _| {
                let id = format!("blank-{}", s.next);
                s.next += 1;
                s.rows.push((
                    id.clone(),
                    catalogue::message(&s.locale, "newTab.title")
                        .unwrap()
                        .into(),
                ));
                s.active = id;
                println!("project-tabs-new");
            },
        );
        rune::col()
            .w_full()
            .h_full()
            .fill(tokens(cx.system_dark()).color("surface-secondary"))
            .child(strip)
    })
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    if !args.iter().any(|a| a == "--tree") || !args.iter().any(|a| a == "--snap") {
        eprintln!("Offscreen gallery requires --tree and --snap");
        std::process::exit(2);
    }
    rune::run(layout::app_spec(
        catalogue::message("en", "window.title.main").unwrap(),
        init,
        view,
    ));
}
