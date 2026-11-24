use super::{fixture, request, wait_until};
use crate::{platform, settings::shortcuts::FILE_SAVE};
use serde_json::{Value, json};

#[test]
fn save_shortcut_updates_only_its_host_config_entry() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        let other = json!([{"key":"n","mod":true}]);
        let binding = json!([{"key":"f8","mod":true}]);
        for patch in [binding, json!([]), Value::Null] {
            let old = prefs.shortcut(FILE_SAVE).map(<[_]>::to_vec);
            prefs.stage_file_save(patch.clone());
            assert_eq!(prefs.shortcut(FILE_SAVE), old.as_deref());
            prefs.poll();
            let write = request(&listener).await;
            assert_eq!(write.first, "PATCH /api/storage/config/ui HTTP/1.1");
            assert_eq!(
                write.body,
                json!({"settings":{"hotkeyOverrides":{"file-save":patch}}})
            );
            let mut overrides = json!({"new-instance": other});
            if !patch.is_null() {
                overrides["file-save"] = patch.clone();
            }
            write
                .reply(200, json!({"settings":{"hotkeyOverrides":overrides}}))
                .await;
            wait_until(|| prefs.poll()).await;
            assert_eq!(
                prefs.shortcut(FILE_SAVE),
                patch.as_array().map(Vec::as_slice)
            );
            assert_eq!(
                prefs.shortcut("new-instance"),
                other.as_array().map(Vec::as_slice)
            );
            assert!(!prefs.file_save_pending());
        }
    });
}
