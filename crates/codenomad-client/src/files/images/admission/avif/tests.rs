use super::*;
use crate::files::images::admission::{can_decode, transcript_dimensions, transcript_raster};
use base64::{Engine, engine::general_purpose::STANDARD};

fn still_32() -> Vec<u8> {
    // A 32×32 solid blue still, encoded with FFmpeg/libaom-av1.
    STANDARD.decode(concat!(
        "AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAAD5bWV0YQAAAAAAAAAvaGRscgAAAAAAAAAA",
        "cGljdAAAAAAAAAAAAAAAAFBpY3R1cmVIYW5kbGVyAAAAAA5waXRtAAAAAAABAAAAHmlsb2MAAAAARAAAAQAB",
        "AAAAAQAAASEAAAAdAAAAKGlpbmYAAAAAAAEAAAAaaW5mZQIAAAAAAQAAYXYwMUNvbG9yAAAAAGppcHJwAAAA",
        "S2lwY28AAAAUaXNwZQAAAAAAAAAgAAAAIAAAABBwaXhpAAAAAAMICAgAAAAMYXYxQ4EADAAAAAATY29scm5j",
        "bHgAAgACAAIAAAAAF2lwbWEAAAAAAAAAAQABBAECgwQAAAAlbWRhdAoGGBE/9sAgMhMYAAAAUAAAAALl1tYoHwKL8RaA",
    )).unwrap()
}

#[test]
fn rejects_small_container_that_disagrees_with_the_coded_picture() {
    let mut image = still_32();
    assert!(transcript_raster(&image));
    assert!(can_decode(&image));
    let ispe = image.windows(4).position(|s| s == b"ispe").unwrap();
    image[ispe + 8..ispe + 16].copy_from_slice(&[0, 0, 0, 2, 0, 0, 0, 2]);
    let declared = imagesize::blob_size(&image).unwrap();
    assert_eq!((declared.width, declared.height), (2, 2));
    assert!(!transcript_raster(&image));
    assert!(!can_decode(&image));
}

#[test]
fn checks_each_config_sequence_and_refuses_an_oversized_header_without_decoding() {
    let regular = [0x0a, 6, 0x18, 0x11, 0x3f, 0xf6, 0xc0, 0x20];
    let oversized = |bits: &[(u32, u8)]| {
        let mut packed = 0_u64;
        let mut len = 0;
        for &(value, width) in bits {
            packed = (packed << width) | u64::from(value);
            len += usize::from(width);
        }
        (packed << (64 - len)).to_be_bytes()[..len.div_ceil(8)].to_vec()
    };
    // Sequence metadata only: no coded frames.
    let large_header = oversized(&[(3, 5), (0, 5), (13, 4), (0, 4), (8192, 14), (0, 1)]);
    let sequence_only = [[0x0a, large_header.len() as u8].as_slice(), &large_header].concat();
    let limits = || Limits::new(transcript_dimensions);
    assert_eq!(sequences(&regular, &mut limits()), Some(true));
    assert_eq!(sequences(&sequence_only, &mut limits()), None);
    assert_eq!(
        sequences(
            &[regular.as_slice(), &sequence_only].concat(),
            &mut limits()
        ),
        None
    );
    let atom = |name: &[u8; 4], body: &[u8]| {
        [(8 + body.len() as u32).to_be_bytes().as_slice(), name, body].concat()
    };
    let av1c = |sequence: &[u8]| {
        atom(
            b"av1C",
            &[&[0x81, 0, 0, 0], regular.as_slice(), sequence].concat(),
        )
    };
    assert!(scan(&av1c(&regular), b"ipco", &mut 0, &mut limits()).is_some());
    assert!(scan(&av1c(&sequence_only), b"ipco", &mut 0, &mut limits()).is_none());
    assert!(scan(&av1c(&[0x0a, 3]), b"ipco", &mut 0, &mut limits()).is_none());
}
