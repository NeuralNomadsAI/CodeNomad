use super::{connection, keys, right_panel, sidebar};
use crate::{State, strings};
use rune::{El, Tx, col, text};
use rune_theme_codenomad::{
    layout::Layout,
    shell::{
        self, CENTER_MIN, PANEL_DEFAULT, PANEL_MIN,
        icons::{LEFT, RIGHT},
    },
};
const KEYS: [&str; 2] = ["sessions-panel-toggle", "right-panel-toggle"];
const LABELS: [&str; 2] = ["window.menu.leftPanel", "window.menu.rightPanel"];
const REGIONS: [&str; 2] = ["sessions-panel", "right-panel"];

pub struct Panels {
    width: f32,
    preferred: [f32; 2],
    pub wanted: [Option<[bool; 2]>; 2],
    portrait: bool,
    floating: Option<usize>,
    resizing: Option<usize>,
}
impl Default for Panels {
    fn default() -> Self {
        Self {
            width: 0.0,
            preferred: PANEL_DEFAULT,
            wanted: [None; 2],
            portrait: false,
            floating: None,
            resizing: None,
        }
    }
}
impl Panels {
    fn wanted(&self) -> [bool; 2] {
        self.wanted[usize::from(self.portrait)].unwrap_or([!self.portrait; 2])
    }
    fn set_wanted(&mut self, index: usize, open: bool) {
        let mut wanted = self.wanted();
        wanted[index] = open;
        self.wanted[usize::from(self.portrait)] = Some(wanted);
    }
    fn docked(&self, wanted: [bool; 2]) -> [Option<f32>; 2] {
        let room = (self.width - CENTER_MIN).max(0.0);
        let [left, right] = self.preferred;
        [
            (wanted[0] && room >= PANEL_MIN[0]).then_some(room.min(left)),
            (wanted[1] && room >= PANEL_MIN[1] + if wanted[0] { left } else { 0.0 })
                .then_some(right.min(room - if wanted[0] { left } else { 0.0 })),
        ]
    }

    fn has_room(&self, index: usize) -> bool {
        let mut wanted = self.wanted();
        wanted[index] = true;
        self.docked(wanted)[index].is_some()
    }

    fn measure(&mut self, width: f32, height: f32, touch: bool, tx: &mut Tx) {
        let before = std::array::from_fn::<_, 2, _>(|i| self.visible(i));
        self.width = width;
        let portrait = touch && width < height;
        if portrait != self.portrait {
            self.portrait = portrait;
            self.leave_project();
        }
        self.dock_floating();
        if self.resizing.is_some_and(|i| !self.visible(i)) {
            self.resizing = None;
        }
        for i in 0..2 {
            if before[i]
                && !self.visible(i)
                && let Some(key) = tx.focused()
                && (sidebar::focus_key(key) && i == 0 || key.starts_with("right-panel-") && i == 1)
                && !KEYS.contains(&key)
            {
                tx.focus_when_shown(KEYS[i], tx.focus_visible());
            }
        }
        tx.instant();
    }

    pub fn visible(&self, index: usize) -> bool {
        self.docked(self.wanted())[index].is_some() || self.floating == Some(index)
    }

    pub fn toggle(&mut self, index: usize, tx: &mut Tx) {
        if self.floating == Some(index) {
            self.close_floating(tx);
        } else if self.docked(self.wanted())[index].is_some() {
            self.set_wanted(index, false);
            tx.focus(KEYS[index], tx.focus_visible());
        } else if self.has_room(index) {
            self.floating = None;
            self.set_wanted(index, true);
        } else {
            self.floating = Some(index);
        }
        self.dock_floating();
        tx.instant();
    }

    fn dock_floating(&mut self) {
        if let Some(index) = self.floating.filter(|&i| self.has_room(i)) {
            self.set_wanted(index, true);
            self.floating = None;
        }
    }

    pub fn close_floating(&mut self, tx: &mut Tx) -> bool {
        let Some(index) = self.floating.take() else {
            return false;
        };
        tx.focus_when_shown(KEYS[index], tx.focus_visible());
        tx.instant();
        true
    }

    pub fn leave_project(&mut self) {
        self.floating = None;
        self.resizing = None;
    }

