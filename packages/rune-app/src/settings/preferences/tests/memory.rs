use super::*;
use crate::settings::memory::action;

#[test]
fn memory_settings_are_demanded_and_failed_writes_only_read_back() {
    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        assert!(!prefs.poll());
        prefs.memory.show(true);
        assert!(prefs.poll());
        let initial = request(&listener).await;
        assert_eq!(initial.first, "GET /api/memory/settings HTTP/1.1");
        prefs.memory.invalidate();
        prefs.memory.invalidate();
        initial.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        let trailing = request(&listener).await;
        assert_eq!(trailing.first, "GET /api/memory/settings HTTP/1.1");
        trailing.reply(200, json!({"enabled":false})).await;
        wait_until(|| prefs.poll()).await;
        action(&mut prefs, Some(true));
        assert!(prefs.poll());
        let put = request(&listener).await;
        assert_eq!(put.first, "PUT /api/memory/settings HTTP/1.1");
        assert_eq!(put.body, json!({"enabled":true}));
        prefs.memory.show(false);
        put.reply(503, json!({})).await;
        let readback = request(&listener).await;
        assert_eq!(readback.first, "GET /api/memory/settings HTTP/1.1");
        readback.reply(200, json!({"enabled":true})).await;
        wait_until(|| prefs.poll()).await;
        prefs.memory.invalidate();
        assert!(!prefs.poll());
        assert!(
            timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
}

#[test]
fn failed_memory_reads_keep_the_last_confirmed_switch_value() {
    fn view(prefs: &Preferences, _: &mut rune::Cx<Preferences>) -> rune::El {
        crate::strings::with_locale("en", || {
            crate::settings::memory::view::<Preferences>(prefs, false, |_, _| {}, |_, _| {})
        })
    }

    platform::block_on(async {
        let (listener, mut prefs) = fixture().await;
        prefs.memory.show(true);
        assert!(prefs.poll());
        request(&listener)
            .await
            .reply(200, json!({"enabled":true}))
            .await;
        wait_until(|| prefs.poll()).await;
        prefs.memory.invalidate();
        assert!(prefs.poll());
        request(&listener).await.reply(503, json!({})).await;
        wait_until(|| prefs.poll()).await;
        let mut rt = rune::Runtime::new(prefs, view, (600.0, 340.0), rune::Env::new(false, 1.0));
        rt.frame(0.02);
        let tree = rt.accessibility_json();
        let find = |name| find_name(&tree, name);
        let switch = find("Memory").expect("memory setting");
        assert_eq!(switch["role"], "switch");
        assert!(
            switch["states"]
                .as_array()
                .is_some_and(|states| states.contains(&json!("checked")))
        );
        assert!(find("Memory is unavailable.").is_some());
        assert!(find("Try again").is_some());
    });
}

fn find_name<'a>(tree: &'a Value, name: &str) -> Option<&'a Value> {
    if tree["name"] == name && matches!(tree["role"].as_str(), Some("switch" | "button" | "alert"))
    {
        return Some(tree);
    }
    tree["children"]
        .as_array()?
        .iter()
        .find_map(|child| find_name(child, name))
}
