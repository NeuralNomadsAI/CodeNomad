# Sorun giderme

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

Sahip olunan bir çalışma ağacı veya konuşma yerleşimi doğrulanamıyorsa, rastgele yolları denemek veya yerel depolamayı düzenlemek yerine fiziksel klasörünü açıkça açın. Bir çalışma ağacının zorla kaldırılması commit edilmemiş dosyaları yok edebilir; bağlantı onarımı olarak kullanmayın.

## OpenCode çalışma zamanı ve WSL {#opencode-runtime}

Başlatma hatası iletişim kutusunda yürütülebilir dosyayı ve sürümü kontrol etmek için **OpenCode Ayarlarını Aç** seçeneğini kullanın; özel ortam değerleri için **Gelişmiş → Ortam Değişkenleri** bölümüne geçin.

1. **Preferences → OpenCode** öğesini açın ve **OpenCode sürümü** kartını (kurulu sürüm ve çalışan hizmet durumu), ardından **OpenCode İkili Dosyası** altındaki seçili yürütülebilir dosyayı kontrol edin.
2. Gerekli çalışma zamanı yoksa desteklenen kurulum/güncelleme eylemini kullanın. Güncel alt sınır: **2.4.2**; önerilen/doğrulanan sürüm: **2.4.2**.
3. Kurulu CLI, çalışan hizmetten farklıysa, paylaşılan hizmetin yeniden başlatılıp başlatılmayacağına açıkça karar verin.

**OpenCode hizmetini yeniden başlat**, **Sorun giderme** altında mevcuttur ve onay gerektirir. Bağlı her istemcideki aktif çalışmayı kesintiye uğratır ancak oturum geçmişini korur. Yapılandırmanın yeniden yüklenmesi ayrı bir eylemdir: süreci korur ancak yüklenen Konumları yeniden oluşturur ve bekleyen soruları/izinleri iptal eder. Zararsız bir yenileme de değildir.

WSL yürütülebilir dosyasında amaçlanan dağıtımı ve Windows localhost yönlendirmesini doğrulayın. Hizmet yaşam döngüsü Linux içinde çalışır; CodeNomad yine de Windows'tan loopback uç noktasına erişmelidir. Hizmet kaydını/veritabanını asla düzenlemeyin veya Windows'tan tahmini Linux süreç kimliklerine sinyal göndermeyin.

## Oturum açma, TLS ve doğrudan bağlantı {#login-and-tls}

| Belirti | Güvenli kontrol ve kurtarma |
| --- | --- |
| **CodeNomad’a yeniden giriş yapın** | Sayfayı açık tutun, sunucu kullanıcı adını/şifresini girin ve **Giriş yap** öğesini seçin. Taslakları tutmak için kurtarma yeniden bağlanır; başarısız olan eylemi tekrarlamaz. |
| Sunucuya ulaşılamıyor | Arka ucun çalıştığını doğrulayın ve yazdırılan adresini/gerçek bağlantı noktasını kullanın. |
| Sertifika adı/güven hatası | Gerçek ana bilgisayar adını/IP'yi SANs sertifikasına göre kontrol edin ve amaçlanan CA güvenini veya geçerli bir sunucu sertifikasını yükleyin. TLS doğrulamasını devre dışı bırakmayın. |
| Doğrudan bağlantı reddedildi | Etkili HTTP/HTTPS bağlamayı, güvenlik duvarını ve yönlendirmeyi kontrol edin. |

Çalışma zamanı parolaları her arka uç başlangıcında sağlanmalıdır; ayarlar aracılığıyla kaydedilen şifre kalır. Bkz. [güvenlik](security.md), [TLS/bağlama kuralları](remote-access.md) ve [sunucu referansı](server.md).

## Uzaktan Kontrol eşleştirme {#pairing}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim** öğesini açın ve Uzaktan Kontrol'ün çalıştığını kontrol edin.
2. Yeni bir eşleştirme bağlantısı oluşturun ve süresi dolmadan bu bağlantıyı amaçlanan cihazda açın.
3. İstemci **Bu cihazı yeniden eşleştirin** gösteriyorsa, ana bilgisayardan eşleştirin ve ardından istemcide **Bağlantıyı kontrol et** öğesini seçin.

