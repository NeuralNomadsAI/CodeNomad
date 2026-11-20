//! `memory/rules.ts` text helpers and `memory/language-data.ts`.
//!
//! NFKC + JS `toLowerCase`, the reference's `Intl.Segmenter("en", word)` filter for
//! duplicate detection and the injection heuristics. Word segmentation follows UAX #29
//! as V8's ICU applies it (colon stays MidLetter: `c:d` is one word). ICU segments
//! Han, Kana and South-East Asian scripts with dictionaries, which this port does not
//! ship: a text containing a letter outside Word_Break ALetter/Hebrew_Letter cannot be
//! segmented identically, so duplicate detection over it is refused (`words` → None).

use icu_properties::{
    CodePointMapData, CodePointSetData,
    props::{ExtendedPictographic, WordBreak, WordBreak as Wb},
};
use std::{collections::BTreeSet, sync::LazyLock};

use crate::shared::js_space;

pub fn normalize(text: &str) -> String {
    icu_normalizer::ComposingNormalizerBorrowed::new_nfkc().normalize(text).to_lowercase()
}

/// Every run of `space` characters as one ` `.
fn collapse(text: &str, space: impl Fn(char) -> bool) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if !space(c) {
            out.push(c);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    out
}
/// JS `trim()` then `/\s+/gu` → one space.
pub fn normalize_title(title: &str) -> String {
    collapse(normalize(title).trim_matches(js_space), js_space)
}

pub const STOPWORDS: [&str; 10] = [
    "a an and are as at be been but by for from has have he her his i if in is it its me my not of on or our she that the their them they this to was we were will with you your",
    "à au aux avec ce ces cette dans de des du elle en est et eux il ils je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous",
    "aber als am an auch auf aus bei das dem den der des die ein eine einem einen einer eines er es für hat ich im in ist mit nicht oder sie sind und vom von war wie wir zu zum zur",
    "a al con como de del el ella en es esta este esto fue ha la las lo los me mi mis no o para pero por que se sin su sus un una unos y yo",
    "או אז אל אם אני אנו את אתה אתם הוא היא הם הן זה זו היה היא היו יש כי כל לא לי מה מי על עם של שלה שלו שלנו גם רק",
    "これ それ あれ この その あの ここ そこ 私 あなた 彼 彼女 は が を に の と で も へ や から まで より です ます する した いる ある こと もの ため",
    "अनि अब आफू आप आफ्नो एक को का कि की के गरि गरी गर्छ छ छन् छु छैन तथा त त्यो त्यस देखि नै पनि पर पछि म मा मेरो यो र लाई लागि ले वा हामी हो हुन्",
    "а без бы был была были было в вам вас во вы да для до его ее её ей ему если есть еще ещё же за и из или им их к как ко на не но о об он она они оно от по при с со так то у уже что это я мы ты",
    "ama bir bu da daha de diye en gibi hem her için ile ise ki mı mi mu mü ne o olan olarak olmak olur onu siz şu ve veya ya yani ile ben sen biz onlar",
    "的 了 和 是 在 有 我 你 他 她 它 我们 你们 他们 这 那 一个 与 及 或 而 也 都 就 为 对 把 被 从 到 中 上 下 会 能 要",
];
static STOP: LazyLock<std::collections::HashSet<String>> =
    LazyLock::new(|| STOPWORDS.iter().flat_map(|w| w.split(' ')).map(normalize).collect());

fn class(c: char) -> Wb {
    static MAP: LazyLock<icu_properties::CodePointMapDataBorrowed<'static, WordBreak>> =
        LazyLock::new(CodePointMapData::<WordBreak>::new);
    // The retired emoji classes behave as Other (no code point carries them).
    match MAP.get(c) {
        Wb::EBase | Wb::EBaseGAZ | Wb::EModifier | Wb::GlueAfterZwj => Wb::Other,
        w => w,
    }
}
fn pictographic(c: char) -> bool {
    static SET: LazyLock<icu_properties::CodePointSetDataBorrowed<'static>> =
        LazyLock::new(CodePointSetData::new::<ExtendedPictographic>);
    SET.contains(c)
}
fn letter(c: char) -> bool {
    static L: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\p{L}").unwrap());
    let mut buf = [0u8; 4];
    L.is_match(c.encode_utf8(&mut buf))
}

