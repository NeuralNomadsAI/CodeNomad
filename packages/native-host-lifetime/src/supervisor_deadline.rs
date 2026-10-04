//! One absolute Stop-drain cutoff, including native wait/ACK observations.
use crate::{Error, Result};
use std::time::{Duration, Instant};

fn remaining_at(ending: Option<Instant>, fallback: Duration, now: Instant) -> Result<Duration> {
    match ending {
        Some(end) => end
            .checked_duration_since(now)
            .filter(|left| !left.is_zero())
            .map(|left| left.min(fallback))
            .ok_or(Error("native-runtime-stop-drain-deadline")),
        None => Ok(fallback),
    }
}
pub(super) fn remaining(ending: Option<Instant>, fallback: Duration) -> Result<Duration> {
    remaining_at(ending, fallback, Instant::now())
}
pub(super) fn check(ending: Option<Instant>) -> Result<()> {
    remaining(ending, Duration::from_secs(5)).map(|_| ())
}
fn milliseconds(left: Duration) -> u32 {
    // Floor, never round up/renew the deadline, and never Win32 INFINITE.
    left.as_millis().min((u32::MAX - 1) as u128) as u32
}
pub(super) fn wait_exit(
    ending: Option<Instant>,
    unconfirmed: &'static str,
    wait: impl FnMut(u32) -> Result<bool>,
) -> Result<()> {
    wait_with_clock(ending, unconfirmed, wait, Instant::now)
}
fn wait_with_clock(
    ending: Option<Instant>,
    unconfirmed: &'static str,
    mut wait: impl FnMut(u32) -> Result<bool>,
    now: impl Fn() -> Instant,
) -> Result<()> {
    loop {
        let left = remaining_at(ending, Duration::from_secs(5), now())?;
        let result = wait(milliseconds(left));
        // Recheck before accepting even an already-signaled retained handle.
        remaining_at(ending, Duration::from_secs(5), now())?;
        if result? {
            return Ok(());
        }
        if ending.is_none() {
            return Err(Error(unconfirmed));
        }
        // A floored sub-ms budget means a nonblocking poll, not another 5s wait
        // or premature success/failure. Retry against the SAME absolute cutoff.
        std::thread::yield_now();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn absolute_remaining_budget_and_expiry_are_not_renewed() {
        let start = Instant::now();
        let end = start + Duration::from_secs(5);
        let fallback = Duration::from_secs(5);
        assert_eq!(
            remaining_at(Some(end), fallback, start + Duration::from_millis(4900)),
            Ok(Duration::from_millis(100))
        );
        assert_eq!(
            remaining_at(Some(end), fallback, end),
            Err(Error("native-runtime-stop-drain-deadline"))
        );
        assert_eq!(
            remaining_at(Some(end), fallback, end + Duration::from_nanos(1)),
            Err(Error("native-runtime-stop-drain-deadline"))
        );
        assert_eq!(remaining_at(None, fallback, end), Ok(fallback));
    }
    #[test]
    fn finite_millisecond_floor_never_rounds_up_or_becomes_infinite() {
        assert_eq!(milliseconds(Duration::ZERO), 0);
        assert_eq!(milliseconds(Duration::from_nanos(999_999)), 0);
        assert_eq!(milliseconds(Duration::from_nanos(1_999_999)), 1);
        assert_eq!(milliseconds(Duration::from_millis(5000)), 5000);
        assert_eq!(milliseconds(Duration::MAX), u32::MAX - 1);
    }
    #[test]
    fn expired_deadline_refuses_before_already_exited_handle_observation() {
        assert_eq!(
            wait_exit(Some(Instant::now()), "unused", |_| panic!(
                "late wait reached"
            )),
            Err(Error("native-runtime-stop-drain-deadline"))
        );
    }
    #[test]
    fn submillisecond_budget_does_not_start_a_fresh_wait() {
        let start = Instant::now();
        let clock = Cell::new(start);
        let mut polls = 0;
        let result = wait_with_clock(
            Some(start + Duration::from_micros(500)),
            "unused",
            |ms| {
                assert_eq!(ms, 0);
                polls += 1;
                clock.set(clock.get() + Duration::from_micros(250));
                Ok(false)
            },
            || clock.get(),
        );
        assert_eq!(result, Err(Error("native-runtime-stop-drain-deadline")));
        assert_eq!(polls, 2);
    }
    #[test]
    fn late_success_after_native_wait_is_refused() {
        let start = Instant::now();
        let end = start + Duration::from_secs(5);
        let clock = Cell::new(start + Duration::from_millis(4900));
        assert_eq!(
            wait_with_clock(
                Some(end),
                "unused",
                |ms| {
                    assert_eq!(ms, 100);
                    clock.set(end);
                    Ok(true)
                },
                || clock.get()
            ),
            Err(Error("native-runtime-stop-drain-deadline"))
        );
    }
    #[test]
    fn sequential_member_waits_and_ack_share_the_original_cutoff() {
        let start = Instant::now();
        let end = Some(start + Duration::from_secs(5));
        let clock = Cell::new(start + Duration::from_millis(4800));
        for expected in [200, 100] {
            assert_eq!(
                wait_with_clock(
                    end,
                    "unused",
                    |ms| {
                        assert_eq!(ms, expected);
                        clock.set(clock.get() + Duration::from_millis(100));
                        Ok(true)
                    },
                    || clock.get()
                ),
                if expected == 200 {
                    Ok(())
                } else {
                    Err(Error("native-runtime-stop-drain-deadline"))
                }
            );
        }
        assert_eq!(
            remaining_at(end, Duration::from_secs(5), clock.get()),
            Err(Error("native-runtime-stop-drain-deadline"))
        );
    }
    #[test]
    fn non_draining_unconfirmed_wait_retains_ordinary_failure() {
        assert_eq!(
            wait_exit(None, "native-runtime-cleanup-unconfirmed", |ms| {
                assert_eq!(ms, 5000);
                Ok(false)
            }),
            Err(Error("native-runtime-cleanup-unconfirmed"))
        );
    }
}
