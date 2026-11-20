//! `@opencode/cli` and its platform packages from the registry: packuments, the platform choice of
//! the package's `postinstall.mjs`, tarballs checked against `dist.integrity` (sha512) before
//! anything is read from them, and the extraction of named regular files only.
use std::{
    fs,
    io::{Read, Write},
    path::Path,
};

use base64::Engine;
use reqwest::{Client, Url};
use serde_json::Value;
use sha2::{Digest, Sha512};

use super::npmrc::Config;

pub const CLI: &str = "@opencode/cli";
const MAX_PACKUMENT: usize = 64 * 1024 * 1024;
const MAX_TARBALL: u64 = 1024 * 1024 * 1024;

fn failed(what: &str) -> String {
    format!("OpenCode registry request failed ({what})")
}

/// The packument (`<registry>/@opencode%2fcli`), with the install metadata npm requests.
pub async fn packument(client: &Client, config: &Config, name: &str) -> Result<Value, String> {
    let url = config.registry()?.join(&name.replacen('/', "%2f", 1)).map_err(|_| failed("name"))?;
    let response = config
        .request(client, url)
        .header("accept", "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*")
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|_| failed("unreachable"))?;
    if !response.status().is_success() {
        return Err(format!("OpenCode registry responded with {}", response.status().as_u16()));
    }
    crate::opencode::read_json(response, MAX_PACKUMENT).await.map_err(|_| failed("invalid packument"))
}

/// The registry's `latest` dist-tag, an exact stable version.
pub fn latest(packument: &Value) -> Result<String, String> {
    let version = packument["dist-tags"]["latest"].as_str().filter(|v| exact(v));
    version.map(str::to_owned).ok_or_else(|| "The latest channel did not resolve to a valid version".into())
}