/// UAX #29 word boundaries (WB1–WB999) over `chars`; returns segment start indices.
fn boundaries(chars: &[char]) -> Vec<usize> {
    let classes: Vec<Wb> = chars.iter().map(|c| class(*c)).collect();
    let ignorable = |w: Wb| matches!(w, Wb::Extend | Wb::Format | Wb::ZWJ);
    let ahletter = |w: Wb| matches!(w, Wb::ALetter | Wb::HebrewLetter);
    let midnumletq = |w: Wb| matches!(w, Wb::MidNumLet | Wb::SingleQuote);
    // Effective class at a position after WB4 (the preceding non-ignorable base).
    let mut base: Vec<Option<usize>> = vec![None; chars.len()];
    let mut last: Option<usize> = None;
    for i in 0..chars.len() {
        let w = classes[i];
        if !ignorable(w) || matches!(last.map(|l| classes[l]), None | Some(Wb::CR | Wb::LF | Wb::Newline)) {
            last = Some(i);
        }
        base[i] = last;
    }
    let next_base = |from: usize| -> Option<usize> { (from..chars.len()).find(|&k| !ignorable(classes[k])) };
    let mut starts = vec![0];
    let mut ri_run = 0usize;
    for i in 1..chars.len() {
        let (a, b) = (classes[i - 1], classes[i]);
        let joined = (|| {
            if a == Wb::CR && b == Wb::LF {
                return true; // WB3
            }
            if matches!(a, Wb::CR | Wb::LF | Wb::Newline) || matches!(b, Wb::CR | Wb::LF | Wb::Newline) {
                return false; // WB3a, WB3b
            }
            if a == Wb::ZWJ && pictographic(chars[i]) {
                return true; // WB3c
            }
            if a == Wb::WSegSpace && b == Wb::WSegSpace {
                return true; // WB3d
            }
            if ignorable(b) {
                return true; // WB4
            }
            let Some(pi) = base[i - 1] else { return false };
            let p = classes[pi];
            let prev_prev = || pi.checked_sub(1).and_then(|k| base[k]).map(|k| classes[k]);
            let after = || next_base(i + 1).map(|k| classes[k]);
            if ahletter(p) && ahletter(b) {
                return true; // WB5
            }
            if ahletter(p) && (b == Wb::MidLetter || midnumletq(b)) && after().is_some_and(ahletter) {
                return true; // WB6
            }
            if (p == Wb::MidLetter || midnumletq(p)) && ahletter(b) && prev_prev().is_some_and(ahletter) {
                return true; // WB7
            }
            if p == Wb::HebrewLetter && b == Wb::SingleQuote {
                return true; // WB7a
            }
            if p == Wb::HebrewLetter && b == Wb::DoubleQuote && after() == Some(Wb::HebrewLetter) {
                return true; // WB7b
            }
            if p == Wb::DoubleQuote && b == Wb::HebrewLetter && prev_prev() == Some(Wb::HebrewLetter) {
                return true; // WB7c
            }
            if p == Wb::Numeric && b == Wb::Numeric
                || ahletter(p) && b == Wb::Numeric
                || p == Wb::Numeric && ahletter(b)
            {
                return true; // WB8–WB10
            }
            if (p == Wb::MidNum || midnumletq(p)) && b == Wb::Numeric && prev_prev() == Some(Wb::Numeric) {
                return true; // WB11
            }
            if p == Wb::Numeric && (b == Wb::MidNum || midnumletq(b)) && after() == Some(Wb::Numeric) {
                return true; // WB12
            }
            if p == Wb::Katakana && b == Wb::Katakana {
                return true; // WB13
            }
            if matches!(p, Wb::ALetter | Wb::HebrewLetter | Wb::Numeric | Wb::Katakana | Wb::ExtendNumLet)
                && b == Wb::ExtendNumLet
            {
                return true; // WB13a
            }
            if p == Wb::ExtendNumLet && matches!(b, Wb::ALetter | Wb::HebrewLetter | Wb::Numeric | Wb::Katakana) {
                return true; // WB13b
            }
            if p == Wb::RegionalIndicator && b == Wb::RegionalIndicator {
                return ri_run % 2 == 1; // WB15, WB16
            }
            false
        })();
        if b == Wb::RegionalIndicator {
            ri_run = if base[i - 1].map(|k| classes[k]) == Some(Wb::RegionalIndicator) { ri_run + 1 } else { 1 };
        } else if !ignorable(b) {
            ri_run = 0;
        }
        if !joined {
            starts.push(i);
        }
    }
    starts
}

