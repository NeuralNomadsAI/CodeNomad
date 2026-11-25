use crate::catalog::{Member, Session};
use codenomad_client::{git::Worktree, same_server_path};
use std::collections::{HashMap, HashSet};

/// Exact host/service locations establish ownership; native project IDs only discover candidates.
pub(super) fn rows(
    members: Vec<Member>,
    opened: &str,
    trees: &[Worktree],
    selected: Option<&str>,
) -> Vec<Session> {
    let by_id: HashMap<_, _> = members
        .iter()
        .filter(|m| !m.session.id.starts_with("ses_cn_schedule_"))
        .map(|m| (m.session.id.as_str(), m))
        .collect();
    let mut roots = HashSet::new();
    let mut resolved = HashMap::new();
    for (&id, member) in &by_id {
        if selected == Some(id)
            || same_server_path(&member.directory, opened)
            || trees.iter().any(|tree| {
                same_server_path(&member.directory, &tree.directory)
                    || tree
                        .service_directory
                        .as_ref()
                        .is_some_and(|path| same_server_path(&member.directory, path))
            })
        {
            if let Some(root) = root(id, &by_id, &mut resolved) {
                roots.insert(root);
            }
        }
    }
    members
        .iter()
        .filter(|m| roots.contains(m.session.id.as_str()))
        .map(|m| m.session.clone())
        .collect()
}

fn root<'a>(
    start: &'a str,
    members: &HashMap<&'a str, &'a Member>,
    resolved: &mut HashMap<&'a str, Option<&'a str>>,
) -> Option<&'a str> {
    let mut path = Vec::new();
    let mut seen = HashSet::new();
    let mut id = start;
    let root = loop {
        if let Some(root) = resolved.get(id) {
            break *root;
        }
        if !seen.insert(id) {
            break None;
        }
        path.push(id);
        match members.get(id).map(|m| m.parent.as_deref()) {
            Some(Some(parent)) => id = parent,
            Some(None) => break Some(id),
            None => break None,
        }
    };
    resolved.extend(path.into_iter().map(|id| (id, root)));
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    fn member(id: &str, directory: &str, parent: Option<&str>) -> Member {
        Member {
            session: Session {
                id: id.into(),
                title: id.into(),
            },
            directory: directory.into(),
            parent: parent.map(str::to_owned),
        }
    }

    #[test]
    fn families_follow_owned_host_and_service_directories_not_clone_identity() {
        let host = "D:/main";
        let linked = Worktree {
            head: None,
            slug: "linked".into(),
            label: None,
            directory: "D:/linked".into(),
            service_directory: Some("/mnt/d/linked".into()),
            branch: None,
            missing: false,
        };
        let members = vec![
            member("linked-child", "/mnt/d/linked", Some("family")),
            member("family", "D:/clone", None),
            member("foreign", "D:/clone", None),
            member("local", "d:/MAIN", None),
            member("loop", host, Some("loop")),
        ];
        let ids = |members, trees: &[Worktree]| {
            rows(members, host, trees, None)
                .into_iter()
                .map(|row| row.id)
                .collect::<Vec<_>>()
        };
        assert_eq!(ids(members.clone(), &[]), ["local"]);
        assert_eq!(ids(members, &[linked]), ["family", "local"]);
    }
}
