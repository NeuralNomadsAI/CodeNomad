use crate::State;
use rune::{Chord, ChordKey, ChordMod, KeyEvent, KeyPlatform, Tx};
use serde_json::Value;

#[derive(Clone, Copy)]
pub(super) enum Action {
    Alternate,
    PreviousUser,
    NextUser,
    PreviousPrompt,
    NextPrompt,
    Clear,
}

impl Action {
    pub(super) fn id(self) -> &'static str {
        match self {
            Self::Alternate => "prompt-alternate-send",
            Self::PreviousUser => "user-message-prev",
            Self::NextUser => "user-message-next",
            Self::PreviousPrompt => "prompt-history-prev",
            Self::NextPrompt => "prompt-history-next",
            Self::Clear => "clear-input",
        }
    }

    fn bindings(self, s: &State) -> Vec<Chord> {
        crate::settings::with_shortcut(s, self.id(), |rules| {
            rules
                .filter(|rules| rules.len() <= 8)
                .and_then(|rules| rules.iter().map(decode).collect())
                .unwrap_or_else(|| self.defaults(KeyPlatform::current()))
        })
    }

    fn defaults(self, platform: KeyPlatform) -> Vec<Chord> {
        use ChordKey::{Char, Down, Enter, Up};
        use ChordMod::{Alt, Primary, Shift};
        let mac = platform == KeyPlatform::Mac;
        match self {
            Self::Alternate => {
                let primary = Chord::new(Enter).with(Primary).with(Shift);
                if mac {
                    vec![primary]
                } else {
                    vec![Chord::new(Enter).with(Alt), primary]
                }
            }
            Self::PreviousUser | Self::NextUser => {
                let key = if matches!(self, Self::PreviousUser) {
                    Up
                } else {
                    Down
                };
                let chord = Chord::new(key).with(Alt);
                vec![if mac { chord.with(Primary) } else { chord }]
            }
            Self::PreviousPrompt => vec![Chord::new(Up)],
            Self::NextPrompt => vec![Chord::new(Down)],
            Self::Clear => vec![Chord::new(Char('k')).with(Primary)],
        }
    }

    pub(super) fn label(self, s: &State) -> Option<String> {
        let chords = self.bindings(s);
        (!chords.is_empty()).then(|| {
            chords
                .iter()
                .map(Chord::label)
                .collect::<Vec<_>>()
                .join(" / ")
        })
    }

    pub(super) fn matches(self, s: &State, event: &KeyEvent, tx: &Tx) -> bool {
        self.bindings(s)
            .iter()
            .any(|chord| chord.matches_tx(event, tx))
    }
}

fn decode(rule: &Value) -> Option<Chord> {
    let key = rule.get("key")?.as_str()?;
    let mut chord = match key {
        " " => Chord::new(ChordKey::Char(' ')),
        "+" => Chord::new(ChordKey::Char('+')),
        _ if key.contains('+') => return None,
        _ => Chord::parse(key).ok()?,
    };
    for (name, modifier) in [
        ("mod", ChordMod::Primary),
        ("ctrl", ChordMod::Ctrl),
        ("meta", ChordMod::Super),
        ("alt", ChordMod::Alt),
        ("shift", ChordMod::Shift),
    ] {
        if let Some(value) = rule.get(name)
            && value.as_bool()?
        {
            chord = chord.with(modifier);
        }
    }
    Some(chord)
}