pub fn exact(version: &str) -> bool {
    let parts: Vec<&str> = version.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.len() <= 9 && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `name@version` from its packument, which must name itself.
pub fn manifest(packument: &Value, name: &str, version: &str) -> Result<Value, String> {
    let manifest = &packument["versions"][version];
    if manifest["name"] != name || manifest["version"] != version {
        return Err(format!("The registry does not provide {name}@{version}"));
    }
    Ok(manifest.clone())
}

/// The sha512 of `dist.integrity` (the strongest hash npm checks); a package without one is refused.
fn integrity(manifest: &Value) -> Result<Vec<u8>, String> {
    let sri = manifest["dist"]["integrity"].as_str().unwrap_or_default();
    sri.split_whitespace()
        .find_map(|h| h.strip_prefix("sha512-"))
        .map(|h| h.split('?').next().unwrap_or(h))
        .and_then(|h| base64::engine::general_purpose::STANDARD.decode(h).ok())
        .filter(|h| h.len() == 64)
        .ok_or_else(|| "The registry package has no sha512 integrity".into())
}

/// Downloads `manifest`'s tarball into `file`, hashing it on the way; a hash other than
/// `dist.integrity` removes the file before anything reads it.
pub async fn download(client: &Client, config: &Config, manifest: &Value, file: &Path) -> Result<(), String> {
    let expected = integrity(manifest)?;
    let url = manifest["dist"]["tarball"].as_str().and_then(|u| Url::parse(u).ok());
    let url = url.filter(|u| matches!(u.scheme(), "http" | "https")).ok_or_else(|| failed("tarball"))?;
    let mut response = config
        .request(client, url)
        .timeout(std::time::Duration::from_secs(300))
        .send()
        .await
        .map_err(|_| failed("tarball unreachable"))?;
    if !response.status().is_success() {
        return Err(format!("OpenCode registry responded with {} for a tarball", response.status().as_u16()));
    }
    let mut out = fs::File::create(file).map_err(|_| "Cannot write the OpenCode download".to_owned())?;
    let (mut hash, mut size) = (Sha512::new(), 0u64);
    while let Some(chunk) = response.chunk().await.map_err(|_| failed("tarball interrupted"))? {
        size += chunk.len() as u64;
        if size > MAX_TARBALL {
            return Err("The OpenCode package exceeds the size limit".into());
        }
        hash.update(&chunk);
        out.write_all(&chunk).map_err(|_| "Cannot write the OpenCode download".to_owned())?;
    }
    out.sync_all().map_err(|_| "Cannot write the OpenCode download".to_owned())?;
    if hash.finalize().as_slice() != expected.as_slice() {
        drop(out);
        let _ = fs::remove_file(file);
        let name = manifest["name"].as_str().unwrap_or("package");
        return Err(format!("integrity_mismatch: {name} does not match its registry integrity"));
    }
    Ok(())
}

/// Copies the regular files of `tarball` whose path below its top folder is in `wanted` to the
/// paired targets. Any link, device or unsafe path in the archive refuses the whole package; the
/// targets come from the caller, never from entry names.
pub fn extract(tarball: &Path, wanted: &[(&str, &Path)]) -> Result<(), String> {
    let invalid = |why: &str| format!("Unsafe OpenCode package ({why})");
    let file = fs::File::open(tarball).map_err(|_| invalid("unreadable"))?;
    let mut tar = flate2::read::GzDecoder::new(std::io::BufReader::new(file));
    let mut found = vec![false; wanted.len()];
    let mut long_name: Option<String> = None;
    let mut header = [0u8; 512];
    loop {
        if tar.read_exact(&mut header).is_err() {
            return Err(invalid("truncated"));
        }
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let field = |range: std::ops::Range<usize>| {
            let raw = &header[range];
            String::from_utf8_lossy(&raw[..raw.iter().position(|b| *b == 0).unwrap_or(raw.len())]).into_owned()
        };
        let octal = field(124..136);
        let size = u64::from_str_radix(octal.trim(), 8).map_err(|_| invalid("size"))?;
        if size > MAX_TARBALL {
            return Err(invalid("size"));
        }
        let kind = header[156];
        let name = long_name.take().unwrap_or_else(|| {
            let (prefix, name) = (field(345..500), field(0..100));
            if header[257..262] == *b"ustar" && !prefix.is_empty() { format!("{prefix}/{name}") } else { name }
        });
        let padded = size.div_ceil(512) * 512;
        let mut body = (&mut tar).take(padded);
        match kind {
            b'x' | b'L' => {
                let mut record = Vec::new();
                body.by_ref().take(size.min(64 * 1024)).read_to_end(&mut record).map_err(|_| invalid("header"))?;
                std::io::copy(&mut body, &mut std::io::sink()).map_err(|_| invalid("header"))?;
                long_name = if kind == b'L' {
                    Some(String::from_utf8_lossy(&record).trim_end_matches('\0').to_owned())
                } else {
                    pax_path(&record)
                };
                continue;
            }
            b'g' | b'5' => {
                std::io::copy(&mut body, &mut std::io::sink()).map_err(|_| invalid("header"))?;
                continue;
            }
            b'0' | 0 => {}
            _ => return Err(invalid("link or special file")),
        }
        let relative = safe_relative(&name).ok_or_else(|| invalid("path"))?;
        match wanted.iter().position(|(path, _)| *path == relative) {
            Some(index) if !found[index] => {
                found[index] = true;
                let mut out =
                    fs::File::create(wanted[index].1).map_err(|_| "Cannot write the OpenCode package".to_owned())?;
                let copied =
                    std::io::copy(&mut body.by_ref().take(size), &mut out).map_err(|_| invalid("truncated"))?;
                if copied != size {
                    return Err(invalid("truncated"));
                }
                out.sync_all().map_err(|_| "Cannot write the OpenCode package".to_owned())?;
                std::io::copy(&mut body, &mut std::io::sink()).map_err(|_| invalid("truncated"))?;
            }
            Some(_) => return Err(invalid("duplicate entry")),
            None => {
                std::io::copy(&mut body, &mut std::io::sink()).map_err(|_| invalid("truncated"))?;
            }
        }
    }
    match wanted.iter().zip(&found).find(|(_, f)| !**f) {
        Some(((path, _), _)) => Err(format!("The OpenCode package has no {path}")),
        None => Ok(()),
    }
}

fn pax_path(record: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(record);
    text.lines().find_map(|line| line.split_once(' ')?.1.strip_prefix("path=").map(str::to_owned))
}

/// The entry's path below the archive's top folder; `None` for absolute, parent, drive or NUL paths.
pub fn safe_relative(name: &str) -> Option<String> {
    if name.contains(['\\', '\0', ':']) || name.starts_with('/') {
        return None;
    }
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty() && *p != ".").collect();
    if parts.len() < 2 || parts.contains(&"..") {
        return None;
    }
    Some(parts[1..].join("/"))
}

