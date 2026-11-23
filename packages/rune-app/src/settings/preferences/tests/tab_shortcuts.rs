use super::{fixture, request, wait_until};
use serde_json::{Value, json};

#[test]
fn tab_shortcuts_save_independently_and_keep_the_file_binding() {
    crate::platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let save = json!([{"key":"f8"}]);
        let binding = json!([{"key":"f9","mod":true}]);
        prefs.fixture_shortcuts(json!({"file-save":save,"close-instance":[]}));
        prefs.stage_shortcut("new-instance", binding.clone());
        prefs.stage_shortcut("close-instance", Value::Null);
        assert!(prefs.shortcut("new-instance").is_none());
        assert_eq!(prefs.shortcut("close-instance"), Some(&[][..]));
        prefs.poll();
        let write = request(&listener).await;
        assert_eq!(
            write.body,
            json!({"settings":{"hotkeyOverrides":{"new-instance":binding,"close-instance":null}}})
        );
        write
            .reply(
                200,
                json!({"settings":{"hotkeyOverrides":{"new-instance":binding,"file-save":save}}}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(
            prefs.shortcut("new-instance"),
            binding.as_array().map(Vec::as_slice)
        );
        assert_eq!(
            prefs.shortcut("file-save"),
            save.as_array().map(Vec::as_slice)
        );
        assert!(prefs.shortcut("close-instance").is_none());
    });
}
