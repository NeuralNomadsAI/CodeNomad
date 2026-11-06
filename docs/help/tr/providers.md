# Sağlayıcılar ve hesaplar

Sağlayıcı kimlik doğrulaması, tarayıcı cihazına veya bir CodeNomad projesine değil, bağlı OpenCode hizmetine aittir. Model görüntüleme tercihleri, abonelik kotaları ve web arama seçeneklerinin farklı kapsamları vardır.

## Bir modeli veya arama sağlayıcısını bağlayın {#connect}

1. Çalışma alanı açıp **Ayarlar → Provider'lar** yoluna gidin. **Modeller** açık olarak başlar; arama sağlayıcıları için **Web araması** bölümünü genişletin. **Görseller** görsel ayarlarını içerir.
2. O grupta **Provider seç** öğesini, ardından **Bağlan** öğesini seçin.
3. Model sağlayıcısı için sunulan yerel **Kimlik doğrulama yöntemi** öğesini tamamlayın: API anahtarı, OAuth veya komut. OAuth için **Yetkilendirme sayfasını aç** öğesini kullanın ve yalnızca istendiğinde bir yetkilendirme kodu gönderin. Arama sağlayıcıları API anahtarıyla bağlanır.
4. Tamamlandıktan sonra yapılandırılmış sağlayıcı satırını kontrol edin. **Modeller** bağlantılardan, hesap değişikliklerinden ve yeniden bağlanmalardan sonra yeniden okunur; **Web araması** bölümünde ayrıca **Yenile** vardır.

Yalnızca arama entegrasyonları **Modeller** altında değil, **Web araması** altında görünür. Kimlik doğrulamanın kaydedilmesi bir model seçmez veya varsayılan arama sağlayıcısını değiştirmez. API anahtarları ve OAuth kimlik bilgileri, etkin OpenCode sunucusu tarafından kaydedilir. Tarayıcı, kayıtlı kimlik bilgisi sırlarını değil, bağlantı meta verilerini alır. Ortam değişkenlerinden kaynaklanan bir bağlantı bu kullanıcı arayüzünde salt okunurdur: bağlantıyı burada kesmeye çalışmak yerine sahibi olduğu ortamı değiştirin.

Yetkilendirme penceresi engellenmişse akıştan **Yetkilendirme sayfasını aç**, **Bu sekmede aç** veya **Bağlantıyı kopyala** öğesini kullanın. Yetkilendirme bağlantısını veya kodunu teşhiste yayınlamayın.

## Hesapları seçin ve yönetin {#accounts}

1. Sağlayıcının satırında, kayıtlı bir kimlik bilgisini seçmek için **Etkin hesap** öğesini kullanın.
2. Başka bir bağlantının kimliğini doğrulamak için **Hesap ekle** öğesini kullanın.
3. Farklı bir kayıtlı hesabı yönetmek için önce hesabı seçin, ardından **Hesabı yeniden adlandır** veya **Hesabı kaldır** öğesini kullanın. Yeniden adlandırma **Hesap adı** ve **Kaydet** öğesini kullanır; **Hesabı kaldır** onay istemeden hemen uygulanır.

Seçme, yeniden adlandırma ve kaldırma, diğer projeler ve istemciler de dahil olmak üzere OpenCode hizmeti genelindeki entegrasyonu etkiler. Bir kimlik bilgisinin kaldırılması, bu istemcilerin kimlik doğrulaması olmadan kalmasına neden olabilir; konuşma geçmişini silmez veya sağlayıcının uzak hesabını iptal etmez. Ortam bağlantıları, yazılabilir kayıtlı kimlik bilgileri olarak seçilemez veya buradan kaldırılamaz. Bir işlem başarısız olursa CodeNomad hesapları yeniden okur: tekrar harekete geçmeden önce **Etkin hesap** öğesini yeniden kontrol edin.

### Otomatik seçim sınırları {#automatic-selection}

