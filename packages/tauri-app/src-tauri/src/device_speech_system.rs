use crate::{
    device_speech::{
        valid_locale, Capabilities, Control, Driver, Engine, Hex, Plan, SpeechError, System,
    },
    device_speech_worker::run_worker,
    managed_node::candidate_resource_roots,
};
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    process::Command,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SystemReason {
    PlatformUnsupported,
    RuntimeUnavailable,
    NoRecognizer,
}

#[derive(Default)]
pub(crate) struct SystemDriver {
    probe: Mutex<Option<(Instant, Result<Vec<String>, SystemReason>)>>,
}

fn helper() -> Result<PathBuf, SystemReason> {
    let name = match std::env::consts::OS {
        "macos" => {
            return std::env::current_exe()
                .ok()
                .and_then(|exe| Some(exe.parent()?.join("codenomad-system-speech")))
                .filter(|path| path.is_file())
                .ok_or(SystemReason::RuntimeUnavailable);
        }
        "windows" => "codenomad-system-speech.exe",
        _ => return Err(SystemReason::PlatformUnsupported),
    };
    candidate_resource_roots()
        .into_iter()
        .chain(
            cfg!(debug_assertions)
                .then(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")),
        )
        .map(|root| root.join("server").join("desktop-speech").join(name))
        .find(|path| path.is_file())
        .ok_or(SystemReason::RuntimeUnavailable)
}

fn discover() -> Result<Vec<String>, SystemReason> {
    let mut command = Command::new(helper()?);
    command.arg("probe");
    let locales: Vec<String> = run_worker(command, None, None, Duration::from_millis(2500), false)
        .ok()
        .and_then(|value| serde_json::from_value(value).ok())
        .filter(|locales: &Vec<String>| {
            locales.len() <= 256 && locales.iter().all(|locale| valid_locale(locale))
        })
        .ok_or(SystemReason::RuntimeUnavailable)?;
    if locales.is_empty() {
        Err(SystemReason::NoRecognizer)
    } else {
        Ok(locales)
    }
}

impl SystemDriver {
    fn locales(&self) -> Result<Vec<String>, SystemReason> {
        let mut probe = self.probe.lock();
        if let Some((expires, locales)) = &*probe {
            if *expires > Instant::now() {
                return locales.clone();
            }
        }
        let locales = discover();
        *probe = Some((
            Instant::now() + Duration::from_millis(1500),
            locales.clone(),
        ));
        locales
    }
}

pub(crate) fn resolve_locale<'a>(locales: &'a [String], requested: &str) -> Option<&'a str> {
    if let Some(exact) = locales
        .iter()
        .find(|locale| locale.eq_ignore_ascii_case(requested))
    {
        return Some(exact);
    }
    let requested_language = requested.to_ascii_lowercase();
    if requested.contains('-') {
        let region = match requested_language.as_str() {
            "zh-hans" => "zh-CN",
            "zh-hant" => "zh-TW",
            _ => return None,
        };
        return locales
            .iter()
            .find(|locale| locale.eq_ignore_ascii_case(region))
            .map(String::as_str);
    }
    let mut candidates = locales.iter().filter(|locale| {
        locale
            .split('-')
            .next()
            .is_some_and(|language| language.eq_ignore_ascii_case(requested))
    });
    let first = candidates.next()?;
    if candidates.next().is_none() {
        return Some(first);
    }
    let preferred = match requested_language.as_str() {
        "en" => "en-US",
        "fr" => "fr-FR",
        _ => return None,
    };
    locales
        .iter()
        .find(|locale| locale.eq_ignore_ascii_case(preferred))
        .map(String::as_str)
}

impl Driver for SystemDriver {
    fn capabilities(&self) -> Capabilities {
        let (system, system_locales, system_reason) = match self.locales() {
            Ok(locales) => (System::Ready, Some(locales), None),
            Err(reason) => (System::Unavailable, None, Some(reason)),
        };
        Capabilities {
            system,
            system_locales,
            system_reason,
            hex: Hex::Unavailable,
        }
    }

    fn prepare(&self, _plan: Plan, _control: Control) -> Result<(), SpeechError> {
        Err(SpeechError::Unavailable)
    }

    fn dictate(
        &self,
        engine: Engine,
        locale: String,
        control: Control,
    ) -> Result<String, SpeechError> {
        if engine != Engine::System {
            return Err(SpeechError::Unavailable);
        }
        let locales = self.locales().map_err(|_| SpeechError::Unavailable)?;
        let locale = resolve_locale(&locales, &locale).ok_or(SpeechError::LocaleUnavailable)?;
        let mut command = Command::new(helper().map_err(|_| SpeechError::Unavailable)?);
        command.args(["dictate", locale]);
        run_worker(
            command,
            None,
            Some(&control),
            Duration::from_secs(150),
            true,
        )?
        .as_str()
        .map(str::to_owned)
        .ok_or(SpeechError::Failed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_locales_are_required_and_language_only_is_deterministic() {
        let locales = ["en-GB", "en-US", "fr-CA", "de-DE"].map(str::to_owned);
        assert_eq!(resolve_locale(&locales, "en"), Some("en-US"));
        assert_eq!(resolve_locale(&locales, "en-gb"), Some("en-GB"));
        assert_eq!(resolve_locale(&locales, "fr"), Some("fr-CA"));
        assert_eq!(resolve_locale(&locales, "fr-FR"), None);
        assert_eq!(resolve_locale(&locales, "es"), None);
    }

    #[test]
    fn chinese_scripts_prefer_exact_recognizers_then_default_regions() {
        let locales = ["zh-CN", "zh-TW"].map(str::to_owned);
        let exact = ["zh-CN", "zh-Hans"].map(str::to_owned);
        assert_eq!(resolve_locale(&exact, "zh-Hans"), Some("zh-Hans"));
        assert_eq!(resolve_locale(&locales, "zh-hans"), Some("zh-CN"));
        assert_eq!(resolve_locale(&locales, "zh-Hant"), Some("zh-TW"));
        assert_eq!(resolve_locale(&locales[..1], "zh-Hant"), None);
        assert_eq!(resolve_locale(&locales, "zh-SG"), None);
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    #[test]
    fn an_unqualified_platform_exposes_no_system_recognizer() {
        assert!(matches!(helper(), Err(SystemReason::PlatformUnsupported)));
    }
}
