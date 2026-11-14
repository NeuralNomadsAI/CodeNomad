pub(crate) fn private_preview_host(host: &str) -> bool {
  host.ends_with(".preview.localhost")
}

pub(crate) fn private_preview_url(raw: &str) -> bool {
  let Ok(parsed) = url::Url::parse(raw) else { return false };
  let content = if parsed.scheme() == "blob" {
    url::Url::parse(parsed.path()).ok()
  } else {
    Some(parsed)
  };
  content.is_some_and(|url| {
    matches!(url.scheme(), "http" | "https")
      && url.host_str().is_some_and(private_preview_host)
  })
}
