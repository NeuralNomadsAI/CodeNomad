/** Small, explicit stopword sets for every UI language; applied together to mixed-language text. */
export const MEMORY_STOPWORDS = {
  en: "a an and are as at be been but by for from has have he her his i if in is it its me my not of on or our she that the their them they this to was we were will with you your",
  fr: "à au aux avec ce ces cette dans de des du elle en est et eux il ils je la le les leur lui ma mais me mes moi mon ne nos notre nous on ou par pas pour que qui sa se ses son sur ta te tes toi ton tu un une vos votre vous",
  de: "aber als am an auch auf aus bei das dem den der des die ein eine einem einen einer eines er es für hat ich im in ist mit nicht oder sie sind und vom von war wie wir zu zum zur",
  es: "a al con como de del el ella en es esta este esto fue ha la las lo los me mi mis no o para pero por que se sin su sus un una unos y yo",
  he: "או אז אל אם אני אנו את אתה אתם הוא היא הם הן זה זו היה היא היו יש כי כל לא לי מה מי על עם של שלה שלו שלנו גם רק",
  ja: "これ それ あれ この その あの ここ そこ 私 あなた 彼 彼女 は が を に の と で も へ や から まで より です ます する した いる ある こと もの ため",
  ne: "अनि अब आफू आप आफ्नो एक को का कि की के गरि गरी गर्छ छ छन् छु छैन तथा त त्यो त्यस देखि नै पनि पर पछि म मा मेरो यो र लाई लागि ले वा हामी हो हुन्",
  ru: "а без бы был была были было в вам вас во вы да для до его ее её ей ему если есть еще ещё же за и из или им их к как ко на не но о об он она они оно от по при с со так то у уже что это я мы ты",
  tr: "ama bir bu da daha de diye en gibi hem her için ile ise ki mı mi mu mü ne o olan olarak olmak olur onu siz şu ve veya ya yani ile ben sen biz onlar",
  "zh-Hans": "的 了 和 是 在 有 我 你 他 她 它 我们 你们 他们 这 那 一个 与 及 或 而 也 都 就 为 对 把 被 从 到 中 上 下 会 能 要",
} as const

