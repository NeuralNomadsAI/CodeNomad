//! Node `path.win32`/`path.posix`: the subset the reference's location rules rely on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Style {
    Win32,
    Posix,
}
impl Style {
    pub fn host() -> Style {
        if cfg!(windows) { Style::Win32 } else { Style::Posix }
    }
    /// `experimental-layers.ts` `pathsFor`: drive or UNC prefix.
    pub fn of(path: &str) -> Style {
        let b = path.as_bytes();
        let drive = b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/');
        if drive || path.starts_with("\\\\") { Style::Win32 } else { Style::Posix }
    }
    fn is_sep(self, c: char) -> bool {
        c == '/' || self == Style::Win32 && c == '\\'
    }
    fn sep(self) -> &'static str {
        if self == Style::Win32 { "\\" } else { "/" }
    }
    /// (root, absolute, rest)
    fn root(self, p: &str) -> (String, bool, String) {
        let c: Vec<char> = p.chars().collect();
        if self == Style::Posix {
            let abs = c.first() == Some(&'/');
            return (if abs { "/".into() } else { String::new() }, abs, p.trim_start_matches('/').into());
        }
        let sep = |i: usize| c.get(i).is_some_and(|ch| self.is_sep(*ch));
        if sep(0) && sep(1) {
            let parts: Vec<String> = p.split(['\\', '/']).filter(|s| !s.is_empty()).map(String::from).collect();
            if parts.len() >= 2 {
                return (format!("\\\\{}\\{}\\", parts[0], parts[1]), true, parts[2..].join("\\"));
            }
        }
        if c.len() >= 2 && c[0].is_ascii_alphabetic() && c[1] == ':' {
            let abs = sep(2);
            let rest: String = c[if abs { 3 } else { 2 }..].iter().collect();
            return (format!("{}:{}", c[0], if abs { "\\" } else { "" }), abs, rest);
        }
        if sep(0) { ("\\".into(), true, c[1..].iter().collect()) } else { (String::new(), false, p.into()) }
    }
    pub fn is_absolute(self, p: &str) -> bool {
        let c: Vec<char> = p.chars().collect();
        match self {
            Style::Posix => p.starts_with('/'),
            Style::Win32 => {
                c.first().is_some_and(|ch| self.is_sep(*ch))
                    || c.len() >= 3 && c[0].is_ascii_alphabetic() && c[1] == ':' && self.is_sep(c[2])
            }
        }
    }
    fn segments(self, rest: &str, absolute: bool) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for s in rest.split(|c| self.is_sep(c)) {
            match s {
                "" | "." => {}
                ".." if out.last().is_some_and(|l| l != "..") => {
                    out.pop();
                }
                ".." if absolute => {}
                s => out.push(s.into()),
            }
        }
        out
    }
    pub fn normalize(self, p: &str) -> String {
        if p.is_empty() {
            return ".".into();
        }
        let (root, absolute, rest) = self.root(p);
        let mut tail = self.segments(&rest, absolute).join(self.sep());
        if tail.is_empty() && !absolute {
            tail = ".".into();
        }
        if !tail.is_empty() && p.chars().last().is_some_and(|c| self.is_sep(c)) {
            tail.push_str(self.sep());
        }
        format!("{root}{tail}")
    }
    pub fn join(self, a: &str, b: &str) -> String {
        if a.is_empty() { self.normalize(b) } else { self.normalize(&format!("{a}{}{b}", self.sep())) }
    }
    pub fn dirname(self, p: &str) -> String {
        let (root, _, rest) = self.root(p);
        let rest = rest.trim_end_matches(|c| self.is_sep(c));
        match rest.rfind(|c| self.is_sep(c)) {
            None if root.is_empty() => ".".into(),
            None => root,
            Some(i) => {
                let head = rest[..i].trim_end_matches(|c| self.is_sep(c));
                if head.is_empty() { root } else { format!("{root}{head}") }
            }
        }
    }
    pub fn basename(self, p: &str) -> String {
        let (_, _, rest) = self.root(p);
        let rest = rest.trim_end_matches(|c| self.is_sep(c));
        rest.rsplit(|c| self.is_sep(c)).next().unwrap_or("").into()
    }
    pub fn fold(self, s: &str) -> String {
        if self == Style::Win32 { s.to_lowercase() } else { s.into() }
    }
    pub fn relative(self, from: &str, to: &str) -> String {
        let (fr, fa, frest) = self.root(&self.normalize(from));
        let (tr, ta, trest) = self.root(&self.normalize(to));
        let f = self.segments(&frest, fa);
        let t = self.segments(&trest, ta);
        if self.fold(&fr) != self.fold(&tr) {
            return self.normalize(to).trim_end_matches(|c| self.is_sep(c)).to_string();
        }
        let common = f.iter().zip(&t).take_while(|(a, b)| self.fold(a) == self.fold(b)).count();
        let mut parts: Vec<String> = vec!["..".into(); f.len() - common];
        parts.extend(t[common..].iter().cloned());
        parts.join(self.sep())
    }
    /// `containsPath`.
    pub fn contains(self, candidate: &str, directory: &str) -> bool {
        let relative = self.relative(candidate, directory);
        relative.is_empty()
            || !relative.starts_with(&format!("..{}", self.sep())) && relative != ".." && !self.is_absolute(&relative)
    }
    /// `samePath` of `plugin-controls.ts`.
    pub fn same(self, a: &str, b: &str) -> bool {
        let n = |v: &str| {
            let mut s = self.normalize(v);
            if s.ends_with(['\\', '/']) {
                s.pop();
            }
            self.fold(&s)
        };
        n(a) == n(b)
    }
    pub fn valid_absolute(self, p: &str) -> bool {
        self.is_absolute(p) && !p.chars().any(|c| (c as u32) < 0x20 || c as u32 == 0x7f)
    }
}