Desteklenen entegrasyonda birden fazla kayıtlı kimlik bilgisi varsa **Hesabı otomatik seç**, CodeNomad üzerinden sonraki istem/özel komut kabulünden önce kota tabanlı seçimi etkinleştirir. Ayar CodeNomad yapılandırmasında entegrasyon başınadır; sonuçtaki hesap seçimi hizmet genelindedir.

| Uygun entegrasyon | Uygun hesap türü |
| --- | --- |
| OpenAI / Codex | Codex tarayıcı/cihaz OAuth abonelik hesapları; OpenAI kullandıkça öde anahtarları veya kullanım verisini OpenAI'ın sağlamadığı ChatGPT oturum açma yöntemi değil. |
| OpenCode Go | Go anahtarı veya **yalnızca Go sağlayıcısı** için kullanılan OpenCode Console girişi/anahtarı; Zen kullandıkça öde kredileri için değil. |
| Anthropic | OpenCode'un Claude Pro/Max OAuth girişi; Claude Code girişi **değil**. |
| GitHub Copilot | Okunabilir premium istek kotasına sahip OAuth; kurumsal uç nokta kimlik bilgileri okunabilir aday değildir. |
| Kodlama planları | Anahtar tabanlı `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `kimi`, `kimi-code-plan-cn`, `kimi-code-plan-global`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Geçişi yalnızca mevcut hesabın kotasının tamamen dolması tetikler; alternatif hesabın daha fazla kapasitesi olması yetmez. Okumalar adayları etkinleştirmeden veya yenileme belirteçlerini takas etmeden her kayıtlı kimlik bilgisini inceler. Codex, Copilot ve kodlama planlarında kullanılabilir olduğu gösterilebilen aday gerekir. Go, Console ve Claude, yakın tarihli yerel kota hatasıyla tükenmiş işaretlenmeyen, kotası bilinmeyen adayı kullanabilir. OpenCode Go okumaları kullanılabilir API'ye ve kimlik bilgisi izinlerine bağlıdır.

Bu, **devam eden istek için otomatik geçiş değildir**. Başarısız istekleri yeniden denemez; istemleri, komutları veya değişiklik işlemlerini yeniden yürütmez. Ortam bağlantılarını, isteğe bağlı sağlayıcıları, kullandıkça öde bakiyelerini veya harici Claude Code girişlerini döndürmez. Hazırlık sırasında elle yapılan hesap değişikliklerine uyulur; istemciler arası hesap kilidi yoktur. Kota/kimlik doğrulama hatalarında **Etkin hesap** bilgisini inceleyin, Kullanımı yenileyin ve bilinçli yeniden göndermeden önce gerekirse kimlik bilgisi sahibinde oturum açın.

## Model görünürlüğü, favoriler ve Düşünme {#models}

1. Model sağlayıcının yanında **Modelleri yönet** öğesini seçin.
2. Ada/kimliğe göre arama yapın ve görünürlüğü değiştirin; **Tümünü göster** ve **Tümünü gizle**, söz konusu sağlayıcının seçici listesini etkiler. Birden fazla modeli tek seferde değiştirmek için onay kutularının üzerinde sürükleyin.
3. Bir konuşmanın **Model** seçicisinde **Favorilere ekle** veya **Favorilerden kaldır** öğesini kullanın; **Tüm modelleri göster** yalnızca favorilere yönelik filtrelemeyi bırakır.
4. Seçilen modelin sunduğu varyantlar için ileti düzenleyicisinde **Düşünme** öğesini kullanın.

Görünürlük ve sık kullanılanlar, CodeNomad'in seçicilerini düzenler; modelleri kaldırmaz, kimlik bilgilerini kaldırmaz veya diğer OpenCode istemcilerinin bunları kullanmasını engellemez. Bir modeli gizlemek hesap bağlantısını kesmek değildir. Düşünme, zaten konuşma dökümünde bulunan akıl yürütmenin görünürlüğünü değil, sonraki gönderimler için bir model çeşidi seçer. Gizli modelleri **Modelleri yönet → Tümünü göster** ile geri yükleyin.

## Kullanım, belirteç sayıları ve süresi dolmuş oturum açma bilgileri {#usage}

Etkin görüşmenin sağlayıcı planı pencereleri, sıfırlama süreleri ve desteklenen bakiyeler için sağ paneldeki **Kullanım** öğesini kullanın. Bu sağlayıcı okumaları, mesaj başına **Tokenlar** ve maliyet tahminlerinden farklıdır: abonelik kotası, görünür konuşma dökümünden hesaplanan bir fatura değildir. Eksik, eski veya bilinmeyen bir okuma, sıfır kullanım veya kalan kapasitenin kanıtı değildir. **Ayarlar → Gelişmiş** içindeki **Sağlayıcı kredi bakiyesi** ek bakiye ekranını kontrol eder.

Ücretsiz OpenCode Zen modelleri için **Kullanım**, bu hizmette 00:00 UTC'den beri kaydedilen adımları, varsayılan günlük 200 isteğe göre tahmin eder; sonraki UTC gece yarısı tahmini sıfırlanma zamanıdır. Adımlar istekleri yaklaşık yansıtır; diğer trafik ve değişken IP sınırları gerçek kota kullanımından farklı sonuç verebilir.

OpenAI, ChatGPT oturum açma yöntemlerinden biri için kullanım verisi sağlamaz: Kullanım, kota pencereleri göstermek yerine bunu belirtir. ChatGPT'de uygulama kullanımını incelemek ve planınıza ve kredilerinize erişimi yönetmek için [ChatGPT kullanımını görüntüle](https://chatgpt.com/settings/usage) seçeneğini kullanın. Sohbet etmek yine çalışır ve aynı girişle yeniden bağlanmak bu okumayı geri getirmez.

Kullanım, seçili OpenCode kimlik bilgisini izler. Claude, `anthropic`/`claude` üzerinden OpenCode Anthropic OAuth girişini kullanır. OpenCode'un **Claude Agent** sağlayıcısı (`claude-agent`) ve `claude-code` sağlayıcısı, WSL dağıtımı dahil daemon ana bilgisayarındaki Claude Code girişini kullanır: önce `CLAUDE_CODE_OAUTH_TOKEN`, sonra kayıtlı giriş; dosya deposunu `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` veya `~/.claude` belirler; native macOS Keychain kullanılabilir. CodeNomad bir Claude girişini diğerinin yerine kullanmaz.

Süresi dolmuş bir sağlayıcı girişi için, sahibi (OpenCode, Claude Code veya Codex CLI) aracılığıyla yenileyin/oturum açın, ardından CodeNomad'i yenileyin. CodeNomad, harici olarak sahip olunan yenileme belirteçlerini takas etmez. CodeNomad sunucu oturum açma süresinin sona ermesi ayrıdır: başarısız bir sağlayıcı isteğinin yeniden gönderileceğini varsaymadan CodeNomad'e yeniden bağlanın/oturum açın. Bkz. [Sorun Giderme](troubleshooting.md).

MiniMax başarılı yanıtında sınırları sağlamadığında, **Kullanım** kota değerleri yerine **MiniMax sınırlarını paylaşmıyor** gösterir.

OpenRouter **Anahtar sınırı**, anahtarın harcama sınırına göre kalan USD tutarını gösterir; sınırı olmayan anahtarda bu satır bulunmaz. API erişime izin verdiğinde hesap kredileri ayrı gösterilir. Kullanım, yol öneki dahil sağlayıcının yapılandırılmış `baseURL` değerini, yoksa `https://openrouter.ai/api/v1` adresini kullanır. Kimlik bilgisi, açık port, sorgu veya parça içermeyen, herkese açık bir HTTPS ana makine adı kullanın; IP adresleri ve localhost reddedilir. Geçersiz URL veya `/key` içermeyen ağ geçidi kullanımı erişilemez kılar; anahtar yapılandırılmış hedefte kalır ve yönlendirmeler reddedilir.

