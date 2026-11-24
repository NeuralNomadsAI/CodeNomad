use bitreader::BitReader;

type Dimensions = (usize, usize);

struct Limits {
    accepts: fn(usize, usize) -> bool,
    dimensions: Option<Dimensions>,
    has_extent: bool,
}

impl Limits {
    fn new(accepts: fn(usize, usize) -> bool) -> Self {
        Self {
            accepts,
            dimensions: None,
            has_extent: false,
        }
    }

    fn check(&mut self, size: Dimensions, fields: Dimensions) -> Option<()> {
        // rav1d accepts frame overrides representable by the header's field widths.
        if size.0 == 0
            || size.1 == 0
            || !(self.accepts)(fields.0, fields.1)
            || *self.dimensions.get_or_insert(size) != size
        {
            return None;
        }
        Some(())
    }
}

pub(super) fn still(bytes: &[u8], accepts: fn(usize, usize) -> bool) -> Option<()> {
    let mut limits = Limits::new(accepts);
    scan(bytes, b"", &mut bytes.len(), &mut limits)?;
    if !limits.has_extent {
        return None;
    }
    // Read the same primary and auxiliary alpha streams that Rune's decoder will receive.
    let mut input = bytes;
    let items = avif_parse::read_avif(&mut input).ok()?;
    if !sequences(&items.primary_item, &mut limits)? {
        return None;
    }
    if let Some(alpha) = items.alpha_item
        && !sequences(&alpha, &mut limits)?
    {
        return None;
    }
    Some(())
}

// Bound the container parser's reads and extent copies before handing it untrusted box sizes.
fn scan(mut bytes: &[u8], parent: &[u8], budget: &mut usize, limits: &mut Limits) -> Option<()> {
    while !bytes.is_empty() {
        let size = u32::from_be_bytes(bytes.get(..4)?.try_into().ok()?);
        let kind = bytes.get(4..8)?;
        let (size, header) = match size {
            0 => return None,
            1 => (
                usize::try_from(u64::from_be_bytes(bytes.get(8..16)?.try_into().ok()?)).ok()?,
                16,
            ),
            n => (n as usize, 8),
        };
        let body = bytes.get(header..size)?;
        match (parent, kind) {
            (b"", b"meta") | (b"meta", b"iref") => scan(body.get(4..)?, kind, budget, limits)?,
            (b"meta", b"iinf") => {
                let count_bytes = match body.first()? {
                    0 => 2,
                    1 => 4,
                    _ => return None,
                };
                let mut bits = BitReader::new(body.get(4..)?);
                let count = bits.read_u32(8 * count_bytes).ok()? as usize;
                let entries = body.get(4 + usize::from(count_bytes)..)?;
                if count > entries.len() / 8 {
                    return None;
                }
                scan(entries, kind, budget, limits)?;
            }
            (b"meta", b"iloc") => locations(body, budget)?,
            (b"meta", b"iprp") | (b"iprp", b"ipco") => scan(body, kind, budget, limits)?,
            (b"ipco", b"ispe") => {
                let extent = body.strip_prefix(&[0; 4])?;
                let side = |at| {
                    usize::try_from(u32::from_be_bytes(extent.get(at..at + 4)?.try_into().ok()?))
                        .ok()
                };
                let size = (side(0)?, side(4)?);
                limits.check(size, size)?;
                limits.has_extent = true;
            }
            (b"ipco", b"av1C") => {
                if body.first() != Some(&0x81) {
                    return None;
                }
                sequences(body.get(4..)?, limits)?;
            }
            _ => {}
        }
        bytes = bytes.get(size..)?;
    }
    Some(())
}

