# Panel uzantıları

## Yüklü ve çevrimiçi uzantılara göz atın {#browse}

1. Sağ panel sekme çubuğunda **Sağ paneli özelleştir** öğesini açın.
2. Ayırıcının altındaki **Uzantılar** öğesini genişletin.
3. Yüklü eklentilerin tek listesini ve resmi çevrimiçi kataloğu aramak için **Uzantı ara** öğesini kullanın. Meta verileri için bir girişin üzerine gelin veya odaklanın.

Özelleştirme açılır penceresi her açıldığında bu bölüm kapalıdır. Yüklü ve çevrimiçi kayıtlar uzantı kimliğine göre birleştirilir; ayrı yönetici penceresi veya yüklü/çevrimiçi modu yoktur. Katalog meta verilerine göz atmak yazarın panel kodunu indirmez veya çalıştırmaz. Katalog [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions) deposundadır; dahil edilmesi ve belirtilen yazar adları imza veya güven kanıtı değildir.

Katalog kullanılamıyorsa yüklü uzantılar ve **ZIP dosyasından yükle…** kullanılabilir durumda kalır. Keşfi yeniden denemek için yenileyin. Açılır pencereyi daraltmak veya kapatmak, beklemedeki inceleme/onay kullanıcı arayüzünü terk eder; sessizce hiçbir şey yüklemez.

## İnceleyin ve devre dışı olarak yükleyin {#install}

1. Katalog girişinde **Yükle…** öğesini veya ayrıca edindiğiniz bir paket için **ZIP dosyasından yükle…** öğesini seçin.
2. Paket kimliğini, yazarı, depoyu, sürümü, API/izinleri ve SHA-256 özetini inceleyin. Gerektiğinde teknik ayrıntıları genişletin.
3. Yayıncıyı doğrulayın ve mümkünse özeti güvenilir bir kanal aracılığıyla karşılaştırın.
4. Yalnızca koda güveniyorsanız **Bu pakete ve yazarına güveniyorum** öğesini, ardından **Devre dışı yükle** öğesini seçin.

İnceleme seçilen paketi indirir/yeniden doğrular; yazar kodu incelemeyle yürütülmez. Özet, yazarın kimliğini değil, tam baytları tanımlar. Katalog paketleri rastgele bir URL'den değil, tam olarak bildirilen GitHub sürüm varlığından gelir. Manuel paketler yalnızca `manifest.json` ve bağımsız `panel.html` içeren ZIP'lerdir; geçersiz veya desteklenmeyen paketler reddedilir.

Kurulum OpenCode'un yeniden başlatılmasını gerektirmez ve etkinleştirmeyi hiçbir zaman otomatik olarak sağlamaz. Başarısız bir doğrulama, çakışma veya depolama işlemi, farklı baytlarla yeniden denemeye izin vermez. Yeni bir kurulum denemesinden önce paketi yeniden inceleyin.

## Etkinleştirin ve kapsamını anlayın {#activate-scope}

1. **Sağ paneli özelleştir** içindeki **Uzantılar** bölümünün üzerindeki eklenti satırına dönün. Yüklü ancak devre dışı eklentiler bu listede kalır.
2. Etkinleştirmek için onay kutusunu seçin. Devre dışı bırakmak için aynı onay kutusunun işaretini kaldırın.

Bu onay kutusu tek etkinleştirme kontrolüdür: ekstra bir yönetici anahtarı veya pencere başına görünürlük kapısı yoktur. Etkinleştirme, klasör başına değil, projeler genelinde yapılandırma genelinde yapılır. Uzak bağlantıda bu durum yalnızca görüntüleme cihazınızı değil, sunucunun yüklü uzantı deposunu da etkiler.

Uzantı deposu seçili CodeNomad yapılandırmasının yanındaki `panel-extensions/` dizinidir. Ayrı masaüstü veri profilleri aynı yapılandırma dizinini kullanıyorsa uzantıları **yalıtmaz**. Buna karşılık farklı yapılandırma açmak, başka yerde yüklü eklentiyi çalıştırma izni değildir. Ayrım için [Masaüstü pencereleri ve verileri](desktop.md) sayfasına bakın.

Etkinleştirilmiş bir panel seçildiğinde monte edilebilir; onu gizlemek geçici kullanıcı arayüzü durumunu ortadan kaldırabilir. Devre dışı bırakmak aktivasyonunu iptal eder. Özelleştirmede **Sıfırla** yalnızca yerleşik düzeni geri yükler ve uzantıları etkinleştirmez, devre dışı bırakmaz veya kaldırmaz.

