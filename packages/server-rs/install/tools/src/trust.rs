//! Release trust state: pinned key, monotonic release serial and key rotation.
//!
//! Each release carries MANIFEST, listed in SHA256SUMS and so covered by the
//! signature:
//!   serial <n>          release number (1 or more); an installation only accepts
//!                       a serial above the highest it accepted
//!   next-key <base64>   optional: the key that signs every later release
//! The installation keeps the same trust record in two files (config and
//! state). The copy with the higher serial wins: each copy is replaced
//! atomically, so an interrupted commit or one restored copy cannot lower it.
//!   codenomad-rs release trust 1
//!   key <base64>                  pinned key
//!   serial <n>                    highest accepted serial (0 before the first)
//!   release <version> <digest>    the release that set it (digest: SHA-256 of SHA256SUMS)
//!   retired <KEYID>               keys rotated out
//!   accepted <version> <digest>   releases accepted here (local rollback targets)

use super::{Failure, SIGNATURE, SUMS, check_sums, signed, valid_version, version};
use minisign::{PublicKey, PublicKeyBox, SignatureBox};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

const MANIFEST: &str = "MANIFEST";
const HEADER: &str = "codenomad-rs release trust 1";
const ACCEPTED_KEPT: usize = 32;
const NO_TRUST: &str = "no release trust state: run the installer with the public key";

pub struct Manifest {
    pub serial: u64,
    pub next_key: Option<PublicKey>,
}

#[derive(Clone, PartialEq, Debug)]
pub struct Trust {
    key: String,
    serial: u64,
    release: Option<(String, String)>,
    retired: Vec<String>,
    accepted: Vec<(String, String)>,
}

struct Admission {
    version: String,
    serial: u64,
    digest: String,
    next_key: Option<String>,
    idempotent: bool,
}

fn serial(text: &str) -> Result<u64, Failure> {
    let ok = !text.is_empty() && text.len() <= 18 && text.bytes().all(|b| b.is_ascii_digit()) && (text == "0" || !text.starts_with('0'));
    if !ok {
        return Err(format!("invalid serial {text:?}").into());
    }
    Ok(text.parse()?)
}

fn key(text: &str) -> Result<PublicKey, Failure> {
    PublicKey::from_base64(text.trim()).map_err(|e| Failure::from(format!("invalid key: {e}")))
}

fn id(keynum: &[u8]) -> String {
    format!("{:016X}", u64::from_le_bytes(keynum.try_into().unwrap_or([0; 8])))
}

fn hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn entry(version: &str, digest: &str) -> Result<(String, String), Failure> {
    if !valid_version(version) || digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
        return Err(format!("malformed release entry {version} {digest}").into());
    }
    Ok((version.to_owned(), digest.to_owned()))
}

pub fn manifest(release: &Path) -> Result<Manifest, Failure> {
    let text = fs::read_to_string(release.join(MANIFEST)).map_err(|_| "release has no MANIFEST (signed serial)")?;
    let (mut number, mut next_key) = (None, None);
    for line in text.lines() {
        match line.split_once(' ') {
            Some(("serial", v)) if number.is_none() => number = Some(serial(v)?),
            Some(("next-key", v)) if next_key.is_none() => next_key = Some(key(v)?),
            _ => return Err(format!("malformed MANIFEST line {line:?}").into()),
        }
    }
    match number {
        Some(0) | None => Err("MANIFEST needs a serial of 1 or more".into()),
        Some(serial) => Ok(Manifest { serial, next_key }),
    }
}

/// `cnrs-release manifest <release> <serial> [<next.pub>]`, before SHA256SUMS and signing.
pub fn write_manifest(release: &Path, number: &str, next: Option<&Path>) -> Result<(), Failure> {
    let mut text = format!("serial {}\n", serial(number)?);
    if let Some(file) = next {
        let pk = PublicKeyBox::from_string(&fs::read_to_string(file)?)?.into_public_key()?;
        text += &format!("next-key {}\n", pk.to_base64());
    }
    fs::write(release.join(MANIFEST), text)?;
    manifest(release).map(|_| ())
}

