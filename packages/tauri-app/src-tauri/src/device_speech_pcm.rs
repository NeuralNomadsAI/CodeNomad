use gst::prelude::*;
use gstreamer as gst;
use std::time::{Duration, Instant};

const RATE: u32 = 16_000;
const LIMIT: Duration = Duration::from_secs(24);
const AUDIO_BYTES: usize = LIMIT.as_secs() as usize * RATE as usize * 2;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Control {
    Record,
    Finish,
    Cancel,
}

pub(super) fn record(
    control: impl FnMut() -> Control,
    started: impl FnOnce(),
) -> Result<Vec<u8>, ()> {
    record_from("pulsesrc", LIMIT, control, started)
}

fn record_from(
    source: &str,
    limit: Duration,
    mut control: impl FnMut() -> Control,
    started: impl FnOnce(),
) -> Result<Vec<u8>, ()> {
    gst::init().map_err(|_| ())?;
    // The source is fixed by the host. The remote document cannot choose a device,
    // pipeline, file or destination; the desktop audio service chooses its default input.
    let pipeline = gst::parse::launch(&format!(
        "{source} ! audioconvert ! audioresample ! \
         audio/x-raw,format=S16LE,rate={RATE},channels=1,layout=interleaved ! \
         appsink name=pcm max-buffers=8 sync=false enable-last-sample=false"
    ))
    .map_err(|_| ())?
    .downcast::<gst::Pipeline>()
    .map_err(|_| ())?;
    let sink = pipeline
        .by_name("pcm")
        .and_then(|sink| sink.downcast::<gstreamer_app::AppSink>().ok())
        .ok_or(())?;
    let bus = pipeline.bus().ok_or(())?;
    let result = (|| {
        if control() != Control::Record {
            return Err(());
        }
        pipeline.set_state(gst::State::Playing).map_err(|_| ())?;
        let mut started = Some(started);
        let mut deadline = Instant::now() + Duration::from_secs(5);
        let mut wav = Vec::with_capacity(44 + AUDIO_BYTES);
        wav.resize(44, 0);
        loop {
            match control() {
                Control::Cancel => return Err(()),
                Control::Finish => break,
                Control::Record => {}
            }
            if Instant::now() >= deadline || wav.len() == 44 + AUDIO_BYTES {
                break;
            }
            if bus
                .pop_filtered(&[gst::MessageType::Error, gst::MessageType::Eos])
                .is_some()
            {
                return Err(());
            }
            if let Some(sample) = sink.try_pull_sample(gst::ClockTime::from_mseconds(20)) {
                let bytes = sample.buffer().ok_or(())?.map_readable().map_err(|_| ())?;
                let count = bytes.size().min(44 + AUDIO_BYTES - wav.len()) & !1;
                if count == 0 {
                    continue;
                }
                wav.extend_from_slice(&bytes.as_slice()[..count]);
                if let Some(ready) = started.take() {
                    deadline = Instant::now() + limit;
                    ready();
                }
            }
        }
        if wav.len() == 44 {
            return Err(());
        }
        let bytes = (wav.len() - 44) as u32;
        wav[..4].copy_from_slice(b"RIFF");
        wav[4..8].copy_from_slice(&(36 + bytes).to_le_bytes());
        wav[8..16].copy_from_slice(b"WAVEfmt ");
        wav[16..24].copy_from_slice(&[16, 0, 0, 0, 1, 0, 1, 0]);
        wav[24..28].copy_from_slice(&RATE.to_le_bytes());
        wav[28..32].copy_from_slice(&(RATE * 2).to_le_bytes());
        wav[32..40].copy_from_slice(b"\x02\0\x10\0data");
        wav[40..44].copy_from_slice(&bytes.to_le_bytes());
        Ok(wav)
    })();
    pipeline.set_state(gst::State::Null).map_err(|_| ())?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn simulated_input_stops_with_bounded_pcm_or_discards_on_revocation() {
        let source = "audiotestsrc is-live=true wave=sine";
        let run = |after_start| {
            let state = Cell::new(false);
            record_from(
                source,
                Duration::from_millis(250),
                || {
                    if state.get() {
                        after_start
                    } else {
                        Control::Record
                    }
                },
                || state.set(true),
            )
        };
        for action in [Control::Finish, Control::Record] {
            let wav = run(action).unwrap();
            assert!(wav.len() > 44 && wav.len() <= 44 + AUDIO_BYTES);
            assert_eq!(&wav[8..16], b"WAVEfmt ");
            assert_eq!(
                u32::from_le_bytes(wav[40..44].try_into().unwrap()) as usize,
                wav.len() - 44
            );
            assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), RATE);
            assert!(wav[44..].iter().any(|byte| *byte != 0));
        }
        assert!(run(Control::Cancel).is_err());
    }
}
