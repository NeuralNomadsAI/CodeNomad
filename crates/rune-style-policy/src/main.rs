use std::{fs, path::Path};
fn scan(path: &Path) -> Result<usize, Box<dyn std::error::Error>> {
    let mut failures = 0;
    if path.is_dir() {
        let mut entries = fs::read_dir(path)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|entry| entry.path());
        for entry in entries {
            failures += scan(&entry.path())?;
        }
    } else if path.extension().is_some_and(|s| s == "rs") {
        for error in rune_style_policy::check(&fs::read_to_string(path)?)? {
            eprintln!("{}:{}: {}", path.display(), error.line, error.message);
            failures += 1;
        }
    }
    Ok(failures)
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "packages/rune-app/src".into());
    let count = scan(Path::new(&path))?;
    if count != 0 {
        return Err(format!("{count} style policy violations").into());
    }
    Ok(())
}
