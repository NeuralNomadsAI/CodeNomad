//! The connected server's folders (`GET /api/filesystem`), for choosing a project from a
//! machine whose own folder picker cannot name them: a phone, a browser.
use crate::{
    backend::{Backend, read_json},
    history::Result,
};
use serde_json::Value;

/// A folder of the server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub name: String,
    /// What [`Backend::folders`] takes to list it.
    pub path: String,
}

/// One listed folder of the server and where to go from it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Folders {
    /// Its absolute path on the server, to open it as a project. The list of a Windows
    /// server's drives has none.
    pub absolute: Option<String>,
    /// What [`Backend::folders`] takes to list its parent.
    pub parent: Option<String>,
    /// The home folder of a server that serves more than its root.
    pub home: Option<String>,
    pub folders: Vec<Folder>,
}

/// The absolute path of `relative` under the server's `root`, in the root's spelling.
fn under(root: &str, relative: &str) -> String {
    if matches!(relative, "" | "." | "./") {
        return root.into();
    }
    let separator = if root.contains('\\') { '\\' } else { '/' };
    let relative: String = relative
        .trim_start_matches(['/', '\\'])
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\') {
                separator
            } else {
                c
            }
        })
        .collect();
    if root.ends_with(separator) {
        format!("{root}{relative}")
    } else {
        format!("{root}{separator}{relative}")
    }
}

pub(crate) fn parse(reply: &Value) -> Result<Folders> {
    let text = |value: &Value, key: &str| {
        value[key]
            .as_str()
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let metadata = &reply["metadata"];
    let current = text(metadata, "currentPath").ok_or("invalid folder listing")?;
    let absolute = match metadata["pathKind"].as_str() {
        Some("drives") => None,
        Some("relative") => Some(under(
            metadata["rootPath"].as_str().unwrap_or_default(),
            &current,
        )),
        _ => text(metadata, "displayPath"),
    };
    let folders = reply["entries"]
        .as_array()
        .filter(|entries| entries.len() <= 4096)
        .ok_or("invalid folder listing")?
        .iter()
        .filter(|entry| entry["type"] == "directory")
        .filter_map(|entry| {
            Some(Folder {
                name: text(entry, "name")?,
                path: text(entry, "path")?,
            })
        })
        .collect();
    Ok(Folders {
        absolute,
        parent: text(metadata, "parentPath"),
        home: (metadata["scope"] == "unrestricted")
            .then(|| text(metadata, "homePath"))
            .flatten(),
        folders,
    })
}

impl Backend {
    /// Lists the folders in `path`, as a [`Folder::path`] or [`Folders::parent`] spells it, or
    /// in the folder the server starts from.
    pub async fn folders(&self, path: Option<&str>) -> Result<Folders> {
        // An empty `includeFiles` is how the server is asked for folders alone.
        let mut query = vec![("includeFiles", "")];
        query.extend(path.map(|path| ("path", path)));
        let reply = read_json(
            self.client
                .get(format!("{}api/filesystem", self.base))
                .query(&query)
                .send()
                .await?
                .error_for_status()?,
        )
        .await?;
        parse(&reply)
    }
}
