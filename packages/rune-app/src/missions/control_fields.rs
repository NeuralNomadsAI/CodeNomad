use super::{
    Gesture, Panel, Source,
    detail::{CancelToken, read_window},
};
use crate::{
    platform,
    strings::{locale, t},
};
use codenomad_client::{
    Receiver, bounded,
    history::Result,
    missions::{ControlPage, ControlPart, ControlReceipt},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    git_panel::{self as theme, ButtonLook::Flat},
    layout::{self, Layout},
    markdown, shell,
};

#[derive(Default)]
pub(super) struct Fields {
    part: Option<ControlPart>,
    revision: u64,
    shown: Option<ControlPage>,
    flight: Option<(CancelToken, Receiver<Result<ControlPage>>)>,
    failed: Option<u64>,
    receipt: Option<ReceiptView>,
}

const RECEIPT_BYTES: usize = 12 * 1024;

struct ReceiptView {
    id: String,
    starts: Vec<usize>,
    page: usize,
}

impl ReceiptView {
    fn new(id: String, source: &str) -> Self {
        let mut starts = vec![0];
        while let Some(&last) = starts.last() {
            if source.len() - last <= RECEIPT_BYTES {
                break;
            }
            let mut next = last + RECEIPT_BYTES;
            while !source.is_char_boundary(next) {
                next -= 1;
            }
            starts.push(next);
        }
        Self {
            id,
            starts,
            page: 0,
        }
    }

    fn text<'a>(&self, source: &'a str) -> &'a str {
        source
            .get(
                self.starts[self.page]
                    ..self
                        .starts
                        .get(self.page + 1)
                        .copied()
                        .unwrap_or(source.len()),
            )
            .unwrap_or_default()
    }
}

impl Fields {
    pub fn mark_cancel(&self) {
        if let Some((cancel, _)) = &self.flight {
            cancel.mark_aborted();
        }
    }

    pub fn cancel(&mut self) {
        *self = Self::default();
    }

    pub fn show_receipt(&mut self, id: String, page: Option<usize>) {
        if self.flight.is_some() {
            return;
        }
        let Some(receipt) = self.shown.as_ref().and_then(|shown| {
            shown
                .rows
                .iter()
                .filter_map(|row| row.receipt.as_ref())
                .find(|row| row.id == id)
        }) else {
            return;
        };
        match (self.receipt.as_mut().filter(|open| open.id == id), page) {
            (Some(open), Some(page)) if page < open.starts.len() => open.page = page,
            (Some(_), None) => self.receipt = None,
            (None, None) => self.receipt = Some(ReceiptView::new(id, &receipt.json)),
            _ => {}
        }
    }

    fn poll(&mut self, revision: Option<u64>) -> bool {
        if self.part.is_none() {
            return false;
        }
        if revision != Some(self.revision) {
            self.cancel();
            return true;
        }
        if let Some(result) = self
            .flight
            .as_ref()
            .and_then(|(_, inbox)| inbox.try_recv().ok())
        {
            self.flight = None;
            match result {
                Ok(page) => {
                    self.failed = None;
                    self.shown = Some(page);
                    self.receipt = None;
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
        let (cancel, signal) = CancelToken::new();
        fields.flight = Some((cancel, inbox));
        let reads = self.reads.clone();
        let wake = self.wake.clone();
        platform::spawn(async move {
            if let Some(result) = read_window(read, &reads, &signal).await
                && !signal.is_cancelled()
                && out.send(result).await.is_ok()
            {
                wake();
            }
        });
    }
}

pub(super) fn view<S: 'static>(
    fields: &Fields,
    control: &ControlReceipt,
    ready: bool,
    source: &Source,
    act: fn(&mut S, &Source, Gesture),
) -> El {
    let button = |label: String, part, offset, key| {
        let source = source.clone();
        theme::button(label, Flat, !ready, move |state: &mut S, tx| {
            act(state, &source, Gesture::ReadField(part, offset));
            tx.instant();
        })
        .key(key)
    };
    let mut toggles = layout::action_row();
    for (part, name, count) in [
        (ControlPart::Receipts, "control.receipts", control.receipts),
        (ControlPart::Pending, "control.pending", control.pending),
    ] {
        toggles = toggles.child(
            button(format!("{name} ({count})"), part, 0, name).expanded(fields.part == Some(part)),
        );
    }
    let mut out = col()
        .full_width()
        .pad(Space::Xs)
        .separate(Space::Xs)
        .role("region")
        .label(t("missionsPanel.pages.fields"))
        .child(shell::panel_title(t("missionsPanel.pages.fields")).role("heading"))
        .child(toggles);
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
                if let Some(receipt) = &row.receipt {
                    let id = &receipt.id;
                    let open = fields.receipt.as_ref().filter(|open| &open.id == id);
                    let detail =
                        |label: &str, disabled: bool, keep_focus: bool, page, key: String| {
                            let (source, id, revision) =
                                (source.clone(), id.clone(), fields.revision);
                            if disabled && keep_focus {
                                layout::focusable_disabled_button(label).key(key)
                            } else {
                                layout::button_tx(label, disabled, move |state: &mut S, tx| {
                                    act(
                                        state,
                                        &source,
                                        Gesture::ReceiptDetails(id.clone(), revision, page),
                                    );
                                    tx.instant();
                                })
                                .key(key)
                            }
                        };
                    let busy = !ready || fields.flight.is_some();
                    out = out.child(
                        detail(&label, busy, false, None, format!("receipt-{id}"))
                            .expanded(open.is_some()),
                    );
                    if let Some(open) = open {
                        out = out.child(
                            markdown::code(open.text(&receipt.json), "json", false, true)
                                .key(format!("receipt-body-{id}")),
                        );
                        if open.starts.len() > 1 {
                            let status = catalogue::format(
                                locale(),
                                "missionsPanel.pages.rawPage",
                                &[
                                    ("page", &(open.page + 1).to_string()),
                                    ("total", &open.starts.len().to_string()),
                                ],
                            );
                            out = out
                                .child(text(status).text_role(TextRole::Small).role("status"))
                                .child(
                                    layout::action_row()
                                        .child(detail(
                                            t("missionsPanel.pages.previous"),
                                            busy || open.page == 0,
                                            true,
                                            Some(open.page.saturating_sub(1)),
                                            format!("receipt-prev-{id}"),
                                        ))
                                        .child(detail(
                                            t("missionsPanel.pages.next"),
                                            busy || open.page + 1 >= open.starts.len(),
                                            true,
                                            Some(open.page + 1),
                                            format!("receipt-next-{id}"),
                                        )),
                                );
                        }
                    }
                } else {
                    out = out.child(text(label).text_role(TextRole::Small).wrap_anywhere());
                }
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

#[cfg(test)]
mod tests;
