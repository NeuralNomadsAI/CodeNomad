# Sağlayıcılar ve hesaplar

Sağlayıcı kimlik doğrulaması, tarayıcı cihazına veya bir CodeNomad projesine değil, bağlı OpenCode hizmetine aittir. Model görüntüleme tercihleri, abonelik kotaları ve web arama seçeneklerinin farklı kapsamları vardır.

## Bir modeli veya arama sağlayıcısını bağlayın {#connect}

1. Çalışma alanı açıp **Ayarlar → Provider'lar** yoluna gidin. **Modeller** açık olarak başlar; arama sağlayıcıları için **Web araması** bölümünü genişletin. **Görseller** görsel ayarlarını içerir.
2. O grupta **Provider seç** öğesini, ardından **Bağlan** öğesini seçin. Aşağıda zaten listelenen bir model sağlayıcısının ilk bağlantısı için de kendi satırındaki **Hesap ekle** (+) öğesini kullanın.
3. Model sağlayıcısı için sunulan yerel **Kimlik doğrulama yöntemi** öğesini tamamlayın: API anahtarı, OAuth veya komut. OAuth için **Yetkilendirme sayfasını aç** öğesini kullanın ve yalnızca istendiğinde bir yetkilendirme kodu gönderin. Arama sağlayıcıları API anahtarıyla bağlanır.
4. Tamamlandıktan sonra yapılandırılmış sağlayıcı satırını kontrol edin.

Yalnızca arama entegrasyonları **Modeller** altında değil, **Web araması** altında görünür. Kimlik doğrulamanın kaydedilmesi bir model seçmez veya varsayılan arama sağlayıcısını değiştirmez. API anahtarları ve OAuth kimlik bilgileri, etkin OpenCode sunucusu tarafından kaydedilir. Tarayıcı, kayıtlı kimlik bilgisi sırlarını değil, bağlantı meta verilerini alır. Ortam değişkenlerinden kaynaklanan bir bağlantı bu kullanıcı arayüzünde salt okunurdur: bağlantıyı burada kesmeye çalışmak yerine sahibi olduğu ortamı değiştirin.

Yetkilendirme bağlantısını veya kodunu teşhiste yayınlamayın.

## Hesapları seçin ve yönetin {#accounts}

1. Sağlayıcının satırında, kayıtlı bir kimlik bilgisini seçmek için **Etkin hesap** öğesini kullanın.
2. Başka bir bağlantının kimliğini doğrulamak için **Hesap ekle** öğesini kullanın.
3. Farklı bir kayıtlı hesabı yönetmek için önce hesabı seçin, ardından **Hesabı yeniden adlandır** veya **Hesabı kaldır** öğesini kullanın. Yeniden adlandırma **Hesap adı** ve **Kaydet** öğesini kullanır; **Hesabı kaldır** onay istemeden hemen uygulanır.

Seçme, yeniden adlandırma ve kaldırma, diğer projeler ve istemciler de dahil olmak üzere OpenCode hizmeti genelindeki entegrasyonu etkiler. Bir kimlik bilgisinin kaldırılması, bu istemcilerin kimlik doğrulaması olmadan kalmasına neden olabilir; konuşma geçmişini silmez veya sağlayıcının uzak hesabını iptal etmez. Ortam bağlantıları, yazılabilir kayıtlı kimlik bilgileri olarak seçilemez veya buradan kaldırılamaz.

### Otomatik seçim sınırları {#automatic-selection}

Desteklenen entegrasyonda birden fazla kayıtlı kimlik bilgisi varsa **Hesabı otomatik seç**, CodeNomad üzerinden sonraki istem/özel komut kabulünden önce kota tabanlı seçimi etkinleştirir. Ayar CodeNomad yapılandırmasında entegrasyon başınadır; sonuçtaki hesap seçimi hizmet genelindedir.

