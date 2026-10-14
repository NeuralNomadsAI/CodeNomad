# Sağlayıcılar ve hesaplar

Sağlayıcı kimlik doğrulaması, tarayıcı cihazına veya bir CodeNomad projesine değil, bağlı OpenCode hizmetine aittir. Model görüntüleme tercihleri, abonelik kotaları ve web arama seçeneklerinin farklı kapsamları vardır.

## Bir modeli veya arama sağlayıcısını bağlayın {#connect}

1. Çalışma alanı açıp **Ayarlar → Provider'lar** yoluna gidin.
2. **Modeller** veya **Web araması** bölümünde **Provider seç** öğesini, ardından **Bağlan** öğesini seçin.
3. Sunulan yerel **Kimlik doğrulama yöntemi** öğesini tamamlayın: API anahtarı, OAuth veya komut. OAuth için **Yetkilendirme sayfasını aç** öğesini kullanın ve yalnızca istendiğinde bir yetkilendirme kodu gönderin.
4. Tamamlandıktan sonra yapılandırılmış sağlayıcı satırını kontrol edin; sonuç net değilse **Yenile** kullanın.

Yalnızca arama entegrasyonları **Modeller** altında değil, **Web araması** altında görünür. Kimlik doğrulamanın kaydedilmesi bir model seçmez veya varsayılan arama sağlayıcısını değiştirmez. API anahtarları ve OAuth kimlik bilgileri, etkin OpenCode sunucusu tarafından kaydedilir. Tarayıcı, kayıtlı kimlik bilgisi sırlarını değil, bağlantı meta verilerini alır. Ortam değişkenlerinden kaynaklanan bir bağlantı bu kullanıcı arayüzünde salt okunurdur: bağlantıyı burada kesmeye çalışmak yerine sahibi olduğu ortamı değiştirin.

Yetkilendirme penceresi engellenmişse akıştan **Yetkilendirme sayfasını aç**, **Bu sekmede aç** veya **Bağlantıyı kopyala** öğesini kullanın. Yetkilendirme bağlantısını veya kodunu teşhiste yayınlamayın.

## Hesapları seçin ve yönetin {#accounts}

1. Sağlayıcının satırında, kayıtlı bir kimlik bilgisini seçmek için **Etkin hesap** öğesini kullanın.
2. Başka bir bağlantının kimliğini doğrulamak için **Hesap ekle** öğesini kullanın.
3. Farklı bir kayıtlı hesabı yönetmek için önce hesabı seçin, ardından **Hesabı yeniden adlandır** veya **Hesabı kaldır** öğesini kullanın. Yeniden adlandırma **Hesap adı** ve **Kaydet** öğesini kullanır.

Seçme, yeniden adlandırma ve kaldırma, diğer projeler ve istemciler de dahil olmak üzere OpenCode hizmeti genelindeki entegrasyonu etkiler. Bir kimlik bilgisinin kaldırılması, bu istemcilerin kimlik doğrulaması olmadan kalmasına neden olabilir; konuşma geçmişini silmez veya sağlayıcının uzak hesabını iptal etmez. Ortam bağlantıları, yazılabilir kayıtlı kimlik bilgileri olarak seçilemez veya buradan kaldırılamaz. Bir işlem başarısız olursa, tekrar harekete geçmeden önce **Etkin hesap** öğesini yenileyin ve uzlaştırın.

### Otomatik seçim sınırları {#automatic-selection}

Desteklenen entegrasyonda birden fazla kayıtlı kimlik bilgisi varsa **Hesabı otomatik seç**, CodeNomad üzerinden sonraki istem/özel komut kabulünden önce kota tabanlı seçimi etkinleştirir. Ayar CodeNomad yapılandırmasında entegrasyon başınadır; sonuçtaki hesap seçimi hizmet genelindedir.

