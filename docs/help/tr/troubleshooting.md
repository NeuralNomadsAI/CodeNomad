# Sorun giderme

Önce başarısız işlemin sahibini kontrol ederek kurtarın: tarayıcı, CodeNomad arka ucu, OpenCode hizmeti veya sağlayıcısı. Kayıp bir yanıt, değişiklik işleminin başarısız olduğunu kanıtlamaz; tekrarlamadan önce mevcut durumu yeniden okuyun.

## Masaüstü başlatma sorunları {#desktop-launch}

### macOS karantinası {#macos-quarantine}

CodeNomad'ın macOS sürümleri Apple tarafından noter onayından (notarization) geçirilmez; bu nedenle macOS, resmi depodan doğruladığınız bir kopya bile olsa indirilen kopyanın ilk açılışını engelleyebilir: **"CodeNomad" Not Opened** iletisini (Apple kötü amaçlı yazılım içermediğini doğrulayamadı) gösterebilir veya uygulamanın zarar gördüğünü bildirebilir.

1. İndirmenin kaynağını ve yüklü uygulama yolunu kontrol edin.
2. Uygulama aşağıdaki yola yüklendiyse karantina özelliğini kaldırın:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Tekrar başlatın. **Not Opened** iletisinde bunun yerine, engellenen açılıştan sonra **System Settings → Privacy & Security** içinde CodeNomad için **Open Anyway** seçeneğini seçip yönetici parolanızla onaylayabilirsiniz.

Bu, söz konusu uygulamadaki macOS karantina özelliğini değiştirir. Bozuk bir indirmeyi onarmaz veya bilinmeyen bir ikili dosyayı güvenilir hale getirmez.

### Linux grafikleri ve FUSE {#linux-graphics}

Wayland/NVIDIA'dan hemen çıkan bir Tauri AppImage, WebKitGTK'nin DMA-BUF/GBM görüntü görüntü oluşturucusundan etkilenebilir. İndirilen AppImage'ı hedeflenen ortam geçersiz kılmayla çalıştırın:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron, Chromium'u kullanır ve aynı ana bilgisayardaki bir alternatiftir. FUSE kullanılamadığı için AppImage bağlanamıyorsa `--appimage-extract-and-run`'yi kullanın; bkz. [Linux kurulumu](install.md#linux-install). Bu düzeltmeler Electron korumalı alanının devre dışı bırakılmasını gerektirmez.

## Git ve çalışma alanı kullanılabilirliği {#git-and-workspaces}

1. Git'i yalnızca aracının kabuğunun içinde değil, arka uç hesabının `PATH`'sinde de kontrol edin.
2. Eksikse bu ana bilgisayara/hesaba Git yükleyin, ardından güncellenen ortamı devralması için CodeNomad arka ucunu yeniden başlatın.
3. Çalışma alanını yeniden açın/yenileyin ve depo durumunu kontrol edin.

