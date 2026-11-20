//! Release signing for the CodeNomad Rust installer (minisign format).
//!   cnrs-release keygen <folder>                 release.pub + release.key (unencrypted, test keys)
//!   cnrs-release sign <release> <release.key>    writes SHA256SUMS.minisig
//!   cnrs-release verify <release> <release.pub>  prints the verified version
//!   cnrs-release manifest <release> <serial> [<next.pub>]   writes MANIFEST (before SHA256SUMS)
//!   cnrs-release pin <release.pub> <trust> <trust copy> <releases>     first install
//!   cnrs-release admit|commit <release> <trust> <trust copy> <releases>
//!   cnrs-release staged <release> <trust> <trust copy>   local rollback target
//!   cnrs-release status <trust> <trust copy>
//! The signature covers SHA256SUMS; its trusted comment binds the version.
//! Verification also requires every file of the release to be listed (an
//! unlisted file, such as a planted DLL beside the binary, is refused).
//! Serial, key rotation and the trust state: see trust.rs.

mod trust;

use minisign::{KeyPair, PublicKey, PublicKeyBox, SecretKeyBox, SignatureBox};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    process::ExitCode,
};

type Failure = Box<dyn std::error::Error>;
const SUMS: &str = "SHA256SUMS";
const SIGNATURE: &str = "SHA256SUMS.minisig";

fn comment(version: &str) -> String {
    format!("codenomad-rs release {version}")
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
        && version.bytes().all(|b| b.is_ascii_alphanumeric() || b"+.-".contains(&b))
}

fn version(release: &Path) -> Result<String, Failure> {
    let version = fs::read_to_string(release.join("VERSION"))?.trim().to_owned();
    if !valid_version(&version) {
        return Err(format!("invalid release version {version:?}").into());
    }
    Ok(version)
}

/// Every regular file below `root`, as `/`-separated relative names; links are refused.
fn files(root: &Path, dir: &Path, out: &mut BTreeSet<String>) -> Result<(), Failure> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_symlink() {
            return Err(format!("release contains a link: {}", path.display()).into());
        } else if kind.is_dir() {
            files(root, &path, out)?;
        } else {
            let relative = path.strip_prefix(root)?.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect::<Vec<_>>().join("/");
            out.insert(relative);
        }
    }
    Ok(())
}

fn check_sums(release: &Path, sums: &str) -> Result<(), Failure> {
    let mut listed = BTreeSet::new();
    for line in sums.lines() {
        let (hash, name) = line.split_once("  ").ok_or("malformed SHA256SUMS line")?;
        let safe = !name.is_empty()
            && !name.starts_with('/')
            && !name.contains('\\')
            && !name.contains(':')
            && name.split('/').all(|part| !part.is_empty() && part != "." && part != "..");
        if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) || !safe {
            return Err(format!("malformed SHA256SUMS entry {name:?}").into());
        }
        let actual = format!("{:x}", Sha256::digest(fs::read(release.join(name))?));
        if actual != hash {
            return Err(format!("checksum mismatch: {name}").into());
        }
        if !listed.insert(name.to_owned()) {
            return Err(format!("duplicate SHA256SUMS entry {name}").into());
        }
    }
    let mut present = BTreeSet::new();
    files(release, release, &mut present)?;
    present.remove(SUMS);
    present.remove(SIGNATURE);
    if let Some(extra) = present.difference(&listed).next() {
        return Err(format!("file not covered by SHA256SUMS: {extra}").into());
    }
    if !listed.contains("VERSION") {
        return Err("VERSION is not covered by SHA256SUMS".into());
    }
    Ok(())
}

fn keygen(folder: &Path) -> Result<(), Failure> {
    let (public, secret) = (folder.join("release.pub"), folder.join("release.key"));
    if public.exists() || secret.exists() {
        return Err("release keys already exist".into());
    }
    fs::create_dir_all(folder)?;
    let pair = KeyPair::generate_unencrypted_keypair()?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    use std::io::Write;
    options.open(&secret)?.write_all(pair.sk.to_box(Some("CodeNomad Rust test release key"))?.to_string().as_bytes())?;
    fs::write(&public, pair.pk.to_box()?.to_string())?;
    println!("{}", public.display());
    Ok(())
}

