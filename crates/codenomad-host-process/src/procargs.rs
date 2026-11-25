//! Pure parser for macOS `KERN_PROCARGS2` process argument/environment buffers.

/// Returns `true` when `buf` (in `KERN_PROCARGS2` layout) contains an exact,
/// NUL-terminated `KEY=VALUE` entry in its `envp` section (never matching
/// `exec_path`, `argv`, or a truncated trailing entry).
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
        // Reject truncated trailing env entries lacking a NUL terminator.
        if i >= buf.len() {
            return false;
        }
        if &buf[start..i] == expected {
            return true;
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::procargs2_has_env_entry;

    fn build_procargs2(exec_path: &str, padding: usize, argv: &[&str], envp: &[&str]) -> Vec<u8> {
        let mut buf = Vec::new();
        let argc = i32::try_from(argv.len()).unwrap();
        buf.extend_from_slice(&argc.to_ne_bytes());
        buf.extend_from_slice(exec_path.as_bytes());
        buf.extend(std::iter::repeat_n(0u8, padding));
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
        for padding in [1usize, 2, 4, 7] {
            let in_env = build_procargs2(
                "/usr/bin/env",
                padding,
                &["node", "worker.mjs"],
                &["PATH=/usr/bin", marker, "HOME=/tmp/x"],
            );
            assert!(procargs2_has_env_entry(&in_env, marker));
            assert!(!procargs2_has_env_entry(
                &in_env,
                "CODENOMAD_FIXTURE_TREE_123_1=998"
            ));
        }

        let only_in_argv = build_procargs2(
            "/usr/bin/env",
            4,
            &["node", marker],
            &["PATH=/usr/bin", "HOME=/tmp/x"],
        );
        assert!(!procargs2_has_env_entry(&only_in_argv, marker));
    }

    #[test]
    fn rejects_truncated_buffers_in_header_exec_argv_and_envp() {
        let marker = "CODENOMAD_FIXTURE_TREE_123_1=999";
        // Truncated header
        assert!(!procargs2_has_env_entry(&[1, 0, 0], marker));
        // Truncated exec_path (no NUL)
        let mut exec_only = 1i32.to_ne_bytes().to_vec();
        exec_only.extend_from_slice(b"/usr/bin/node");
        assert!(!procargs2_has_env_entry(&exec_only, marker));
        // Truncated argv (missing NUL terminator)
        let mut argv_trunc = 1i32.to_ne_bytes().to_vec();
        argv_trunc.extend_from_slice(b"/usr/bin/node\0\0node");
        assert!(!procargs2_has_env_entry(&argv_trunc, marker));
        // Truncated trailing envp entry matching marker bytes but lacking NUL terminator
        let mut env_trunc = build_procargs2("/usr/bin/env", 2, &["node"], &["PATH=/usr/bin"]);
        // Remove trailing double NUL (end-of-envp marker) and append unterminated marker
        env_trunc.pop();
        env_trunc.extend_from_slice(marker.as_bytes());
        assert!(!procargs2_has_env_entry(&env_trunc, marker));
        // Appending the terminating NUL makes it valid
        env_trunc.push(0);
        assert!(procargs2_has_env_entry(&env_trunc, marker));
    }
}
