//! Exercise normal setup, launcher bootstrap and owned shutdown without a visible window.
pub fn run() {
    assert!(
        crate::platform::setting("RUNE_BACKEND").is_none(),
        "external backend disables owned startup"
    );
    assert!(crate::platform::setting("RUNE_SERVER_BIN").is_some());
    assert!(crate::platform::setting("RUNE_HOST_ROOT").is_some());
    struct Finish;
    impl Drop for Finish {
        fn drop(&mut self) {
            crate::platform::finish();
        }
    }
    let _finish = Finish;
    let mut state = crate::init();
    crate::setup(&mut state, std::sync::Arc::new(|| {}));
    assert!(state.launcher_visible);
    assert!(state.launcher.as_ref().unwrap().pending);
    let mut runtime = rune::Runtime::new(
        state,
        crate::view,
        (640.0, 800.0),
        rune::Env::new(false, 1.0),
    );
    runtime.poll = Some(crate::poll);
    let until = std::time::Instant::now() + std::time::Duration::from_secs(90);
    loop {
        runtime.frame(0.02);
        let launcher = runtime.state.launcher.as_ref().unwrap();
        assert!(launcher.error.is_none(), "owned startup failed");
        if launcher.connection.is_some() && !launcher.pending {
            assert!(launcher.has_owned_server());
            assert!(!launcher.pending);
            break;
        }
        assert!(std::time::Instant::now() < until, "owned startup timed out");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    drop(runtime);
    crate::platform::finish();
    println!(
        "owned startup: normal setup, bootstrap auth, project list, state release, shutdown workers joined"
    );
}