fn parse(text: &str) -> Result<Trust, Failure> {
    let mut lines = text.lines();
    if lines.next() != Some(HEADER) {
        return Err("unknown release trust format".into());
    }
    let (mut pinned, mut number, mut release, mut retired, mut accepted) = (None, None, None, vec![], vec![]);
    for line in lines {
        match line.split(' ').collect::<Vec<_>>().as_slice() {
            ["key", k] if pinned.is_none() => pinned = Some(key(k)?.to_base64()),
            ["serial", n] if number.is_none() => number = Some(serial(n)?),
            ["release", v, d] if release.is_none() => release = Some(entry(v, d)?),
            ["retired", k] if k.len() == 16 && k.bytes().all(|b| b.is_ascii_hexdigit()) => retired.push((*k).to_owned()),
            ["accepted", v, d] => accepted.push(entry(v, d)?),
            _ => return Err(format!("malformed release trust line {line:?}").into()),
        }
    }
    let (Some(key), Some(serial)) = (pinned, number) else { return Err("release trust state lacks key or serial".into()) };
    if (serial == 0) != release.is_none() {
        return Err("release trust state: serial and release disagree".into());
    }
    Ok(Trust { key, serial, release, retired, accepted })
}

fn render(t: &Trust) -> String {
    let mut s = format!("{HEADER}\nkey {}\nserial {}\n", t.key, t.serial);
    if let Some((v, d)) = &t.release {
        s += &format!("release {v} {d}\n");
    }
    for r in &t.retired {
        s += &format!("retired {r}\n");
    }
    for (v, d) in &t.accepted {
        s += &format!("accepted {v} {d}\n");
    }
    s
}

/// The copy with the highest serial; two copies at one serial must be identical.
pub fn load(paths: &[&Path]) -> Result<Option<Trust>, Failure> {
    let mut best: Option<Trust> = None;
    for path in paths {
        let text = match fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let trust = parse(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        let newer = match &best {
            Some(b) if trust.serial == b.serial && trust != *b => return Err("release trust copies disagree at the same serial".into()),
            Some(b) => trust.serial > b.serial,
            None => true,
        };
        if newer {
            best = Some(trust);
        }
    }
    Ok(best)
}

/// Each copy is replaced atomically (written, flushed, renamed), in order.
fn store(paths: &[&Path], trust: &Trust) -> Result<(), Failure> {
    let text = render(trust);
    for path in paths {
        if fs::read_to_string(path).is_ok_and(|t| t == text) {
            continue;
        }
        let temporary = path.with_file_name(format!("{}.tmp", path.file_name().ok_or("bad trust path")?.to_string_lossy()));
        let mut options = fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
        let mut file = options.open(&temporary)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            fs::File::open(parent)?.sync_all()?;
        }
    }
    Ok(())
}

/// A staged release with a higher serial than the trust state means the state
/// was restored or copied from an older one. The candidate itself is skipped
/// (a staging interrupted before its commit).
fn newer_staged(releases: &Path, candidate: &str, serial: u64) -> Result<(), Failure> {
    let Ok(entries) = fs::read_dir(releases) else { return Ok(()) };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".tmp") || !entry.file_type()?.is_dir() {
            continue;
        }
        let Ok(sums) = fs::read(entry.path().join(SUMS)) else { continue };
        if hex(&sums) == candidate {
            continue;
        }
        if let Ok(m) = manifest(&entry.path()) {
            if m.serial > serial {
                return Err(format!("the release trust state (serial {serial}) is older than the staged release {name} (serial {}): finish installing {name}, or the state was restored or copied", m.serial).into());
            }
        }
    }
    Ok(())
}