fn sign(release: &Path, key: &Path) -> Result<(), Failure> {
    let version = version(release)?;
    let sums = fs::read_to_string(release.join(SUMS))?;
    check_sums(release, &sums)?;
    trust::manifest(release)?;
    let sk = SecretKeyBox::from_string(&fs::read_to_string(key)?)?.into_unencrypted_secret_key()?;
    let signature = minisign::sign(None, &sk, Cursor::new(sums.as_bytes()), Some(&comment(&version)), Some("CodeNomad Rust release"))?;
    fs::write(release.join(SIGNATURE), signature.to_string())?;
    println!("{version}");
    Ok(())
}

fn verify(release: &Path, key: &Path) -> Result<(), Failure> {
    let pk = PublicKeyBox::from_string(&fs::read_to_string(key)?)?.into_public_key()?;
    println!("{}", signed(release, &pk)?);
    Ok(())
}

/// Signature by `pk`, signed version, every file listed and matching, valid MANIFEST.
fn signed(release: &Path, pk: &PublicKey) -> Result<String, Failure> {
    let version = version(release)?;
    let signature = fs::read_to_string(release.join(SIGNATURE)).map_err(|_| "release is not signed (SHA256SUMS.minisig missing)")?;
    let signature = SignatureBox::from_string(&signature)?;
    let sums = fs::read(release.join(SUMS))?;
    // Legacy (non-prehashed-only) signatures are refused.
    minisign::verify(pk, &signature, Cursor::new(&sums), true, false, false).map_err(|e| format!("bad release signature: {e}"))?;
    if signature.trusted_comment()? != comment(&version) {
        return Err("signed version differs from VERSION".into());
    }
    check_sums(release, std::str::from_utf8(&sums)?)?;
    trust::manifest(release)?;
    Ok(version)
}

fn main() -> ExitCode {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    let result = match args.iter().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>().as_slice() {
        [cmd, _] if cmd == "keygen" => keygen(&args[1]),
        [cmd, _, _] if cmd == "sign" => sign(&args[1], &args[2]),
        [cmd, _, _] if cmd == "verify" => verify(&args[1], &args[2]),
        [cmd, _, serial] if cmd == "manifest" => trust::write_manifest(&args[1], serial, None),
        [cmd, _, serial, _] if cmd == "manifest" => trust::write_manifest(&args[1], serial, Some(args[3].as_path())),
        [cmd, _, _, _, _] if cmd == "pin" => trust::pin(&args[1], &[args[2].as_path(), args[3].as_path()], &args[4]),
        [cmd, _, _, _, _] if cmd == "admit" => trust::check(&args[1], &[args[2].as_path(), args[3].as_path()], &args[4]).map(|v| println!("{v}")),
        [cmd, _, _, _, _] if cmd == "commit" => trust::commit(&args[1], &[args[2].as_path(), args[3].as_path()], &args[4]).map(|v| println!("{v}")),
        [cmd, _, _, _] if cmd == "staged" => trust::staged(&args[1], &[args[2].as_path(), args[3].as_path()]).map(|v| println!("{v}")),
        [cmd, _, _] if cmd == "status" => trust::status(&[args[1].as_path(), args[2].as_path()]).map(|s| println!("{s}")),
        _ => Err("usage: cnrs-release keygen <folder> | sign <release> <key> | verify <release> <pub> | manifest <release> <serial> [<next.pub>]\n  | pin <pub> <trust> <copy> <releases> | admit|commit <release> <trust> <copy> <releases> | staged <release> <trust> <copy> | status <trust> <copy>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("cnrs-release: {e}");
            ExitCode::FAILURE
        }
    }
}
