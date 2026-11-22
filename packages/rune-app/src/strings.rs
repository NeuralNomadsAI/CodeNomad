//! Native aliases into the shared UI catalogue. Locale override supports isolated fixtures.
pub fn locale() -> &'static str {
    static LOCALE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    rune_theme_codenomad::catalogue::render_locale(|| {
        LOCALE.get_or_init(crate::platform::locale).as_str()
    })
}
/// Scope a render and its text to an explicit locale without process-global environment changes.
pub fn with_locale<T>(locale: &'static str, render: impl FnOnce() -> T) -> T {
    rune_theme_codenomad::catalogue::with_locale(locale, render)
}
pub fn t(key: &str) -> &'static str {
    let locale = locale();
    let canonical = match key {
        "title" => "window.title.main",
        "loading" => "rune.loading",
        "ready" => "rune.ready",
        "streaming" => "rune.streaming",
        "failed" => "rune.failed",
        "latest" => "rune.latest",
        "prompt" => "rune.prompt",
        "send" => "promptInput.overlay.send",
        "server" => "rune.server",
        "password" => "authRecovery.password",
        "connect" => "folderSelection.servers.dialog.connect",
        "folder" => "instanceInfo.labels.folder",
        "browse" => "folderSelection.browseMenu.title",
        "open" => "directoryBrowser.openCurrent",
        "sessions" => "sessionList.header.title",
        "refresh" => "rune.refresh",
        "search" => "rune.search",
        "untitled" => "sessionList.session.untitled",
        "empty_sessions" => "rune.empty_sessions",
        "more" => "rune.more",
        "new_session" => "sessionList.actions.newSession.title",
        "session_title" => "rune.session_title",
        "create" => "rune.create",
        "connect_error" => "rune.connect_error",
        "open_error" => "rune.open_error",
        "list_error" => "rune.list_error",
        "create_error" => "rune.create_error",
        "tool_pending" => "rune.tool_pending",
        "tool_running" => "toolCall.status.running",
        "tool_done" => "toolCall.status.completed",
        "tool_error" => "rune.tool_error",
        "details" => "rune.details",
        "hide_details" => "rune.hide_details",
        "tool_input" => "rune.tool_input",
        "tool_output" => "toolCall.task.sections.output",
        "tool_limited" => "rune.tool_limited",
        "model" => "rune.model",
        "find_model" => "rune.find_model",
        "refresh_controls" => "rune.refresh_controls",
        "stop" => "rune.stop",
        "control_error" => "rune.control_error",
        "previous_request" => "interruption.previous",
        "next_request" => "interruption.next",
        "permission" => "permissionApproval.kind.permission",
        "reason" => "rune.reason",
        "allow_once" => "rune.allow_once",
        "allow_always" => "rune.allow_always",
        "reject" => "rune.reject",
        "question" => "permissionApproval.kind.question",
        "unsupported_question" => "rune.unsupported_question",
        "other_values" => "rune.other_values",
        "answer" => "rune.answer",
        "cancel_question" => "rune.cancel_question",
        "yes" => "rune.yes",
        "no" => "rune.no",
        "older" => "rune.older",
        "reconnecting" => "rune.reconnecting",
        "retry" => "sessionList.loadError.retry",
        "user" => "messageItem.speaker.you",
        "assistant" => "messageItem.speaker.assistant",
        "tool_more" => "messageBlock.hiddenText.showAll",
        _ => key,
    };
    rune_theme_codenomad::catalogue::message(locale, canonical).expect("shared catalogue key")
}