| Uygun entegrasyon | Uygun hesap türü |
| --- | --- |
| OpenAI / Codex | OpenAI kullandıkça öde anahtarları değil, Codex OAuth abonelik hesapları. |
| OpenCode Go | Go anahtarı veya Console girişi; **yalnızca Go sağlayıcısı** için kullanılır, OpenCode Zen kullandıkça öde kredileri için değil. |
| Anthropic | OpenCode'un Claude Pro/Max OAuth girişi; Claude Code girişi **değil**. |
| GitHub Copilot | Okunabilir premium istek kotasına sahip OAuth; kurumsal uç nokta kimlik bilgileri okunabilir aday değildir. |
| Kodlama planları | Anahtar tabanlı `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Geçişi yalnızca mevcut hesabın kotasının tamamen dolması tetikler; alternatif hesabın daha fazla kapasitesi olması yetmez. Okumalar adayları etkinleştirmeden veya yenileme belirteçlerini takas etmeden her kayıtlı kimlik bilgisini inceler. Codex, Copilot ve kodlama planlarında kullanılabilir olduğu gösterilebilen aday gerekir. Go, Console ve Claude, yakın tarihli yerel kota hatasıyla tükenmiş işaretlenmeyen, kotası bilinmeyen adayı kullanabilir. OpenCode Go kullanım uç noktası ve Console OAuth kullanımı kaynak tarafta doğrulanmamıştır; kullanılabilirlik garantisi yoktur.

Bu, **devam eden istek için otomatik geçiş değildir**. Başarısız istekleri yeniden denemez; istemleri, komutları veya değişiklik işlemlerini yeniden yürütmez. Ortam bağlantılarını, isteğe bağlı sağlayıcıları, kullandıkça öde bakiyelerini veya harici Claude Code girişlerini döndürmez. Hazırlık sırasında elle yapılan hesap değişikliklerine uyulur; istemciler arası hesap kilidi yoktur. Kota/kimlik doğrulama hatalarında **Etkin hesap** bilgisini inceleyin, Kullanımı yenileyin ve bilinçli yeniden göndermeden önce gerekirse kimlik bilgisi sahibinde oturum açın.

## Model görünürlüğü, favoriler ve Düşünme {#models}

1. Model sağlayıcının yanında **Modelleri yönet** öğesini seçin.
2. Ada/kimliğe göre arama yapın ve görünürlüğü değiştirin; **Tümünü göster** ve **Tümünü gizle**, söz konusu sağlayıcının seçici listesini etkiler.
3. Bir konuşmanın **Model** seçicisinde **Favorilere ekle** veya **Favorilerden kaldır** öğesini kullanın; **Tüm modelleri göster** yalnızca favorilere yönelik filtrelemeyi bırakır.
4. Seçilen modelin sunduğu varyantlar için ileti düzenleyicisinde **Düşünme** öğesini kullanın.

Görünürlük ve sık kullanılanlar, CodeNomad'in seçicilerini düzenler; modelleri kaldırmaz, kimlik bilgilerini kaldırmaz veya diğer OpenCode istemcilerinin bunları kullanmasını engellemez. Bir modeli gizlemek hesap bağlantısını kesmek değildir. Düşünme, zaten konuşma dökümünde bulunan akıl yürütmenin görünürlüğünü değil, sonraki gönderimler için bir model çeşidi seçer. Gizli modelleri **Modelleri yönet → Tümünü göster** ile geri yükleyin.

## Kullanım, belirteç sayıları ve süresi dolmuş oturum açma bilgileri {#usage}

Etkin görüşmenin sağlayıcı planı pencereleri, sıfırlama süreleri ve desteklenen bakiyeler için sağ paneldeki **Kullanım** öğesini kullanın. Bu sağlayıcı okumaları, mesaj başına **Tokenlar** ve maliyet tahminlerinden farklıdır: abonelik kotası, görünür konuşma dökümünden hesaplanan bir fatura değildir. Eksik, eski veya bilinmeyen bir okuma, sıfır kullanım veya kalan kapasitenin kanıtı değildir. Sohbet ayarlarındaki **Sağlayıcı kredi bakiyesi** ek bakiye ekranını kontrol eder.

Kullanım, seçili OpenCode kimlik bilgisini izler. Claude, `anthropic`/`claude` üzerinden OpenCode Anthropic OAuth girişini kullanır. `claude-code` sağlayıcısı, WSL dağıtımı dahil daemon ana bilgisayarındaki Claude Code girişini kullanır: önce `CLAUDE_CODE_OAUTH_TOKEN`, sonra kayıtlı giriş; dosya deposunu `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` veya `~/.claude` belirler; native macOS Keychain kullanılabilir. CodeNomad bir Claude girişini diğerinin yerine kullanmaz.

Süresi dolmuş bir sağlayıcı girişi için, sahibi (OpenCode, Claude Code veya Codex CLI) aracılığıyla yenileyin/oturum açın, ardından CodeNomad'i yenileyin. CodeNomad, harici olarak sahip olunan yenileme belirteçlerini takas etmez. CodeNomad sunucu oturum açma süresinin sona ermesi ayrıdır: başarısız bir sağlayıcı isteğinin yeniden gönderileceğini varsaymadan CodeNomad'e yeniden bağlanın/oturum açın. Bkz. [Sorun Giderme](troubleshooting.md).

### İsteğe bağlı kullanım ortamı değişkenleri {#usage-environment}

Bunları başlatmadan önce **CodeNomad arka uç sürecinin** ortamında ayarlayın. Bunlar tarayıcı ayarı veya model seçimi değil, kullanım okuyucusu kimlik bilgileridir. Oturum **Ortam Değişkenleri** düzenleyicisini değiştirmek çalışan arka ucun bu okuyucular için kullandığı `process.env` değerini güncellemez. Değiştirirken arka ucu amaçlanan ortamda yeniden başlatın; yalnızca kullanım okuyucusu değişkeni için ortak OpenCode hizmetini yeniden başlatmayın.

| Kullanım entegrasyonu | Ortam değişkeni |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, yoksa `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| OpenCode Go ek kullanımı | `OPENCODE_GO_WORKSPACE_ID` ve `OPENCODE_GO_AUTH_COOKIE` birlikte |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — çıkarım anahtarından farklı platform anahtarı |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | Native kimlik bilgisi yoksa `COMMAND_CODE_API_KEY` kullanılır |