| Uygun entegrasyon | Uygun hesap türü |
| --- | --- |
| OpenAI / Codex | Codex tarayıcı/cihaz OAuth abonelik hesapları; OpenAI kullandıkça öde anahtarları veya kullanım verisini OpenAI'ın sağlamadığı ChatGPT oturum açma yöntemi değil. |
| OpenCode Go | Go anahtarı veya **yalnızca Go sağlayıcısı** için kullanılan OpenCode Console girişi/anahtarı; ücretli Console modelleri elle seçilir. |
| Anthropic | OpenCode'un Claude Pro/Max OAuth girişi; Claude Code girişi **değil**. |
| GitHub Copilot | Okunabilir premium istek kotasına sahip OAuth; kurumsal uç nokta kimlik bilgileri okunabilir aday değildir. |
| Kodlama planları | Anahtar tabanlı `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Geçişi yalnızca mevcut hesabın kotasının tamamen dolması tetikler; alternatif hesabın daha fazla kapasitesi olması yetmez. Codex, Copilot ve kodlama planlarında kullanılabilir olduğu gösterilebilen aday gerekir. Go, Console ve Claude, yakın tarihli yerel kota hatasıyla tükenmiş işaretlenmeyen, kotası bilinmeyen adayı kullanabilir.

Bu, **devam eden istek için otomatik geçiş değildir**. Başarısız istekleri yeniden denemez; istemleri, komutları veya değişiklik işlemlerini yeniden yürütmez. Ortam bağlantılarını, isteğe bağlı sağlayıcıları, kullandıkça öde bakiyelerini veya harici Claude Code girişlerini döndürmez.

## Model görünürlüğü, favoriler ve Düşünme {#models}

1. Model sağlayıcının yanında **Modelleri yönet** öğesini seçin.
2. Ada/kimliğe göre arama yapın ve görünürlüğü değiştirin; **Tümünü göster** ve **Tümünü gizle**, söz konusu sağlayıcının seçici listesini etkiler. Birden fazla modeli tek seferde değiştirmek için onay kutularının üzerinde sürükleyin.
3. Bir konuşmanın **Model** seçicisinde **Favorilere ekle** veya **Favorilerden kaldır** öğesini kullanın; **Tüm modelleri göster** yalnızca favorilere yönelik filtrelemeyi bırakır.
4. Seçilen modelin sunduğu varyantlar için ileti düzenleyicisinde **Düşünme** öğesini kullanın.

Görünürlük ve sık kullanılanlar, CodeNomad'in seçicilerini düzenler; modelleri kaldırmaz, kimlik bilgilerini kaldırmaz veya diğer OpenCode istemcilerinin bunları kullanmasını engellemez. Düşünme, zaten konuşma dökümünde bulunan akıl yürütmenin görünürlüğünü değil, sonraki gönderimler için bir model çeşidi seçer. Gizli modelleri **Modelleri yönet → Tümünü göster** ile geri yükleyin.

## Kullanım, belirteç sayıları ve süresi dolmuş oturum açma bilgileri {#usage}

Etkin görüşmenin sağlayıcı planı pencereleri, sıfırlama süreleri ve desteklenen bakiyeler için sağ paneldeki **Kullanım** öğesini kullanın. Bu sağlayıcı okumaları, mesaj başına **Tokenlar** ve maliyet tahminlerinden farklıdır: abonelik kotası, görünür konuşma dökümünden hesaplanan bir fatura değildir. Eksik, eski veya bilinmeyen bir okuma, sıfır kullanım veya kalan kapasitenin kanıtı değildir. **Ayarlar → Gelişmiş** içindeki **Sağlayıcı kredi bakiyesi** ek bakiye ekranını kontrol eder.

Google'ın [Antigravity SSS](https://antigravity.google/docs/faq/) sayfası, Antigravity girişiyle üçüncü taraf yazılım kullanmanın hizmet koşullarını ihlal ettiğini ve hesabın askıya alınmasına veya kapatılmasına yol açabileceğini belirtir.

`opencode` entegrasyonunun ücretli modellerinde **OpenCode Console**, Console'un bildirdiği şekilde **24 saat**, **7 gün** ve **30 gün** için **İstekler** gösterir. **Modele göre istekler · 30 gün** her modeli sağlayıcısıyla listeler. Sayaçlar bağlı Console hesabını kapsar ve sayılar uygulamanın diline göre biçimlendirilir. **Hizmet hesabı bütçeleri** altında **Bütçeler kullanılamıyor.** görünür. **Sağlayıcı kredi bakiyesi** açıkken Console kredi bakiyesi **Kredi** olarak görünür. OpenCode Go kendi kota okuyucusunu kullanır.

Geçersiz veya süresi dolmuş Console OAuth bağlantısını, API anahtarı da kayıtlı olsa bile sahibi üzerinden düzeltin.

Console bağlantı hatasında (401 veya 403) **Ayarlar → Provider'lar** altında oturum açmayı, kuruluş kimliğini ve **Usage › Read** iznini kontrol edin, ardından **Kullanım** bölümünü yenileyin. OAuth için `https://opencode.ai/console` gerekir.