Yalnızca dizin konuşmaları Git olmadan kullanılabilir durumda kalır; Worktree ve Git kontrolleri bunu yapmaz. Windows'ta, yalnızca WSL içine yüklenen Git, Windows arka ucu için yeterli değildir. Deposu olmayan bilinen bir klasör **Git'i başlat** öğesini açığa çıkarabilir; eksik bir Git yürütülebilir dosyası farklı bir durumdur ve öncelikle düzeltilmesi gerekir. Bkz. [gereksinimler](install.md#requirements) ve [Dosyalar](files.md).

Sahip olunan bir çalışma ağacı veya konuşma yerleşimi doğrulanamıyorsa, rastgele yolları denemek veya yerel depolamayı düzenlemek yerine fiziksel klasörünü açıkça açın. Hangi yerleşimin gerçekte mevcut olduğunu görmek için belirsiz bir taşıma/kaldırma işleminden sonra yenileyin. Bir çalışma ağacının zorla kaldırılması commit edilmemiş dosyaları yok edebilir; bağlantı onarımı olarak kullanmayın.

## OpenCode çalışma zamanı ve WSL {#opencode-runtime}

1. **Preferences → OpenCode** öğesini açın ve **OpenCode sürümü** kartını (kurulu sürüm ve çalışan hizmet durumu), ardından **OpenCode Binary** altındaki seçili yürütülebilir dosyayı kontrol edin.
2. Gerekli çalışma zamanı yoksa desteklenen kurulum/güncelleme eylemini kullanın. Güncel alt sınır: **2.1.2**; önerilen/doğrulanan: **2.1.4**.
3. Kurulu CLI, çalışan hizmetten farklıysa, paylaşılan hizmetin yeniden başlatılıp başlatılmayacağına açıkça karar verin.

**OpenCode hizmetini yeniden başlat**, **Sorun giderme** altında mevcuttur ve onay gerektirir. Bağlı her istemcideki aktif çalışmayı kesintiye uğratır ancak oturum geçmişini korur. Yapılandırmanın yeniden yüklenmesi ayrı bir eylemdir: süreci korur ancak yüklenen Konumları yeniden oluşturur ve bekleyen soruları/izinleri iptal eder. Zararsız bir yenileme de değildir.

WSL yürütülebilir dosyasında amaçlanan dağıtımı ve Windows localhost yönlendirmesini doğrulayın. Hizmet yaşam döngüsü Linux içinde çalışır; CodeNomad yine de Windows'tan loopback uç noktasına erişmelidir. Hizmet kaydını/veritabanını asla düzenlemeyin veya Windows'tan tahmini Linux süreç kimliklerine sinyal göndermeyin.

Özel/daha yeni sürüm, uyumsuz olmadan da doğrulanmamış olabilir. Sürüm değiştirmeden önce gerçek sözleşme hatasını okuyun. Oturum ortamı eşitlemesi başarısızsa yürütme ana bilgisayarının ortamını/bağlantısını düzeltin: CodeNomad bu eşitleme olmadan istem göndermez. Bkz. [OpenCode](opencode.md).

## Oturum açma, TLS ve doğrudan bağlantı {#login-and-tls}

| Belirti | Güvenli kontrol ve kurtarma |
| --- | --- |
| **CodeNomad’a yeniden giriş yapın** | Sayfayı açık tutun, sunucu kullanıcı adını/şifresini girin ve **Giriş yap** öğesini seçin. Taslakları tutmak için kurtarma yeniden bağlanır; başarısız olan eylemi tekrarlamaz. |
| Sunucuya ulaşılamıyor | Arka ucun çalıştığını doğrulayın ve yazdırılan adresini/gerçek bağlantı noktasını kullanın. Ulaşılamayan bir kontrol tek başına giriş bilgilerinizin süresinin dolduğunu kanıtlamaz. |
| Sağlayıcı kimlik doğrulamayı reddediyor | Sağlayıcının giriş bilgilerini sahibi aracılığıyla onarın; sağlayıcı OAuth'yi onarmak için CodeNomad sunucu şifresini değiştirmeyin. |
| Sertifika adı/güven hatası | Gerçek ana bilgisayar adını/IP'yi SANs sertifikasına göre kontrol edin ve amaçlanan CA güvenini veya geçerli bir sunucu sertifikasını yükleyin. TLS doğrulamasını devre dışı bırakmayın. |
| Doğrudan bağlantı reddedildi | Etkili HTTP/HTTPS bağlamayı, güvenlik duvarını ve yönlendirmeyi kontrol edin. HTTP masaüstü veya çift dinleyici modunda geri döngüde kalır; bağımsız HTTP-yalnızca farklı bağlanma davranışına sahiptir. |

Kimlik doğrulama kurtarıldıktan sonra, yanıtı belirsiz olan bir değişiklik işlemini manuel olarak yeniden denemeden önce durumu inceleyin. Çalışma zamanı parolaları her arka uç başlangıcında sağlanmalıdır; ayarlar aracılığıyla kaydedilen şifre kalır. Bkz. [güvenlik](security.md), [TLS/bağlama kuralları](remote-access.md) ve [sunucu referansı](server.md).

## Uzaktan Kontrol eşleştirme {#pairing}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim** öğesini açın ve Uzaktan Kontrol'ün çalıştığını kontrol edin.
2. Yeni bir eşleştirme bağlantısı oluşturun ve süresi dolmadan bu bağlantıyı amaçlanan cihazda açın.
3. İstemci **Bu cihazı yeniden eşleştirin** gösteriyorsa, ana bilgisayardan eşleştirin ve ardından istemcide **Bağlantıyı kontrol et** öğesini seçin.

Eşleştirme bağlantıları tek kullanımlıktır ve kısa ömürlüdür; doğrudan erişim şifresi onun yerine geçmez. İptal edilen veya etkinliğin sona erdiği cihaz kimlik bilgilerinin yeniden eşleştirilmesi gerekir. Son masaüstü penceresinin kapatılması, arka ucunu ve dolayısıyla Uzaktan Kontrolü durdurur; Etkinleştirilmiş bir hizmet, bir sonraki uygulama açılışında devam eder. Kullanılamayan yalnızca ana bilgisayar yüzeyleri ve iptal için [Uzaktan Kontrol](remote-control.md) bölümüne bakın.

## Sağlayıcı, eklenti ve uzantı durumu {#providers-and-addons}

| Sorun | Kurtarma |
| --- | --- |
| Yanlış sağlayıcı hesabı/kota | Seçilen yerel hesabı ve **Kullanım** öğesini kontrol edin. Kota ekranı bir belirteç/maliyet toplamı değildir. Belirsiz bir hesap değişikliğinden sonra yenileyin; seçim o hizmetin diğer istemcilerini etkileyebilir. |
| Süresi dolmuş harici mülkiyetli OAuth | OpenCode, Claude Code veya ilgili kimlik bilgisi sahibi aracılığıyla tekrar oturum açın. CodeNomad yenileme jetonlarını değiştirmez. |
| Otomatik hesap seçimi geçiş yapmıyor | Özelliğin açık ve hesabın uygun olduğunu, mevcut kotanın tamamen dolduğunu kontrol edin. Bu, devam eden isteğe müdahale veya hemen yeniden yürütme değil, kabul öncesi ilkedir. |
| Eklenti durumu eski görünüyor | **Plugin denetimlerini yenile** öğesini kullanın ve eklenti ipucunun kapsamını/hedefini inceleyin; çalışma zamanı aktivasyonu yerel yenilemeyi bekleyebilir. Belirsiz bir yazmayı tekrar tekrar değiştirmeyin. |
| **Görev Kontrolü kullanılamıyor** | Belirtilen nedeni izleyin. OpenCode Görevler eklentisini yüklemediyse yenileyin, sorun sürerse **OpenCode yapılandırmasını yeniden yükle** eylemini kullanın; eklenti yüklenemediyse hatasını Eklentiler listesinde okuyun; sunucu yerel Görevler bağlantısını açamadıysa sunucu günlüğünü kontrol edin, çünkü OpenCode'u yeniden yüklemek işe yaramaz. Görevler bağımsız sunucuda da çalışır. |
| Yüklü uzantı eksik | Panel özelleştirmesinde tek etkinleştirme onay kutusunu işaretleyin. Kurulum/değiştirme işlemi, siz açıkça etkinleştirip gerekli onayı onaylayana kadar onu devre dışı bırakır. |
| Uzantı öğeleri reddedildi | Geçerli bağlı oturum için API 2 varlık okuma iznini onaylayın. Bir uzantı yüklemek, rastgele dosyaları/geçmişi okuma izni değildir. |

Bkz. [Sağlayıcılar](providers.md), [Entegrasyonlar](integrations.md) ve [Uzantılar](extensions.md).

## Geçmiş, bekleyen istekler ve temizleme {#history-and-requests}

Tam geçmiş araması, halihazırda yüklü olan konuşma dökümü satırlarıyla sınırlı değildir. Görüntüleme filtresi içeriği silmeden gizler; Arama, sıkıştırma, teknik temizleme ve silme işlemlerini ayırt etmek için [Geçmiş](history.md)'yi kullanın.

Bekleyen istek kurtarma işlemi tamamlanmadıysa CodeNomad, eksik kapsamı boş bir kuyruk olarak ele almak yerine bilinen kuyrukları ve yanıt taslaklarını korur. Art arda iki eksik kurtarma sonrasında projeyi, nedeni, klasörleri ve etkilenen oturumları belirterek bir kez uyarır; uyarı **Projeler ve sekmeler** bildirim kategorisine aittir (varsayılan olarak ekranda ve geçmişte görünür; bkz. **Ayarlar → Bildirimler**). Geçici arızalar canlılık kontrolü tarafından yeniden denenir. Sıkıştırmayla ilgili erteleme, talebin iptal edildiği anlamına gelmez. Taslağı olduğu gibi bırakın, hizmet bağlantısını doğrulayın ve tekrar yanıtlamadan önce isteğin mevcut durumunu kullanın.

İptal edilmiş veya kısmi temizlikte başka silme başlatmadan önce ilerlemeyi/karar kayıtlarını okuyun. İptal gönderilmiş toplu işlemi geri almaz. Geçmişi OpenCode veritabanını düzenleyerek onarmayın. Görev belirsizliğinde yeni çalıştırma oluşturmak veya işi otomatik tekrarlamak yerine **Durumu denetle**/yenileme kurtarmasını kullanın; [Görevler](missions.md) yeniden başlatma ve çalışma ömrü sınırlarını açıklar.

## Günlükler ve güvenli tanılama {#diagnostics}

1. Durumunu incelemek için **Instance Bilgisi** öğesini açın; **Sunucu log'larını göster** mevcut çıktıyı ortaya çıkarır.
2. **Preferences → OpenCode** bölümünde amaçlanan **Varsayılan log seviyesi** öğesini yalnızca daha fazla ayrıntıya ihtiyaç duyulduğunda seçin. Bağımsız CodeNomad günlük kaydı için [sunucu CLI günlük kaydı seçenekleri](server.md)'yi kullanın.
3. **Ayarlar → Bilgi → Tanılama** öğesini açın ve **Hata bildir**, **Panoya kopyala** veya **.txt indir** öğesini kullanın.

Günlüğe kaydetme ayrıntıları yolları, çıktıları ve uygulama verilerini ortaya çıkarabilir. Günlükleri/yakalamaları paylaşmadan önce kimlik bilgilerini, eşleştirme bağlantılarını, ağ adreslerini, özel yolları ve konuşma içeriğini çıkarın. Tam teşhis raporu yolları/adresleri içerir; önceden doldurulmuş hata formu bunları kasıtlı olarak hariç tutar. Bkz. [Destek](support.md#report-a-bug).