/// `postinstall.mjs` of `@opencode/cli`: the platform packages to try, in order.
pub fn candidates(dependencies: &serde_json::Map<String, Value>) -> Result<Vec<String>, String> {
    let platform = if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let native = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    // An x64 build emulated on Windows ARM64 still sees the host CPU here.
    let arm_host = std::env::var("PROCESSOR_IDENTIFIER").is_ok_and(|p| p.starts_with("ARM"));
    let arch = if platform == "windows" && native == "x64" && arm_host { "arm64" } else { native };
    let suffix = format!("-{platform}-{arch}");
    let base = dependencies.keys().find(|n| n.ends_with(&suffix)).cloned();
    let base = base.ok_or_else(|| format!("OpenCode does not provide a binary for {platform}-{arch}"))?;
    let baseline = arch == "x64" && !avx2();
    let v = |s: &str| format!("{base}{s}");
    let mut names = match (platform, arch, musl()) {
        ("linux", "x64", true) if baseline => vec![v("-baseline-musl"), v("-musl"), v("-baseline"), v("")],
        ("linux", "x64", true) => vec![v("-musl"), v("-baseline-musl"), v(""), v("-baseline")],
        ("linux", _, true) => vec![v("-musl"), v("")],
        ("linux", "x64", false) if baseline => vec![v("-baseline"), v(""), v("-baseline-musl"), v("-musl")],
        ("linux", "x64", false) => vec![v(""), v("-baseline"), v("-musl"), v("-baseline-musl")],
        ("linux", _, false) => vec![v(""), v("-musl")],
        (_, "x64", _) if baseline => vec![v("-baseline"), v("")],
        (_, "x64", _) => vec![v(""), v("-baseline")],
        _ => vec![v("")],
    };
    if platform == "windows" && arch == "arm64" {
        let x64 = base.trim_end_matches("-arm64").to_owned() + "-x64";
        names.extend([format!("{x64}-baseline"), x64]);
    }
    names.retain(|n| dependencies.contains_key(n));
    Ok(names)
}

fn avx2() -> bool {
    #[cfg(target_arch = "x86_64")]
    return std::arch::is_x86_feature_detected!("avx2");
    #[cfg(not(target_arch = "x86_64"))]
    false
}

