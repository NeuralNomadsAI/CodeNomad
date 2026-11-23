use super::{Gesture, Panel, Source, detail::read_window, lifecycle_view::Act};
use crate::{State, platform, strings::t};
use codenomad_client::{
    Receiver, bounded,
    history::Result,
    missions::{ControlPage, ControlPart, ControlReceipt},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, git_panel as theme,
    layout::{self, Layout},
};

#[derive(Default)]
pub(super) struct Fields {
    part: Option<ControlPart>,
    revision: u64,
    shown: Option<ControlPage>,
    flight: Option<Receiver<Result<ControlPage>>>,
    failed: Option<u64>,
}

impl Fields {
    pub fn cancel(&mut self) {
        *self = Self::default();
    }

    fn poll(&mut self, revision: Option<u64>) -> bool {
        if self.part.is_none() {
            return false;
        }
        if revision != Some(self.revision) {
            self.cancel();
            return true;
        }
        if let Some(result) = self.flight.as_ref().and_then(|inbox| inbox.try_recv().ok()) {
            self.flight = None;
            match result {
                Ok(page) => {
                    self.failed = None;
                    self.shown = Some(page);
                }
                Err(_) => {}
            }
            return true;
        }
        false
    }
}

impl Panel {
    pub(super) fn poll_control_fields(&mut self) -> bool {
        let revision = self
            .detail
            .snapshot
            .as_ref()
            .filter(|_| self.detail.authoritative())
            .map(|snapshot| snapshot.header.root.revision);
        // A busy refresh retains the display until the new header settles.
        if self.detail.busy() {
            return false;
        }
        self.control_fields.poll(revision)
    }

    pub(super) fn read_control_field(&mut self, part: ControlPart, offset: u64) {
        let Some(header) = self
            .detail
            .snapshot
            .as_ref()
            .filter(|_| self.detail.authoritative())
            .map(|snapshot| &snapshot.header)
        else {
            return;
        };
        let fields = &mut self.control_fields;
        if offset == 0 && fields.part == Some(part) && fields.failed.is_none() {
            fields.cancel();
            return;
        }
        if fields.part != Some(part) {
            fields.cancel();
        }
        let order = fields.shown.as_ref().map(|page| page.window.order.as_str());
        let Ok(read) = self
            .backend
            .mission_control_page(header, part, offset, order)
        else {
            return;
        };
        fields.part = Some(part);
        fields.revision = header.root.revision;
        fields.failed = Some(offset);
        let (out, inbox) = bounded(1);
        fields.flight = Some(inbox);
        let reads = self.reads.clone();
        let wake = self.wake.clone();
        platform::spawn(async move {
            let (_hold, cancel) = bounded(1);
            if let Some(Some(result)) =
                codenomad_client::runtime::until_closed(&out, read_window(read, &reads, &cancel))
                    .await
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }
}

pub(super) fn view(fields: &Fields, control: &ControlReceipt, source: &Source, act: Act) -> El {
    let button = |label: String, part, offset, key| {
        let source = source.clone();
        layout::button_tx(&label, false, move |state: &mut State, tx| {
            act(state, &source, Gesture::ReadField(part, offset));
            tx.instant();
        })
        .key(key)
    };
    let mut out = col()
        .full_width()
        .pad(Space::Xs)
        .role("region")
        .label(t("missionsPanel.pages.fields"))
        .child(text(t("missionsPanel.pages.fields")).role("heading"));
    for (part, name, count) in [
        (ControlPart::Receipts, "control.receipts", control.receipts),
        (ControlPart::Pending, "control.pending", control.pending),
    ] {
        out = out.child(
            button(format!("{name} ({count})"), part, 0, name).expanded(fields.part == Some(part)),
        );
    }
    if let Some(part) = fields.part {
        if let Some(page) = &fields.shown {
            out = out.child(
                text(format!(
                    "{}–{} / {}",
                    if page.rows.is_empty() {
                        0
                    } else {
                        page.window.offset + 1
                    },
                    page.window.end,
                    page.window.total
                ))
                .text_role(TextRole::Small)
                .role("status"),
            );
            for row in &page.rows {
                let label = if part == ControlPart::Receipts {
                    if row.known {
                        row.session.clone()
                    } else {
                        format!(
                            "{} · {}",
                            row.session,
                            t("missions.control.activity.state.unknown")
                        )
                    }
                } else {
                    row.session.clone()
                };
                out = out.child(text(label).text_role(TextRole::Small).wrap_anywhere());
            }
            if fields.flight.is_none()
                && fields.failed.is_none()
                && page.window.end < page.window.total
            {
                out = out.child(button(
                    t("missionsPanel.pages.more").into(),
                    part,
                    page.window.end,
                    "mission-control-fields-more",
                ));
            }
        }
        if fields.flight.is_some() {
            out = out.child(theme::note(t("missions.control.loading"), "status"));
        } else if let Some(offset) = fields.failed {
            out = out
                .child(theme::note(t("missionsPanel.pages.failed"), "alert"))
                .child(button(
                    t("missions.control.retry").into(),
                    part,
                    offset,
                    "mission-control-fields-retry",
                ));
        }
    }
    out
}
