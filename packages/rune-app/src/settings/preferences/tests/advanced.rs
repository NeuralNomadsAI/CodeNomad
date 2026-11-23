use super::*;
use crate::settings::advanced::Toggle;

#[test]
fn advanced_persists_only_supported_options_and_one_server_environment_variable() {
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
            "hideDiffWhitespaceChanges": false
        }});
        assert_eq!(req.body, expected);
        req.reply(200, expected).await;
        wait_until(|| prefs.poll()).await;
        assert_eq!(prefs.advanced_toggle(Toggle::ProviderBalance), Some(false));

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

#[test]
fn general_retry_leaves_an_advanced_refusal_in_its_section() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.set_contrast("on");
        prefs.set_advanced_toggle(Toggle::Whitespace, false);
        assert!(prefs.poll());
        let write = request(&listener).await;
        assert_eq!(
            write.body,
            json!({"settings":{"highContrast":"on","hideDiffWhitespaceChanges":false}})
        );
        write.reply(503, json!({})).await;
        let saved = json!({"settings":{"locale":"en","highContrast":"auto","hideDiffWhitespaceChanges":true}});
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_some() && prefs.advanced_failed());

        prefs.retry_general();
        assert!(prefs.poll());
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        let retry = request(&listener).await;
        assert_eq!(retry.body, json!({"settings":{"highContrast":"on"}}));
        let mut saved = saved;
        saved["settings"]["highContrast"] = "on".into();
        retry.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_none() && prefs.advanced_failed());

        prefs.retry_advanced();
        assert!(prefs.poll());
        request(&listener).await.reply(200, saved.clone()).await;
        wait_until(|| prefs.poll()).await;
        let retry = request(&listener).await;
        assert_eq!(
            retry.body,
            json!({"settings":{"hideDiffWhitespaceChanges":false}})
        );
        saved["settings"]["hideDiffWhitespaceChanges"] = false.into();
        retry.reply(200, saved).await;
        wait_until(|| prefs.poll()).await;
        assert!(prefs.general_error().is_none() && !prefs.advanced_failed());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}
