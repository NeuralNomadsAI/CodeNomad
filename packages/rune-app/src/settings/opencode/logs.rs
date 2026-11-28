use super::super::Preferences;
use crate::{history::Result, platform, strings::t};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::{OpenCodeLogs, opencode_logs},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
    settings as chrome,
};
use std::{cell::RefCell, rc::Rc};

const MAX_DISPLAY_BYTES: usize = 128 * 1024;

#[derive(Default)]
pub(super) struct State {
    authority: Option<String>,
    last_binary: Option<String>,
    open: bool,
    info_open: bool,
    loading: bool,
    error: bool,
    snapshot: Option<OpenCodeLogs>,
    flight: Option<(Sender<()>, Receiver<Result<OpenCodeLogs>>)>,
}

impl State {
    pub(super) fn close(&mut self) {
        self.open = false;
        self.loading = false;
        self.error = false;
        self.snapshot = None;
        self.flight = None;
    }

    pub(super) fn poll(&mut self, prefs: &Preferences, _wake: &rune::Waker) -> bool {
        let backend = prefs.backend.as_ref().filter(|_| prefs.can_retry());
        let authority = backend.map(|backend| backend.client_id.as_str());
        let mut changed = authority != self.authority.as_deref();
        if changed {
            *self = Self {
                authority: authority.map(str::to_owned),
                ..Self::default()
            };
        }
        let binary = prefs.opencode_binary();
        if binary != self.last_binary {
            if self.open {
                self.close();
            }
            self.last_binary = binary;
            changed = true;
        }
        let done = self.flight.as_ref().and_then(|(_, rx)| rx.try_recv().ok());
        if let Some(result) = done {
            self.flight = None;
            self.loading = false;
            changed = true;
            if self.open {
                match result {
                    Ok(snapshot) => {
                        self.snapshot = Some(snapshot);
                        self.error = false;
                    }
                    Err(_) => {
                        self.snapshot = None;
                        self.error = true;
                    }
                }
            }
        }
        changed
    }

    pub(super) fn toggle(&mut self, prefs: &Preferences, wake: Option<rune::Waker>) {
        if self.open {
            self.close();
        } else {
            self.open = true;
            self.refresh(prefs, wake);
        }
    }