fn locations(body: &[u8], budget: &mut usize) -> Option<()> {
    let limit = *budget as u64;
    let id_bits = match *body.first()? {
        0 | 1 => 16,
        2 => 32,
        _ => return None,
    };
    let has_method = body[0] != 0;
    let mut b = BitReader::new(body.get(4..)?);
    fn field(b: &mut BitReader<'_>) -> Option<u8> {
        let width = b.read_u8(4).ok()?;
        matches!(width, 0 | 4 | 8).then_some(width * 8)
    }
    let offset = field(&mut b)?;
    let length = field(&mut b)?;
    let base = field(&mut b)?;
    let index = if has_method {
        field(&mut b)?
    } else {
        b.skip(4).ok()?;
        0
    };
    let items = b.read_u32(id_bits).ok()?;
    let min_item = u64::from(id_bits + base) + if has_method { 48 } else { 32 };
    if u64::from(items) > b.remaining() / min_item {
        return None;
    }
    for _ in 0..items {
        b.skip(u64::from(id_bits) + if has_method { 32 } else { 16 })
            .ok()?;
        let base_offset = b.read_u64(base).ok()?;
        let extents = b.read_u16(16).ok()?;
        let width = u64::from(index) + u64::from(offset) + u64::from(length);
        if (width == 0 && extents > 1) || width * u64::from(extents) > b.remaining() {
            return None;
        }
        for _ in 0..extents {
            b.skip(u64::from(index)).ok()?;
            let start = base_offset.checked_add(b.read_u64(offset).ok()?)?;
            let declared = b.read_u64(length).ok()?;
            let remaining = limit.checked_sub(start)?;
            let len = if declared == 0 { remaining } else { declared };
            if len > remaining {
                return None;
            }
            *budget = budget.checked_sub(usize::try_from(len).ok()?)?;
        }
    }
    (b.remaining() == 0).then_some(())
}

fn sequences(mut bytes: &[u8], limits: &mut Limits) -> Option<bool> {
    let mut found = false;
    while let Some((&header, rest)) = bytes.split_first() {
        if header & 0x81 != 0 {
            return None;
        }
        bytes = if header & 4 != 0 {
            rest.get(1..)?
        } else {
            rest
        };
        let len = if header & 2 != 0 {
            obu_length(&mut bytes)?
        } else {
            bytes.len()
        };
        let (payload, rest) = bytes.split_at_checked(len)?;
        if (header >> 3) & 15 == 1 {
            let (size, fields) = dimensions(payload)?;
            limits.check(size, fields)?;
            found = true;
        }
        bytes = rest;
    }
    Some(found)
}

fn obu_length(bytes: &mut &[u8]) -> Option<usize> {
    let mut len = 0_u64;
    for shift in (0..56).step_by(7) {
        let (&byte, rest) = bytes.split_first()?;
        *bytes = rest;
        len |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return usize::try_from(u32::try_from(len).ok()?).ok();
        }
    }
    None
}

fn dimensions(payload: &[u8]) -> Option<(Dimensions, Dimensions)> {
    let mut b = BitReader::new(payload);
    let profile = b.read_u8(3).ok()?;
    let still = b.read_bool().ok()?;
    let reduced = b.read_bool().ok()?;
    if profile > 2 || (reduced && !still) {
        return None;
    }
    if reduced {
        b.skip(5).ok()?;
    } else {
        let mut model_delay_bits = None;
        if b.read_bool().ok()? {
            b.skip(64).ok()?;
            if b.read_bool().ok()? {
                let mut zeros = 0;
                while !b.read_bool().ok()? {
                    zeros += 1;
                    if zeros == 32 {
                        return None;
                    }
                }
                b.skip(zeros).ok()?;
            }
            if b.read_bool().ok()? {
                model_delay_bits = Some(1 + u64::from(b.read_u8(5).ok()?));
                b.skip(42).ok()?;
            }
        }
        let display_delay = b.read_bool().ok()?;
        let operating_points = 1 + b.read_u8(5).ok()?;
        for _ in 0..operating_points {
            b.skip(12).ok()?;
            if b.read_u8(5).ok()? > 7 {
                b.skip(1).ok()?;
            }
            if let Some(bits) = model_delay_bits
                && b.read_bool().ok()?
            {
                b.skip(bits * 2 + 1).ok()?;
            }
            if display_delay && b.read_bool().ok()? {
                b.skip(4).ok()?;
            }
        }
    }
    let w = 1 + b.read_u8(4).ok()?;
    let h = 1 + b.read_u8(4).ok()?;
    let size = (
        1 + usize::from(b.read_u16(w).ok()?),
        1 + usize::from(b.read_u16(h).ok()?),
    );
    Some((size, if reduced { size } else { (1 << w, 1 << h) }))
}

#[cfg(test)]
mod tests;