fn admit(release: &Path, trust: &Trust, releases: &Path) -> Result<Admission, Failure> {
    let version = version(release)?;
    let sums = fs::read(release.join(SUMS)).map_err(|_| "release has no SHA256SUMS")?;
    let digest = hex(&sums);
    check_sums(release, std::str::from_utf8(&sums)?)?;
    let manifest = manifest(release)?;
    newer_staged(releases, &digest, trust.serial)?;
    let same = |t: &Trust| t.release.as_ref().is_some_and(|(v, d)| *v == version && *d == digest);
    if manifest.serial == trust.serial && same(trust) {
        // Reinstalling the release that set the serial: it was verified then.
        return Ok(Admission { version, serial: manifest.serial, digest, next_key: None, idempotent: true });
    }
    if manifest.serial <= trust.serial {
        return Err(format!("release {version} has serial {}, not above the installed serial {} (downgrade refused)", manifest.serial, trust.serial).into());
    }
    let pinned = key(&trust.key)?;
    let signer = fs::read_to_string(release.join(SIGNATURE)).ok().and_then(|s| SignatureBox::from_string(&s).ok()).map(|s| id(s.keynum()));
    if let Some(signer) = signer.filter(|s| *s != id(pinned.keynum())) {
        return Err(if trust.retired.contains(&signer) {
            format!("release {version} is signed by the retired key {signer}")
        } else {
            format!("release {version} is signed by key {signer}, not by the pinned key {}", id(pinned.keynum()))
        }
        .into());
    }
    signed(release, &pinned)?;
    if hex(&fs::read(release.join(SUMS))?) != digest {
        return Err("SHA256SUMS changed during verification".into());
    }
    let next_key = match manifest.next_key {
        Some(next) if next.to_base64() == trust.key || trust.retired.contains(&id(next.keynum())) => {
            return Err(format!("next key {} is the pinned key or a retired one", id(next.keynum())).into());
        }
        next => next.map(|k| k.to_base64()),
    };
    Ok(Admission { version, serial: manifest.serial, digest, next_key, idempotent: false })
}

/// `cnrs-release pin <release.pub> <trust> <trust copy> <releases>`: first install.
pub fn pin(public: &Path, paths: &[&Path], releases: &Path) -> Result<(), Failure> {
    let pk = PublicKeyBox::from_string(&fs::read_to_string(public)?)?.into_public_key()?.to_base64();
    if let Some(trust) = load(paths)? {
        if trust.key != pk {
            return Err(format!("another release key is pinned ({})", id(key(&trust.key)?.keynum())).into());
        }
        return store(paths, &trust); // repairs a missing copy
    }
    if fs::read_dir(releases).is_ok_and(|mut e| e.any(|e| e.is_ok_and(|e| !e.file_name().to_string_lossy().ends_with(".tmp")))) {
        return Err("releases are staged but the release trust state is missing: restore it or purge the installation".into());
    }
    let pinned = id(key(&pk)?.keynum());
    store(paths, &Trust { key: pk, serial: 0, release: None, retired: vec![], accepted: vec![] })?;
    println!("pinned release key {pinned}");
    Ok(())
}

/// `cnrs-release admit <release> <trust> <trust copy> <releases>`: prints the version, writes nothing.
pub fn check(release: &Path, paths: &[&Path], releases: &Path) -> Result<String, Failure> {
    Ok(admit(release, &load(paths)?.ok_or(NO_TRUST)?, releases)?.version)
}

/// `cnrs-release commit …`: admits the staged release, then advances serial
/// and key in one atomic replacement of each copy.
pub fn commit(release: &Path, paths: &[&Path], releases: &Path) -> Result<String, Failure> {
    let trust = load(paths)?.ok_or(NO_TRUST)?;
    let a = admit(release, &trust, releases)?;
    let mut next = trust.clone();
    if !a.idempotent {
        if let Some(k) = a.next_key {
            let old = id(key(&trust.key)?.keynum());
            if !next.retired.contains(&old) {
                next.retired.push(old);
            }
            next.key = k;
        }
        next.serial = a.serial;
        next.release = Some((a.version.clone(), a.digest.clone()));
        next.accepted.retain(|(v, _)| *v != a.version);
        next.accepted.push((a.version.clone(), a.digest));
        let excess = next.accepted.len().saturating_sub(ACCEPTED_KEPT);
        next.accepted.drain(..excess);
    }
    store(paths, &next)?; // an idempotent commit repairs a stale copy
    Ok(a.version)
}