fn musl() -> bool {
    if !cfg!(target_os = "linux") {
        return false;
    }
    if Path::new("/etc/alpine-release").exists() {
        return true;
    }
    let output = std::process::Command::new("ldd").arg("--version").output();
    output.is_ok_and(|o| {
        format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr))
            .to_lowercase()
            .contains("musl")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entry_paths_stay_below_the_package_folder() {
        assert_eq!(safe_relative("package/bin/opencode.exe").as_deref(), Some("bin/opencode.exe"));
        assert_eq!(safe_relative("./package//./package.json").as_deref(), Some("package.json"));
        for bad in ["/etc/passwd", "package/../x", "package\\bin", "C:/x/y", "package", "package/a\0b"] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
    }

    #[test]
    fn platform_candidates_follow_the_postinstall_order() {
        let names = [
            "windows-x64",
            "windows-x64-baseline",
            "windows-arm64",
            "linux-x64",
            "linux-x64-baseline",
            "linux-x64-musl",
            "linux-x64-baseline-musl",
            "linux-arm64",
            "linux-arm64-musl",
            "darwin-x64",
            "darwin-x64-baseline",
            "darwin-arm64",
        ];
        let deps = names.iter().map(|n| (format!("@opencode/cli-{n}"), Value::from("1.0.0"))).collect();
        let list = candidates(&deps).unwrap();
        assert!(!list.is_empty() && list.iter().all(|n| deps.contains_key(n)));
        if cfg!(all(windows, target_arch = "x86_64"))
            && std::env::var("PROCESSOR_IDENTIFIER").is_ok_and(|p| !p.starts_with("ARM"))
        {
            let expected = if avx2() {
                ["@opencode/cli-windows-x64", "@opencode/cli-windows-x64-baseline"]
            } else {
                ["@opencode/cli-windows-x64-baseline", "@opencode/cli-windows-x64"]
            };
            assert_eq!(list, expected);
        }
        assert!(candidates(&serde_json::Map::new()).unwrap_err().starts_with("OpenCode does not provide a binary for"));
    }

    fn tar_entry(out: &mut Vec<u8>, name: &str, kind: u8, body: &[u8]) {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[124..135].copy_from_slice(format!("{:011o}", body.len()).as_bytes());
        header[156] = kind;
        header[257..262].copy_from_slice(b"ustar");
        out.extend(header);
        out.extend(body);
        out.resize(out.len().div_ceil(512) * 512, 0);
    }
    fn tgz(entries: &[(&str, u8, &[u8])]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, kind, body) in entries {
            tar_entry(&mut tar, name, *kind, body);
        }
        tar.resize(tar.len() + 1024, 0);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&tar).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn only_named_regular_files_are_extracted_and_links_refuse_the_package() {
        let dir = crate::shared::test_dir("install-extract");
        fs::create_dir_all(&dir).unwrap();
        let archive = dir.join("p.tgz");
        let (manifest, binary) = (dir.join("package.json"), dir.join("bin"));
        let pax = b"29 path=package/bin/opencode\n";
        fs::write(
            &archive,
            tgz(&[
                ("package/package.json", b'0', b"{}"),
                ("package/README", b'0', b"x"),
                ("PaxHeader", b'x', pax),
                ("ignored-by-pax", b'0', b"BIN"),
            ]),
        )
        .unwrap();
        extract(&archive, &[("package.json", &manifest), ("bin/opencode", &binary)]).unwrap();
        assert_eq!((fs::read(&manifest).unwrap(), fs::read(&binary).unwrap()), (b"{}".to_vec(), b"BIN".to_vec()));
        assert!(!dir.join("README").exists());
        for (bad, why) in [
            (vec![("package/bin/opencode", b'2', &b""[..])], "link"),
            (vec![("package/../../escape", b'0', &b"x"[..])], "path"),
        ] {
            fs::write(&archive, tgz(&bad)).unwrap();
            assert!(extract(&archive, &[("package.json", &manifest)]).unwrap_err().contains(why), "{why}");
        }
        fs::write(&archive, tgz(&[("package/other", b'0', b"x")])).unwrap();
        assert_eq!(
            extract(&archive, &[("package.json", &manifest)]).unwrap_err(),
            "The OpenCode package has no package.json"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn integrity_requires_a_sha512() {
        let hash = base64::engine::general_purpose::STANDARD.encode([7u8; 64]);
        let m = |sri: &str| serde_json::json!({"dist": {"integrity": sri}});
        assert_eq!(integrity(&m(&format!("sha1-abc sha512-{hash}"))).unwrap(), vec![7u8; 64]);
        assert!(integrity(&m("sha1-abc")).is_err() && integrity(&m("sha512-short")).is_err());
    }
}
