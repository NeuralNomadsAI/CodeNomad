use super::{Display, TOOL_LIMIT, Tool, string, window};
use crate::{
    State, screen,
    strings::{locale, t},
};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole, catalogue,
    layout::{self, Layout},
};

const MAX_ITEMS: usize = 32;

pub(super) fn title(tool: &Tool) -> &str {
    t(if tool.status == "completed" {
        "toolCall.question.title.questions"
    } else {
        "toolCall.question.title.askingQuestions"
    })
}

pub(super) fn view(s: &State, key: &str, tool: &Tool) -> Option<El> {
    if tool.status != "completed" {
        return None;
    }
    let mut items = Vec::new();
    for (i, question) in tool.input["questions"]
        .as_array()?
        .iter()
        .take(MAX_ITEMS)
        .enumerate()
    {
        let prompt = string(question, &["question", "header"]);
        if prompt.trim().is_empty() {
            continue;
        }
        let header = string(question, &["header"]);
        let options: Vec<_> = question["options"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|option| {
                let label = string(option, &["label"]);
                (!label.trim().is_empty()).then(|| (label, string(option, &["description"])))
            })
            .take(MAX_ITEMS)
            .collect();
        let selected = tool.metadata["answers"]
            .get(i)
            .and_then(|row| row.as_array())
            .filter(|row| row.iter().all(|label| label.is_string()));
        let is_selected =
            |label: &str| selected.is_some_and(|row| row.iter().any(|value| value == label));
        let remaining: Vec<_> = options
            .iter()
            .copied()
            .filter(|(label, _)| !is_selected(label))
            .collect();
        let mut item = col()
            .full_width()
            .separate(Space::Sm)
            .inset_surface()
            .pad(Space::Sm)
            .children(
                (!header.trim().is_empty() && header != prompt)
                    .then(|| line(header).text_role(TextRole::Label)),
            )
            .child(line(prompt))
            .child(text(t("question-receipt.answer")).text_role(TextRole::Label));
        let answers: Vec<_> = selected
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str())
            .filter(|label| !label.trim().is_empty())
            .take(MAX_ITEMS)
            .enumerate()
            .map(|(answer, label)| {
                let mut matches = options.iter().filter(|(option, _)| *option == label);
                let description = matches
                    .next()
                    .filter(|_| matches.next().is_none())
                    .map_or("", |v| v.1);
                col()
                    .full_width()
                    .role("listitem")
                    .child(window(
                        s,
                        format!("{key}-question-{i}-answer-{answer}"),
                        &[label],
                        TOOL_LIMIT,
                        |shown, _| answer_line(shown),
                    ))
                    .children((!description.trim().is_empty()).then(|| line(description)))
            })
            .collect();
        item = if answers.is_empty() {
            item.child(text(t(if selected.is_some() {
                "interruption.noAnswer"
            } else {
                "question-receipt.unavailable"
            })))
        } else {
            item.child(col().role("list").children(answers))
        };
        if !remaining.is_empty() {
            let choices = format!("{key}-question-{i}-choices");
            let open = s.transcript_display.toggled(&choices);
            let label = catalogue::format(
                locale(),
                if selected.is_some() {
                    "question-receipt.otherChoices"
                } else {
                    "question-receipt.offeredChoices"
                },
                &[("count", &remaining.len().to_string())],
            );
            item = item.child(
                layout::button(
                    &label,
                    false,
                    screen::action(&s.input_scope, {
                        let choices = choices.clone();
                        move |s| Display::toggle(s, &choices)
                    }),
                )
                .key(choices)
                .expanded(open),
            );
            if open {
                item = item.child(
                    col().role("list").children(
                        remaining
                            .into_iter()
                            .map(|(label, description)| choice(label, description)),
                    ),
                );
            }
        }
        items.push(item);
    }
    (!items.is_empty()).then(|| col().full_width().separate(Space::Sm).children(items))
}

fn choice(label: &str, description: &str) -> El {
    col()
        .full_width()
        .role("listitem")
        .child(line(label))
        .children((!description.trim().is_empty()).then(|| line(description)))
}

fn line(value: &str) -> El {
    answer_line(&value.chars().take(4096).collect::<String>())
}

fn answer_line(value: &str) -> El {
    text(value)
        .wrap_anywhere()
        .selectable(true)
        .content_direction()
}

#[cfg(test)]
#[test]
fn question_receipt_uses_native_answers_and_reveals_other_choices() {
    use crate::{Phase, history, init};
    use rune::{Env, Runtime};
    use serde_json::json;
    let row = history::decode_message(&json!({
        "id":"answer","type":"assistant","time":{"completed":1},"content":[{
          "type":"tool","name":"question","id":"ask","state":{
            "status":"completed","input":{"questions":[
              {"question":"Choose the route","options":[{"label":"Route A","description":"Primary route"},{"label":"Route B"}]},
              {"question":"Fallback?","options":[]}
            ]},"metadata":{"answers":[["Route A"]]}}}]
    })).unwrap();
    let mut state = init();
    state.phase = Phase::Ready;
    state.messages.push(row.into());
    let mut rt = Runtime::new(
        state,
        |s, cx| crate::strings::with_locale("en", || crate::view(s, cx)),
        (960.0, 900.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let mut click = |key: &str| {
        let (x, y) = rt.find(key).unwrap();
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        for _ in 0..12 {
            rt.frame(1.0 / 60.0);
        }
        rt.accessibility_json().to_string()
    };
    let tree = click("toggle-tool-answer:3:ask");
    assert!(tree.contains("Primary route") && tree.contains("Answer unavailable"));
    assert!(!tree.contains("Route B"));
    assert!(click("tool-answer:3:ask-question-0-choices").contains("Route B"));
}

#[cfg(test)]
#[test]
fn free_answer_keeps_whitespace_and_reveals_the_verbatim_tail() {
    use crate::history;
    use rune::{Env, Runtime};
    use serde_json::json;
    let answer = format!("  Première ligne 🦀\n  {}  FIN\r\n", "x".repeat(10_020));
    let row = history::decode_message(&json!({
        "id":"answer","type":"assistant","time":{"completed":1},"content":[{
          "type":"tool","name":"question","id":"ask","state":{
            "status":"completed","input":{"questions":[{"question":"Free answer?"}]},
            "metadata":{"answers":[[answer]]}}}]
    }))
    .unwrap();
    let mut s = crate::init();
    s.messages.push(row.into());
    let mut rt = Runtime::new(
        s,
        |s, _| {
            crate::strings::with_locale("en", || {
                let crate::content::Part::Tool(tool) = &s.messages[0].parts[0] else {
                    panic!("question tool")
                };
                view(s, "ask", tool).unwrap()
            })
        },
        (1600.0, 4000.0),
        Env::new(false, 1.0),
    );
    rt.frame(0.0);
    let before = rt.accessibility_json().to_string();
    assert!(before.contains("  Première ligne 🦀\\n  ") && !before.contains("  FIN"));
    let (x, y) = rt.find("reveal-ask-question-0-answer-0").unwrap();
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    for _ in 0..8 {
        rt.frame(0.02);
    }
    let after = rt.accessibility_json().to_string();
    assert!(after.contains(&serde_json::to_string(&answer).unwrap()));
}
