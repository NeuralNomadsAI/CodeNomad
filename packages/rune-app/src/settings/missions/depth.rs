//! Location-scoped Subagent depth editor matching `mission-subagent-depth.tsx`.
use super::{InfoTip, Picker};
use crate::{
    platform,
    settings::providers::Target,
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, Sender, bounded,
    settings::missions::{
        SubagentDepthError, SubagentDepthSnapshot, read_subagent_depth,
        resolve_workspace_directory, set_subagent_depth,
    },
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Phase {
    Idle,
    Reading,
    Ready,
    Saving,
    Uncertain,
    Unsupported,
}

impl Default for Phase {
    fn default() -> Self {
        Self::Idle
    }
}

type ReadFlight = (
    Sender<()>,
    Receiver<Result<SubagentDepthSnapshot, SubagentDepthError>>,
);
type SaveFlight = Receiver<Result<(), SubagentDepthError>>;

#[derive(Default)]
pub(super) struct State {
    scope: Option<(String, String, Option<String>)>,
    authority: u64,
    seen_revision: Option<u64>,
    manual_epoch: u64,
    phase: Phase,
    snapshot: Option<SubagentDepthSnapshot>,
    draft: String,
    dirty: bool,
    error: bool,
    saved: bool,
    queued: Option<(String, String)>,
    read_flight: Option<ReadFlight>,
    save_flight: Option<SaveFlight>,
    pending_save: bool,
}

impl State {
    pub(super) fn suspend(&mut self) {
        if self.phase == Phase::Reading {
            self.phase = if self.snapshot.is_some() {
                Phase::Ready
            } else {
                Phase::Idle
            };
        }
        self.read_flight = None;
        self.seen_revision = None;
    }

    pub(super) fn needs_confirm_refresh(&self) -> bool {
        self.dirty || self.phase == Phase::Uncertain
    }

    pub(super) fn busy(&self) -> bool {
        matches!(self.phase, Phase::Reading | Phase::Saving)
    }

    pub(super) fn request_refresh(&mut self) {
        self.dirty = false;
        self.error = false;
        self.saved = false;
        self.queued = None;
        self.pending_save = false;
        if self.phase == Phase::Uncertain || self.phase == Phase::Unsupported {
            self.phase = Phase::Idle;
        }
        self.manual_epoch = self.manual_epoch.wrapping_add(1);
        self.seen_revision = None;
    }

    fn masked(&self) -> bool {
        self.draft.is_empty()
            && !self.dirty
            && self
                .snapshot
                .as_ref()
                .and_then(|s| s.project.as_ref())
                .is_some_and(|p| p.empty_experimental)
    }

    fn saved_value(&self) -> &str {
        if self.masked() { "masked" } else { &self.draft }
    }

    fn selected_value(&self) -> &str {
        self.queued
            .as_ref()
            .map_or_else(|| self.saved_value(), |(value, _)| value.as_str())
    }

    fn locked(&self) -> bool {
        self.busy() || self.pending_save
    }

    fn disabled(&self, active: bool, has_target: bool) -> bool {
        !active
            || !has_target
            || matches!(self.phase, Phase::Uncertain | Phase::Unsupported)
            || self.error
            || self
                .snapshot
                .as_ref()
                .is_none_or(|s| s.capability.is_none() || s.project.is_none())
    }

    pub(super) fn choose(&mut self, value: String, active: bool, has_target: bool) {
        if self.disabled(active, has_target) || value == "masked" {
            return;
        }
        if !self.locked() && value == self.saved_value() {
            self.queued = None;
            return;
        }
        if self.locked() {
            let base = self
                .queued
                .as_ref()
                .map_or_else(|| self.draft.clone(), |(_, base)| base.clone());
            self.queued = Some((value, base));
            return;
        }
        self.draft = value;
        self.queued = None;
        self.dirty = true;
        self.saved = false;
        self.pending_save = true;
    }

    pub(super) fn poll(
        &mut self,
        target: Option<&Target>,
        active: bool,
        wake: &rune::Waker,
    ) -> bool {
        let mut changed = false;
        let Some(target) = target else {
            if self.phase == Phase::Saving {
                self.save_flight = None;
                self.phase = Phase::Uncertain;
                self.pending_save = false;
                self.queued = None;
                changed = true;
            }
            if self.scope.is_some() || self.read_flight.is_some() {
                self.scope = None;
                self.read_flight = None;
                self.snapshot = None;
                self.seen_revision = None;
                self.dirty = false;
                self.error = false;
                self.saved = false;
                self.phase = Phase::Idle;
                changed = true;
            }
            return changed;
        };

        let (backend, workspace, authority, _) = target.stats_source();
        let (_, session) = target.location();
        let scope = (
            backend.client_id.clone(),
            workspace.to_owned(),
            session.map(str::to_owned),
        );
        if self.scope.as_ref() != Some(&scope) {
            *self = Self {
                scope: Some(scope),
                authority,
                ..Self::default()
            };
            changed = true;
        } else if self.authority != authority {
            self.authority = authority;
            self.seen_revision = None;
            if self.phase == Phase::Saving {
                self.save_flight = None;
                self.pending_save = false;
                self.queued = None;
                self.phase = Phase::Uncertain;
            } else if self.phase == Phase::Reading {
                self.suspend();
            }
            changed = true;
        }

        if !target.online() {
            if self.phase == Phase::Saving {
                self.save_flight = None;
                self.phase = Phase::Uncertain;
                self.pending_save = false;
                self.queued = None;
                changed = true;
            }
            if self.read_flight.is_some() || self.seen_revision.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        }

        if let Some(result) = self
            .save_flight
            .as_ref()
            .and_then(|inbox| inbox.try_recv().ok())
        {
            self.save_flight = None;
            self.pending_save = false;
            match result {
                Ok(()) => {
                    self.dirty = false;
                    self.error = false;
                    self.saved = true;
                    self.phase = Phase::Ready;
                    self.seen_revision = None;
                }
                Err(SubagentDepthError::Unsupported) => {
                    self.dirty = false;
                    self.queued = None;
                    self.phase = Phase::Unsupported;
                }
                Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                    self.queued = None;
                    self.phase = Phase::Uncertain;
                }
            }
            changed = true;
        }

        if let Some(result) = self
            .read_flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.read_flight = None;
            match result {
                Ok(snapshot) => {
                    let fresh = snapshot
                        .project
                        .as_ref()
                        .and_then(|p| p.depth)
                        .map_or_else(String::new, |d| d.to_string());
                    let queued = self.queued.take().filter(|(_, base)| *base == fresh);
                    self.snapshot = Some(snapshot);
                    self.draft = fresh;
                    self.dirty = false;
                    self.error = false;
                    self.phase = Phase::Ready;
                    if let Some((next_value, _)) = queued
                        && next_value != self.saved_value()
                    {
                        self.draft = next_value;
                        self.dirty = true;
                        self.saved = false;
                        self.pending_save = true;
                    }
                }
                Err(SubagentDepthError::Unsupported) => {
                    self.queued = None;
                    self.error = false;
                    self.phase = Phase::Unsupported;
                }
                Err(SubagentDepthError::Conflict | SubagentDepthError::Failed) => {
                    self.queued = None;
                    self.error = true;
                    self.phase = Phase::Ready;
                }
            }
            changed = true;
        }

        if self.pending_save && self.save_flight.is_none() && self.read_flight.is_none() {
            self.pending_save = false;
            if let Some(snapshot) = &self.snapshot
                && let (Some(capability), Some(project)) = (&snapshot.capability, &snapshot.project)
            {
                let parsed = if self.draft.is_empty() {
                    Some(None)
                } else {
                    self.draft
                        .parse::<u64>()
                        .ok()
                        .filter(|&d| {
                            d >= capability.minimum && capability.maximum.is_none_or(|max| d <= max)
                        })
                        .map(Some)
                };
                if let Some(depth) = parsed {
                    let (out, inbox) = bounded(1);
                    let backend = backend.clone();
                    let workspace = workspace.to_owned();
                    let directory = snapshot.directory.clone();
                    let expectation = project.expectation.clone();
                    let wake = wake.clone();
                    self.phase = Phase::Saving;
                    self.error = false;
                    self.saved = false;
                    self.save_flight = Some(inbox);
                    platform::spawn(async move {
                        let result = set_subagent_depth(
                            &backend,
                            &workspace,
                            &directory,
                            depth,
                            &expectation,
                        )
                        .await;
                        if out.send(result).await.is_ok() {
                            wake();
                        }
                    });
                    changed = true;
                }
            }
        }

        if !active {
            if self.read_flight.is_some() {
                self.suspend();
                changed = true;
            }
            return changed;
        }

        let revision = target.revision().wrapping_add(self.manual_epoch);
        if self.read_flight.is_none()
            && self.save_flight.is_none()
            && self.seen_revision != Some(revision)
            && !self.dirty
            && !matches!(self.phase, Phase::Uncertain | Phase::Unsupported)
        {
            let (cancel, cancelled) = bounded(1);
            let (out, inbox) = bounded(1);
            let backend = backend.clone();
            let workspace = workspace.to_owned();
            let session = session.map(str::to_owned);
            let wake = wake.clone();
            self.seen_revision = Some(revision);
            self.phase = Phase::Reading;
            self.error = false;
            self.read_flight = Some((cancel, inbox));
            platform::spawn(async move {
                let task = async {
                    let directory =
                        resolve_workspace_directory(&backend, &workspace, session.as_deref())
                            .await?;
                    read_subagent_depth(&backend, &workspace, &directory).await
                };
                if let Some(result) = platform::reads::cancellable(&cancelled, task).await
                    && out.send(result).await.is_ok()
                {
                    wake();
                }
            });
            changed = true;
        }
        changed
    }

    fn details(&self) -> String {
        let mut lines = vec![
            t("missions.depth.hint").to_owned(),
            t("missions.depth.nesting.rule").to_owned(),
        ];
        let effective = self.snapshot.as_ref().and_then(|s| s.effective_depth);
        lines.push(match effective {
            None => t("missions.depth.unknown").to_owned(),
            Some(depth) => catalogue::format(
                locale(),
                "missions.depth.effective",
                &[("depth", &depth.to_string())],
            ),
        });
        if let Some(nesting) = self.snapshot.as_ref().and_then(|s| s.nesting.as_ref())
            && let Some(effective) = effective
        {
            let note = if effective < 2 {
                t("missions.depth.nesting.limited")
            } else if nesting.hidden {
                t("missions.depth.nesting.blocked")
            } else {
                match nesting.effect.as_str() {
                    "allow" => t("missions.depth.nesting.allowed"),
                    "ask" => t("missions.depth.nesting.ask"),
                    _ => t("missions.depth.nesting.generalDenied"),
                }
            };
            lines.push(note.to_owned());
        }
        if let Some(snapshot) = &self.snapshot {
            if let Some(project) = &snapshot.project {
                lines.push(format!(
                    "{}: \u{2066}{}\u{2069}",
                    t("missions.settings.projectTarget"),
                    project.path
                ));
            }
            let origin = snapshot
                .origin
                .as_deref()
                .map(|path| format!("\u{2066}{path}\u{2069}"))
                .unwrap_or_else(|| t("missions.settings.noOrigin").to_owned());
            lines.push(format!(
                "{} {origin}",
                t("missions.settings.effectiveOrigin")
            ));
        }
        lines.join("\n")
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn view<S: 'static>(
        &self,
        active: bool,
        has_target: bool,
        info_open: Option<InfoTip>,
        open_picker: Option<Picker>,
        layers: &mut Vec<El>,
        toggle_info: impl Fn(&mut S, InfoTip) + Copy + 'static,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
        choose: impl Fn(&mut S, String) + Copy + 'static,
        refresh: impl Fn(&mut S) + Copy + 'static,
    ) -> El {
        let disabled = self.disabled(active, has_target);
        let effective = self.snapshot.as_ref().and_then(|s| s.effective_depth);
        let inherit_label = if self
            .snapshot
            .as_ref()
            .and_then(|s| s.project.as_ref())
            .is_some_and(|p| p.depth.is_none())
            && !self.masked()
            && let Some(depth) = effective
        {
            catalogue::format(
                locale(),
                "missions.depth.inheritValue",
                &[("depth", &depth.to_string())],
            )
        } else {
            t("missions.depth.inherit").to_owned()
        };

        let mut labels = vec![inherit_label];
        let mut values = vec![String::new()];
        if self.masked() {
            let depth_text = effective.map_or_else(|| "?".to_owned(), |d| d.to_string());
            labels.push(catalogue::format(
                locale(),
                "missions.depth.masked",
                &[("depth", &depth_text)],
            ));
            values.push("masked".to_owned());
        }
        let max_choice = self
            .snapshot
            .as_ref()
            .and_then(|s| s.capability.as_ref())
            .and_then(|c| c.maximum)
            .map_or(10, |m| m.min(10));
        let mut choices = BTreeSet::new();
        for value in 1..=max_choice {
            choices.insert(value);
        }
        if let Ok(saved) = self.draft.parse::<u64>() {
            choices.insert(saved);
        }
        for value in choices {
            let text_val = value.to_string();
            labels.push(text_val.clone());
            values.push(text_val);
        }

        let selected = self.selected_value();
        let current_index = values.iter().position(|v| v == selected).unwrap_or(0);
        let refs: Vec<&str> = labels.iter().map(String::as_str).collect();
        let is_open = open_picker == Some(Picker::Depth) && !disabled && !self.locked();
        let labels_for_choose = labels.clone();
        let picker = chrome::picker("mission-subagent-depth", t("missions.depth.label"), &refs)
            .current(Some(refs[current_index]))
            .disabled(disabled || self.locked())
            .open(is_open)
            .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(Picker::Depth)))
            .on_close(move |s: &mut S| set_picker(s, None))
            .on_choose(move |s: &mut S, value, _| {
                set_picker(s, None);
                if let Some(pos) = labels_for_choose.iter().position(|label| label == value) {
                    choose(s, values[pos].clone());
                }
            });
        let picker = chrome::build_picker(picker, layers);

        let details = self.details();
        let info = chrome::info_tip(
            t("missions.depth.label"),
            &details,
            info_open == Some(InfoTip::Depth),
            move |s: &mut S| toggle_info(s, InfoTip::Depth),
        )
        .key("mission-depth-info");

        let mut card = col()
            .full_width()
            .separate(Space::Sm)
            .child(chrome::setting_row_with_info(
                t("missions.depth.label"),
                Some(info),
                picker,
            ));

        if self
            .snapshot
            .as_ref()
            .and_then(|s| s.project.as_ref())
            .is_some_and(|p| p.depth.is_some() && p.nesting_skipped)
        {
            card = card.child(
                text(t("missions.depth.nesting.skipped"))
                    .wrap()
                    .role("alert"),
            );
        }
        if self.phase == Phase::Unsupported
            || self
                .snapshot
                .as_ref()
                .is_some_and(|s| s.capability.is_none())
        {
            card = card.child(text(t("missions.depth.unsupported")).wrap().role("status"));
        }
        if self.error {
            card = card.child(text(t("missions.depth.error")).wrap().role("alert"));
        }
        if self.phase == Phase::Uncertain {
            card = card.child(text(t("missions.depth.uncertain")).wrap().role("alert"));
        }
        if self.phase == Phase::Saving {
            card = card.child(text(t("missions.depth.saving")).role("status"));
        } else if self.saved {
            card = card.child(text(t("missions.depth.saved")).role("status"));
        }
        if self.error || self.phase == Phase::Uncertain {
            card = card.child(
                layout::action_row().child(
                    layout::button(
                        t("missions.depth.refresh"),
                        !active || self.busy() || !has_target,
                        refresh,
                    )
                    .key("mission-depth-refresh"),
                ),
            );
        }

        chrome::card(card)
    }
}
