use crate::{
    State,
    content::Part,
    history::Result,
    platform,
    strings::{locale, t},
};
use codenomad_client::{Receiver, Sender, bounded, search::Hit};
use rune_theme_codenomad::catalogue;

#[derive(Default)]
pub(super) struct Preview {
    pub(super) body: Option<Body>,
    pub(super) failed: bool,
    flight: Option<(Sender<()>, Receiver<Result<Body>>)>,
}

pub(super) struct Body {
    pub(super) title: String,
    pub(super) slug: String,
    pub(super) created: Option<u64>,
    pub(super) blocks: Vec<String>,
}

impl Preview {
    pub(super) fn pending(&self) -> bool {
        self.flight.is_some()
    }
}

pub(super) fn age(at: u64, now: u64) -> String {
    let minutes = now.saturating_sub(at) / 60_000;
    let (key, count) = match minutes {
        0 => return t("time.relative.justNow").into(),
        1..=59 => ("time.relative.minutesAgoShort", minutes),
        60..=1439 => ("time.relative.hoursAgoShort", minutes / 60),
        _ => ("time.relative.daysAgoShort", minutes / 1440),
    };
    catalogue::format(locale(), key, &[("count", &count.to_string())])
}

pub(super) fn blocks<'a>(hit: &'a Hit, body: &'a [String]) -> impl Iterator<Item = &'a str> {
    std::iter::once(hit.excerpt.as_str()).chain(
        body.iter()
            .map(String::as_str)
            .filter(|text| *text != hit.excerpt),
    )
}

pub(super) fn start(s: &mut State, hit: Hit, tx: &mut rune::Tx) {
    let Some(backend) = s.transcript_display.timeline.backend.clone() else {
        return;
    };
    let Some(project) = s.screen.launcher().and_then(|l| l.project.clone()) else {
        return;
    };
    let reads = s.reads.clone();
    let wake = s.wake.clone();
    let (cancel, cancelled) = bounded(1);
    let (out, inbox) = bounded(1);
    super::state(s).preview = Preview {
        flight: Some((cancel, inbox)),
        ..Default::default()
    };
    rune_theme_codenomad::timeline::search::announce(
        tx,
        t("messageSection.search.searching").to_owned(),
    );
    platform::spawn(async move {
        let Some(_permit) = reads.preview(&cancelled).await else {
            return;
        };
        let request = async {
            let (backend, session, slug) = backend
                .bind_session_placed(&project, &hit.session, false)
                .await?;
            let entry = backend.history_search_preview(&hit.message).await?;
            let row = entry.row;
            let mut left = 4096;
            let mut blocks = Vec::new();
            let mut add = |text: &str| {
                if left == 0 || text.is_empty() || blocks.len() == 32 {
                    return;
                }
                let cut = text.floor_char_boundary(text.len().min(left));
                if cut == 0 {
                    return;
                }
                left -= cut;
                blocks.push(text[..cut].to_owned());
            };
            if row.role != "assistant" || row.parts.is_empty() {
                add(&row.body);
            }
            for part in &row.parts {
                match part {
                    Part::Text(text) => add(&text.text),
                    Part::Reasoning(part) => add(&part.text),
                    Part::Tool(tool) => {
                        add(&tool.name);
                        add(&tool.output);
                        add(&tool.error);
                    }
                    _ => {}
                }
            }
            Ok(Body {
                title: session.title,
                slug,
                created: entry.created,
                blocks,
            })
        };
        if let Some(result) = platform::reads::cancellable(&cancelled, request).await
            && out.send(result).await.is_ok()
        {
            wake();
        }
    });
}

pub(super) fn poll(s: &mut State) -> bool {
    let preview = &mut super::state(s).preview;
    let Some(result) = preview
        .flight
        .as_ref()
        .and_then(|(_, inbox)| inbox.try_recv().ok())
    else {
        return false;
    };
    preview.flight = None;
    match result {
        Ok(body) => preview.body = Some(body),
        Err(_) => preview.failed = true,
    }
    true
}
