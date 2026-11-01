/// Canonical destination check after the native URL parser. Raw spelling is
/// checked at the backend and trusted renderer before handoff.
pub fn is_integration_docs_url(value: &str) -> bool {
    let Some(id) = value.strip_prefix("https://github.com/NeuralNomadsAI/opencode-integrations/tree/main/integrations/") else { return false };
    !id.is_empty() && id.len() <= 32 && id.as_bytes()[0].is_ascii_lowercase()
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

#[cfg(test)]
mod tests {
    use super::is_integration_docs_url as allowed;
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
