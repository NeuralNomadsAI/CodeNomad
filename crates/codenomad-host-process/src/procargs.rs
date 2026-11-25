//! Pure parser for macOS `KERN_PROCARGS2` process argument/environment buffers.

/// Returns `(exec_path, argv)` extracted from a `KERN_PROCARGS2` buffer.
///
/// Note on XNU `KERN_PROCARGS2` layout: `exec_path` is followed by one or more
/// NUL padding bytes before `argv[0]`. When `argc > 0`, XNU strips leading NUL
/// padding up to the first non-NUL byte of `argv[0]`; an empty `argv[0]` cannot
/// be distinguished from padding in the raw kernel layout.
pub fn parse_procargs2_exec_and_argv(buf: &[u8]) -> Option<(String, Vec<String>)> {
    if buf.len() < 4 {
        return None;
    }
    let argc = i32::from_ne_bytes([buf[0], buf[1], buf[2], buf[3]]);
    if argc < 0 {
        return None;
    }
    let mut i = 4usize;
    let exec_start = i;
    while i < buf.len() && buf[i] != 0 {
        i += 1;
    }
    if i >= buf.len() {
        return None;
    }
    let exec_path = String::from_utf8_lossy(&buf[exec_start..i]).into_owned();
    while i < buf.len() && buf[i] == 0 {
        i += 1;
    }
    let mut argv = Vec::with_capacity(usize::try_from(argc).ok()?);
    for _ in 0..argc {
        if i >= buf.len() {
            return None;
        }
        let arg_start = i;
        while i < buf.len() && buf[i] != 0 {
            i += 1;
        }
        if i >= buf.len() {
            return None;
        }
        argv.push(String::from_utf8_lossy(&buf[arg_start..i]).into_owned());
        i += 1;
    }
    Some((exec_path, argv))
}

/// Returns `true` when `buf` (in `KERN_PROCARGS2` layout) contains an exact,
/// NUL-terminated `KEY=VALUE` entry in its `envp` section (never matching
/// `exec_path`, `argv`, or a truncated trailing entry).
///
/// Note: as with `parse_procargs2_exec_and_argv`, XNU places NUL padding between
/// `exec_path` and `argv[0]` (or `envp[0]` when `argc == 0`). When `argc > 0`
/// and `argv[0]` is empty, the first non-NUL entry is indistinguishable from
/// `argv[0]` in the kernel format.
pub fn procargs2_has_env_entry(buf: &[u8], expected_entry: &str) -> bool {
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
    // Skip trailing NUL padding between exec_path and argv[0] (or envp[0] when argc == 0).
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
    use super::{parse_procargs2_exec_and_argv, procargs2_has_env_entry};

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

        // argc == 0 with marker as very first env entry
        let zero_argc = build_procargs2("/usr/bin/env", 3, &[], &[marker, "HOME=/tmp/x"]);
        assert!(procargs2_has_env_entry(&zero_argc, marker));
        assert_eq!(
            parse_procargs2_exec_and_argv(&zero_argc),
            Some(("/usr/bin/env".into(), vec![]))
        );

        // Structured argv preserves spaces, quotes, and backslashes
        let spaced = build_procargs2(
            "/opt/my node/bin/node",
            2,
            &[
                "node",
                "--config",
                "/tmp/launcher-café 1/config.yaml",
                "a\"b\\c",
            ],
            &[marker],
        );
        assert_eq!(
            parse_procargs2_exec_and_argv(&spaced),
            Some((
                "/opt/my node/bin/node".into(),
                vec![
                    "node".into(),
                    "--config".into(),
                    "/tmp/launcher-café 1/config.yaml".into(),
                    "a\"b\\c".into(),
                ]
            ))
        );
        assert!(procargs2_has_env_entry(&spaced, marker));
    }

    #[test]
    fn rejects_truncated_buffers_in_header_exec_argv_and_envp() {
        let marker = "CODENOMAD_FIXTURE_TREE_123_1=999";
        assert!(!procargs2_has_env_entry(&[1, 0, 0], marker));
        assert_eq!(parse_procargs2_exec_and_argv(&[1, 0, 0]), None);
        let mut exec_only = 1i32.to_ne_bytes().to_vec();
        exec_only.extend_from_slice(b"/usr/bin/node");
        assert!(!procargs2_has_env_entry(&exec_only, marker));
        assert_eq!(parse_procargs2_exec_and_argv(&exec_only), None);
        let mut argv_trunc = 1i32.to_ne_bytes().to_vec();
        argv_trunc.extend_from_slice(b"/usr/bin/node\0\0node");
        assert!(!procargs2_has_env_entry(&argv_trunc, marker));
        assert_eq!(parse_procargs2_exec_and_argv(&argv_trunc), None);
        let mut env_trunc = build_procargs2("/usr/bin/env", 2, &["node"], &["PATH=/usr/bin"]);
        env_trunc.pop();
        env_trunc.extend_from_slice(marker.as_bytes());
        assert!(!procargs2_has_env_entry(&env_trunc, marker));
        env_trunc.push(0);
        assert!(procargs2_has_env_entry(&env_trunc, marker));
    }
}
