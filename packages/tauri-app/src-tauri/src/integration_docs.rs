/// Canonical destination check after the native URL parser. Raw spelling is
/// checked at the backend and trusted renderer before handoff.
pub fn is_integration_docs_url(value: &str) -> bool {
    let Some(path) = value.strip_prefix("https://github.com/NeuralNomadsAI/opencode-integrations/") else { return false };
    let Some(id) = path.strip_prefix("blob/main/integrations/")
        .and_then(|rest| rest.strip_suffix("/plugin/README.md"))
        .or_else(|| path.strip_prefix("tree/main/integrations/")) else { return false };
    !id.is_empty() && id.len() <= 32 && id.as_bytes()[0].is_ascii_lowercase()
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::is_integration_docs_url as allowed;
    #[test]
    fn immutable_catalog_readme_destination() {
        let catalog: serde_json::Value = serde_json::from_str(include_str!("../../../server/src/opencode/integrations/fixtures/catalog-54d6e5d.json")).unwrap();
        let good = catalog["integrations"][0]["docs"].as_str().unwrap();
        assert!(allowed(good));
        for value in [format!("{good}/"), format!("{good}?"), format!("{good}#"), format!("{good}\n"),
            good.replace("github.com", "github.com.evil.test"), good.replace("github.com", "github.com:443"),
            good.replace("github.com", "github.com:444"), good.replace("github.com", "user@github.com"),
            good.replace("https:", "http:"), good.replace("/main/", "/other/"),
            good.replace("/opencode-integrations/", "/other-repository/"), good.replace("/blob/", "/tree/"),
            good.replace("/plugin/README.md", "/README.md"), good.replace("README.md", "readme.md"),
            good.replace("/plugin/", "/other/"), good.replace("blender", "%62lender"),
            good.replace("README.md", "%52EADME.md"), good.replace("/plugin/", "/x/../plugin/"),
            good.replace("/plugin/", "/x/%2e%2e/plugin/"), good.replace("/plugin/", "//plugin/"),
            good.replace("/plugin/", "\\plugin\\")] {
            assert!(!allowed(&value), "{value:?}");
        }
    }
    #[test]
    fn canonical_repository_docs_only() {
        let good = "https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/blender";
        assert!(allowed(good));
        for value in [format!("{good}/"), format!("{good}?"), format!("{good}#"),
            good.replace("github.com", "github.com.evil.test"), good.replace("github.com", "github.com:443"),
            good.replace("https:", "http:"), good.replace("/main/", "/evil/"),
            good.replace("blender", "%62lender"), good.replace("blender", "../blender"),
            good.replace("blender", "a/b"), good.replace("blender", ""),
            good.replace("github.com", "user@github.com"), format!("{good}\n")] {
            assert!(!allowed(&value), "{value:?}");
        }
    }
}
