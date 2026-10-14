# Güncellemeler

## Yayın akışını seçin {#feed}

1. **Ayarlar → Bilgi → Güncellemeler** öğesini açın.
2. **Güncelleme akışı** öğesini **Kararlı sürümler** veya **Önizleme ve kararlı sürümler** olarak ayarlayın.
3. Kurulumu kabul etmeden önce güncellemeleri yenileyin/kontrol edin ve sunulan sürümü inceleyin.

Akış, CodeNomad sunucu yapılandırmasına kaydedilir ve yalnızca hangi sürümlerin sunulduğu değişir. Masaüstü veri profillerini, taslakları, pencereleri, OpenCode oturumlarını veya hizmet yapılandırmasını değiştirmez. Açık bir seçim olmadan, önizleme etiketli derlemeler varsayılan olarak önizlemelere, diğer derlemeler ise kararlıdır.

Kararlı akış en son nihai sürümü seçer. Geliştirme derlemeleri aynı temel sürüm numarasını paylaşabildiğinden önizleme akışı yayımlanma sırasını izler; yalnızca sayısal sürümleri karşılaştırmayın. Önizleme paketleri yayımlanmadan önce davranışı sınamak isteyenler içindir; yeniden başlatmadan önce sürüm notlarını inceleyip önemli taslakları koruyun.

## Masaüstü kurulumunu güncelleme {#desktop-update}

1. **Help → Get Updates...** öğesini veya güncelleme bildirimini kullanın.
2. Electron'de sürüm sayfasını takip edin ve kullandığınız ana bilgisayar/platformun arşivini/paketini edinin.
3. Uygun yerel Tauri kurulumlarında yerel teklifi inceleyin ve açıkça **Yükle ve yeniden başlat** öğesini seçin.
4. Kurulumdan/yeniden başlatmadan önce her pencerede önemli çalışmaları kaydedin ve yeniden başlattıktan sonra **Bilgi** öğesini doğrulayın.

| Tauri kurulumu | Uygulama içi yükleme uygunluğu |
| --- | --- |
| Windows x64 NSIS kurulumu | Yerleşik güncelleyici anahtarı ve imzalı sürüm verisi ile desteklenir. |
| macOS x64 / arm64 uygulaması | Yerleşik güncelleyici anahtarı ve imzalı bir `.app.tar.gz` verisi ile desteklenir. |
| Linux x64 AppImage | AppImage paket işaretçisi ve boş olmayan bir `APPIMAGE` yolunun yanı sıra imzalı güncelleme desteği gerektirir. `APPRUN` tek başına yetersizdir. |
| Debian/RPM, bağımsız Windows yürütülebilir dosyası, imzasız/anahtarsız derleme | Uygulama içi yükleme yerine sürüm sayfasını açar. |
| Tercihler, uzak pencereler, oturum açma/eşleştirme ekranları | Sürüm sayfası geri dönüşü, yerel güncelleyici yetkilisi değil. |

Tauri yalnızca seçilen feed/hedef için yayınlanmış bir güncelleme bildirimine sahip sürümleri sunar. Yeni duyurulan bir sürüm henüz yüklenemeyebilir; bildirim bunun yerine yayın sayfasını açabilir. Kurulumdan önce yerel imza doğrulaması gereklidir. Güncelleyici imzaları, işletim sistemi noter onayı/kod imzalama güvencelerinden farklıdır.

Kurulum uygulamayı değiştirmeden/yeniden başlatmadan önce tüm uygulama pencerelerinin durumunu diske kaydeder ve kendisine ait CodeNomad arka ucunu durdurur. Bağımsız yönetilen OpenCode daemon'ı bu kapatmaya dahil değildir. CodeNomad kapalıyken dönene kadar arka uca bağlı özellikler kullanılamaz; süren OpenCode oturumundan kesintisiz arayüz hizmeti sonucu çıkarmayın.

Bir kontrol meşgulse diğer pencerenin çalışmasını bekleyin. İndirme, doğrulama veya kapatma hataları için hatayı okuyun ve yeni bir kontrol yapın; eski bir bildirim, eski baytları yeniden yükleme lisansı değildir. Başarısız bir kurulum, arka ucu geri yükleyebilir ve pencereleri yeniden yükleyebilir ve kurulumu otomatik olarak yeniden yürütmez. Yerel kurulum kullanılamıyorsa uygun paketin yayın sayfasını kullanın; bkz. [Kurulum](install.md).

## Bağımsız bir sunucuyu güncelleme {#standalone-update}

1. CodeNomad'i nasıl başlattığınızı belirleyin ve bu arka uca bağlı tüm çalışmaları kaydedin.
2. Bu CodeNomad sunucu işlemini normal işlem/hizmet kontrolünü kullanarak durdurun.
3. Aynı paket kurulumunu güncelleyin, ardından amaçlanan yapılandırma ve bayraklarla yeniden başlatın.

| Başlatma/yükleme yöntemi | Güncelleme komutu |
| --- | --- |
| Tek seferlik kararlı npm lansmanı | `npx @neuralnomads/codenomad@latest` normal bayraklarınızla |
| Küresel kararlı kurulum | `npm install -g @neuralnomads/codenomad@latest` |
| Yerel kararlı kurulum | Bu paket dizinindeki `npm install @neuralnomads/codenomad@latest` |
| Tek seferlik önizleme lansmanı | `npx @neuralnomads/codenomad-dev@latest` normal bayraklarınızla |
| Küresel/yerel önizleme kurulumu | `@neuralnomads/codenomad-dev@latest`'yi aynı genel/yerel npm formuyla yükleyin |

Halihazırda çalışan bir işlem, npm yüklediği için yeni kodu almaz. Aynı yapılandırma yolunu kasıtlı olarak koruyun; Ayarlar'da bir yayın seçilmesi, npm paketinizin yerini almaz veya kararlı/önizleme paketi adlarını otomatik olarak değiştirmez. Yeniden başlatırken kimlik doğrulama/TLS işaretlerini koruyun; bkz. [Sunucu](server.md).

## OpenCode bakımını ayrı tutun {#opencode-separate}

CodeNomad'in güncellenmesi, seçilen OpenCode CLI'nin güncellenmesi anlamına gelmez. CLI'nin güncellenmesi, çalışan paylaşılan arka plan programını yeniden başlatmıyor. Yerel yapılandırmanın yeniden yüklenmesi, yüklenen Konumlar ve istekler üzerinde kendi etkileri olan başka bir açık işlemdir.

Masaüstü Node/npm kaynakları uygulamayla gelir; bunların güncellemeleri uygulama sürümüyle sunulur. Bu, sistem Node/npm kurulumunu, Electron dahili çalışma zamanını, platform web görünümünü veya bağımsız yönetilen OpenCode hizmetini değiştirmez.

Çalışma zamanı seçimi, kurulum/güncelleme ve açık hizmet kontrolleri için **Ayarlar → OpenCode** öğesini kullanın. Özellikle diğer pencereler/kullanıcılar veya Görevler arka plan programını paylaştığında, yeniden başlatmadan veya yeniden yüklemeden önce [OpenCode kurulumu](opencode.md)'yi kontrol edin. Bir güncelleme/yeniden bağlanma bitti diye belirsiz bir istemi veya değişiklik işlemini asla tekrarlamayın.
