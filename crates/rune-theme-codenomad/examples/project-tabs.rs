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
    primitive: bool,
    halo: bool,
}
fn init() -> Gallery {
    let locale = std::env::var("RUNE_PARITY_LOCALE").unwrap_or_else(|_| "en".into());
    assert!(catalogue::SUPPORTED_LOCALES.contains(&locale.as_str()));
    let overflow = std::env::var("RUNE_PARITY_CASE").as_deref() == Ok("overflow");
    let mut names: Vec<String> = if overflow {
        (0..8)
            .map(|i| format!("Project {} · long synthetic folder name", i + 1))
            .collect()
    } else {
        vec!["Alpha".into(), "Beta".into()]
    };
    if let Ok(title) = std::env::var("RUNE_PARITY_TITLE") {
        assert!(
            !title.is_empty() && title.len() <= 512,
            "Synthetic title bound"
        );
        names[0] = title;
    }
    let rows: Vec<_> = names
        .into_iter()
        .enumerate()
        .map(|(i, title)| (format!("tab-{i}"), title))
        .collect();
    Gallery {
        locale,
        active: if std::env::var("RUNE_PARITY_CASE").as_deref() == Ok("inactive") {
            "tab-1".into()
        } else {
            "tab-0".into()
        },
        next: rows.len(),
        rows,
        primitive: std::env::var("RUNE_PARITY_PRIMITIVE").as_deref() == Ok("true"),
        halo: std::env::var("RUNE_PARITY_HALO").as_deref() == Ok("true"),
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
                help: None,
                blank: id.starts_with("blank-"),
                status: None,
                closable: true,
                temporary: false,
            })
            .collect();
        let select = |s: &mut Gallery, id: &str, _: &mut rune::Tx| {
            s.active = id.into();
            println!("project-tabs-select:{id}");
        };
        let close = |s: &mut Gallery, id: &str, _: &mut rune::Tx| {
            s.rows.retain(|(key, _)| key != id);
            println!("project-tabs-close:{id}");
        };
        let strip = if s.primitive {
            tabs::tab(
                &s.locale,
                &items[0],
                s.active == items[0].id,
                true,
                select,
                close,
            )
        } else {
            tabs::strip(
                cx.touch_controls(),
                &s.locale,
                &items,
                Some(&s.active),
                select,
                close,
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
                [],
            )
        };
        rune::row()
            .w_full()
            .h_full()
            .padding(if s.halo {
                tokens(cx.system_dark()).metric("tabFocus", "extent").px()
            } else {
                0.0
            })
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
