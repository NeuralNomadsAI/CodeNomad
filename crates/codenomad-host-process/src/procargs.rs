//! Pure parser for macOS `KERN_PROCARGS2` process argument/environment buffers.

/// Returns `true` when `buf` (in `KERN_PROCARGS2` layout) contains an exact
/// `KEY=VALUE` entry in its `envp` section (never matching `exec_path` or `argv`).
pub(crate) fn procargs2_has_env_entry(buf: &[u8], expected_entry: &str) -> bool {
    if expected_entry.is_empty() || buf.len() < 4 {
        return false;
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 0 {
        return false;
    }
    let mut i = 4usize;
    // Skip exec_path up to its terminating NUL.
    while i < buf.len() && buf[i] != 0 {
        i += 1;
    }
    if i >= buf.len() {
        return false;
    }
    // Skip trailing NUL padding between exec_path and argv[0].
    while i < buf.len() && buf[i] == 0 {
        i += 1;
    }
    // Skip `argc` NUL-terminated argv entries.
    for _ in 0..argc {
        if i >= buf.len() {
            return false;
        }
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        if i >= buf.len() {
            return false;
        }
        i += 1;
    }
    let expected = expected_entry.as_bytes();
    // Scan NUL-terminated envp entries until an empty entry or end of buffer.
    while i < buf.len() {
        if buf[i] == 0 {
            break;
        }
        let start = i;
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        if &buf[start..i] == expected {
            return true;
        }
        if i < buf.len() {
            i += 1;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::procargs2_has_env_entry;

    fn build_procargs2(exec_path: &str, argv: &[&str], envp: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        let argc = i32::try_from(argv.len()).unwrap();
        buf.extend_from_slice(&argc.to_ne_bytes());
        buf.extend_from_slice(exec_path.as_bytes());
        buf.extend_from_slice(&[0, 0, 0, 0]);
        for arg in argv {
            buf.extend_from_slice(arg.as_bytes());
            buf.push(0);
        }
        for env in envp {
            buf.extend_from_slice(env.as_bytes());
            buf.push(0);
        }
        buf.push(0);
        buf
    }

    #[test]
    fn matches_exact_env_entry_and_ignores_argv_spoofing() {
        let marker = "CODENOMAD_FIXTURE_TREE_123_1=999";
        let in_env = build_procargs2(
            "/usr/bin/env",
            &["node", "worker.mjs"],
            &["PATH=/usr/bin", marker, "HOME=/tmp/x"],
        );
        assert!(procargs2_has_env_entry(&in_env, marker));
        assert!(!procargs2_has_env_entry(
            &in_env,
            "CODENOMAD_FIXTURE_TREE_123_1=998"
        ));

        let only_in_argv = build_procargs2(
            "/usr/bin/env",
            &["node", marker],
            &["PATH=/usr/bin", "HOME=/tmp/x"],
        );
        assert!(!procargs2_has_env_entry(&only_in_argv, marker));

        let truncated = build_procargs2("/usr/bin/env", &["node"], &[]);
        assert!(!procargs2_has_env_entry(&truncated[..3], marker));
    }
}