Belirteçleri/çerezleri kabuk geçmişinden, ekran görüntülerinden ve raporlardan uzak tutun. İsteğe bağlı okuyucular, sağlayıcı API'lerine ve kimlik bilgilerinin geçerliliğine bağlıdır; Bir değişkenin yapılandırılması, kullanılabilir kota verilerinin garantisi değildir.

## Web araması varsayılanı ve Proje geçersiz kılma {#web-search}

1. **Ayarlar → Provider'lar → Web araması** bölümünde, kimlik doğrulaması gerekiyorsa arama entegrasyonunu bağlayın.
2. Genel yapılandırma için **Varsayılan arama** öğesini seçin.
3. Etkin Location için geçersiz kılmak üzere **Geçerli proje için** öğesini kullanın. Etkili sonuç için **Bu projede arama** öğesini kontrol edin.

Değişiklikler otomatik olarak kaydedilir. **Varsayılan / devralınan**, devralınan yapılandırmayı veya kaydedilen yerel seçimi kullanır; Proje geçersiz kılma Global'e galip gelir. **Devre dışı** seçilen kapsamda aramayı kapatır; **Otomatik sağlayıcı**, yerel otomatik sağlayıcı seçimi talep ediyor. Ortam kaynaklı bir seçim salt okunur olarak görüntülenir.

Arama kimlik bilgileri, sağlayıcı seçimi Proje kapsamında olsa bile hizmet geneli olarak kalır. Bir anahtarın kaydedilmesi, onu arama varsayılanı olarak seçmez. Okuma/kaydetme işlemi başarısız olursa, yeniden denemeden önce yenileyin; konfigürasyonu körü körüne değiştirmeyin. Yerel yapılandırma ayrıntıları için, bkz. [OpenCode belgeleri](https://opencode.ai/v2/docs/) ve [OpenCode kurulumu](opencode.md).
