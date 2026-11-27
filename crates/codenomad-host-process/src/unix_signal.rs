#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProcessRow {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    pub exiting: bool,
    pub start_id: String,
}

#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn is_ps_exiting_stat(stat: &str) -> bool {
    stat.starts_with('Z') || stat.chars().skip(1).any(|ch| ch == 'E')
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn is_proc_exiting_stat(state: &str) -> bool {
    matches!(state, "Z" | "X" | "x")
}

#[cfg(any(not(target_os = "linux"), test))]
pub(crate) fn parse_ps_table(raw: &str, ps_pid: i32) -> Option<Vec<ProcessRow>> {
    let mut rows = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let pid_str = trimmed.split_whitespace().next()?;
        let pid = pid_str.parse::<i32>().ok()?;
        let rest = trimmed.strip_prefix(pid_str)?.trim_start();
        let ppid_str = rest.split_whitespace().next()?;
        let ppid = ppid_str.parse::<i32>().ok()?;
        let rest = rest.strip_prefix(ppid_str)?.trim_start();
        let pgid_str = rest.split_whitespace().next()?;
        let pgid = pgid_str.parse::<i32>().ok()?;
        let rest = rest.strip_prefix(pgid_str)?.trim_start();
        let stat_str = rest.split_whitespace().next()?;
        if pid == ps_pid {
            continue;
        }
        let start_id = rest
            .strip_prefix(stat_str)
            .map(str::trim)
            .unwrap_or_default();
        rows.push(ProcessRow {
            pid,
            ppid,
            pgid,
            exiting: is_ps_exiting_stat(stat_str),
            start_id: start_id.to_owned(),
        });
    }
    if rows.is_empty() {
        return None;
    }
    Some(rows)
}

pub(crate) fn group_has_live_members(pgid: i32, rows: &[ProcessRow]) -> bool {
    rows.iter().any(|row| row.pgid == pgid && !row.exiting)
}

/// Classify a `kill(-leader, sig)` error.
///
/// `ESRCH` always means the process group is gone. `EPERM` is harmless only when
/// the leader PID has already been reused or, on non-Linux Unix systems (XNU's
/// `killpg1`), when a fresh process-table scan proves the group contains no
/// live non-exiting members. Any live member or unreadable table fails closed.
pub(crate) fn group_signal_error_is_harmless(
    is_esrch: bool,
    is_eperm: bool,
    allow_zombie_group_eperm: bool,
    leader: i32,
    leader_reused: impl FnOnce() -> bool,
    table: impl FnOnce() -> Option<Vec<ProcessRow>>,
) -> bool {
    if is_esrch {
        return true;
    }
    if !is_eperm {
        return false;
    }
    if leader_reused() {
        return true;
    }
    if !allow_zombie_group_eperm {
        return false;
    }
    match table() {
        Some(rows) => !group_has_live_members(leader, &rows),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pid: i32, pgid: i32, exiting: bool) -> ProcessRow {
        ProcessRow {
            pid,
            ppid: 1,
            pgid,
            exiting,
            start_id: "Fri Nov 27 09:45:00 2026".to_owned(),
        }
    }

    #[test]
    fn parses_ps_table_with_stat_and_exiting_flags() {
        let raw = "\
  101   1   101 Z+   Fri Nov 27 09:45:00 2026
  102 101   101 SE   Fri Nov 27 09:45:01 2026
  103   1   103 Ss   Fri Nov 27 09:45:02 2026
  104   1   104 Z
  999   1   999 R+   Fri Nov 27 09:45:03 2026
";
        let rows = parse_ps_table(raw, 999).expect("parsed rows");
        assert_eq!(rows.len(), 4);
        assert!(rows[0].exiting);
        assert_eq!(rows[0].pgid, 101);
        assert_eq!(rows[0].start_id, "Fri Nov 27 09:45:00 2026");
        assert!(rows[1].exiting);
        assert!(!rows[2].exiting);
        assert!(rows[3].exiting);
        assert_eq!(rows[3].start_id, "");
        assert!(parse_ps_table("", 999).is_none());
        assert!(parse_ps_table("   \n\n", 999).is_none());
        assert!(parse_ps_table("  999   1   999 R+   Fri Nov 27 09:45:03 2026\n", 999).is_none());
        assert!(parse_ps_table("not-a-pid foo bar\n", 999).is_none());
        assert!(
            parse_ps_table(
                "  101   1   101 Z+   Fri Nov 27 09:45:00 2026\n  bad line\n",
                999
            )
            .is_none()
        );
    }

    #[test]
    fn classifies_group_signal_errors_safely() {
        assert!(group_signal_error_is_harmless(
            true,
            false,
            true,
            42,
            || panic!("ESRCH must not query leader_reused"),
            || panic!("ESRCH must not scan process table"),
        ));
        assert!(!group_signal_error_is_harmless(
            false,
            false,
            true,
            42,
            || false,
            || Some(vec![]),
        ));
        assert!(group_signal_error_is_harmless(
            false,
            true,
            false,
            42,
            || true,
            || panic!("reused leader must not scan process table"),
        ));
        assert!(group_signal_error_is_harmless(
            false,
            true,
            true,
            42,
            || false,
            || Some(vec![row(42, 42, true), row(99, 99, false)]),
        ));
        assert!(group_signal_error_is_harmless(
            false,
            true,
            true,
            42,
            || false,
            || Some(vec![row(99, 99, false)]),
        ));
        assert!(!group_signal_error_is_harmless(
            false,
            true,
            true,
            42,
            || false,
            || Some(vec![row(42, 42, true), row(43, 42, false)]),
        ));
        assert!(!group_signal_error_is_harmless(
            false,
            true,
            true,
            42,
            || false,
            || None,
        ));
        assert!(!group_signal_error_is_harmless(
            false,
            true,
            false,
            42,
            || false,
            || Some(vec![row(42, 42, true)]),
        ));
        assert!(is_proc_exiting_stat("Z"));
        assert!(is_proc_exiting_stat("X"));
        assert!(!is_proc_exiting_stat("S"));
    }
}