Eşleştirme bağlantıları tek kullanımlıktır ve kısa ömürlüdür; doğrudan erişim şifresi onun yerine geçmez. İptal edilen veya etkinliğin sona erdiği cihaz kimlik bilgilerinin yeniden eşleştirilmesi gerekir. Son masaüstü penceresinin kapatılması, arka ucunu ve dolayısıyla Uzaktan Kontrolü durdurur; Etkinleştirilmiş bir hizmet, bir sonraki uygulama açılışında devam eder. Kullanılamayan yalnızca ana bilgisayar yüzeyleri ve iptal için [Uzaktan Kontrol](remote-control.md) bölümüne bakın.

## Sağlayıcı, eklenti ve uzantı durumu {#providers-and-addons}

- Eklenen eklenti başarısız oldu veya **Onaylanmadı** gösteriyor — OpenCode ana makinesinden paket adını, sürümü ve kayıt defteri erişimini denetleyin. Eklenti araç ipucundaki hata referansını OpenCode günlüğünde arayın. **Onaylanmadı** devre dışı bir eklenti için de görünür.
- Yüklü uzantı eksik — Panel özelleştirmesinde etkinleştirin. Kurulum/değiştirme işlemi, siz açıkça etkinleştirip gerekli onayı onaylayana kadar onu devre dışı bırakır.
- **Tam zaman çizelgesi kullanılamıyor** — OpenCode günlüğündeki `codenomad-session-pruning` yükleme hatasını okuyun.

Bkz. [Sağlayıcılar](providers.md), [Entegrasyonlar](integrations.md) ve [Uzantılar](extensions.md).

## Geçmiş, bekleyen istekler ve temizleme {#history-and-requests}

Tam geçmiş araması, halihazırda yüklü olan konuşma dökümü satırlarıyla sınırlı değildir. Görüntüleme filtresi içeriği silmeden gizler; Arama, sıkıştırma, teknik temizleme ve silme işlemlerini ayırt etmek için [Geçmiş](history.md)'yi kullanın.

İptal edilmiş veya kısmi temizlikte başka silme başlatmadan önce ilerlemeyi/karar kayıtlarını okuyun. İptal gönderilmiş toplu işlemi geri almaz. Geçmişi OpenCode veritabanını düzenleyerek onarmayın.

## Günlükler ve güvenli tanılama {#diagnostics}

1. **Ayarlar → OpenCode → OpenCode loglarını görüntüle** yolunu açın. Seçilen yürütme sunucusunun genel `opencode.log` dosyası `opencode debug paths log` ile bulunur. En fazla son 128 KiB gösterilir; **Yenile** dosyayı tekrar okur.
2. **Preferences → OpenCode** bölümünde amaçlanan **Varsayılan log seviyesi** öğesini yalnızca daha fazla ayrıntıya ihtiyaç duyulduğunda seçin. Bağımsız CodeNomad günlük kaydı için [sunucu CLI günlük kaydı seçenekleri](server.md)'yi kullanın. CodeNomad sunucusu ayrıca yapılandırma dosyasının yanında (varsayılan olarak `~/.config/codenomad`) `logs/server.log` içinde kendi günlüğünü tutar; dolan önceki dosya `server.previous.log` olur.
3. **Ayarlar → Bilgi → Tanılama** öğesini açın ve **Hata bildir**, **Panoya kopyala** veya **.txt indir** öğesini kullanın.

Günlüğe kaydetme ayrıntıları yolları, çıktıları ve uygulama verilerini ortaya çıkarabilir. Günlükleri/yakalamaları paylaşmadan önce kimlik bilgilerini, eşleştirme bağlantılarını, ağ adreslerini, özel yolları ve konuşma içeriğini çıkarın. Tam teşhis raporu yolları/adresleri içerir; önceden doldurulmuş hata formu bunları kasıtlı olarak hariç tutar. Bkz. [Hata bildirin](support.md#report-a-bug).
