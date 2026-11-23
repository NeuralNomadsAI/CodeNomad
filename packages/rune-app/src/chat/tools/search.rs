use crate::{State, screen, strings::t};
use rune::{El, col, text};
use rune_theme_codenomad::{
    Space, TextRole,
    layout::{self, Layout},
};

struct ResultCard<'a> {
    title: &'a str,
    url: String,
    host: String,
    published: Option<&'a str>,
    snippet: String,
}

fn parse(output: &str) -> Option<Vec<ResultCard<'_>>> {
    if output.encode_utf16().nth(super::TOOL_LIMIT).is_some() {
        return None;
    }
    let output = output.trim();
    if output == "No search results found. Please try a different query." {
        return Some(vec![]);
    }
    let mut results: Vec<ResultCard<'_>> = Vec::new();
    for line in output.lines() {
        if let Some(heading) = line.strip_prefix("## [") {
            let (title, raw) = heading.strip_suffix(')')?.rsplit_once("](")?;
            if !(raw.starts_with("http://") || raw.starts_with("https://"))
                || raw.chars().any(char::is_whitespace)
                || results.len() == 50
            {
                return None;
            }
            let (url, host) = codenomad_client::http::external_http_url(raw)?;
            results.push(ResultCard {
                title: if title.is_empty() { raw } else { title },
                url,
                host,
                published: None,
                snippet: String::new(),
            });
        } else {
            let last = results.last_mut()?;
            if last.snippet.is_empty()
                && last.published.is_none()
                && let Some(date) = line
                    .strip_prefix("Published: ")
                    .filter(|date| !date.is_empty() && !date.chars().any(char::is_whitespace))
            {
                last.published = Some(date);
            } else {
                last.snippet.push_str(line);
                last.snippet.push('\n');
            }
        }
    }
    (!results.is_empty()).then_some(results)
}

pub(super) fn view(s: &State, output: &str) -> Option<El> {
    let results = parse(output)?;
    if results.is_empty() {
        return Some(text(t("toolCall.websearch.empty")));
    }
    Some(
        col()
            .full_width()
            .role("list")
            .separate(Space::Sm)
            .children(results.into_iter().map(|result| {
                let label = if let Some(date) = result.published {
                    format!("{} · {date}", result.host)
                } else {
                    result.host
                };
                col()
                    .role("listitem")
                    .full_width()
                    .child(layout::button_tx(
                        result.title,
                        false,
                        screen::action_tx(&s.input_scope, move |_, tx| {
                            let _ = tx.open_url(&result.url);
                        }),
                    ))
                    .child(text(label).text_role(TextRole::Label))
                    .children(
                        (!result.snippet.trim().is_empty())
                            .then(|| text(result.snippet.trim()).wrap().selectable(true)),
                    )
            })),
    )
}

#[cfg(test)]
#[test]
fn websearch_rejects_unknown_envelopes_and_links_with_credentials() {
    assert!(parse("raw provider output").is_none());
    assert!(parse("## [Invalid](https://user:secret@example.com)").is_none());
    let results =
        parse("## [Heading](https://example.com/sample)\nPublished: 2026-11-23\nSnippet").unwrap();
    assert_eq!(results[0].host, "example.com");
    assert_eq!(results[0].published, Some("2026-11-23"));
}