z.ai ve Zhipu için Kullanım, OpenCode'un kendi ana makinesinde çözümlediği `{env:…}` ve `{file:…}` değerleri dahil yapılandırılmış `apiKey` değerine öncelik verir; bu anahtar yoksa kayıtlı kimlik bilgisini kullanır. Anahtar ve kayıtlı kimlik bilgisi yoksa sağlayıcı yapılandırılmamış olarak gösterilir. İş mantığı hatalarında kota değerleri yerine çevrilmiş sağlayıcı hatası ve varsa sayısal kod gösterilir. Plan kredileri beş saatlik ve haftalık pencereleri kullanır; MCP araçlarının ayrı bir kotası vardır.

GitHub Copilot **Kullanım**, tüketimi **kullanılan / sınır kullanıldı** biçiminde, GitHub sağladığında ise sınırsız havuzdaki tüketilen kredileri gösterir; aksi halde **Sınırsız** gösterilir. Premium istekler kendi etiketini korur. Alt bölüm tanınan planın adını içerir. Enterprise bağlantıları, kayıtlı bağlantının ana makinesinden veya HTTPS kök URL'sinden `https://api.<host>/copilot_internal/user` adresini kullanır. Kimlik bilgisi, açık port (`:443` dahil), `/` ötesinde yol, sorgu veya parça içermeyen tam bir ana makine adı kullanın; IP adresleri ve localhost, belirteç gönderilmeden reddedilir. Yönlendirmeler reddedilir. Geçersiz hedefte veya bu API'yi sunmayan sunucuda kullanım erişilemez kalır. Enterprise bağlantıları otomatik hesap seçiminin dışında kalır.