## Sürümü değiştirin veya kaldırın {#replace-remove}

1. Yüklü bir paketi değiştirmek için **Sürümü değiştir…** kullanın veya aynı kimliğe sahip başka bir ZIP'i inceleyin.
2. Yeni özeti ve izinleri inceleyin, güven onayını verip devre dışı olarak yükleyin.
3. Yalnızca yeni sürüme güvenmeye karar verdikten sonra normal onay kutusunu kullanarak yeniden etkinleştirin.
4. Kaldırmak için hedefi inceledikten sonra **Kaldır…** ve **Kaldırmayı onayla** öğesini kullanın.

Paketin her değiştirilmesi, izin listesi değişmese bile tüm projelerde etkinleştirmeyi iptal eder ve panelin kaydedilmiş kendi ayarlarını temizler. Doğrulama/çatışma/depolama hatası yüklü paketi korur. Sessiz uzantı güncellemesi yok. Kaldırma işlemi, OpenCode oturumlarını veya proje dosyalarını değil, paketi, etkinleştirme ayarlarını ve kaydedilmiş panel ayarlarını siler. İstenmeyen koddan kurtulmak için önce onu devre dışı bırakın; yalnızca doğrulanmış güvenilir bir paketi yeniden yükleyin.

## Bağlam, varlık izni ve korumalı alan sınırları {#permissions-sandbox}

| Sözleşme | Etkinleştirmeye izin verilenler |
| --- | --- |
| API 1 / `session.context` | Geçerli oturum tanımlayıcısı (veya hiçbiri), arayüz dili ve görünümü. Konuşma dökümü metni veya dosya sistemi erişimi yok. |
| API 2 / `session.assets.read` artı bağlam | Sınırlı geçerli oturum aracı-sonuç resmini/ek meta verilerini listelemek ve desteklenen gömülü baytları okumak için açıkça gözden geçirilmiş izin. Genel konuşma dökümü, dosya veya URL erişimi değildir. |
| API 3 / `repository.workItems.read` ve bağlam | GitHub, GitLab veya Gitea/Forgejo üzerindeki proje deposunun issue ve pull request'lerini sınırlı sayfalar halinde listelemek ve birini tarayıcıda açmak için açıkça incelenmiş izin. Dosya, kimlik bilgisi veya genel ağ erişimi değildir. |
| API 4 / bağlam artı aşağıdaki izinlerden bir veya daha fazlası | İnceleme, bildirilen her izin için bir cümle listeler; etkinleştirme hepsini birlikte verir ve bir değiştirme hepsini iptal eder. |
| `session.images.read` | Görüntülenen konuşmada read aracının döndürdüğü görselleri, doğrulanabildiğinde oluşturma durumu ve kökeniyle birlikte okumak. |
| `session.images.prompts` (`session.images.read` gerektirir) | Projenin Görseller konuşmasında oluşturulan her görselin istemini ve modelini okumak. |
| `composer.prefill` | Görüntülenen konuşmanın ileti düzenleyicisine metin eklemek. Asla mesaj göndermez. |
| `images.conversation` | Bu projenin Görseller konuşmasını açmak veya başlatmak. |
| `opencode.designAgent` | Bu uzantı etkinken CodeNomad'in Design ajanını ve görsel becerilerini OpenCode'a ekler. |
| `panel.preferences` | Bu panelin kendi ayarlarını hatırlamak. |

Varlık erişimi, yazarın seçtiği bir oturumu değil, halihazırda bağlı olan ana bilgisayarı/oturumu takip eder. Yerel/uzak referanslar mevcut değil olarak listelenebilir; API varlığı rastgele uzak URL'ler getirmez veya yerel dosyaları açmaz. Oturumları değiştirmek, bağlantıyı kesmek veya izni iptal etmek eski erişimi geçersiz kılar.

