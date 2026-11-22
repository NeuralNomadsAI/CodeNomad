use rune::Icon;

pub static LEFT: Icon = Icon {
    name: "lucide-panel-left",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/></g>"#,
};
pub static RIGHT: Icon = Icon {
    name: "lucide-panel-right",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/></g>"#,
};
pub static SEARCH: Icon = Icon {
    name: "lucide-search",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/></g>"#,
};
pub static PLUS: Icon = Icon {
    name: "lucide-plus",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></g>"#,
};
pub static BACK: Icon = Icon {
    name: "lucide-arrow-left",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></g>"#,
};
pub static FORWARD: Icon = Icon {
    name: "lucide-arrow-right",
    view: 24.0,
    body: r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></g>"#,
};