Kimi, `kimi-code-plan-cn` (kimi.com), `kimi-code-plan-global` (kimi.ai), `kimi-for-coding` ve `kimi` kimliklerini destekler. **Kullanım**, konuşmanın entegrasyonundan başlayarak her entegrasyonun etkin kayıtlı anahtarını ortak bir süre sınırı içinde sırayla dener. Kullanılabilir beş saatlik, haftalık, **Aylık** ve **Aylık kodlama** sınırları kullanılan yüzdeyi gösterir. Aylık sınırlar sağlayıcının sıfırlama tarihini izler; herhangi bir aylık sınırı tükenen hesap, daha kısa bir pencerede kapasite kalsa bile otomatik seçim için kullanılamaz.

OpenCode Go API anahtarları kullanılabilir tüketim yüzdelerini ve sıfırlama zamanlarını gösterir. OpenCode Console oturumu, faturalandırma izinleri uygunsa cüzdan bakiyesini de USD olarak okur. Bu ayrı bakiyeyi göstermek için **Sağlayıcı kredi bakiyesi** seçeneğini açın (varsayılan olarak kapalıdır); Go kotaları ve Extra Usage ayrı kalır. Yalnızca bakiye varsa otomatik seçim kotayı bilinmiyor olarak tutar. **OpenCode Go anahtarının süresi doldu.** göründüğünde [OpenCode Console'da yeni bir anahtar oluşturup eskisini değiştirin](https://opencode.ai/console/login) bağlantısını seçin. **Account → Personal API keys** altında anahtar oluşturun (veya yöneticiden bir hizmet hesabı anahtarı isteyin), ardından sağlayıcı bağlantı akışından kayıtlı anahtarı değiştirin. Süresi dolan anahtarın değiştirilmesi gerekir.

### İsteğe bağlı kullanım ortamı değişkenleri {#usage-environment}

Cursor Enterprise, özel pano API'lerini kullanılabilirliklerine göre kullanır. Profilde takım üyeliği ve takım kimliği varsa **Kullanım**, tanımlanan `gpt-4` istek grubunu ve sağlanan **Kullanıcı başına sınır** / **Takım sınırı** tutarlarını ayrı ayrı USD olarak gösterir. Harcama bilinmiyorsa yalnızca sınır, istek sınırı bilinmiyorsa yalnızca kullanılan sayı gösterilir. Bilinmeyen gruplar ve sıfırlama tarihleri kullanılamaz kalır. Eksik takım, erişim reddi ve süresi dolmuş belirteç için ayrı mesajlar vardır; doğrulanmış kısmi okumalar görünür kalır.

Aşağıdaki değişkenlerle güncel bir Cursor erişim belirteci sağlayın. Enterprise okumaları takımın pano verilerini okuma izni gerektirir; [Yönetici API'si](https://cursor.com/docs/account/teams/admin-api) ayrı bir yönetim anahtarı kullanır. Süresi dolmuş belirteci güncelleyin ve arka ucu güncel ortamla yeniden başlatın.

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

1. **Ayarlar → Provider'lar** bölümünde **Web araması** grubunu genişletin ve gerekiyorsa arama entegrasyonunu API anahtarıyla bağlayın.
2. Genel yapılandırma için **Varsayılan arama** öğesini seçin.
3. Etkin Location için geçersiz kılmak üzere **Geçerli proje için** öğesini kullanın. Etkili sonucu içeren **Bu projede arama** bilgisini görmek için bu seçicinin üzerine gelin veya odaklanın.

Değişiklikler otomatik olarak kaydedilir. **Varsayılan / devralınan**, devralınan yapılandırmayı veya kaydedilen yerel seçimi kullanır; Proje geçersiz kılma Global'e galip gelir. **Devre dışı** seçilen kapsamda aramayı kapatır; **Otomatik sağlayıcı**, yerel otomatik sağlayıcı seçimi talep ediyor. **Web araması** bağlantılarını ve seçimlerini yalnızca genişletildiğinde yükler. **Bağlantıyı kes** kayıtlı bir arama anahtarını kaldırır; bir ortam değişkeninden sağlanan bağlantı salt okunur olarak etiketlenir ve **Bağlantıyı kes** eylemi yoktur.

Arama kimlik bilgileri, sağlayıcı seçimi Proje kapsamında olsa bile hizmet geneli olarak kalır. Bir anahtarın kaydedilmesi, onu arama varsayılanı olarak seçmez. Okuma/kaydetme işlemi başarısız olursa, yeniden denemeden önce yenileyin; konfigürasyonu körü körüne değiştirmeyin. Yerel yapılandırma ayrıntıları için, bkz. [OpenCode belgeleri](https://opencode.ai/v2/docs/) ve [OpenCode kurulumu](opencode.md).

## Görsel oluşturma ve saklama {#images}

1. **Ayarlar → Provider'lar** içinde **Görseller** bölümünü genişletin.
2. Siz değiştirmedikçe **Görsel oluşturma** **Açık, otomatik model** durumundadır: bunun yerine bağlı sağlayıcılarınızın sunduğu görsel modellerinden birini ya da Global yapılandırmada kapatmak için **Kapalı** seçeneğini seçin.
3. Eklenen veya oluşturulan her görselin, onu kullanan her mesajın içinde değil yalnızca bir kez saklanması için **Görselleri bir kez sakla** seçeneğini işaretleyin.

Değişiklikler Global OpenCode yapılandırmasına otomatik kaydedilir ve tüm projelere uygulanır. İkisi de deneysel OpenCode özellikleridir: **Görseller** yalnızca bağlı OpenCode sürümünün desteklediği ayarları gösterir. Ajanlar görsel aracını yalnızca bağlı bir sağlayıcı görsel modeli sunduğu sürece alır. Her görsel arka planda oluşturulur ve dosya olarak kaydedilir; ajan dosyanın yolunu bildirir. **Görselleri bir kez sakla** yeni mesajlara uygulanır. **Görselleri bir kez sakla** ayarını projenin kendi OpenCode yapılandırma dosyası belirliyorsa, kutu orada geçerli olan değeri gösterir ve kaydetmek değeri o dosyaya da yazar. Aksi hâlde, projenin kendi yapılandırması gibi başka bir OpenCode yapılandırması bir ayarı onun yerine belirliyorsa, **Görseller** bunu o ayarın altında belirtir. Kaydetmek başka bir OpenCode yapılandırma dosyasının deneysel ayarlarını gizleyecekse, **Görseller** salt okunur kalır ve bunu belirtir; seçenekleri bunun yerine o dosyada değiştirin.

Görselleri ayrı bir sohbette oluşturmak, karşılaştırmak ve iyileştirmek için [Design uzantısıyla görsel oluşturun](extensions.md#design) bölümüne bakın.
