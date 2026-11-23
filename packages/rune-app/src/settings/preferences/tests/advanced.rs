use super::*;
use crate::settings::advanced::Toggle;

#[test]
fn advanced_persists_solid_options_and_one_server_environment_variable() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        for (toggle, value) in [
            (Toggle::EmptySessions, false),
            (Toggle::UnseenSubagents, false),
            (Toggle::SecondLaunch, true),
            (Toggle::ProviderBalance, true),
            (Toggle::Whitespace, false),
            (Toggle::LongReplies, false),
        ] {
            assert_ne!(prefs.advanced_toggle(toggle), Some(value));
            prefs.set_advanced_toggle(toggle, value);
        }
        assert!(prefs.poll());
        let req = request(&listener).await;
        assert_eq!(req.first, "PATCH /api/storage/config/ui HTTP/1.1");
        let expected = json!({"settings":{
            "autoCleanupBlankSessions": false, "keepUnseenSubagentIdleStatus": false,
            "focusExistingWindowOnSecondLaunch": true, "showProviderUsageCreditBalance": true,
            "hideDiffWhitespaceChanges": false, "holdLongAssistantReplies": false
        }});
        assert_eq!(req.body, expected);
        req.reply(200, expected).await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.advanced_toggle(Toggle::ProviderBalance), Some(true));

        prefs.show_environment(true);
        assert!(prefs.poll());
        let read = request(&listener).await;
        assert!(read.first.starts_with("GET /api/storage/config/server?"));
        read.reply(
            200,
            json!({"environmentVariables":{"OTHER":"keep"},"secureEnvVars":["OTHER"]}),
        )
        .await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.stage_environment("CN_FIXTURE".into(), Some("value".into()), true));
        assert!(prefs.poll());
        let req = request(&listener).await;
        assert_eq!(req.first, "PATCH /api/storage/config/server HTTP/1.1");
        assert_eq!(
            req.body,
            json!({"environmentVariables":{"CN_FIXTURE":"value"},"secureEnvVars":["OTHER","CN_FIXTURE"]})
        );
        req.reply(200, json!({"environmentVariables":{"OTHER":"keep","CN_FIXTURE":"value"},"secureEnvVars":["OTHER","CN_FIXTURE"]})).await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.environment_pending() && !prefs.environment_failed());
        assert!(prefs.stage_environment("CN_FIXTURE".into(), None, false));
        assert!(prefs.poll());
        let remove = request(&listener).await;
        assert_eq!(
            remove.body,
            json!({"environmentVariables":{"CN_FIXTURE":null},"secureEnvVars":["OTHER"]})
        );
        remove
            .reply(
                200,
                json!({"environmentVariables":{"OTHER":"keep"},"secureEnvVars":["OTHER"]}),
            )
            .await;
        wait_until(|| prefs.poll()).await;
        assert!(!prefs.environment_pending() && !prefs.environment_failed());
    });
}
