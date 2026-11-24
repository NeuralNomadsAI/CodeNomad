use super::*;
use std::sync::{Mutex, Weak};

const MAX_LOCATIONS: usize = 32;
const MAX_PAGE: usize = 1024;
const COUNTS: [&str; 5] = ["scanned", "candidates", "judged", "skipped", "prefilterBypassed"];
const MAX_SAFE: u64 = (1 << 53) - 1;

struct Connection {
    endpoint: Weak<Endpoint>,
    generation: uuid::Uuid,
    unsupported: bool,
}

fn connection(endpoint: &Arc<Endpoint>, unsupported: bool) -> (uuid::Uuid, bool) {
    static LAST: Mutex<Option<Connection>> = Mutex::new(None);
    let mut last = LAST.lock().unwrap();
    let endpoint = Arc::downgrade(endpoint);
    if last.as_ref().is_none_or(|last| !last.endpoint.ptr_eq(&endpoint)) {
        *last = Some(Connection { endpoint, generation: uuid::Uuid::new_v4(), unsupported: false });
    }
    let last = last.as_mut().unwrap();
    last.unsupported |= unsupported;
    (last.generation, last.unsupported)
}

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Continuation {
    examined: u64,
    pages: Vec<Page>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Page {
    index: usize,
    page: String,
}

pub(super) fn valid_dates(since: Option<&Value>, until: Option<&Value>) -> bool {
    fn date(input: &Value) -> Option<chrono::NaiveDate> {
        let input = input.as_str()?;
        let date = chrono::NaiveDate::parse_from_str(input, "%Y-%m-%d").ok()?;
        (input.len() == 10 && date.format("%Y-%m-%d").to_string() == input).then_some(date)
    }
    match (since.map(date), until.map(date)) {
        (Some(None), _) | (_, Some(None)) => false,
        (Some(Some(since)), Some(Some(until))) => since <= until,
        _ => true,
    }
}

pub(super) async fn run(scope: &Scope<'_>, mut input: Value, token: Option<&str>) -> Result<Response, Error> {
    let Some(root) = scope.workspace.location["directory"].as_str() else { return Ok(blocked()) };
    let root = scope.own(root).await;
    if !scope.current() {
        return Ok(blocked());
    }
    let root = root.ok_or_else(location_denied)?;
    let (generation, unsupported) = connection(&scope.endpoint, false);
    if unsupported {
        return Ok(status("unsupported"));
    }
    let Some(directories) = scope.directories().await else { return Ok(blocked()) };
    let selected = &directories[..directories.len().min(MAX_LOCATIONS)];
    let binding =
        cursor::digest(&json!([scope.workspace.id, scope.workspace.location, directories, generation, input]));
    let prior: Continuation = if let Some(token) = token {
        let invalid = || error(Status::BAD_REQUEST, "Invalid ranked history cursor");
        let prior: Continuation = cursor::open(&binding, token).ok_or_else(invalid)?;
        if prior.examined > MAX_SAFE
            || prior.pages.is_empty()
            || prior.pages.len() > selected.len()
            || prior.pages.iter().any(|page| page.index >= selected.len() || !valid_page(&page.page))
            || prior.pages.iter().map(|page| page.index).collect::<HashSet<_>>().len() != prior.pages.len()
        {
            return Err(invalid());
        }
        prior
    } else {
        Continuation::default()
    };
    let Some(limit) = input["limit"].as_u64() else { return Ok(blocked()) };
    input["limit"] = json!(40);
    let mut capped = selected.len() < directories.len();
    let mut fences = Vec::with_capacity(selected.len());
    let mut exclusions = Vec::new();
    let mut pages = Vec::new();
    let mut sessions = Vec::new();
    let mut hits = Vec::new();
    let mut seen = HashSet::new();
    for (index, directory) in selected.iter().enumerate() {
        let mut request = input.clone();
        if token.is_some() {
            let Some(page) = prior.pages.iter().find(|page| page.index == index) else { continue };
            request["cursor"] = json!(page.page);
        }
        let owned = scope.own(directory).await;
        if !scope.current() {
            return Ok(blocked());
        }
        let owned = owned.ok_or_else(location_denied)?;
        match scope.verify_native_location(&owned.directory, true).await {
            Ok(()) => {}
            Err(Some(err)) => return Err(err),
            Err(None) => return Ok(blocked()),
        }
        let output = match scope.call(&owned, "historyRanked", &request, None).await {
            Some(Call::Result(output)) => output,
            Some(Call::Unsupported) if token.is_some() => return Ok(status("restart_required")),
            Some(Call::Unsupported) => {
                connection(&scope.endpoint, true);
                return Ok(status("unsupported"));
            }
            None => return Ok(blocked()),
        };
        fences.push(owned);
        if output["status"] != "ranked" {
            return Ok(Json(output).into_response());
        }
        let owners = list(&output["sessions"]);
        let found = list(&output["hits"]);
        if !valid_counts(&output, owners, found) {
            return Ok(blocked());
        }
        if let Some(page) = output["cursor"].as_str() {
            if !valid_page(page) {
                return Ok(blocked());
            }
            pages.push(Page { index, page: page.into() });
        }
        let Some(approved) = scope.filter(owners, None).await else { return Ok(blocked()) };
        if owners.len() != approved.len() {
            add_exclusion(&mut exclusions, "foreign_directory");
        }
        let ids: HashSet<_> = approved.iter().filter_map(|owner| owner["sessionID"].as_str()).collect();
        for (rank, hit) in found.iter().enumerate() {
            if hit["sessionID"].as_str().is_some_and(|id| ids.contains(id)) {
                hits.push((rank, index, hit.clone()));
            }
        }
        for owner in approved {
            if !seen.insert(owner["sessionID"].clone()) {
                return Ok(blocked());
            }
            sessions.push(owner.clone());
        }
        for reason in list(&output["exclusions"]).iter().filter_map(Value::as_str) {
            add_exclusion(&mut exclusions, reason);
        }
        capped |= output["capped"] == true;
    }
    let Some(approved) = scope.filter(&sessions, None).await else { return Ok(blocked()) };
    if approved.len() != sessions.len() {
        add_exclusion(&mut exclusions, "foreign_directory");
    }
    if !scope.owned_current(&root).await {
        return Ok(blocked());
    }
    for fence in &fences {
        if !scope.owned_current(fence).await {
            return Ok(blocked());
        }
    }
    let ids: HashSet<_> = approved.iter().filter_map(|owner| owner["sessionID"].as_str()).collect();
    hits.sort_by_key(|&(rank, index, _)| (rank, index));
    let mut displayed = HashSet::new();
    let (first, rest): (Vec<_>, Vec<_>) = hits
        .into_iter()
        .map(|(_, _, hit)| hit)
        .filter(|hit| hit["sessionID"].as_str().is_some_and(|id| ids.contains(id)))
        .partition(|hit| displayed.insert(hit["sessionID"].clone()));
    let mut output = json!({ "version":1, "status":"ranked", "capped":capped, "exclusions":exclusions,
        "matchedSessions":approved.iter().filter(|owner| positive(owner, "matchedMessages")).count(),
        "examinedBefore":prior.examined, "cursor":null, "hits":first.into_iter().chain(rest).take(limit as usize).collect::<Vec<_>>() });
    for key in COUNTS {
        let Some(count) = sum(&approved, key).filter(|&count| count <= MAX_SAFE) else { return Ok(blocked()) };
        output[key] = json!(count);
    }
    if !pages.is_empty() {
        let examined = prior.examined + output["scanned"].as_u64().unwrap();
        let Some(token) =
            cursor::seal(&binding, &Continuation { examined, pages }).filter(|token| token.len() <= 32768)
        else {
            return Ok(blocked());
        };
        if examined > MAX_SAFE {
            return Ok(blocked());
        }
        output["cursor"] = json!(token);
    }
    Ok(Json(output).into_response())
}

fn status(value: &str) -> Response {
    Json(json!({"status":value})).into_response()
}
fn valid_page(page: &str) -> bool {
    !page.is_empty() && page.encode_utf16().count() <= MAX_PAGE
}
fn positive(owner: &Value, key: &str) -> bool {
    owner[key].as_u64().is_some_and(|value| value > 0)
}
fn add_exclusion(exclusions: &mut Vec<String>, reason: &str) {
    if !exclusions.iter().any(|value| value == reason) {
        exclusions.push(reason.into());
    }
}

fn valid_counts(output: &Value, owners: &[Value], hits: &[Value]) -> bool {
    let mut by_id = BTreeMap::new();
    for owner in owners {
        let [Some(matched), Some(judged), Some(candidates), Some(scanned)] =
            ["matchedMessages", "judged", "candidates", "scanned"].map(|key| owner[key].as_u64())
        else {
            return false;
        };
        if matched > judged || judged > candidates || candidates > scanned {
            return false;
        }
        if by_id.insert(owner["sessionID"].as_str(), matched).is_some() {
            return false;
        }
    }
    let matched_sessions = by_id.values().filter(|&&count| count > 0).count() as u64;
    if output["matchedSessions"].as_u64() != Some(matched_sessions) {
        return false;
    }
    let owners: Vec<_> = owners.iter().collect();
    if COUNTS.iter().any(|key| output[*key].as_u64() != sum(&owners, key)) {
        return false;
    }
    let mut messages = HashSet::new();
    for hit in hits {
        let id = hit["sessionID"].as_str();
        let Some(left) = by_id.get_mut(&id) else { return false };
        if *left == 0 || !messages.insert((id, hit["messageID"].as_str())) {
            return false;
        }
        *left -= 1;
    }
    true
}