Ücretsiz OpenCode modellerinde (`big-pickle` ve kimliği `-free` ile biten modeller) **Kullanım** tek bir çubuk gösterir: bağlı Console hesabının Console'a göre son 24 saatteki ücretsiz istekleri, **800** referansıyla karşılaştırılır; gerçek sınırlar değişebilir. Sayaç hesabın diğer istemcilerini de kapsar ve sıfırlanma zamanı yoktur. **Sağlayıcı kredi bakiyesi** açıkken Console kredi bakiyesi **Kredi** olarak görünür. Ücretsiz model isteklerini izlemek için **Ayarlar → Sağlayıcılar** üzerinden OpenCode Console'u bağlayın.

Ücretsiz kullanım ve ücretli Console sayaçları yalnızca görüntüleme içindir; otomatik hesap seçimi ayrı okuyucular ve kurallar kullanır.

OpenAI, ChatGPT oturum açma yöntemlerinden biri için kullanım verisi sağlamaz: Kullanım, kota pencereleri göstermek yerine bunu belirtir. ChatGPT'de uygulama kullanımını incelemek ve planınıza ve kredilerinize erişimi yönetmek için [ChatGPT kullanımını görüntüle](https://chatgpt.com/settings/usage) seçeneğini kullanın.

Claude, `anthropic`/`claude` üzerinden OpenCode Anthropic OAuth girişini kullanır. OpenCode'un **Claude Agent** sağlayıcısı (`claude-agent`) ve `claude-code` sağlayıcısı, WSL dağıtımı dahil daemon ana bilgisayarındaki Claude Code girişini kullanır: önce `CLAUDE_CODE_OAUTH_TOKEN`, sonra kayıtlı giriş; dosya deposunu `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` veya `~/.claude` belirler; native macOS Keychain kullanılabilir.

OpenRouter **Anahtar sınırı**, anahtarın harcama sınırına göre kalan USD tutarını gösterir; sınırı olmayan anahtarda bu satır bulunmaz. Kullanım, yol öneki dahil sağlayıcının yapılandırılmış `baseURL` değerini, yoksa `https://openrouter.ai/api/v1` adresini kullanır. Kimlik bilgisi, açık port, sorgu veya parça içermeyen, herkese açık bir HTTPS ana makine adı kullanın; IP adresleri ve localhost reddedilir. Geçersiz URL veya `/key` içermeyen ağ geçidi kullanımı erişilemez kılar; anahtar yapılandırılmış hedefte kalır ve yönlendirmeler reddedilir.

GitHub Copilot **Kullanım**, tüketimi **kullanılan / sınır kullanıldı** biçiminde, GitHub sağladığında ise sınırsız havuzdaki tüketilen kredileri gösterir; aksi halde **Sınırsız** gösterilir. Enterprise bağlantıları, kayıtlı bağlantının ana makinesinden veya HTTPS kök URL'sinden `https://api.<host>/copilot_internal/user` adresini kullanır. Kimlik bilgisi, açık port (`:443` dahil), `/` ötesinde yol, sorgu veya parça içermeyen tam bir ana makine adı kullanın; IP adresleri ve localhost, belirteç gönderilmeden reddedilir. Yönlendirmeler reddedilir. Enterprise bağlantıları otomatik hesap seçiminin dışında kalır.

Kimi, `kimi-code-plan-cn`, `kimi-code-plan-global`, `kimi-for-coding` ve `kimi` kimliklerini destekler. Kullanılabilir beş saatlik, haftalık, **Aylık** ve **Aylık kodlama** sınırları kullanılan yüzdeyi gösterir.

Aylık sınırlar sağlayıcının sıfırlama tarihini izler; herhangi bir aylık sınırı tükenen `kimi-for-coding` hesabı, daha kısa bir pencerede kapasite kalsa bile otomatik seçim için kullanılamaz.

OpenCode Go API anahtarları kullanılabilir tüketim yüzdelerini ve sıfırlama zamanlarını gösterir. OpenCode Console oturumu, faturalandırma izinleri uygunsa cüzdan bakiyesini de USD olarak okur. Bu ayrı bakiyeyi göstermek için **Sağlayıcı kredi bakiyesi** seçeneğini açın (varsayılan olarak kapalıdır); Go kotaları ve Extra Usage ayrı kalır. Yalnızca bakiye varsa otomatik seçim kotayı bilinmiyor olarak tutar.

**Kullanım bilgisi geçici olarak kullanılamıyor.** veya **OpenCode Console'a ulaşılamıyor.** için ağ bağlantısını kontrol edip **Kullanım** bölümünü yenileyin.

