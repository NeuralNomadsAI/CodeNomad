use crate::{
    device_speech::{Control, Driver, Hex, Operation, Plan, SpeechError},
    device_speech_worker::run_worker,
    managed_node::{resolve_bundled_node_binary, resolve_desktop_speech_worker},
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::{path::PathBuf, process::Command, time::Duration};

#[path = "device_speech_hex_service.rs"]
mod service;
use service::{HexService, Installation};

const MAX_WAV: usize = 44 + 16_000 * 2 * 120;

pub(crate) fn valid_audio_encoding(value: &str) -> bool {
    let body = value.trim_end_matches('=');
    (64..=MAX_WAV.div_ceil(3) * 4).contains(&value.len())
        && value.len() % 4 == 0
        && value.len() - body.len() <= 2
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
}

pub(crate) fn decode_wav(value: &str) -> Option<Vec<u8>> {
    let wav = STANDARD.decode(value).ok()?;
    let u16_at = |i| u16::from_le_bytes([wav[i], wav[i + 1]]);
    let u32_at = |i| u32::from_le_bytes([wav[i], wav[i + 1], wav[i + 2], wav[i + 3]]);
    (wav.len() > 44
        && wav.len() <= MAX_WAV
        && wav.len() % 2 == 0
        && &wav[..4] == b"RIFF"
        && u32_at(4) as usize == wav.len() - 8
        && &wav[8..16] == b"WAVEfmt "
        && u32_at(16) == 16
        && u16_at(20) == 1
        && u16_at(22) == 1
        && u32_at(24) == 16_000
        && u32_at(28) == 32_000
        && u16_at(32) == 2
        && u16_at(34) == 16
        && &wav[36..40] == b"data"
        && u32_at(40) as usize == wav.len() - 44)
        .then_some(wav)
}

pub(crate) struct HexDriver {
    root: PathBuf,
    service: HexService,
}

impl HexDriver {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            service: HexService::default(),
        }
    }
}

impl Driver for HexDriver {
    fn capabilities(&self) -> Hex {
        self.run("read", "", None, None, Duration::from_secs(4))
            .ok()
            .and_then(|value| serde_json::from_value(value).ok())
            .unwrap_or(Hex::Unavailable)
    }

    fn prepare(&self, plan: Plan, control: Control) -> Result<(), SpeechError> {
        self.stop();
        self.run(
            "prepare",
            &plan.id,
            Some(&[1]),
            Some(&control),
            Duration::from_secs(7200),
        )?;
        Ok(())
    }

    fn stop(&self) {
        self.service.stop();
    }

    fn request_stop(&self) {
        self.service.request_stop();
    }

    fn dictate(
        &self,
        control: Control,
        selected: Box<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<String, SpeechError> {
        let installation = self
            .run(
                "installation",
                "",
                None,
                Some(&control),
                Duration::from_secs(30),
            )
            .and_then(|value| {
                serde_json::from_value::<Installation>(value).map_err(|_| SpeechError::Failed)
            });
        let installation = match installation {
            Ok(installation) => installation,
            Err(error) => {
                if !control.cancelled() {
                    self.stop();
                }
                return Err(error);
            }
        };
        control.progress(Operation::Recording);
        self.service.dictate(
            installation,
            selected,
            || control.cancelled(),
            |interrupted| {
                let audio = control.wait_for_audio(interrupted)?;
                control.progress(Operation::Transcribing);
                Some(audio)
            },
        )
    }
}

impl HexDriver {
    fn run(
        &self,
        action: &str,
        arg: &str,
        input: Option<&[u8]>,
        control: Option<&Control>,
        timeout: Duration,
    ) -> Result<Value, SpeechError> {
        let program = resolve_desktop_speech_worker().ok_or(SpeechError::Unavailable)?;
        let node = resolve_bundled_node_binary().map_err(|_| SpeechError::Unavailable)?;
        let mut command = Command::new(node);
        command
            .arg(program)
            .arg(action)
            .arg(&self.root)
            .arg(arg)
            .env_remove("NODE_OPTIONS")
            .env_remove("NODE_PATH");
        run_worker(command, input, control, timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finish_audio_requires_canonical_mono_pcm_wav() {
        let mut wav = b"RIFF\x26\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0\x80\x3e\0\0\0\x7d\0\0\x02\0\x10\0data\x02\0\0\0\0\0".to_vec();
        assert_eq!(decode_wav(&STANDARD.encode(&wav)), Some(wav.clone()));
        wav[22] = 2;
        assert_eq!(decode_wav(&STANDARD.encode(&wav)), None);
        assert!(!valid_audio_encoding(
            &"A".repeat(MAX_WAV.div_ceil(3) * 4 + 4)
        ));
        assert!(!valid_audio_encoding(&format!("={}A", "A".repeat(62))));
    }
}