    fn resize(&mut self, index: usize, resize: shell::Resize, tx: &mut Tx) {
        match resize {
            shell::Resize::Start => self.resizing = Some(index),
            shell::Resize::Set(width) if self.resizing == Some(index) => {
                let [left, right] = self.docked(self.wanted());
                let other = [right, left][index].unwrap_or_default();
                let max = (self.width - CENTER_MIN - other).max(PANEL_MIN[index]);
                if width < max || self.preferred[index] <= max {
                    self.preferred[index] = width.clamp(PANEL_MIN[index], max);
                    self.dock_floating();
                }
            }
            shell::Resize::End if self.resizing == Some(index) => self.resizing = None,
            _ => return,
        }
        tx.instant();
    }
}

pub fn view(s: &State, touch: bool, project: bool, body: El) -> El {
    let rtl = rune_theme_codenomad::catalogue::direction(strings::locale()) == "rtl";
    let docked = if project {
        s.shell.docked(s.shell.wanted())
    } else {
        [None; 2]
    };
    let floating = s.shell.floating.filter(|_| project);
    let t = strings::t;
    let inactive = |e: El| {
        if floating.is_some() {
            e.inert().a11y_hidden()
        } else {
            e
        }
    };
    let panel = |i: usize, width, floating| {
        let content = if i == 0 {
            sidebar::view(s, touch, rtl, floating)
        } else {
            right_panel::view(s, touch, floating)
        };
        let pane = shell::panel(width, floating)
            .key(REGIONS[i])
            .role("region")
            .label(t(LABELS[i]))
            .child(content);
        if floating {
            pane
        } else {
            let scope = s.input_scope.clone();
            pane.child(shell::panel_grip(
                if i == 0 {
                    "sessions-panel-resize"
                } else {
                    "right-panel-resize"
                },
                t(LABELS[i]),
                i == 0,
                rtl,
                s.shell.resizing == Some(i),
                s.shell.preferred[i],
                move |s: &mut State, resize, tx| {
                    if s.current_scope(&scope) {
                        s.shell.resize(i, resize, tx);
                    }
                },
            ))
        }
    };
    let mut center = shell::conversation_column().key("conversation");
    if project
        || !s.chat_title.is_empty()
        || matches!(s.phase, crate::Phase::Failed | crate::Phase::Reconnecting)
    {
        center = center.child(header(s, project, docked, touch));
    }
    let center = center.child(body.remaining());
    let mut columns = shell::columns();
    if let Some(width) = docked[0].filter(|_| floating != Some(0)) {
        columns = columns.child(panel(0, width, false));
    }
    columns = columns.child(center);
    if let Some(width) = docked[1].filter(|_| floating != Some(1)) {
        columns = columns.child(panel(1, width, false));
    }
    let mut root = shell::frame()
        .key("session-shell")
        .on_layout_tx(move |s: &mut State, [_, _, width, height], tx| {
            s.shell.measure(width, height, touch, tx)
        })
        .on_key(keys);
    if project {
        for i in 0..2 {
            root = root.child(shell::toggle(
                if (i == 0) != rtl { &LEFT } else { &RIGHT },
                t(LABELS[i]),
                KEYS[i],
                i == 0,
                touch,
                s.shell.visible(i),
                crate::screen::action_tx(&s.input_scope, move |s, tx| s.shell.toggle(i, tx)),
            ));
        }
    }
    root = root.child(inactive(columns));
    if let Some(index) = floating {
        root = root.child(panel(index, PANEL_DEFAULT[index], true));
    }
    root
}

fn header(s: &State, project: bool, docked: [Option<f32>; 2], touch: bool) -> El {
    let t = strings::t;
    let title = if s.chat_title.is_empty() && project {
        s.screen
            .launcher()
            .and_then(|l| l.project.as_ref())
            .map_or("", |p| &p.path)
    } else {
        &s.chat_title
    };
    let reserve = |i: usize| project && docked[i].is_none();
    let warning = match s.phase {
        crate::Phase::Reconnecting => Some(text(connection(s)).role("status")),
        crate::Phase::Failed => Some(crate::components::button(
            "connection-retry",
            t("sessionList.loadError.retry"),
            false,
            crate::screen::action(&s.input_scope, crate::retry_connection),
        )),
        _ => None,
    };
    shell::header(
        reserve(0),
        reserve(1),
        touch,
        [
            shell::spacer(),
            shell::panel_title(title).key("chat-title").role("heading"),
            shell::spacer(),
            warning.unwrap_or_else(col),
        ],
    )
    .key("session-header")
}
