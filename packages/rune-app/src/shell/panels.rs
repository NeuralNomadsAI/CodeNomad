use super::{connection, panel_keys, right_panel, sidebar};
use crate::{State, strings};
use rune::{El, Tx, text};
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
    right_width_initialized: bool,
    pub wanted: [Option<[bool; 2]>; 2],
    pub(crate) file_wrap: bool,
    touch: bool,
    portrait: bool,
    touch_initialized: bool,
    started_portrait: bool,
    touch_viewport: Option<(f32, f32)>,
    portrait_width: Option<f32>,
    screen_portrait: Option<bool>,
    floating: Option<usize>,
    floating_epoch: u64,
    resizing: Option<usize>,
    pub(crate) directory_browser: Box<super::directory_browser::Browser>,
    pub(crate) new_instance_launcher: Box<super::new_instance_launcher::LauncherMenu>,
    #[cfg(target_arch = "wasm32")]
    orientation_watch: Option<super::web_orientation::Watch>,
    #[cfg(target_arch = "wasm32")]
    orientation_watch_attempted: bool,
    #[cfg(test)]
    pub(super) touch_override: bool,
    #[cfg(test)]
    pub(super) test_orientation_pending: Option<Option<bool>>,
}
impl Default for Panels {
    fn default() -> Self {
        Self {
            width: 0.0,
            preferred: PANEL_DEFAULT,
            right_width_initialized: false,
            wanted: [None; 2],
            file_wrap: false,
            touch: false,
            portrait: false,
            touch_initialized: false,
            started_portrait: false,
            touch_viewport: None,
            portrait_width: None,
            screen_portrait: None,
            floating: None,
            floating_epoch: 0,
            resizing: None,
            directory_browser: Box::default(),
            new_instance_launcher: Box::default(),
            #[cfg(target_arch = "wasm32")]
            orientation_watch: None,
            #[cfg(target_arch = "wasm32")]
            orientation_watch_attempted: false,
            #[cfg(test)]
            touch_override: false,
            #[cfg(test)]
            test_orientation_pending: None,
        }
    }
}
impl Panels {
    pub(crate) fn width(&self) -> f32 {
        self.width
    }

