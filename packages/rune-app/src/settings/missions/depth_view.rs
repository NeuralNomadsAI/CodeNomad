//! View rendering for the Location-scoped Subagent depth editor.
use super::{
    InfoTip, Picker,
    depth::{Phase, State},
};
use crate::strings::{locale, t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, catalogue,
    layout::{self, Layout},
    settings as chrome,
};
use std::collections::BTreeSet;

impl State {
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
        pinned_directory: Option<&str>,
        info_open: Option<InfoTip>,
        open_picker: Option<Picker>,
        layers: &mut Vec<El>,
        toggle_info: impl Fn(&mut S, InfoTip) + Copy + 'static,
        set_picker: impl Fn(&mut S, Option<Picker>) + Copy + 'static,
        choose: impl Fn(&mut S, String) + Clone + 'static,
        refresh: impl Fn(&mut S) + Clone + 'static,
    ) -> El {
        let disabled = self.disabled(active, has_target, pinned_directory);
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
        let min_choice = self
            .snapshot
            .as_ref()
            .and_then(|s| s.capability.as_ref())
            .map_or(1, |c| c.minimum.max(1));
        let max_choice = self
            .snapshot
            .as_ref()
            .and_then(|s| s.capability.as_ref())
            .and_then(|c| c.maximum)
            .map_or(10, |m| m.min(10));
        let mut choices = BTreeSet::new();
        for value in min_choice..=max_choice {
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
        // Keep the picker focusable while Reading/Saving so the user can step or queue the next choice,
        // while announcing busy state during in-flight work.
        let locked = self.locked();
        let is_open = open_picker == Some(Picker::Depth) && !disabled;
        let labels_for_choose = labels.clone();
        let picker =
            chrome::stepping_picker("mission-subagent-depth", t("missions.depth.label"), &refs)
                .current(Some(refs[current_index]))
                .disabled(disabled)
                .open(is_open)
                .on_toggle(move |s: &mut S| set_picker(s, (!is_open).then_some(Picker::Depth)))
                .on_close(move |s: &mut S| set_picker(s, None))
                .on_choose(move |s: &mut S, value, _| {
                    set_picker(s, None);
                    if let Some(pos) = labels_for_choose.iter().position(|label| label == value) {
                        choose(s, values[pos].clone());
                    }
                });
        let picker = chrome::build_picker(picker, layers).busy(locked);

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
