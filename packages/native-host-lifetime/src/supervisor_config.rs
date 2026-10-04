//! Configuration arrives only after native parent-pipe bootstrap, never HTTP/RPC.
use crate::channel_wire::ServicePolicy;
use crate::{Command, Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Component, Path};

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct NodeProgram {
    pub node: String,
    pub entry: String,
    pub cwd: String,
    pub loader: Option<String>,
}
impl NodeProgram {
    pub(crate) fn command(&self) -> Result<Command> {
        for path in [&self.node, &self.entry, &self.cwd] {
            artifact(path)?;
        }
        let mut args = vec![];
        if let Some(loader) = &self.loader {
            // Loader is a trusted installed artifact, never manager/RPC-supplied.
            let raw = loader
                .strip_prefix("file:///")
                .ok_or(Error("native-artifact-path-invalid"))?;
            let mut decoded = Vec::new();
            let mut i = 0;
            while i < raw.len() {
                if raw.as_bytes()[i] == b'%' {
                    if i + 3 > raw.len() {
                        return Err(Error("native-artifact-path-invalid"));
                    }
                    decoded.push(
                        u8::from_str_radix(&raw[i + 1..i + 3], 16)
                            .map_err(|_| Error("native-artifact-path-invalid"))?,
                    );
                    i += 3;
                } else {
                    decoded.push(raw.as_bytes()[i]);
                    i += 1;
                }
            }
            artifact(
                &String::from_utf8(decoded).map_err(|_| Error("native-artifact-path-invalid"))?,
            )?;
            args.extend(["--import".into(), loader.clone()]);
        }
        args.push(self.entry.clone());
        Ok(Command {
            executable: self.node.clone().into(),
            args,
            directory: self.cwd.clone().into(),
            environment: std::env::vars()
                .filter(|(k, _)| {
                    !["NODE_CHANNEL_FD", "NODE_CHANNEL_SERIALIZATION_MODE"].contains(&k.as_str())
                })
                .collect(),
        })
    }
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BrokerConfig {
    pub program: NodeProgram,
    pub launcher_module: String,
    pub policy: ServicePolicy,
    pub binding_file: String,
    pub binding_sha256: String,
    pub entry_sha256: String,
    pub launcher_sha256: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct SupervisorConfig {
    pub v: u8,
    pub profile: String,
    pub generation: String,
    pub manager: NodeProgram,
    pub application: Value,
    pub broker: Option<BrokerConfig>,
}
impl SupervisorConfig {
    pub fn validate(&self) -> Result<()> {
        let uuid = self.generation.as_bytes();
        let valid_uuid = uuid.len() == 36
            && uuid.iter().enumerate().all(|(i, b)| {
                if [8, 13, 18, 23].contains(&i) {
                    *b == b'-'
                } else {
                    b.is_ascii_digit() || (b'a'..=b'f').contains(b)
                }
            });
        if self.v != 1 || !crate::channel_wire::is_hex(&self.profile) || !valid_uuid {
            return Err(Error("native-supervisor-scope-invalid"));
        }
        self.manager.command()?;
        if let Some(broker) = &self.broker {
            broker.program.command()?;
            verify_artifact(&broker.binding_file, &broker.binding_sha256)?;
            verify_artifact(&broker.program.entry, &broker.entry_sha256)?;
            verify_artifact(&broker.launcher_module, &broker.launcher_sha256)?;
            artifact(&broker.launcher_module)?;
            artifact(&broker.policy.executable)?;
            artifact(&broker.policy.cwd)?;
            if !Path::new(&broker.launcher_module)
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|s| {
                    matches!(
                        s,
                        "native-service-launcher.js" | "native-service-launcher.ts"
                    )
                })
                || broker.policy.args_prefix.is_empty()
                || !broker
                    .policy
                    .args_prefix
                    .windows(2)
                    .any(|p| p == ["service", "start"])
            {
                return Err(Error("native-service-policy-invalid"));
            }
            if Path::new(&broker.binding_file)
                .extension()
                .and_then(|s| s.to_str())
                != Some("node")
            {
                return Err(Error("native-service-binding-required"));
            }
            #[cfg(not(feature = "fixtures"))]
            if !broker
                .policy
                .args_prefix
                .starts_with(&["service".into(), "start".into()])
            {
                return Err(Error("native-service-canonical-args-required"));
            }
        }
        Ok(())
    }
}
pub(crate) fn verify_artifact(path: &str, digest: &str) -> Result<()> {
    artifact(path)?;
    if !crate::channel_wire::is_hex(digest) {
        return Err(Error("native-artifact-digest-invalid"));
    }
    let file = std::fs::File::open(path).map_err(|_| Error("native-artifact-unavailable"))?;
    use std::io::Read;
    let mut bytes = Vec::new();
    file.take(32 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error("native-artifact-unavailable"))?;
    if bytes.len() > 32 * 1024 * 1024 || crate::runtime_wire::digest(&bytes) != digest {
        return Err(Error("native-artifact-digest-refused"));
    }
    Ok(())
}
pub(crate) fn artifact(path: &str) -> Result<()> {
    use crate::handle::Handle;
    use windows_sys::Win32::Storage::FileSystem::*;
    let p = Path::new(path);
    if !p.is_absolute()
        || path.contains('\0')
        || path.starts_with("\\\\")
        || p.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(Error("native-artifact-path-invalid"));
    }
    // Read-only native ancestor checks. No ACL repair or caller-claimed root attestation.
    for part in p.ancestors() {
        let wide: Vec<u16> = part.to_string_lossy().encode_utf16().chain([0]).collect();
        let handle = unsafe {
            Handle::take(CreateFileW(
                wide.as_ptr(),
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            ))?
        };
        let mut info: FILE_ATTRIBUTE_TAG_INFO = unsafe { std::mem::zeroed() };
        if unsafe {
            GetFileInformationByHandleEx(
                handle.raw(),
                FileAttributeTagInfo,
                &mut info as *mut _ as _,
                std::mem::size_of_val(&info) as u32,
            )
        } == 0
            || info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return Err(Error("native-artifact-reparse-refused"));
        }
    }
    Ok(())
}
