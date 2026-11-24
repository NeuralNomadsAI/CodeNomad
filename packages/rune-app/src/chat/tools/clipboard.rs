use super::{
    Tool, apply_patch,
    children::{Children, CopyKey, ReportCopyKey},
    error, output, task, todo,
};
use crate::{State, content::Part, screen, strings::t};
use rune::El;
use rune_theme_codenomad::markdown;

#[derive(Clone, Copy)]
pub(super) enum Section {
    Input,
    Output,
    Error,
}

pub(super) fn copy(
    s: &State,
    message: &str,
    card_key: &str,
    call: &str,
    section: Section,
    ancestors: &[&str],
) -> El {
    let (message, call) = (message.to_owned(), call.to_owned());
    let ancestors_owned: Vec<String> = ancestors.iter().map(|&a| a.to_owned()).collect();
    let key = format!(
        "copy-{card_key}-{}",
        match section {
            Section::Input => "input",
            Section::Output => "output",
            Section::Error => "error",
        }
    );
    let copy_key = key.clone();
    markdown::copy_button(
        t(if matches!(section, Section::Input) {
            "toolCall.io.copyInputAriaLabel"
        } else {
            "toolCall.io.copyOutputAriaLabel"
        }),
        screen::action_tx(&s.input_scope, move |s, tx| {
            let anc_refs: Vec<&str> = ancestors_owned.iter().map(String::as_str).collect();
            let owner_parent = anc_refs.len().checked_sub(2).map(|i| anc_refs[i]);
            let async_report = {
                let Some(tool) = lookup(s, &message, owner_parent, &call) else {
                    return;
                };
                match section {
                    Section::Input => {
                        if let Some(source) =
                            super::format::bounded_json(&tool.input, 8 * 1024 * 1024)
                        {
                            tx.copy(source);
                        }
                        None
                    }
                    Section::Output => {
                        if task::is_task(tool) {
                            let delivery = task::delivery(s, &message, tool, &anc_refs);
                            if let Some(d) = delivery.as_ref().filter(|d| d.report_truncated)
                                && let Some(parent) = task::parent_child(&message)
                                && let Some((row_id, part_idx)) = d.report_location
                            {
                                Some(ReportCopyKey {
                                    key: copy_key.clone(),
                                    parent: parent.to_owned(),
                                    row_id: row_id.to_owned(),
                                    part_index: part_idx,
                                    child: task::child(tool).to_owned(),
                                })
                            } else {
                                tx.copy(task::output(
                                    tool,
                                    delivery.as_ref().and_then(|d| d.report),
                                ));
                                None
                            }
                        } else if let Some(value) = super::format::structured_output(tool) {
                            if let super::format::Formatted::Text(source, _) =
                                super::format::format_unknown(value, Some(8 * 1024 * 1024))
                            {
                                tx.copy(source);
                            }
                            None
                        } else if tool.name == "todowrite"
                            && let Some(source) = todo::copy(tool)
                        {
                            tx.copy(source);
                            None
                        } else if tool.name == "apply_patch"
                            && let Some(source) = apply_patch::copy_all(tool)
                        {
                            tx.copy(source);
                            None
                        } else {
                            let mut parts = [""; 4];
                            output(tool, &mut parts);
                            tx.copy(parts.concat());
                            None
                        }
                    }
                    Section::Error => {
                        tx.copy(error(tool));
                        None
                    }
                }
            };
            if let Some(report_key) = async_report {
                let target = CopyKey::Report(report_key.clone());
                if let Some(ready) = s.transcript_display.children.take_ready_copy(&target) {
                    tx.copy(ready);
                } else {
                    Children::copy_report(s, report_key);
                }
            } else {
                s.transcript_display.children.cancel_copy();
            }
        }),
    )
    .key(key)
}

fn lookup<'a>(
    s: &'a State,
    message: &str,
    owner_parent: Option<&str>,
    call: &str,
) -> Option<&'a Tool> {
    if let Some((child, id)) = message
        .strip_prefix("child:")
        .and_then(|v| v.split_once(':'))
    {
        return s
            .transcript_display
            .children
            .steps(owner_parent, child)
            .iter()
            .find(|(row, tool)| row == id && tool.id == call)
            .map(|(_, tool)| tool.as_ref());
    }
    s.messages
        .iter()
        .find(|m| m.id == message)?
        .parts
        .iter()
        .find_map(|part| match part {
            Part::Tool(tool) if tool.id == call => Some(tool.as_ref()),
            _ => None,
        })
}