API 4 ile görsel okuma da aynı şekilde görüntülenen konuşmayı takip eder ve yalnızca ajanın konuşmaya geri okuduğu görselleri gösterir. `session.images.prompts` iznine sahip bir uzantı, sizin veya ajanın bir Görseller konuşmasında görseller için yazdığı istemleri okuyabilir ve korumalı alana rağmen bunları başkasına aktarabilir; bu nedenle bu izni yalnızca onları emanet ettiğiniz yazarlara verin. `composer.prefill` ile eklenen metin, siz onu düzenleyene veya **Mesaj gönder** öğesini seçene kadar ileti düzenleyicisinde kalır; asla bir komutla başlamaz, asla açık bir `@` bahsiyle bitmez ve görsel yollarını düz metin olarak belirtir. İleti düzenleyicisinde Ctrl+Z (macOS'ta Cmd+Z) ile geri almak onu kaldırmaz. Kaydedilmiş panel ayarları bu CodeNomad profiline aittir, uzantı başına en fazla 4 KiB; bir uzantıyı devre dışı bırakmak onları korur.

Öğeler proje klasörünün `upstream` uzak deposundan, yoksa `origin`'den gelir. CodeNomad bunları oturum açtığınız GitHub, GitLab veya Gitea CLI'si (`gh`, `glab`, `tea`) ile ya da herkese açık depolarda anonim olarak okur ve hiçbir belirteç saklamaz; eklenti yalnızca depo adını ve öğeleri görür. Anonim okuma github.com, gitlab.com, codeberg.org ve gitea.com içindir; kendi barındırdığınız bir platform yalnızca orada oturum açılmış CLI'si üzerinden okunur. Bir öğeyi açmak, CodeNomad'den o öğenin aynı platformdaki sayfasını tarayıcınızda açmasını ister (saniyede en fazla bir kez); eklenti başka adresler açamaz.

Yazar kodu güvenilir uygulama arayüzünde değil, kısıtlanmış iframe içinde çalışır. Native/OpenCode köprüsü, kimlik bilgilerine erişim, genel RPC, form gönderimi, açılır pencere veya indirme yetkisi almaz; ağ API'leri ve dış kaynaklar kısıtlıdır. Uzantılar [OpenCode eklentileri](integrations.md) değil, arayüz eklentileridir.

Korumalı alan süreç/CPU yalıtımı veya onaylanan kodun zararsız olduğu garantisi değildir. Kötü amaçlı uzantı kendi arayüz sürecini aksatabilir. Yalnızca güvenilir yazarların paketlerini yükleyin, sırlarınızı vermeyin ve beklenmedik davranışta eklentiyi devre dışı bırakın/kaldırın.

## Design uzantısıyla görsel oluşturun {#design}

**Design** uzantısı, bir projenin **Görseller sohbeti** içinde CodeNomad'in Design ajanıyla oluşturduğunuz görseller için bir ışık masasıdır. Görselleri gösterir, mesaj kutusunda istekler hazırlar ve her üretimi sizin gönderdiğiniz mesajlara bırakır.

1. Görsel modeli sunan bir sağlayıcı bağlayın. Görsel oluşturma, **Ayarlar → Provider'lar → Görseller** içinde kapatılmadıkça açıktır ([Görsel oluşturma ve saklama](providers.md#images)).
2. **Sağ paneli özelleştir → Uzantılar** içinde, izinlerini inceledikten sonra ([Bağlam, varlık izni ve korumalı alan sınırları](#permissions-sandbox)) **Design** uzantısını katalogdan yükleyin ([İnceleyin ve devre dışı olarak yükleyin](#install)), ardından onay kutusunu seçin ([Etkinleştirin ve kapsamını anlayın](#activate-scope)).
3. **Design** panelini açın ve **Görseller sohbetini aç** öğesini seçin.

Uzantı etkinken CodeNomad, Design ajanını ve görsel becerilerini OpenCode'a ekler. Kendi `design` ajanınız ve kendi `design-*` becerileriniz her zaman önceliklidir; kendi `design` ajanınızı sağladığınızda panel **Kendi Design ajanınız kullanılıyor.** gösterir. Görsel oluşturma, bir görsel modeli veya Design ajanı eksik olduğunda da panel bunu belirtir.

### Görseller sohbeti {#design-conversation}

Her proje klasörünün veya worktree'nin, başlığı **Görseller** olan kendi Görseller sohbeti vardır. **Görseller sohbetini aç** onu bulur ya da Design ajanı ve CodeNomad'in bu ajanla yeni bir sohbet için seçtiği modelle oluşturur, ardından odak mesaj kutusundayken gösterir; açmak hiçbir şey göndermez. Mevcut bir Görseller sohbeti kendi modelini korur. **Yeni Görseller sohbeti** boş bir ışık masasıyla başka bir sohbet başlatır; bir sohbette çok sayıda görsel olduğunda panel bunu önerir ve ardından **Aç** en yenisini gösterir. Arşivlenmiş ve silinmiş Görseller sohbetleri atlanır.

İhtiyacınızı yazıp gönderin: ajan birkaç çerçeveleme sorusu sorar, kaç görsel üreteceğini söyler, onları üretir, her birini geri okur ve değerlendirir. Görseller proje klasörünün `.codenomad/design/` klasörüne kaydedilir. CodeNomad bu klasörü deponun yerel Git hariç tutmalarına (`.git/info/exclude`) ekler ve `.gitignore` dosyasına dokunmaz; ekleyemediğinde panel **Bu konumdaki görseller Git’te görünebilir.** gösterir. Bir turu geri almak, görsellerini ışık masasından kaldırır ama dosyalarını korur; ajanın üzerine yazdığı bir görsel ise geri getirilemez. Ajan yaklaşık 1K piksellik görseller ister, ancak sağlayıcılar daha büyüklerini döndürebilir ve aynı anda birkaç büyük görsel paylaşılan OpenCode hizmetinde çok bellek kullanabilir.

Design ajanını kullanan bir Görseller sohbetinde bu ajan yoksa mesaj kutusu **Design agent'ı kullanılamıyor** gösterir ve göndermeyi engeller: **Varsayılan agent'ı kullan** öğesini seçin veya Design uzantısını yeniden etkinleştirin. Sohbetin sohbet modeli görsel alamıyorsa panel, ajanın görselleri görsel olarak değerlendiremeyeceği uyarısını gösterir; geri okuduğu görseller ışık masasında görünmeye devam eder.

### Işık masası {#design-light-table}

**Işık masası**, ajanın görüntülenen sohbette geri okuduğu görselleri en yeniden eskiye, yanıtlara göre gruplanmış olarak gösterir. Bir görseli seçmek onu 16, 32 ve 64 px **Küçük boyutlar** önizlemeleriyle daha büyük gösterir; **Karşılaştır** iki görseli yan yana koyar ve **Tam boyutta görüntüle** bir görüntüleyici açar. Dar bir panelde karşılaştırmak için paneli genişletin. Soy ağacı (**Şundan üretildi**, **Şunda kullanıldı**) ve Görseller sohbetinde istem ile model, yalnızca CodeNomad görseli hangi üretimin oluşturduğunu doğrulayabildiğinde görünür; aksi halde görsel piksellerini korur ve **kaynağı doğrulanamıyor** gösterir. **Üretimler** her görsel üretimini durumuyla listeler; ilerlemesini sohbetten izleyin. Başka bir sohbette panel, o sohbette geri okunan görselleri istemler ve istekler olmadan gösterir ve Görseller sohbetini açmayı önerir.

Görseller sohbetinde **Şununla başla** (uygulama simgesi veya logo gibi bir tarif), **İyileştir**, **Varyantlar**, **Yönü uygula**, **Projeye kaydet…**, **Ajandan göstermesini iste** ve **Yeniden dene**, mesaj kutusuna yalnızca düzenlenebilir metin ekler: panel hiçbir zaman mesaj göndermez veya görsel üretmez. Seçilen bir görselle ilgili eylemler onun projeye göre göreli yolunu alıntılar ve yalnızca kaynağı doğrulanabilen proje görselleri alıntılanabilir. İsteği düzenleyin, ardından kendiniz gönderin. **Projeye kaydet…**, ajandan görseli isteğin ardından yazdığınız hedefe kopyalamasını ister. **Tur başına görsel** (1 ile 4 arası, varsayılan 3) yeni görsel üreten isteklere eklenir ve panelin kayıtlı ayarlarında saklanır. Telefonda panel yüzer ve bir istek eklediğinde kapanır.

### Design ajanını CodeNomad olmadan kullanın {#design-without-codenomad}

Design ajanı ve becerileri sıradan OpenCode dosyalarıdır. Onları CodeNomad olmadan OpenCode TUI'de veya başka bir istemcide kullanmak için [Design içerik klasörünün](../../../packages/server/src/opencode/design/opencode/) içeriğini bir projenin `.opencode/` klasörüne veya genel OpenCode yapılandırma klasörünüze (`~/.config/opencode/`) kopyalayın; `NOTICE.md` ve lisansı da yanlarında tutun. Ardından **design** ajanını seçin; becerilerini adlarıyla yükler ve diğer ajanlar onları yalnızca siz adlarını verdiğinizde kullanır.

Design ajanı ve becerileri [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) ve [taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT) kaynaklı materyalleri uyarlar; `NOTICE.md` uyarlanan her dosyayı listeler. Design uzantısı MCP Assets uzantısının kodunu (MIT) yeniden kullanır.