    pub fn restore_widths(&mut self, widths: [Option<u16>; 2]) {
        for (i, width) in widths.into_iter().enumerate() {
            if let Some(width) = width {
                self.preferred[i] = f32::from(width);
                self.right_width_initialized |= i == 1;
            }
        }
    }
    fn wanted(&self) -> [bool; 2] {
        let default = !self.portrait && !(self.touch && self.started_portrait);
        self.wanted[usize::from(self.portrait)].unwrap_or([default; 2])
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

    pub(crate) fn docked_left(&self) -> bool {
        self.floating != Some(0) && self.docked(self.wanted())[0].is_some()
    }

    fn has_room(&self, index: usize) -> bool {
        let mut wanted = self.wanted();
        wanted[index] = true;
        self.docked(wanted)[index].is_some()
    }

    fn resolve_portrait(
        &mut self,
        width: f32,
        height: f32,
        touch: bool,
        screen_portrait: Option<bool>,
    ) -> bool {
        if !touch || width <= 0.0 || height <= 0.0 {
            self.touch_viewport = None;
            return false;
        }
        let previous = self.touch_viewport.replace((width, height));
        let Some((prev_w, prev_h)) = previous else {
            if screen_portrait.is_some() {
                self.screen_portrait = screen_portrait;
            }
            return width <= height;
        };
        if (width - prev_w).abs() < 1.0 {
            if !self.portrait && screen_portrait == Some(true) {
                self.screen_portrait = Some(true);
                return true;
            }
            return self.portrait || width <= height;
        }
        let screen_changed = screen_portrait.is_some() && screen_portrait != self.screen_portrait;
        if screen_portrait.is_some() {
            self.screen_portrait = screen_portrait;
        }
        if screen_changed {
            return screen_portrait.unwrap_or(width <= height);
        }
        if !self.portrait
            && width < prev_w
            && height > prev_h
            && self
                .portrait_width
                .is_some_and(|pw| (width - pw).abs() < 1.0)
        {
            return true;
        }
        width <= height
    }

    pub(super) fn measure(
        &mut self,
        width: f32,
        height: f32,
        touch: bool,
        panel_overlay_open: bool,
        tx: &mut Tx,
    ) -> Option<usize> {
        #[cfg(target_arch = "wasm32")]
        let screen_portrait = web_screen_portrait();
        #[cfg(not(target_arch = "wasm32"))]
        let screen_portrait = None;
        self.measure_with_screen_and_overlay(
            width,
            height,
            touch,
            screen_portrait,
            panel_overlay_open,
            tx,
        )
    }

    pub(super) fn poll(
        &mut self,
        wake: &rune::Waker,
        panel_overlay_open: bool,
        tx: &mut Tx,
    ) -> (bool, Option<usize>) {
        let _ = wake;
        #[cfg(target_arch = "wasm32")]
        {
            if !self.orientation_watch_attempted {
                self.orientation_watch_attempted = true;
                self.orientation_watch = super::web_orientation::Watch::new(wake.clone());
            }
            if self
                .orientation_watch
                .as_ref()
                .is_some_and(super::web_orientation::Watch::take_changed)
                && self.touch
                && let Some((width, height)) = self.touch_viewport
            {
                let dismissed = self.measure_with_screen_and_overlay(
                    width,
                    height,
                    true,
                    web_screen_portrait(),
                    panel_overlay_open,
                    tx,
                );
                return (true, dismissed);
            }
        }
        #[cfg(test)]
        if let Some(screen_portrait) = self.test_orientation_pending.take()
            && self.touch
            && let Some((width, height)) = self.touch_viewport
        {
            let dismissed = self.measure_with_screen_and_overlay(
                width,
                height,
                true,
                screen_portrait,
                panel_overlay_open,
                tx,
            );
            return (true, dismissed);
        }
        (false, None)
    }

    #[cfg(test)]
    pub(super) fn measure_with_screen(
        &mut self,
        width: f32,
        height: f32,
        touch: bool,
        screen_portrait: Option<bool>,
        tx: &mut Tx,
    ) -> Option<usize> {
        self.measure_with_screen_and_overlay(width, height, touch, screen_portrait, false, tx)
    }

    fn measure_with_screen_and_overlay(
        &mut self,
        width: f32,
        height: f32,
        touch: bool,
        screen_portrait: Option<bool>,
        panel_overlay_open: bool,
        tx: &mut Tx,
    ) -> Option<usize> {
        if width > 0.0 && !self.right_width_initialized {
            self.preferred[1] = shell::default_right_panel(width);
            self.right_width_initialized = true;
        }
        let prev_floating = self.floating;
        self.width = width;
        self.touch = touch;
        let portrait = self.resolve_portrait(width, height, touch, screen_portrait);
        if touch && width > 0.0 && height > 0.0 && !self.touch_initialized {
            self.touch_initialized = true;
            self.started_portrait = portrait;
            self.portrait = portrait;
            if portrait {
                self.portrait_width = Some(width);
            }
        } else if portrait != self.portrait {
            self.portrait = portrait;
            if touch && portrait {
                self.portrait_width = Some(width);
            }
            if let Some(index) = self.floating.take()
                && (tx.focus_within(REGIONS[index]) || (index == 1 && panel_overlay_open))
            {
                tx.focus_when_shown(KEYS[index], tx.focus_visible());
            }
            self.resizing = None;
        } else if touch && portrait {
            self.portrait_width = Some(width);
        }
        if !touch {
            self.portrait_width = None;
            self.screen_portrait = None;
        }
        self.dock_floating();
        if self.resizing.is_some_and(|i| !self.visible(i)) {
            self.resizing = None;
        }
        tx.instant();
        prev_floating.filter(|&index| self.floating != Some(index))
    }

    pub fn visible(&self, index: usize) -> bool {
        self.docked(self.wanted())[index].is_some() || self.floating == Some(index)
    }

    fn toggle(&mut self, index: usize, tx: &mut Tx) {
        if self.floating == Some(index) {
            self.close_floating(tx);
        } else if self.docked(self.wanted())[index].is_some() {
            self.set_wanted(index, false);
            tx.focus(KEYS[index], tx.focus_visible());
        } else if self.has_room(index) {
            self.floating = None;
            self.set_wanted(index, true);
        } else {
            self.floating_epoch = self.floating_epoch.wrapping_add(1);
            self.floating = Some(index);
            tx.focus_when_shown(KEYS[index], tx.focus_visible());
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

    pub fn floating_sessions(&self) -> Option<u64> {
        (self.floating == Some(0)).then_some(self.floating_epoch)
    }
    pub fn floating_panel(&self) -> Option<u64> {
        self.floating.map(|_| self.floating_epoch)
    }
    pub fn has_floating(&self) -> bool {
        self.floating.is_some()
    }

    pub fn leave_project(&mut self) {
        self.floating = None;
        self.resizing = None;
        self.directory_browser.dismiss();
        self.new_instance_launcher.dismiss();
    }

    pub fn dismiss_outside(s: &mut State, tx: &mut Tx) {
        if s.shell.floating.take().is_some() {
            tx.instant();
        }
    }

    fn resize(&mut self, index: usize, resize: shell::Resize, tx: &mut Tx) {
        match resize {
            shell::Resize::Start => self.resizing = Some(index),
            shell::Resize::Set(width) | shell::Resize::Nudge(width)
                if self.resizing == Some(index) || matches!(resize, shell::Resize::Nudge(_)) =>
            {
                let max = self.max_width(index);
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
    fn max_width(&self, index: usize) -> f32 {
        let [left, right] = self.docked(self.wanted());
        let other = [right, left][index].unwrap_or_default();
        (self.width - CENTER_MIN - other).clamp(
            PANEL_MIN[index],
            f32::from(crate::workspace::MAX_PANEL_WIDTH),
        )
    }

    pub(super) fn wrap_floating_focus(&self, _backward: bool, tx: &mut Tx) -> bool {
        let Some(index) = self.floating else {
            return false;
        };
        if tx.focused().is_none() {
            tx.focus(KEYS[index], true);
            return true;
        }
        false
    }
}

#[cfg(target_arch = "wasm32")]
fn web_screen_portrait() -> Option<bool> {
    let window = web_sys::window()?;
    let screen = js_sys::Reflect::get(window.as_ref(), &"screen".into()).ok()?;
    let orientation = js_sys::Reflect::get(&screen, &"orientation".into()).ok()?;
    let kind = js_sys::Reflect::get(&orientation, &"type".into())
        .ok()?
        .as_string()?;
    if kind.starts_with("portrait") {
        Some(true)
    } else if kind.starts_with("landscape") {
        Some(false)
    } else {
        None
    }
}

pub fn toggle(s: &mut State, index: usize, tx: &mut Tx) {
    if s.shell.resizing == Some(index) {
        s.shell.resizing = None;
    }
    s.shell.toggle(index, tx);
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
            right_panel::view(s, width, touch, floating)
        };
        let pane = shell::panel(width, floating)
            .key(REGIONS[i])
            .role("region")
            .label(t(LABELS[i]))
            .focus_return(KEYS[i])
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
                width,
                PANEL_MIN[i],
                s.shell.max_width(i),
                move |s: &mut State, resize, tx| {
                    if s.current_scope(&scope) {
                        let before = s.shell.preferred[i];
                        s.shell.resize(i, resize, tx);
                        if s.shell.preferred[i] != before {
                            let width = s.shell.preferred[i].round() as u16;
                            crate::workspace::panel_width(s, i, width);
                        }
                    }
                },
            ))
        }
    };
    let session = crate::workspace::active_session(s);
    let mut center = shell::conversation_column().key(match session {
        Some(id) => format!("conversation-session-{id}"),
        None => "conversation-draft".into(),
    });
    if project || !s.chat_title.is_empty() || s.files.is_some() {
        center = center.child(header(s, project, docked, touch));
    } else if let Some(warning) = connection_warning(s) {
        center = center.child(shell::floating_notice(warning).key("connection-warning"));
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
    let mut root = shell::frame().key("session-shell").on_key(panel_keys);
    if project {
        for i in 0..2 {
            root = root.child(shell::toggle(
                if (i == 0) != rtl { &LEFT } else { &RIGHT },
                t(LABELS[i]),
                KEYS[i],
                i == 0,
                touch,
                s.shell.visible(i),
                crate::screen::action_tx(&s.input_scope, move |s, tx| toggle(s, i, tx)),
            ));
        }
    }
    root = root.child(inactive(columns));
    if let Some(index) = floating {
        let width = if s.shell.width > 0.0 {
            s.shell.width
        } else {
            PANEL_DEFAULT[index]
        };
        root = root.child(panel(index, width, true));
    }
    root
}

fn header(s: &State, project: bool, docked: [Option<f32>; 2], touch: bool) -> El {
    let title = if s.chat_title.is_empty() && project {
        crate::workspace::active_project_title(s).unwrap_or_else(|| {
            s.screen
                .launcher()
                .and_then(|l| l.project.as_ref())
                .map_or("", |p| &p.path)
        })
    } else {
        &s.chat_title
    };
    let left_open = project && s.shell.visible(0);
    let active_conversation = crate::workspace::active_session(s).is_some()
        || s.agent.is_some()
        || !s.chat_title.is_empty();
    let reserve = |i: usize| project && docked[i].is_none();
    let reserve_left = reserve(0);
    let reserve_right = reserve(1);
    let center_width = if s.shell.width > 0.0 {
        (s.shell.width - docked[0].unwrap_or(0.0) - docked[1].unwrap_or(0.0)).max(0.0)
    } else {
        0.0
    };
    let inset_w = |reserved: bool| {
        if reserved {
            if touch { 56.0 } else { 44.0 }
        } else {
            12.0
        }
    };
    let row_budget = if center_width > 0.0 {
        (center_width - inset_w(reserve_left) - inset_w(reserve_right)).max(0.0)
    } else {
        0.0
    };
    let (meter_density, show_connection_label) = if row_budget == 0.0 {
        if touch {
            (shell::ContextMeterDensity::DialOnly, false)
        } else {
            (shell::ContextMeterDensity::Full, true)
        }
    } else if row_budget >= 410.0 && !touch {
        (shell::ContextMeterDensity::Full, true)
    } else if row_budget >= 340.0 {
        (shell::ContextMeterDensity::Full, false)
    } else if row_budget >= 290.0 {
        (shell::ContextMeterDensity::Compact, false)
    } else {
        (shell::ContextMeterDensity::DialOnly, false)
    };
    let meter = (project || active_conversation).then(|| context_meter(s, meter_density));
    let show_center_title =
        !left_open && !title.is_empty() && (row_budget == 0.0 || row_budget >= 320.0);
    let center_title =
        show_center_title.then(|| shell::panel_title(title).key("chat-title").role("heading"));
    let retry = connection_retry(s);
    let compact_actions =
        row_budget > 0.0 && (row_budget < 220.0 || (retry.is_some() && row_budget < 270.0));
    let mut actions = Vec::with_capacity(9);
    if let Some(meter) = meter {
        actions.push(meter);
    }
    actions.push(shell::spacer());
    if let Some(heading) = center_title {
        actions.push(heading);
        actions.push(shell::spacer());
    }
    if !compact_actions && let Some(rename) = super::tab_rename::trigger(s, touch) {
        actions.push(rename);
    }
    actions.push(super::command_palette::trigger(s, touch));
    if let Some(search) = crate::timeline::search::trigger(s) {
        actions.push(search);
    }
    actions.push(crate::files::view::toggle(s));
    actions.push(shell::connection_indicator(
        connection_dot(s),
        connection(s),
        show_connection_label,
    ));
    if let Some(retry) = retry {
        actions.push(retry);
    }
    shell::header(reserve_left, reserve_right, touch, actions).key("session-header")
}

fn context_meter(s: &State, density: shell::ContextMeterDensity) -> El {
    let usage = s
        .messages
        .iter()
        .rev()
        .find_map(|row| (row.role == "assistant").then_some(row.usage).flatten())
        .or_else(|| s.agent.as_ref().and_then(|agent| agent.usage));
    let used = usage.map_or(0, |u| {
        u.input
            .saturating_add(u.cache_read)
            .saturating_add(u.cache_write)
            .saturating_add(u.output)
            .saturating_add(u.reasoning)
    });
    // Shortcut bounded by the B2/B10 file frontier: codenomad-client::agent_api::Model does not
    // yet decode /api/model limit.{input,context}. Upgrade by adding limit decoding on Model and
    // looking up agent.current in agent.models, keeping limit.input preferred over limit.context.
    let avail = s
        .agent
        .as_ref()
        .and_then(|agent| agent.current.as_ref())
        .and_then(|model| {
            model["limit"]["input"]
                .as_u64()
                .filter(|limit| *limit > 0)
                .or_else(|| {
                    model["limit"]["context"]
                        .as_u64()
                        .filter(|limit| *limit > 0)
                })
        });
    let locale = strings::locale();
    let used_label = strings::t("instanceShell.metrics.usedLabel");
    let avail_label = strings::t("instanceShell.metrics.availableLabel");
    let used_compact = rune_theme_codenomad::usage::numbers::compact(locale, used);
    let used_exact = rune_theme_codenomad::usage::numbers::exact(locale, used);
    let (avail_compact, avail_exact) = match avail {
        Some(limit) => (
            rune_theme_codenomad::usage::numbers::compact(locale, limit),
            rune_theme_codenomad::usage::numbers::exact(locale, limit),
        ),
        None => ("--".to_owned(), "--".to_owned()),
    };
    let ratio = avail.map(|limit| {
        let denom = if limit >= used {
            limit
        } else {
            limit.saturating_add(used)
        };
        (used as f32 / denom.max(1) as f32).clamp(0.0, 1.0)
    });
    let tooltip = match ratio {
        Some(value) => format!(
            "{used_label}: {used_exact} / {avail_label}: {avail_exact} ({}%)",
            (value * 100.0).round() as u32
        ),
        None => format!("{used_label}: {used_exact} / {avail_label}: {avail_exact}"),
    };
    shell::context_meter(
        used_label,
        &used_compact,
        avail_label,
        &avail_compact,
        ratio,
        density,
        &tooltip,
    )
}

fn connection_dot(s: &State) -> shell::ServiceDot {
    match s.phase {
        crate::Phase::Ready | crate::Phase::Streaming => shell::ServiceDot::Ready,
        crate::Phase::Loading
        | crate::Phase::Reconnecting
        | crate::Phase::StreamDisconnected { .. } => shell::ServiceDot::Pending,
        crate::Phase::Failed => shell::ServiceDot::Error,
        #[cfg(target_arch = "wasm32")]
        crate::Phase::WorkspaceMissing => shell::ServiceDot::Pending,
        #[cfg(target_arch = "wasm32")]
        crate::Phase::RestoreFailed => shell::ServiceDot::Error,
    }
}

fn connection_retry(s: &State) -> Option<El> {
    let failed = s.phase == crate::Phase::Failed;
    #[cfg(target_arch = "wasm32")]
    let failed = failed || s.phase == crate::Phase::RestoreFailed;
    failed.then(|| {
        crate::components::button_tx(
            "connection-retry",
            strings::t("sessionList.loadError.retry"),
            false,
            crate::screen::action_tx(&s.input_scope, crate::retry_connection),
        )
    })
}

fn connection_warning(s: &State) -> Option<El> {
    #[cfg(target_arch = "wasm32")]
    if s.phase == crate::Phase::WorkspaceMissing {
        return Some(text(connection(s)).role("status"));
    }
    match &s.phase {
        phase if phase.reconnecting() => Some(text(connection(s)).role("status")),
        _ => connection_retry(s),
    }
}

#[cfg(test)]
mod header_right_panel_tests;