/// `words(text)` of `rules.ts`; `None` when ICU's dictionary segmentation would apply.
pub fn words(text: &str) -> Option<BTreeSet<String>> {
    let n = normalize(text);
    let chars: Vec<char> = n.chars().collect();
    if chars.iter().any(|c| letter(*c) && !matches!(class(*c), Wb::ALetter | Wb::HebrewLetter)) {
        return None;
    }
    let mut out = BTreeSet::new();
    if chars.is_empty() {
        return Some(out);
    }
    let mut starts = boundaries(&chars);
    starts.push(chars.len());
    for pair in starts.windows(2) {
        let segment: String = chars[pair[0]..pair[1]].iter().collect();
        let word_like =
            chars[pair[0]..pair[1]].iter().any(|c| matches!(class(*c), Wb::ALetter | Wb::HebrewLetter | Wb::Numeric));
        if word_like && segment.chars().any(letter) && !STOP.contains(&segment) {
            out.insert(segment);
        }
    }
    Some(out)
}

pub fn similarity(left: &BTreeSet<String>, right: &BTreeSet<String>) -> f64 {
    if left.len() < 4 || right.len() < 4 {
        return 0.0;
    }
    let common = left.intersection(right).count();
    common as f64 / (left.len() + right.len() - common) as f64
}

