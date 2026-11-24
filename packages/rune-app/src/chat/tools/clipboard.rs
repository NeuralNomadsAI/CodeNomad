use super::{Tool, children::split_chain, error, output, task, todo};
use crate::{State, content::Part, screen, strings::t};
use rune::El;
use rune_theme_codenomad::markdown;

#[derive(Clone, Copy)]
pub(super) enum Section {
    Input,
    Output,
    Error,
}

pub(super) fn copy(s: &State, message: &str, card_key: &str, call: &str, section: Section) -> El {
    let (message, call) = (message.to_owned(), call.to_owned());
    let key = format!(
        "copy-{card_key}-{}",
        match section {
            Section::Input => "input",
            Section::Output => "output",
            Section::Error => "error",
        }
    );
    markdown::copy_button(
        t(if matches!(section, Section::Input) {
            "toolCall.io.copyInputAriaLabel"
        } else {
            "toolCall.io.copyOutputAriaLabel"
        }),
        screen::action_tx(&s.input_scope, move |s, tx| {
            let Some(tool) = lookup(s, &message, &call) else {
                return;
            };
            match section {
                Section::Input => {
                    if let Ok(source) = serde_json::to_string_pretty(&tool.input) {
                        tx.copy(source);
                    }
                }
                Section::Output => {
                    if task::is_task(tool) {
                        tx.copy(task::output(tool, task::report_body(s, &message, tool)));
                        return;
                    }
                    if tool.name == "todowrite"
                        && let Some(source) = todo::copy(tool)
                    {
                        tx.copy(source);
                        return;
                    }
                    let mut parts = [""; 4];
                    output(tool, &mut parts);
                    tx.copy(parts.concat());
                }
                Section::Error => tx.copy(error(tool)),
            }
        }),
    )
    .key(key)
}

fn lookup<'a>(s: &'a State, message: &str, call: &str) -> Option<&'a Tool> {
    if let Some((chain, id)) = message
        .strip_prefix("child:")
        .and_then(|v| v.split_once(':'))
    {
        let (parent, child) = split_chain(chain);
        return s
            .transcript_display
            .children
            .steps(parent, child)
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
