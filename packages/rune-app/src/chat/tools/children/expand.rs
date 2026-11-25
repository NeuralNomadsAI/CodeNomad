use super::*;

impl Children {
    pub(in crate::chat::tools) fn loaded_report(&self, key: &ReportCopyKey) -> Option<&str> {
        let target = ExpandKey::Report(key.clone());
        self.expanded_reports
            .iter()
            .find(|(current, _)| current == &target)
            .map(|(_, text)| text.as_str())
    }

    pub(in crate::chat::tools) fn expand_failed(&self, key: &ReportCopyKey) -> bool {
        self.failed_report.as_ref() == Some(&ExpandKey::Report(key.clone()))
    }

    pub(in crate::chat::tools) fn loaded_tool_output(&self, key: &ToolCopyKey) -> Option<&str> {
        let target = ExpandKey::ToolOutput(key.clone());
        self.expanded_reports
            .iter()
            .find(|(current, _)| current == &target)
            .map(|(_, text)| text.as_str())
    }

    pub(in crate::chat::tools) fn expand_tool_failed(&self, key: &ToolCopyKey) -> bool {
        self.failed_report.as_ref() == Some(&ExpandKey::ToolOutput(key.clone()))
    }

    pub(in crate::chat::tools) fn expand_report(s: &mut State, key: ReportCopyKey) {
        let expand_key = ExpandKey::Report(key.clone());
        if s.transcript_display
            .children
            .expanded_reports
            .iter()
            .any(|(current, _)| current == &expand_key)
            || s.transcript_display
                .children
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| current == &expand_key)
        {
            return;
        }
        if s.transcript_display.children.failed_report.as_ref() == Some(&expand_key) {
            s.transcript_display.children.failed_report = None;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.parent))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_report(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        s.transcript_display.children.loading_report = Some((expand_key, revocation, cancel, rx));
    }

    pub(in crate::chat::tools) fn expand_tool_output(s: &mut State, key: ToolCopyKey) {
        let expand_key = ExpandKey::ToolOutput(key.clone());
        if s.transcript_display
            .children
            .expanded_reports
            .iter()
            .any(|(current, _)| current == &expand_key)
            || s.transcript_display
                .children
                .loading_report
                .as_ref()
                .is_some_and(|(current, _, _, _)| current == &expand_key)
        {
            return;
        }
        if s.transcript_display.children.failed_report.as_ref() == Some(&expand_key) {
            s.transcript_display.children.failed_report = None;
        }
        let Some((watch_rx, settlement)) = s
            .transcript_display
            .children
            .backend
            .as_ref()
            .and_then(|b| b.watch_child(&key.child))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let rev_before = settlement.revocation_gen();
        let Some((cancel, rx)) =
            Self::fetch_tool_section(s, &key, Some((settlement.clone(), rev_before)))
        else {
            s.transcript_display.children.failed_report = Some(expand_key);
            return;
        };
        let revocation = CopyRevocation {
            _rx: watch_rx,
            settlement,
            rev_before,
        };
        s.transcript_display.children.loading_report = Some((expand_key, revocation, cancel, rx));
    }
}