const W: &str = r"[\p{L}\p{M}\p{N}_]";
const LM: &str = r"[\p{L}\p{M}]";
fn word(alternatives: &str) -> String {
    format!(r"(?<!{W})(?:{alternatives})(?!{W})")
}
/// `MEMORY_INJECTION_PATTERNS` (applied to whitespace-collapsed text).
static INJECTION: LazyLock<Vec<fancy_regex::Regex>> = LazyLock::new(|| {
    let w = word;
    let l = LM;
    let mut sources: Vec<String> = vec![
        // en
        format!(
            "{}.{{0,50}}{}.{{0,30}}{}",
            w("ignore|disregard|forget|override"),
            w("previous|prior|above|system|all"),
            w("instructions?|rules?|prompts?")
        ),
        format!(
            "{}.{{0,30}}{}.{{0,30}}{}",
            w("ignore|disregard|forget|override"),
            w("instructions?|rules?|prompts?"),
            w("above|previous|prior|system")
        ),
        format!("{}.{{0,40}}{}", w("bypass|disable|override"), w("safety|security|safeguards?|restrictions?")),
        format!(
            "{}.{{0,100}}{}",
            w("send|upload|exfiltrate|reveal|transmit|leak"),
            w("secrets?|passwords?|credentials?|api[ -]?keys?|tokens?|private[ -]?keys?")
        ),
        // fr
        format!(
            "{}.{{0,50}}{}.{{0,40}}{}",
            w(&format!("ignor{l}*|oublie{l}*|contourn{l}*")),
            w("instructions?|règles?|consignes?"),
            w(&format!("précédent{l}*|antérieur{l}*|système|toutes?"))
        ),
        format!(
            "{}.{{0,30}}{}.{{0,30}}{}",
            w(&format!("ignor{l}*|oublie{l}*|contourn{l}*")),
            w(&format!("précédent{l}*|antérieur{l}*|toutes?")),
            w("instructions?|règles?|consignes?")
        ),
        format!("{}.{{0,40}}{}", w(&format!("désactiv{l}*|contourn{l}*")), w(&format!("sécurité|protection{l}*"))),
        format!(
            "{}.{{0,100}}{}",
            w(&format!("envoi{l}*|envoy{l}*|exfiltr{l}*|révèl{l}*|révél{l}*|transmet{l}*")),
            w("secrets?|mots? de passe|identifiants?|clés? api|jetons?")
        ),
        // de
        format!(
            "{}.{{0,60}}{}",
            w(&format!("ignorier{l}*|vergiss|missacht{l}*")),
            w("anweisungen|instruktionen|regeln")
        ),
        format!("{}.{{0,40}}{}", w(&format!("umgeh{l}*|deaktivier{l}*")), w(&format!("sicherheit{l}*|schutz{l}*"))),
        format!(
            "{}.{{0,100}}{}",
            w(&format!("send{l}*|übertrag{l}*|offenbar{l}*|exfiltrier{l}*")),
            w(&format!("geheimnisse|passwörter|zugangsdaten|api[ -]?schlüssel|token{l}*"))
        ),
        // es
        format!(
            "{}.{{0,60}}{}",
            w(&format!("ignora{l}*|olvida{l}*|omite{l}*")),
            w("instrucciones|reglas|indicaciones")
        ),
        format!(
            "{}.{{0,40}}{}",
            w(&format!("desactiva{l}*|elude{l}*|evita{l}*")),
            w("seguridad|protecciones|salvaguardas")
        ),
        format!(
            "{}.{{0,100}}{}",
            w(&format!("envía{l}*|envia{l}*|revela{l}*|exfiltra{l}*|transmite{l}*")),
            w("secretos|contraseñas|credenciales|claves api|tokens")
        ),
    ];
    sources.extend(
        [
            // he
            "(?:התעלם|התעלמי|שכח|עקוף).{0,50}(?:הוראות|הנחיות|כללים)",
            "(?:בטל|עקוף|השבת).{0,40}(?:בטיחות|אבטחה|הגנות)",
            "(?:שלח|שלחי|העלה|חשוף|הדלף).{0,100}(?:סודות|סיסמאות|פרטי גישה|מפתחות api|אסימונים)",
            // ja
            "(?:以前|前の|上記|すべて|全て|システム).{0,30}(?:指示|命令|ルール).{0,30}(?:無視|忘れ|上書き)",
            "(?:安全|セキュリティ|保護).{0,30}(?:無効|回避|解除)",
            "(?:秘密|パスワード|認証情報|apiキー|トークン|秘密鍵).{0,80}(?:送信|送って|アップロード|公開|漏ら)",
            // ne
            "(?:अघिल्ला|अघिल्लो|पहिलेका|सबै|प्रणाली).{0,40}(?:निर्देशन|नियम).{0,40}(?:बेवास्ता|बिर्स|नमान)",
            "(?:सुरक्षा|सुरक्षण).{0,40}(?:निष्क्रिय|बन्द|बाइपास|हटाउ)",
            "(?:गोप्य|पासवर्ड|प्रमाणपत्र|एपिआई कुञ्जी|टोकन).{0,80}(?:पठाउ|अपलोड|खुलासा|सार्वजनिक)",
            // ru
            "(?:игнорируй|игнорируйте|забудь|забудьте|отмени).{0,60}(?:инструкции|указания|правила)",
            "(?:отключи|обойди|обойти).{0,40}(?:безопасность|защиту|ограничения)",
            "(?:отправь|отправьте|передай|раскрой|выгрузи).{0,100}(?:секреты|пароли|учётные данные|учетные данные|ключи api|токены)",
            // tr
            "(?:önceki|önce|tüm|sistem).{0,40}(?:talimat|yönerge|kural).{0,40}(?:yok say|unut|görmezden gel)",
            "(?:güvenlik|koruma).{0,40}(?:devre dışı|atla|kaldır)",
            "(?:sırları|parolaları|şifreleri|kimlik bilgilerini|api anahtarlarını|belirteçleri).{0,80}(?:gönder|yükle|açığa çıkar|sızdır)",
            // zh-Hans
            "(?:忽略|无视|忘记|覆盖).{0,40}(?:指令|指示|规则|提示词)",
            "(?:绕过|禁用|关闭).{0,30}(?:安全|保护|限制)",
            "(?:发送|上传|泄露|公开|传输).{0,80}(?:秘密|密码|凭据|api密钥|令牌|私钥)",
            "(?:秘密|密码|凭据|api密钥|令牌|私钥).{0,80}(?:发送|上传|泄露|公开|传输)",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    // JS `.` without `s` excludes line terminators; the input never contains any.
    sources.into_iter().map(|s| fancy_regex::Regex::new(&s).expect("injection pattern")).collect()
});
const JS_SPACE: &str =
    r"[\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";
static ROLE: LazyLock<regex::Regex> = LazyLock::new(|| {
    let s = JS_SPACE;
    regex::Regex::new(&format!(
        r"(?:^|\n){s}*(?:#{{1,6}}{s}*)?(?:system|developer|assistant|système|développeur|assistent|entwickler|sistema|desarrollador|asistente|מערכת|מפתח|עוזר|システム|開発者|アシスタント|प्रणाली|सिस्टम|विकासकर्ता|सहायक|система|разработчик|ассистент|sistem|geliştirici|asistan|系统|开发者|助手){s}*[:：]|<\|(?:im_start|system|start_header_id)\|>|\[/?(?:system|inst)\]|</?(?:system|developer)>"
    ))
    .expect("role pattern")
});
fn format_control(c: char) -> bool {
    static CF: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\p{Cf}").unwrap());
    let mut buf = [0u8; 4];
    CF.is_match(c.encode_utf8(&mut buf))
}

/// `reviewMemoryEntry` for one field.
pub fn suspicious(value: &str) -> bool {
    let visible: String = normalize(value).chars().filter(|c| !format_control(*c)).collect();
    let role = collapse(&visible, |c| js_space(c) && c != '\n');
    if ROLE.is_match(&role) {
        return true;
    }
    let flat = collapse(&role, js_space);
    INJECTION.iter().any(|p| p.is_match(&flat).unwrap_or(true))
}
