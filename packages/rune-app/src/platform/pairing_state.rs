//! Platform-independent pairing recovery state transitions (tested on native builds).

const AUTH_SIGNAL_RETRIES: u8 = 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AuthSignal {
    Launcher(u64),
    Conversation(u64),
}

impl AuthSignal {
    fn slot(self) -> (usize, u64) {
        match self {
            Self::Launcher(generation) => (0, generation),
            Self::Conversation(generation) => (1, generation),
        }
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct PairingState {
    pub(crate) required: bool,
    pub(crate) in_flight: bool,
    pub(crate) recheck: bool,
    pub(crate) auth_retries: u8,
    pub(crate) retry_waiting: bool,
    pub(crate) seen_auth: [Option<u64>; 2],
    pub(crate) auth_episode_armed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Action {
    None,
    StartCheck,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Settled {
    Unchanged,
    Required,
    Recovered,
    Recheck,
    RetryAfter(u64),
}

impl PairingState {
    /// Passive failure signal (transport/launcher error): never overrides an active
    /// recovery dialog with stale probes that would disable the manual check button.
    pub(crate) fn observe_passive(&mut self) -> Action {
        if self.in_flight || self.required {
            return Action::None;
        }
        self.retry_waiting = false;
        self.seen_auth = [None, None];
        self.auth_episode_armed = false;
        self.in_flight = true;
        Action::StartCheck
    }

    /// Explicit recovery signal (button press, tab focus/visibility, or authenticated
    /// traffic arriving while the pairing overlay is shown). Queues one trailing probe
    /// if a check is already in flight so a stale pre-pairing response cannot strand
    /// the dialog open.
    pub(crate) fn request_recheck(&mut self) -> Action {
        self.retry_waiting = false;
        if self.in_flight {
            self.recheck = true;
            return Action::None;
        }
        self.in_flight = true;
        self.recheck = false;
        Action::StartCheck
    }

    /// Authenticated traffic arrived on a specific connection generation: if pairing
    /// recovery is visible or an initial failure probe is already in flight, trigger
    /// one bounded verification episode per connection generation so repeated syncs
    /// on the same connection cannot bypass the transient-failure retry bound.
    pub(crate) fn on_authenticated_signal(&mut self, signal: AuthSignal) -> Action {
        if !(self.required || self.in_flight) {
            return Action::None;
        }
        let (slot, generation) = signal.slot();
        if self.seen_auth[slot] == Some(generation) {
            return Action::None;
        }
        self.seen_auth[slot] = Some(generation);
        if self.auth_episode_armed {
            if self.in_flight {
                // A genuinely new connection generation arrived while an earlier probe was
                // still in flight: queue one follow-up verification without resetting the
                // retry budget so a stale `pairingRequired=true` cannot strand the dialog.
                self.recheck = true;
                return Action::None;
            }
            if self.retry_waiting {
                return Action::None;
            }
        }
        self.auth_episode_armed = true;
        self.auth_retries = AUTH_SIGNAL_RETRIES;
        self.request_recheck()
    }

    /// Bounded backoff timer fired after a transient probe failure following an
    /// authenticated SSE signal.
    pub(crate) fn on_retry_timer(&mut self) -> Action {
        if !self.retry_waiting || !self.required || self.in_flight {
            self.retry_waiting = false;
            return Action::None;
        }
        self.retry_waiting = false;
        self.in_flight = true;
        Action::StartCheck
    }

    /// Keep window focus / visibility listeners armed both while the recovery overlay is
    /// visible and while an initial probe is still in flight (so re-pairing and returning
    /// to a launcher tab with no live conversation stream never strands a stale overlay).
    pub(crate) fn watches_focus(&self) -> bool {
        self.required || self.in_flight
    }

    pub(crate) fn settle(&mut self, result: Option<bool>) -> Settled {
        self.in_flight = false;
        self.retry_waiting = false;
        match result {
            Some(false) => {
                self.recheck = false;
                self.auth_retries = 0;
                self.auth_episode_armed = false;
                self.seen_auth = [None, None];
                if self.required {
                    self.required = false;
                    Settled::Recovered
                } else {
                    Settled::Unchanged
                }
            }
            Some(true) => {
                let became_required = !self.required;
                self.required = true;
                if self.recheck {
                    self.recheck = false;
                    self.in_flight = true;
                    return if became_required {
                        // Becoming required still needs focus hooks installed; the caller
                        // inspects `in_flight` to dispatch the queued recheck.
                        Settled::Required
                    } else {
                        Settled::Recheck
                    };
                }
                self.auth_retries = 0;
                self.auth_episode_armed = false;
                if became_required {
                    Settled::Required
                } else {
                    Settled::Unchanged
                }
            }
            None => {
                if self.recheck {
                    self.recheck = false;
                    self.in_flight = true;
                    Settled::Recheck
                } else if self.required && self.auth_retries > 0 {
                    let attempt = AUTH_SIGNAL_RETRIES - self.auth_retries;
                    self.auth_retries -= 1;
                    self.retry_waiting = true;
                    Settled::RetryAfter(1_000u64 << attempt)
                } else {
                    self.auth_retries = 0;
                    self.auth_episode_armed = false;
                    if !self.required {
                        self.seen_auth = [None, None];
                    }
                    Settled::Unchanged
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_errors_do_not_start_stale_checks_while_pairing_is_required() {
        let mut state = PairingState::default();
        assert_eq!(state.observe_passive(), Action::StartCheck);
        assert_eq!(state.settle(Some(true)), Settled::Required);
        assert!(state.required);
        assert!(!state.in_flight);

        // Repeated 401/disconnect errors while the dialog is visible stay quiet.
        assert_eq!(state.observe_passive(), Action::None);
        assert!(!state.in_flight);
    }

    #[test]
    fn explicit_recheck_during_stale_in_flight_probe_clears_after_re_pairing() {
        let mut state = PairingState {
            required: true,
            in_flight: true,
            ..Default::default()
        };
        // Focus, visibilitychange, button click, or authenticated SSE arrives while a
        // pre-pairing /api/auth/status check is still in flight.
        assert_eq!(state.request_recheck(), Action::None);
        assert!(state.recheck);

        // Stale pre-pairing probe returns pairingRequired=true -> must immediately queue fresh probe.
        assert_eq!(state.settle(Some(true)), Settled::Recheck);
        assert!(state.required);
        assert!(state.in_flight);
        assert!(!state.recheck);

        // Fresh post-pairing probe returns pairingRequired=false -> dismisses overlay cleanly.
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.recheck);
    }

    #[test]
    fn transient_probe_failure_still_honors_queued_recheck() {
        let mut state = PairingState {
            required: true,
            in_flight: true,
            ..Default::default()
        };
        assert_eq!(state.request_recheck(), Action::None);
        assert_eq!(state.settle(None), Settled::Recheck);
        assert!(state.required);
        assert!(state.in_flight);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
    }

    #[test]
    fn recovery_response_cancels_redundant_queued_recheck() {
        let mut state = PairingState {
            required: true,
            in_flight: true,
            ..Default::default()
        };
        assert_eq!(state.request_recheck(), Action::None);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.recheck);
    }

    #[test]
    fn authenticated_signal_during_initial_stale_probe_recovers_without_click() {
        let mut state = PairingState::default();
        assert_eq!(state.observe_passive(), Action::StartCheck);
        assert!(!state.required);
        assert!(state.in_flight);

        // Authenticated traffic resumes before the initial stale /api/auth/status check settles.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::None
        );
        assert!(state.recheck);

        // The stale probe resolves pairingRequired=true -> installs overlay and immediately dispatches a fresh probe.
        assert_eq!(state.settle(Some(true)), Settled::Required);
        assert!(state.required);
        assert!(state.in_flight);
        assert!(!state.recheck);

        // The queued fresh probe resolves pairingRequired=false -> dismisses overlay automatically without a click.
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.watches_focus());
    }

    #[test]
    fn focus_during_initial_stale_probe_recovers_without_conversation_stream() {
        let mut state = PairingState::default();
        assert!(!state.watches_focus());

        // Launcher passive probe starts -> focus/visibility listeners must already be armed.
        assert_eq!(state.observe_passive(), Action::StartCheck);
        assert!(state.watches_focus());

        // User re-pairs in another tab and returns to the launcher before the first probe settles.
        assert_eq!(state.request_recheck(), Action::None);
        assert!(state.recheck);
        assert!(state.watches_focus());

        // Stale first probe answers pairingRequired=true -> shows overlay and immediately dispatches fresh check.
        assert_eq!(state.settle(Some(true)), Settled::Required);
        assert!(state.required);
        assert!(state.in_flight);
        assert!(state.watches_focus());

        // Fresh check resolves pairingRequired=false -> overlay clears automatically with zero manual click.
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.watches_focus());
    }

    #[test]
    fn transient_focus_probe_failure_recovers_on_launcher_authenticated_reconnect_without_click() {
        let mut state = PairingState {
            required: true,
            ..Default::default()
        };
        // User returns focus during a brief network outage -> probe fails transiently (`None`).
        assert_eq!(state.request_recheck(), Action::StartCheck);
        assert_eq!(state.settle(None), Settled::Unchanged);
        assert!(state.required);
        assert!(!state.in_flight);
        assert!(state.watches_focus());

        // Without another focus or manual click, the launcher's SSE reopens on an authenticated generation.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::StartCheck
        );
        assert!(state.in_flight);

        // Fresh status check clears the overlay automatically.
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.watches_focus());
    }

    #[test]
    fn authenticated_sse_retries_bounded_after_transient_probe_failure_and_recovers() {
        let mut state = PairingState {
            required: true,
            ..Default::default()
        };
        // Order: SSE authenticated -> HTTP fails transiently -> bounded retry -> HTTP fails -> bounded retry -> HTTP succeeds.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::StartCheck
        );
        assert!(state.in_flight);
        assert_eq!(state.settle(None), Settled::RetryAfter(1_000));
        assert!(!state.in_flight);
        assert!(state.retry_waiting);

        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert!(state.in_flight);
        assert!(!state.retry_waiting);
        assert_eq!(state.settle(None), Settled::RetryAfter(2_000));
        assert!(state.retry_waiting);

        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.in_flight);
        assert!(!state.retry_waiting);
        assert_eq!(state.auth_retries, 0);
    }

    #[test]
    fn authenticated_sse_retry_budget_is_bounded_and_stops_cleanly() {
        let mut state = PairingState {
            required: true,
            ..Default::default()
        };
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::StartCheck
        );
        assert_eq!(state.settle(None), Settled::RetryAfter(1_000));
        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert_eq!(state.settle(None), Settled::RetryAfter(2_000));
        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        // Budget exhausted -> stops cleanly with zero further timers; manual/focus recheck stays available.
        assert_eq!(state.settle(None), Settled::Unchanged);
        assert!(state.required);
        assert!(!state.in_flight);
        assert!(!state.retry_waiting);
        assert_eq!(state.auth_retries, 0);
        assert_eq!(state.on_retry_timer(), Action::None);
        assert_eq!(state.request_recheck(), Action::StartCheck);
    }

    #[test]
    fn repeated_authenticated_signals_for_same_generation_do_not_bypass_retry_bound() {
        let mut state = PairingState {
            required: true,
            ..Default::default()
        };
        // Opening the conversation stream arms one bounded episode for Conversation(1).
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::StartCheck
        );
        // Repeated Sync / ReaderSync on the SAME connection generation must not queue extra
        // probes or reset retries.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::None
        );
        assert!(!state.recheck);
        assert_eq!(state.settle(None), Settled::RetryAfter(1_000));

        // Repeated signals (or an overlapping launcher signal) during backoff must not cancel
        // backoff or reset auth_retries.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::None
        );
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::None
        );
        assert!(state.retry_waiting);
        assert_eq!(state.auth_retries, 1);

        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert_eq!(state.settle(None), Settled::RetryAfter(2_000));
        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert_eq!(state.settle(None), Settled::Unchanged);
        assert_eq!(state.auth_retries, 0);

        // After the episode exhausts, repeating the already-seen generations stays silent.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::None
        );
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::None
        );

        // A genuinely new connection generation starts a fresh check; if ANOTHER new generation
        // arrives while that check is still in flight (before stale pairingRequired=true returns),
        // it queues one follow-up check without resetting retries on its own duplicates.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(3)),
            Action::StartCheck
        );
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(2)),
            Action::None
        );
        assert!(state.recheck);
        // Duplicate of Conversation(2) stays silent.
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(2)),
            Action::None
        );
        // Stale probe from Launcher(3) settles pairingRequired=true -> immediately runs the
        // queued follow-up probe for Conversation(2) and recovers cleanly.
        assert_eq!(state.settle(Some(true)), Settled::Recheck);
        assert!(state.in_flight);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
    }

    #[test]
    fn manual_recheck_during_retry_backoff_cancels_timer_and_runs_immediately() {
        let mut state = PairingState {
            required: true,
            ..Default::default()
        };
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Launcher(1)),
            Action::StartCheck
        );
        assert_eq!(state.settle(None), Settled::RetryAfter(1_000));
        assert!(state.retry_waiting);

        // User clicks Check (or tab focuses) before the 1 s timer fires -> starts immediately.
        assert_eq!(state.request_recheck(), Action::StartCheck);
        assert!(!state.retry_waiting);
        assert!(state.in_flight);
        // Any late timer callback becomes a no-op.
        assert_eq!(state.on_retry_timer(), Action::None);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
    }

    #[test]
    fn stale_probe_followed_by_sse_then_transient_failure_recovers_via_bounded_retry() {
        let mut state = PairingState::default();
        assert_eq!(state.observe_passive(), Action::StartCheck);
        assert_eq!(
            state.on_authenticated_signal(AuthSignal::Conversation(1)),
            Action::None
        );
        assert!(state.recheck);
        assert_eq!(state.settle(Some(true)), Settled::Required);
        assert!(state.required);
        assert!(state.in_flight);

        // The SSE-triggered follow-up probe fails transiently -> bounded retry still recovers without click/focus.
        assert_eq!(state.settle(None), Settled::RetryAfter(1_000));
        assert_eq!(state.on_retry_timer(), Action::StartCheck);
        assert_eq!(state.settle(Some(false)), Settled::Recovered);
        assert!(!state.required);
        assert!(!state.watches_focus());
    }
}