    pub(super) fn refresh(&mut self, prefs: &Preferences, wake: Option<rune::Waker>) {
        let (Some(backend), Some(wake)) = (
            prefs
                .backend
                .as_ref()
                .filter(|_| prefs.can_retry())
                .cloned(),
            wake,
        ) else {
            self.loading = false;
            self.snapshot = None;
            self.error = true;
            self.flight = None;
            return;
        };
        self.snapshot = None;
        self.error = false;
        self.loading = true;
        let (out, rx) = bounded(1);
        let (cancel, cancelled) = bounded(1);
        self.flight = Some((cancel, rx));
        platform::spawn(async move {
            if let Some(result) =
                platform::reads::cancellable(&cancelled, opencode_logs(&backend)).await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }

    pub(super) fn action_view<S: 'static>(
        &self,
        prefs: &Preferences,
        shared: &Rc<RefCell<Preferences>>,
        wake: Option<rune::Waker>,
        layers: &mut Vec<El>,
        access: fn(&mut S) -> &mut super::Status,
    ) -> El {
        let toggle_shared = shared.clone();
        let toggle_wake = wake.clone();
        let trigger = chrome::secondary_action(
            t("settings.opencode.logs.open"),
            !prefs.opencode_binary_available(),
            move |s: &mut S| {
                let prefs = toggle_shared.borrow();
                access(s).logs.toggle(&prefs, toggle_wake.clone());
            },
        )
        .key("opencode-logs-open");
        let info = chrome::info_tip(
            t("settings.opencode.logs.info"),
            t("settings.opencode.logs.info"),
            self.info_open,
            move |s: &mut S| {
                let state = &mut access(s).logs;
                state.info_open = !state.info_open;
            },
        )
        .key("opencode-logs-info");

        if self.open {
            let refresh_shared = shared.clone();
            let refresh_wake = wake;
            let actions = layout::action_row()
                .child(
                    layout::button(
                        t("instanceShell.rightPanel.actions.refresh"),
                        self.loading || !prefs.can_retry(),
                        move |s: &mut S| {
                            let prefs = refresh_shared.borrow();
                            access(s).logs.refresh(&prefs, refresh_wake.clone());
                        },
                    )
                    .key("opencode-logs-refresh"),
                )
                .child(
                    layout::button(
                        t("backgroundProcessOutputDialog.actions.close"),
                        false,
                        move |s: &mut S| {
                            access(s).logs.close();
                        },
                    )
                    .key("opencode-logs-close"),
                );
            let mut body = col().full_width().separate(Space::Sm);
            if self.loading {
                body = body.child(
                    text(t("instanceInfo.loading"))
                        .text_role(TextRole::Small)
                        .role("status")
                        .key("opencode-logs-loading"),
                );
            }
            if self.error {
                body = body.child(
                    chrome::palette::save_error(t("settings.opencode.logs.failed"))
                        .key("opencode-logs-error"),
                );
            }
            if let Some(snapshot) = &self.snapshot {
                let (content, locally_truncated) = if snapshot.text.is_empty() {
                    (t("settings.opencode.logs.empty"), false)
                } else {
                    bounded_tail(&snapshot.text)
                };
                if snapshot.truncated || locally_truncated {
                    body = body.child(
                        text(t("settings.opencode.logs.truncated"))
                            .text_role(TextRole::Small)
                            .wrap()
                            .role("status")
                            .key("opencode-logs-truncated"),
                    );
                }
                body = body.child(chrome::log_block(content).key("opencode-logs-content"));
            }
            layers.push(chrome::output_window(
                "opencode-logs-window",
                t("settings.opencode.logs.title"),
                self.snapshot.as_ref().map(|s| s.path.as_str()),
                "opencode-logs-open",
                actions,
                body,
                move |s: &mut S| access(s).logs.close(),
            ));
        }

        layout::action_row().child(trigger).child(info)
    }
}

fn bounded_tail(source: &str) -> (&str, bool) {
    if source.len() <= MAX_DISPLAY_BYTES {
        return (source, false);
    }
    let mut start = source.len() - MAX_DISPLAY_BYTES;
    while start < source.len() && !source.is_char_boundary(start) {
        start += 1;
    }
    if let Some(offset) = source[start..].find('\n') {
        let after = &source[start + offset + 1..];
        if !after.is_empty() {
            return (after, true);
        }
    }
    (&source[start..], true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_tail_reports_local_truncation_and_respects_utf8_boundaries() {
        let short = "line1\nline2\n";
        assert_eq!(bounded_tail(short), (short, false));

        let mut oversized = String::from("é".repeat(MAX_DISPLAY_BYTES));
        oversized.push_str("\ntail-entry\n");
        let (tail, truncated) = bounded_tail(&oversized);
        assert!(truncated);
        assert!(tail.len() <= MAX_DISPLAY_BYTES);
        assert_eq!(tail, "tail-entry\n");
    }

    #[test]
    fn bounded_tail_falls_back_to_utf8_boundary_for_single_oversized_line_with_newline() {
        let mut ascii_line = "a".repeat(MAX_DISPLAY_BYTES + 64);
        ascii_line.push('\n');
        let (tail, truncated) = bounded_tail(&ascii_line);
        assert!(truncated);
        assert!(!tail.is_empty());
        assert_eq!(tail.len(), MAX_DISPLAY_BYTES);
        assert!(tail.ends_with('\n'));

        // Multi-byte UTF-8 single line > 128 KiB ending with '\n' must stay non-empty and valid.
        let mut utf8_line = "é".repeat(MAX_DISPLAY_BYTES);
        utf8_line.push('\n');
        let (utf8_tail, utf8_truncated) = bounded_tail(&utf8_line);
        assert!(utf8_truncated);
        assert!(!utf8_tail.is_empty());
        assert!(utf8_tail.len() <= MAX_DISPLAY_BYTES);
        assert!(utf8_tail.ends_with('\n'));

        // Single line > 128 KiB without any newline falls back to the same UTF-8 boundary.
        let no_newline = "é".repeat(MAX_DISPLAY_BYTES);
        let (no_nl_tail, no_nl_truncated) = bounded_tail(&no_newline);
        assert!(no_nl_truncated);
        assert!(!no_nl_tail.is_empty());
        assert!(no_nl_tail.len() <= MAX_DISPLAY_BYTES);
    }
}
