# Güncellemeler

## Yayın akışını seçin {#feed}

1. **Ayarlar → Bilgi → Güncellemeler** öğesini açın.
2. **Güncelleme akışı** öğesini **Kararlı sürümler** veya **Önizleme ve kararlı sürümler** olarak ayarlayın.
3. Kurulumu kabul etmeden önce güncellemeleri yenileyin/kontrol edin ve sunulan sürümü inceleyin.

Akış yalnızca sunulan sürümleri değiştirir. Masaüstü veri profilleri, taslaklar, pencereler, OpenCode oturumları ve hizmet yapılandırması değişmeden kalır. Açık bir seçim olmadan, önizleme etiketli derlemeler varsayılan olarak önizlemelere, diğer derlemeler ise kararlıdır.

Kararlı akış en son nihai sürümü seçer. Geliştirme derlemeleri aynı temel sürüm numarasını paylaşabildiğinden önizleme akışı yayımlanma sırasını izler; yalnızca sayısal sürümleri karşılaştırmayın. Bir önizleme sürümü ancak tüm derlemeleri yayımlandıktan sonra sunulur. Önizleme paketleri yayımlanmadan önce davranışı sınamak isteyenler içindir; yeniden başlatmadan önce sürüm notlarını inceleyip önemli taslakları koruyun.

## Masaüstü kurulumunu güncelleme {#desktop-update}

1. **Yardım → Güncellemeleri denetle…** öğesini, güncelleme bildirimini veya **Ayarlar → Bilgi → Güncellemeler** içindeki düğmeyi kullanın.
2. Electron'de sürüm sayfasını takip edin ve kullandığınız ana bilgisayar/platformun arşivini/paketini edinin.
3. Uygun yerel Tauri kurulumlarında yerel teklifi inceleyin ve açıkça **Yükle ve yeniden başlat** öğesini seçin.
4. Kurulumdan/yeniden başlatmadan önce her pencerede önemli çalışmaları kaydedin ve yeniden başlattıktan sonra **Bilgi** öğesini doğrulayın.

| Tauri kurulumu | Uygulama içi yükleme uygunluğu |
| --- | --- |
| Windows x64 NSIS kurulumu | Yerleşik güncelleyici anahtarı ve imzalı sürüm verisi ile desteklenir. |
| macOS x64 / arm64 uygulaması | Yerleşik güncelleyici anahtarı ve imzalı bir `.app.tar.gz` verisi ile desteklenir. |
| Linux x64 AppImage | AppImage paket işaretçisi ve boş olmayan bir `APPIMAGE` yolunun yanı sıra imzalı güncelleme desteği gerektirir. `APPRUN` tek başına yetersizdir. |
| Debian/RPM, bağımsız Windows yürütülebilir dosyası, imzasız/anahtarsız derleme | Uygulama içi yükleme yerine sürüm sayfasını açar. |

Tauri uygulama pencerelerinde ve yerel **Tercihler** pencerelerinde, bir sürüm sunulduğunda Güncellemeler kartı **Güncellemeyi yükle** düğmesini gösterir. Seçilen akışı kontrol eder ve uygulama içi güncelleme mevcutsa **Yükle ve yeniden başlat** seçeneğini sunar; aksi halde kartta gösterilen sürüm sayfasını açar. Electron, web ve uzak pencereler ise yerel güncelleyici kontrolü olmadan **Güncellemeyi indir** bağlantısını gösterir.

Tauri'nin **Yardım → Güncellemeleri denetle…** menüsü güncelleme akışını odaktaki uygulama penceresinde çalıştırır. Tercihler veya uzak bir pencereden kullanıldığında, kontrolü çalıştırmak için en son kullanılan uygulama penceresini öne getirir; uzak pencere üzerinden kurulum yapmaz.

Kurulumdan önce yerel imza doğrulaması gereklidir. Güncelleyici imzaları, işletim sistemi noter onayı/kod imzalama güvencelerinden farklıdır.

Kurulum uygulamayı değiştirmeden/yeniden başlatmadan önce tüm uygulama pencerelerinin durumunu diske kaydeder ve kendisine ait CodeNomad arka ucunu durdurur. Bağımsız yönetilen OpenCode daemon'ı bu kapatmaya dahil değildir. CodeNomad kapalıyken dönene kadar arka uca bağlı özellikler kullanılamaz; süren OpenCode oturumundan kesintisiz arayüz hizmeti sonucu çıkarmayın.

## Bağımsız bir sunucuyu güncelleme {#standalone-update}

1.2 arayüzünde konuşma bazında izinler için CodeNomad sunucusunun **1.2.0 veya daha yeni** olması gerekir. Eski sunucular önbellekteki veya birlikte gelen arayüzü korur.

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

Masaüstü çalışma zamanları uygulamayla güncellenir: Electron yerleşik Node'unu kullanır, Tauri Node'u paketler ve ikisi de npm içerir. Sistem Node/npm kurulumu, platform web görünümü ve OpenCode hizmeti bağımsız yönetilir.

Çalışma zamanı seçimi, kurulum/güncelleme ve açık hizmet kontrolleri için **Ayarlar → OpenCode** öğesini kullanın. Özellikle diğer pencereler/kullanıcılar veya Görevler arka plan programını paylaştığında, yeniden başlatmadan veya yeniden yüklemeden önce [OpenCode kurulumu](opencode.md)'yi kontrol edin. Bir güncelleme/yeniden bağlanma bitti diye belirsiz bir istemi veya değişiklik işlemini asla tekrarlamayın.
