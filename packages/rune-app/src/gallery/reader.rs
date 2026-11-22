use crate::{Phase, State, backend::Backend, files::Ui, strings::t};
use base64::Engine;
use codenomad_client::{files::Preview, http::Http};
use rune::AppSpec;
use rune_theme_codenomad::layout;

fn locale() -> &'static str {
    let requested = std::env::var("RUNE_READER_LOCALE").unwrap_or_else(|_| "en".into());
    rune_theme_codenomad::catalogue::SUPPORTED_LOCALES
        .iter()
        .copied()
        .find(|locale| *locale == requested)
        .expect("explicit reader locale")
}
fn init() -> State {
    crate::strings::with_locale(locale(), init_scene)
}
fn init_scene() -> State {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("../../tests/fixtures/reader-content.json")).unwrap();
    let case = std::env::var("RUNE_READER_CASE").unwrap_or_else(|_| "source".into());
    let (name, bytes) = match case.as_str() {
        "error" => ("missing.rs", vec![]),
        name => {
            let name = if name == "source" { "reader.rs" } else { name };
            let entry = cases["images"]
                .as_array()
                .unwrap()
                .iter()
                .chain(cases["documents"].as_array().unwrap())
                .find(|entry| entry["name"] == name)
                .expect("explicit reader scene");
            (
                entry["name"].as_str().unwrap(),
                base64::engine::general_purpose::STANDARD
                    .decode(entry["base64"].as_str().unwrap())
                    .unwrap(),
            )
        }
    };
    let backend = Backend {
        client: Http::new().unwrap(),
        base: "http://127.0.0.1:9/".into(),
        workspace: "reader-gallery-scene".into(),
        session: "synthetic".into(),
        client_id: "reader-scene".into(),
        fresh_mode: false,
    };
    let mut state = crate::init();
    let mut files = Ui::new(
        backend,
        "/synthetic".into(),
        state.reads.clone(),
        state.wake.clone(),
    );
    files.open(name.into());
    files.reader.scene(if case == "error" {
        Err(std::io::Error::other("Synthetic read failure").into())
    } else {
        Ok(Preview {
            workspace_id: "reader-gallery-scene".into(),
            path: name.into(),
            bytes,
            version: Some("scene-v1".into()),
        })
    });
    files.document.online(true);
    files.poll(0.0);
    files.document.online(false);
    state.files = Some(files);
    state.phase = Phase::Ready;
    state.draft = rune::TextEdit::new("Synthetic draft");
    state.messages = crate::transport::synthetic();
    state
}
fn view(state: &State, cx: &mut rune::Cx<State>) -> rune::El {
    crate::strings::with_locale(locale(), || crate::view(state, cx))
}
pub fn run() {
    let args: Vec<_> = std::env::args().collect();
    if !args.iter().any(|arg| arg == "--tree") || !args.iter().any(|arg| arg == "--snap") {
        eprintln!("Reader qualification requires offscreen --tree and --snap");
        std::process::exit(2);
    }
    rune::run(AppSpec {
        poll: Some(|state: &mut State, _, _| {
            state.files.as_mut().is_some_and(|files| files.poll(0.0))
        }),
        ..layout::app_spec(t("window.title.main"), init, view)
    });
}