/// `cnrs-release staged <release> <trust> <trust copy>`: a local rollback target
/// must be a release accepted here, unchanged since (whatever key signed it).
pub fn staged(release: &Path, paths: &[&Path]) -> Result<String, Failure> {
    let trust = load(paths)?.ok_or(NO_TRUST)?;
    let version = version(release)?;
    let sums = fs::read(release.join(SUMS))?;
    check_sums(release, std::str::from_utf8(&sums)?)?;
    if !trust.accepted.contains(&(version.clone(), hex(&sums))) {
        return Err(format!("release {version} was not accepted on this installation").into());
    }
    Ok(version)
}

/// `cnrs-release status <trust> <trust copy>`: one JSON line.
pub fn status(paths: &[&Path]) -> Result<String, Failure> {
    let t = load(paths)?.ok_or(NO_TRUST)?;
    let list = |items: Vec<&String>| items.iter().map(|s| format!("\"{s}\"")).collect::<Vec<_>>().join(",");
    Ok(format!(
        "{{\"key\":\"{}\",\"serial\":{},\"release\":{},\"retired\":[{}],\"accepted\":[{}]}}",
        id(key(&t.key)?.keynum()),
        t.serial,
        t.release.as_ref().map_or("null".to_owned(), |(v, _)| format!("\"{v}\"")),
        list(t.retired.iter().collect()),
        list(t.accepted.iter().map(|(v, _)| v).collect())
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Bench {
        dir: PathBuf,
    }
    impl Bench {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("cnrs-trust-{}-{name}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(dir.join("releases")).unwrap();
            fs::create_dir_all(dir.join("config")).unwrap();
            fs::create_dir_all(dir.join("state")).unwrap();
            Bench { dir }
        }
        fn key(&self, name: &str) -> PathBuf {
            let folder = self.dir.join("keys").join(name);
            if !folder.join("release.pub").exists() {
                super::super::keygen(&folder).unwrap();
            }
            folder
        }
        fn paths(&self) -> [PathBuf; 2] {
            [self.dir.join("config/release-trust"), self.dir.join("state/release-trust")]
        }
        fn with<T>(&self, f: impl FnOnce(&[&Path], &Path) -> T) -> T {
            let [a, b] = self.paths();
            f(&[a.as_path(), b.as_path()], &self.dir.join("releases"))
        }
        /// A signed release in out/<version>; `change` runs after signing.
        fn release(&self, version: &str, serial: u64, next: Option<&str>, signer: &str, change: impl FnOnce(&Path)) -> PathBuf {
            let dir = self.dir.join("out").join(version);
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("codenomad-rs"), format!("binary {version}")).unwrap();
            fs::write(dir.join("VERSION"), format!("{version}\n")).unwrap();
            let next = next.map(|n| self.key(n).join("release.pub"));
            write_manifest(&dir, &serial.to_string(), next.as_deref()).unwrap();
            let mut lines = vec![];
            for name in ["MANIFEST", "VERSION", "codenomad-rs"] {
                lines.push(format!("{}  {name}", hex(&fs::read(dir.join(name)).unwrap())));
            }
            fs::write(dir.join(SUMS), lines.join("\n") + "\n").unwrap();
            super::super::sign(&dir, &self.key(signer).join("release.key")).unwrap();
            change(&dir);
            dir
        }
        fn pin(&self, name: &str) {
            let public = self.key(name).join("release.pub");
            self.with(|p, r| pin(&public, p, r)).unwrap();
        }
        /// What the installer does: admit, copy beside the others, commit the copy.
        fn install(&self, release: &Path) -> Result<String, String> {
            self.with(|p, r| {
                check(release, p, r)?;
                let dest = r.join(version(release)?);
                if !dest.exists() {
                    copy(release, &dest);
                }
                commit(&dest, p, r)
            })
            .map_err(|e| e.to_string())
        }
        fn trust(&self) -> Trust {
            self.with(|p, _| load(p)).unwrap().unwrap()
        }
    }
    fn copy(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap() {
            let e = e.unwrap();
            fs::copy(e.path(), to.join(e.file_name())).unwrap();
        }
    }
    fn none(_: &Path) {}

    #[test]
    fn counter_refuses_lower_and_equal_serials() {
        let b = Bench::new("counter");
        b.pin("main");
        let one = b.release("0.1.0", 1, None, "main", none);
        let two = b.release("0.2.0", 2, None, "main", none);
        assert_eq!(b.install(&one).unwrap(), "0.1.0");
        assert_eq!(b.install(&one).unwrap(), "0.1.0", "idempotent reinstall");
        assert_eq!(b.install(&two).unwrap(), "0.2.0");
        assert!(b.install(&one).unwrap_err().contains("downgrade refused"));
        let same = b.release("0.2.1", 2, None, "main", none);
        assert!(b.install(&same).unwrap_err().contains("not above the installed serial 2"));
        // After a partial uninstall (releases removed, trust kept) the counter still holds.
        fs::remove_dir_all(b.dir.join("releases")).unwrap();
        assert!(b.install(&one).unwrap_err().contains("downgrade refused"));
        assert_eq!(b.install(&two).unwrap(), "0.2.0");
        // Local rollback target: accepted here, whatever its serial.
        assert_eq!(b.with(|p, r| staged(&r.join("0.1.0"), p)).ok(), None, "0.1.0 is no longer staged");
        assert_eq!(b.with(|p, r| staged(&r.join("0.2.0"), p)).unwrap(), "0.2.0");
        let unsigned = b.release("0.3.0", 3, None, "main", |d| fs::remove_file(d.join(SIGNATURE)).unwrap());
        assert!(b.install(&unsigned).unwrap_err().contains("not signed"));
        let missing = b.release("0.3.1", 3, None, "main", |d| fs::remove_file(d.join(MANIFEST)).unwrap());
        assert!(b.install(&missing).is_err());
    }

    #[test]
    fn rotation_moves_the_pinned_key() {
        let b = Bench::new("rotation");
        b.pin("main");
        assert_eq!(b.install(&b.release("0.1.0", 1, None, "main", none)).unwrap(), "0.1.0");
        let early = b.release("0.2.0-early", 2, None, "next", none);
        assert!(b.install(&early).unwrap_err().contains("not by the pinned key"));
        let foreign = b.release("0.2.0-foreign", 2, Some("next"), "foreign", none);
        assert!(b.install(&foreign).unwrap_err().contains("not by the pinned key"));
        let unsigned = b.release("0.2.0-unsigned", 2, None, "main", |d| {
            let pk = PublicKeyBox::from_string(&fs::read_to_string(d.join("../../keys/next/release.pub")).unwrap()).unwrap().into_public_key().unwrap();
            fs::OpenOptions::new().append(true).open(d.join(MANIFEST)).unwrap().write_all(format!("next-key {}\n", pk.to_base64()).as_bytes()).unwrap();
        });
        assert!(b.install(&unsigned).unwrap_err().contains("checksum mismatch: MANIFEST"));
        let altered = b.release("0.2.0-altered", 2, Some("next"), "main", |d| {
            let other = fs::read_to_string(d.join("../../keys/foreign/release.pub")).unwrap();
            let line = other.lines().nth(1).unwrap();
            fs::write(d.join(MANIFEST), format!("serial 2\nnext-key {line}\n")).unwrap();
        });
        assert!(b.install(&altered).unwrap_err().contains("checksum mismatch: MANIFEST"));
        let planted = b.release("0.2.0-planted", 2, None, "main", |d| fs::write(d.join("next-key.pub"), "x").unwrap());
        assert!(b.install(&planted).unwrap_err().contains("not covered"));
        assert_eq!(b.trust().serial, 1, "refusals leave the state");
        let rotate = b.release("0.2.0", 2, Some("next"), "main", none);
        assert_eq!(b.install(&rotate).unwrap(), "0.2.0");
        let t = b.trust();
        assert_eq!(t.retired.len(), 1);
        assert_eq!(b.install(&rotate).unwrap(), "0.2.0", "idempotent after rotation");
        let old = b.release("0.3.0-old", 3, None, "main", none);
        assert!(b.install(&old).unwrap_err().contains("retired key"));
        let back = b.release("0.3.0-back", 3, Some("main"), "next", none);
        assert!(b.install(&back).unwrap_err().contains("retired"));
        assert_eq!(b.install(&b.release("0.3.0", 3, None, "next", none)).unwrap(), "0.3.0");
        // The release signed by the retired key stays a local rollback target.
        assert_eq!(b.with(|p, r| staged(&r.join("0.1.0"), p)).unwrap(), "0.1.0");
        fs::write(b.dir.join("releases/0.1.0/codenomad-rs"), "changed").unwrap();
        assert!(b.with(|p, r| staged(&r.join("0.1.0"), p)).is_err());
    }

    #[test]
    fn copies_and_interruptions() {
        let b = Bench::new("copies");
        b.pin("main");
        b.install(&b.release("0.1.0", 1, None, "main", none)).unwrap();
        let [config, state] = b.paths();
        let old = fs::read_to_string(&config).unwrap();
        b.install(&b.release("0.2.0", 2, Some("next"), "main", none)).unwrap();
        // Interrupted between the two copies, or one copy restored: the higher serial wins.
        fs::write(&config, &old).unwrap();
        fs::write(config.with_file_name("release-trust.tmp"), "partial").unwrap();
        assert_eq!(b.trust().serial, 2);
        let stale_old_key = b.release("0.3.0-old", 3, None, "main", none);
        assert!(b.install(&stale_old_key).unwrap_err().contains("retired key"));
        b.install(&b.release("0.2.0", 2, Some("next"), "main", none)).unwrap();
        assert_eq!(fs::read_to_string(&config).unwrap(), fs::read_to_string(&state).unwrap(), "idempotent commit repairs the copy");
        // Both copies restored from an older state: the staged releases reveal it.
        let current = fs::read_to_string(&state).unwrap();
        fs::write(&config, &old).unwrap();
        fs::write(&state, &old).unwrap();
        assert!(b.install(&stale_old_key).unwrap_err().contains("restored or copied"));
        fs::write(&config, &current).unwrap();
        fs::write(&state, &current).unwrap();
        // Staging interrupted before its commit: that release completes, another one waits.
        let three = b.release("0.3.0", 3, None, "next", none);
        copy(&three, &b.dir.join("releases/0.3.0"));
        let four = b.release("0.4.0", 4, None, "next", none);
        assert!(b.install(&four).unwrap_err().contains("finish installing 0.3.0"));
        assert_eq!(b.install(&three).unwrap(), "0.3.0");
        assert_eq!(b.install(&four).unwrap(), "0.4.0");
        assert_eq!(b.trust().serial, 4);
        // Disagreeing copies at one serial, missing trust with staged releases.
        let mut t = b.trust();
        t.retired.push("0000000000000001".into());
        fs::write(&config, render(&t)).unwrap();
        assert!(b.with(|p, _| load(p)).unwrap_err().to_string().contains("disagree"));
        fs::remove_file(&config).unwrap();
        fs::remove_file(&state).unwrap();
        let public = b.key("main").join("release.pub");
        assert!(b.with(|p, r| pin(&public, p, r)).unwrap_err().to_string().contains("purge"));
    }

    #[test]
    fn pin_refuses_another_key() {
        let b = Bench::new("pin");
        b.pin("main");
        let other = b.key("foreign").join("release.pub");
        assert!(b.with(|p, r| pin(&other, p, r)).unwrap_err().to_string().contains("another release key"));
        b.pin("main");
        assert!(status(&[b.paths()[0].as_path()]).unwrap().contains("\"serial\":0"));
    }
}
