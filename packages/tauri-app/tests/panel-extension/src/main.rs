#[tauri::command]
fn probe(role: String) { println!("NATIVE:{role}"); }

fn main() {
    let url = std::env::args().nth(1).expect("isolated fixture URL");
    let profile = std::env::args().nth(2).expect("isolated browser profile");
    let seconds = std::env::args().nth(3).map_or(6, |value| value.parse().expect("lifetime in seconds"));
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![probe])
        .setup(move |app| {
            tauri::WebviewWindowBuilder::new(app, "probe", tauri::WebviewUrl::External(url.parse()?))
                .title("Isolated panel extension fixture")
                .data_directory(std::path::PathBuf::from(profile))
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(seconds));
                handle.exit(0);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("isolated native fixture");
}