OpenCode Go anahtarının süresi dolduysa [OpenCode Console](https://opencode.ai/console/login) içindeki **Account → Personal API keys** altında yeni bir anahtar oluşturup sağlayıcı bağlantısı üzerinden kayıtlı anahtarı değiştirin.

### İsteğe bağlı kullanım ortamı değişkenleri {#usage-environment}

Aşağıdaki değişkenlerle güncel bir Cursor erişim belirteci sağlayın. Enterprise okumaları takımın pano verilerini okuma izni gerektirir; [Yönetici API'si](https://cursor.com/docs/account/teams/admin-api) ayrı bir yönetim anahtarı kullanır. Süresi dolmuş belirteci güncelleyin ve arka ucu güncel ortamla yeniden başlatın.

Bunları başlatmadan önce **CodeNomad arka uç sürecinin** ortamında ayarlayın. Oturum **Ortam Değişkenleri** düzenleyicisini değiştirmek çalışan arka ucun bu okuyucular için kullandığı `process.env` değerini güncellemez. Değiştirirken arka ucu amaçlanan ortamda yeniden başlatın; yalnızca kullanım okuyucusu değişkeni için ortak OpenCode hizmetini yeniden başlatmayın.

| Kullanım entegrasyonu | Ortam değişkeni |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, yoksa `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| OpenCode Go ek kullanımı | `OPENCODE_GO_WORKSPACE_ID` ve `OPENCODE_GO_AUTH_COOKIE` birlikte |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — çıkarım anahtarından farklı platform anahtarı |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | Native kimlik bilgisi yoksa `COMMAND_CODE_API_KEY` kullanılır |

Belirteçleri/çerezleri kabuk geçmişinden, ekran görüntülerinden ve raporlardan uzak tutun.

## Web araması varsayılanı ve Proje geçersiz kılma {#web-search}

1. **Ayarlar → Provider'lar** bölümünde **Web araması** grubunu genişletin ve gerekiyorsa arama entegrasyonunu API anahtarıyla bağlayın.
2. Genel yapılandırma için **Varsayılan arama** öğesini seçin.
3. Etkin Location için geçersiz kılmak üzere **Geçerli proje için** öğesini kullanın. Etkili sonucu içeren **Bu projede arama** bilgisini görmek için bu seçicinin üzerine gelin veya odaklanın.

Değişiklikler otomatik olarak kaydedilir. **Varsayılan / devralınan**, devralınan yapılandırmayı veya kaydedilen yerel seçimi kullanır; Proje geçersiz kılma Global'e galip gelir. **Devre dışı** seçilen kapsamda aramayı kapatır; **Otomatik sağlayıcı**, yerel otomatik sağlayıcı seçimi talep ediyor. **Bağlantıyı kes** kayıtlı bir arama anahtarını kaldırır; bir ortam değişkeninden sağlanan bağlantı salt okunur olarak etiketlenir ve **Bağlantıyı kes** eylemi yoktur.

Arama kimlik bilgileri, sağlayıcı seçimi Proje kapsamında olsa bile hizmet geneli olarak kalır. Bir anahtarın kaydedilmesi, onu arama varsayılanı olarak seçmez. Yerel yapılandırma ayrıntıları için, bkz. [OpenCode belgeleri](https://opencode.ai/v2/docs/) ve [OpenCode kurulumu](opencode.md).

## Görsel oluşturma ve saklama {#images}

1. **Ayarlar → Provider'lar** içinde **Görseller** bölümünü genişletin.
2. Siz değiştirmedikçe **Görsel oluşturma** **Açık, otomatik model** durumundadır: bunun yerine bağlı sağlayıcılarınızın sunduğu görsel modellerinden birini ya da Global yapılandırmada kapatmak için **Kapalı** seçeneğini seçin.
3. Eklenen veya oluşturulan her görselin, onu kullanan her mesajın içinde değil yalnızca bir kez saklanması için **Görselleri bir kez sakla** seçeneğini işaretleyin.

Değişiklikler Global OpenCode yapılandırmasına otomatik kaydedilir ve tüm projelere uygulanır. İkisi de deneysel OpenCode özellikleridir: **Görseller** yalnızca bağlı OpenCode sürümünün desteklediği ayarları gösterir. Ajanlar görsel aracını yalnızca bağlı bir sağlayıcı görsel modeli sunduğu sürece alır. **Görselleri bir kez sakla** yeni mesajlara uygulanır. **Görselleri bir kez sakla** ayarını projenin kendi OpenCode yapılandırma dosyası belirliyorsa, kutu orada geçerli olan değeri gösterir ve kaydetmek değeri o dosyaya da yazar. Kaydetmek diğer OpenCode ayarlarını gizleyecekse, **Görseller** salt okunur kalır; seçenekleri uyarının araç ipucunda belirtilen yapılandırma dosyasında değiştirin.

Görselleri ayrı bir sohbette oluşturmak, karşılaştırmak ve iyileştirmek için [Design uzantısıyla görsel oluşturun](extensions.md#design) bölümüne bakın.
