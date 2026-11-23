use super::*;

pub(in crate::chat) fn for_message(s: &State, message: &str) -> Option<El> {
    view(s, Some(message.into()))
}

pub(in crate::chat) fn session(s: &State) -> Option<El> {
    view(s, None)
}

fn view(s: &State, key: Option<String>) -> Option<El> {
    let entry = s.transcript_display.receipts.entries.get(&key)?;
    if entry.receipt.is_empty() && entry.next.is_none() && !entry.failed {
        return None;
    }
    let mut group = col()
        .full_width()
        .separate(Space::Sm)
        .role("region")
        .label(t("permissionReceipts.title"));
    let mut list = col().full_width().separate(Space::Sm).role("list");
    for receipt in &entry.receipt {
        list = list.child(row(receipt));
    }
    if entry.next.is_some() {
        list = list.child(action(s, key.clone(), true, entry.job.is_some()));
    }
    if let Some(message) = &key {
        group = group.key(format!("receipts-{message}")).child(list);
    } else {
        const KEY: &str = "session-permission-receipts";
        let name = catalogue::format(
            locale(),
            "permissionReceipts.session",
            &[("count", &entry.receipt.len().to_string())],
        );
        let expanded = s.transcript_display.toggled(KEY);
        group = group
            .child(
                layout::button(
                    &name,
                    false,
                    screen::action(&s.input_scope, |s| {
                        super::super::actions::Display::toggle(s, KEY)
                    }),
                )
                .key(KEY)
                .expanded(expanded),
            )
            .children(expanded.then_some(list));
    }
    if entry.failed {
        group = group.child(
            layout::action_row()
                .child(text(t("permissionReceipts.error")).role("status"))
                .child(action(s, key, false, entry.job.is_some())),
        );
    }
    Some(group)
}

fn action(s: &State, key: Option<String>, more: bool, disabled: bool) -> El {
    let label = t(if more {
        "permissionReceipts.more"
    } else {
        "permissionReceipts.retry"
    });
    layout::button(
        label,
        disabled,
        screen::action(&s.input_scope, move |s| {
            let receipts = &mut s.transcript_display.receipts;
            let more = more
                || receipts
                    .entries
                    .get(&key)
                    .is_some_and(|entry| entry.failed && entry.retry_more && !entry.dirty);
            receipts.start(&key, more, &s.reads, &s.wake);
        }),
    )
    .key(if more {
        "permission-receipts-more"
    } else {
        "permission-receipts-retry"
    })
}

fn row(receipt: &Receipt) -> El {
    let decision = t(match receipt.decision {
        Decision::Once => "permissionReceipts.once",
        Decision::Always => "permissionReceipts.always",
        Decision::Reject => "permissionReceipts.reject",
    });
    let origin = t(match receipt.origin {
        Origin::Codenomad => "permissionReceipts.origin.codenomad",
        Origin::Yolo => "permissionReceipts.origin.automatic",
        Origin::Native => "permissionReceipts.origin.native",
    });
    let body = |text_value: &str| {
        text(text_value)
            .wrap_anywhere()
            .selectable(true)
            .content_direction()
    };
    col()
        .key(&receipt.request_id)
        .full_width()
        .role("listitem")
        .inset_surface()
        .pad(Space::Sm)
        .separate(Space::Xs)
        .child(
            layout::action_row()
                .child(text(decision).text_role(TextRole::Button))
                .child(text(origin).text_role(TextRole::Label)),
        )
        .children(receipt.action.as_deref().map(body))
        .children(receipt.resources.iter().map(|resource| body(resource)))
        .children(receipt.request_message.as_deref().map(body))
        .children(receipt.reason.as_deref().map(body))
}