/** Detection is deliberately conservative: suspicious instructions stay available for human review. */
export const MEMORY_INJECTION_PATTERNS = {
  en: [
    /\b(?:ignore|disregard|forget|override)\b.{0,50}\b(?:previous|prior|above|system|all)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b/u,
    /\b(?:ignore|disregard|forget|override)\b.{0,30}\b(?:instructions?|rules?|prompts?)\b.{0,30}\b(?:above|previous|prior|system)\b/u,
    /\b(?:bypass|disable|override)\b.{0,40}\b(?:safety|security|safeguards?|restrictions?)\b/u,
    /\b(?:send|upload|exfiltrate|reveal|transmit|leak)\b.{0,100}\b(?:secrets?|passwords?|credentials?|api[ -]?keys?|tokens?|private[ -]?keys?)\b/u,
  ],
  fr: [
    /\b(?:ignore\w*|ignor\w*|oublie\w*|contourn\w*)\b.{0,50}\b(?:instructions?|règles?|consignes?)\b.{0,40}\b(?:précédent\w*|antérieur\w*|système|toutes?)\b/u,
    /\b(?:ignor\w*|oublie\w*|contourn\w*)\b.{0,30}\b(?:précédent\w*|antérieur\w*|toutes?)\b.{0,30}\b(?:instructions?|règles?|consignes?)\b/u,
    /\b(?:désactiv\w*|contourn\w*)\b.{0,40}\b(?:sécurité|protection\w*)(?!\p{L})/u,
    /\b(?:envoi\w*|envoy\w*|exfiltr\w*|révèl\w*|révél\w*|transmet\w*)\b.{0,100}\b(?:secrets?|mots? de passe|identifiants?|clés? api|jetons?)\b/u,
  ],
  de: [
    /\b(?:ignorier\w*|vergiss|missacht\w*)\b.{0,60}\b(?:anweisungen|instruktionen|regeln)\b/u,
    /\b(?:umgeh\w*|deaktivier\w*)\b.{0,40}\b(?:sicherheit\w*|schutz\w*)\b/u,
    /\b(?:send\w*|sende\w*|übertrag\w*|offenbar\w*|exfiltrier\w*)\b.{0,100}\b(?:geheimnisse|passwörter|zugangsdaten|api[ -]?schlüssel|token\w*)\b/u,
  ],
  es: [
    /\b(?:ignora\w*|olvida\w*|omite\w*)\b.{0,60}\b(?:instrucciones|reglas|indicaciones)\b/u,
    /\b(?:desactiva\w*|elude\w*|evita\w*)\b.{0,40}\b(?:seguridad|protecciones|salvaguardas)\b/u,
    /\b(?:envía\w*|envia\w*|revela\w*|exfiltra\w*|transmite\w*)\b.{0,100}\b(?:secretos|contraseñas|credenciales|claves api|tokens)\b/u,
  ],
  he: [
    /(?:התעלם|התעלמי|שכח|עקוף).{0,50}(?:הוראות|הנחיות|כללים)/u,
    /(?:בטל|עקוף|השבת).{0,40}(?:בטיחות|אבטחה|הגנות)/u,
    /(?:שלח|שלחי|העלה|חשוף|הדלף).{0,100}(?:סודות|סיסמאות|פרטי גישה|מפתחות api|אסימונים)/u,
  ],
  ja: [
    /(?:以前|前の|上記|すべて|全て|システム).{0,30}(?:指示|命令|ルール).{0,30}(?:無視|忘れ|上書き)/u,
    /(?:安全|セキュリティ|保護).{0,30}(?:無効|回避|解除)/u,
    /(?:秘密|パスワード|認証情報|apiキー|トークン|秘密鍵).{0,80}(?:送信|送って|アップロード|公開|漏ら)/u,
  ],
  ne: [
    /(?:अघिल्ला|अघिल्लो|पहिलेका|सबै|प्रणाली).{0,40}(?:निर्देशन|नियम).{0,40}(?:बेवास्ता|बिर्स|नमान)/u,
    /(?:सुरक्षा|सुरक्षण).{0,40}(?:निष्क्रिय|बन्द|बाइपास|हटाउ)/u,
    /(?:गोप्य|पासवर्ड|प्रमाणपत्र|एपिआई कुञ्जी|टोकन).{0,80}(?:पठाउ|अपलोड|खुलासा|सार्वजनिक)/u,
  ],
  ru: [
    /(?:игнорируй|игнорируйте|забудь|забудьте|отмени).{0,60}(?:инструкции|указания|правила)/u,
    /(?:отключи|обойди|обойти).{0,40}(?:безопасность|защиту|ограничения)/u,
    /(?:отправь|отправьте|передай|раскрой|выгрузи).{0,100}(?:секреты|пароли|учётные данные|учетные данные|ключи api|токены)/u,
  ],
  tr: [
    /(?:önceki|önce|tüm|sistem).{0,40}(?:talimat|yönerge|kural).{0,40}(?:yok say|unut|görmezden gel)/u,
    /(?:güvenlik|koruma).{0,40}(?:devre dışı|atla|kaldır)/u,
    /(?:sırları|parolaları|şifreleri|kimlik bilgilerini|api anahtarlarını|belirteçleri).{0,80}(?:gönder|yükle|açığa çıkar|sızdır)/u,
  ],
  "zh-Hans": [
    /(?:忽略|无视|忘记|覆盖).{0,40}(?:指令|指示|规则|提示词)/u,
    /(?:绕过|禁用|关闭).{0,30}(?:安全|保护|限制)/u,
    /(?:发送|上传|泄露|公开|传输).{0,80}(?:秘密|密码|凭据|api密钥|令牌|私钥)/u,
    /(?:秘密|密码|凭据|api密钥|令牌|私钥).{0,80}(?:发送|上传|泄露|公开|传输)/u,
  ],
} as const

export const MEMORY_ROLE_PATTERN = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:system|developer|assistant|système|développeur|assistent|entwickler|sistema|desarrollador|asistente|מערכת|מפתח|עוזר|システム|開発者|アシスタント|प्रणाली|सिस्टम|विकासकर्ता|सहायक|система|разработчик|ассистент|sistem|geliştirici|asistan|系统|开发者|助手)\s*[:：]|<\|(?:im_start|system|start_header_id)\|>|\[\/?(?:system|inst)\]|<\/?(?:system|developer)>/u
