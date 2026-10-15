# CodeNomad yardımı

Mevcut CodeNomad masaüstü veya tarayıcı çalışma alanını OpenCode hizmetinizle çalıştırmak için bu kılavuzu kullanın. OpenCode yapılandırma eğitimlerine veya sürüm arşivine değil, CodeNomad'in kontrollerine, yürütme sınırlarına ve kurtarmaya odaklanır.

## Önce bunu okuyun {#read-this-first}

CodeNomad çalışma alanınızı tek, paylaşılan OpenCode arka plan hizmetine bağlar. Oturumlar ve mesajlar OpenCode'a; sekmeler, ileti taslakları ve yerleşim CodeNomad istemcisine aittir. Sekmeyi kapatmak projeyi CodeNomad'de kapatır; oturumlar OpenCode'da devam eder ve projeyi yeniden açtığınızda bulunur. CodeNomad'i kapatmak OpenCode'u durdurmaz.

1. [Ana bilgisayar gereksinimleri](install.md#requirements) ve [OpenCode kurulumu](opencode.md)'yi kontrol edin.
2. [Bir proje açın](projects.md), ardından görüşmenin Aracı, Model ve Düşünme kontrollerini seçin.
3. Kimlik bilgilerini değiştirmeden, bir hizmeti yeniden başlatmadan veya geçmişi silmeden önce etkilenen kapsamı kontrol edin. Diğer istemciler aynı yerel hizmeti kullanabilir.

Kamu yardım sitesi CodeNomad, arka ucu veya oturum açma bilgileri olmadan çalışır. Masaüstündeki **Yardım → CodeNomad Yardımı** ve komut paletindeki **Yardımı aç**, onu geçerli kullanıcı arayüzü dilinde ayrı ayrı açar. Dil değişiklikleri saklanan konuşmaları çevirmez.

**Ayarlar**, yerel **Preferences** penceresini yerel bir masaüstü istemcisinde açar; tarayıcı ve uzak istemciler yerleşik ayarları kullanır. **Ayarlar → Provider'lar** gibi yollar her iki yüzeyde de aynı ayarlar bölümünü tanımlar.

Hazırlanmış bir ana bilgisayarda bağımsız bir tarayıcı çalışma alanı için, [sunucu kılavuzu](server.md) bu başlatmayı ve kimlik doğrulama/TLS gereksinimlerini açıklar:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

## İstemcinizi seçin {#choose-your-client}

| Yetenek | Yerel masaüstü | Doğrudan tarayıcı veya uzak sunucu penceresi | Uzaktan Kontrolyla eşleştirilmiş cihaz |
| --- | --- | --- | --- |
| Projeler, konuşmalar, dosyalar ve geçmiş | Arka ucun klasörleri ve OpenCode oturumları | Bağlı sunucunun klasörleri ve oturumları | Ana bilgisayarın yetkili çalışma alanı yüzeyleri |
| Yerel Tercihler ve masaüstü pencereleri | Mevcut | Tarayıcı/uzaktan ayarlar istemcide kalır | Yalnızca ana bilgisayar masaüstü denetimleri kullanılamıyor |
| Oturum tarayıcı önizlemesi | Electron ve Windows Tauri'de yerel; diğer Tauri platformlarında iframe | Mevcut olduğunda Iframe | Yalnızca ana makine önizleme uç noktaları kullanılamıyor |
| Yerel masaüstü/tarayıcı otomasyonu | Sahip olunan yerel pencereler/önizlemeler | Yerel masaüstü otomasyonunun yerini almaz | Yalnızca ana makine otomasyon uç noktaları kullanılamıyor |
| Kimlik doğrulama | Yerel önyükleme veya parola oturumu | Sunucu şifre oturumu | Eşleştirilmiş cihaz kimlik bilgisi |
| PWA kurulumu | Yerel uygulamayı veya tarayıcıyı kullanın | Tarayıcıya bağımlı; güvenli bağlam gerekli | Tarayıcıya bağımlı; eşleştirme hala gerekli |

Kesin sınırlar için, bkz. [tarayıcı önizlemeleri ve SideCars](browser-sidecars.md), [Uzaktan Kontrol](remote-control.md) ve [mobile/PWA](mobile.md). Uzak bir pencere, cihazınızın dosya sistemini sunucu çalışma alanına dönüştürmez.

## Durumun kime ait olduğunu bilin {#state-and-scope}

| Terim | CodeNomad'deki anlamı |
| --- | --- |
| Proje sekmesi / çalışma alanı / örnek | Açıkça açılmış bir klasöre CodeNomad bağlantısı; birden fazla sekme paylaşılan hizmeti kullanabilir. |
| Konuşma / oturum | Yerel OpenCode geçmişi ve dizini ile ilişkili yürütme. |
| Aile | Konuşma ve tüm alt oturumları; taşıma, etkinlik, Yolo ve Görev kontrolleri açısından önemlidir. |
| Çalışma ağacı | Göz atma veya oturum yerleştirme için seçilen, sahipliği doğrulanmış depo çalışma kopyası. Göz atmak konuşmayı taşımaz. |
| Location | OpenCode'un dizin kapsamlı yerel çalışma zamanı bağlamı; proje sekmesini kapatmak bu bağlamı kaldırmaz veya oturumlarını durdurmaz. |
| CodeNomad arka uç | Çalışma alanı, Git, kimlik doğrulama ve istemci bağlantısı sağlayan sunucu. Hesabı ve ortamı, arka uç dosya sistemi erişimini belirler. |
| Yapılandırma | sunucunun yapılandırma dizini altındaki CodeNomad ayarları; Global/Project OpenCode ayarlarının kendi yerel kapsamları vardır. |
| Pencere | Kendi sekmeleri, gezinmesi, taslakları ve geri yüklenen görünümü. Yerel geçmiş her pencere için kopyalanmaz, paylaşılır. |
| Masaüstü veri profili | Açık yerel/istemci depolama seçimi; OpenCode oturumlarını veya paylaşılan her yapılandırmayı otomatik olarak yalıtmaz. |

Çalışma alanı kökü, CodeNomad'in açabileceği klasörleri sınırlar; ajan için korumalı alan değildir. Ana bilgisayarı dışarı açmadan veya geniş araç erişimi vermeden önce [güvenlik](security.md) sayfasını inceleyin.

## Göreve göre keşfedin {#explore-by-task}

| Görev | Rehber |
| --- | --- |
| Çalışma alanını kurun veya sunun | [Kurulum](install.md), [Sunucu başvurusu](server.md), [Ağ ve TLS](remote-access.md) |
| Çalışma kopyaları ve konuşmalar arasında çalışın | [Projeler](projects.md), [Konuşmalar](conversations.md), [Dosyalar](files.md) |
| Geçmişi bulun veya güvenle temizleyin | [Geçmiş](history.md) |
| Yerel soruları ve izinleri yanıtlayın | [İzinler](permissions.md) |
| Sınırlı veya günlük işleri koordine edin | [Görevler](missions.md) |
| Yürütme ve entegrasyonları yapılandırma | [OpenCode](opencode.md), [Sağlayıcılar](providers.md), [Entegrasyonlar](integrations.md) |
| Başka bir cihaz bağlayın | [Uzaktan Kontrol](remote-control.md), [Güvenlik](security.md), [Mobil](mobile.md) |
| Çalışma alanını uyarlayın | [Ayarlar](settings.md), [Kısayollar](shortcuts.md), [Ses](voice.md), [Uzantılar](extensions.md) |
| Yerel uygulamayı yönetin | [Masaüstü](desktop.md), [Tarayıcı önizlemeleri ve SideCars](browser-sidecars.md), [Güncellemeler](updates.md) |
| Teşhis edin veya katkıda bulunun | [Sorun giderme](troubleshooting.md), [Destek ve kaynak derlemeleri](support.md) |

## Çalışmayı değiştirmeden izleyin {#monitor-work}

Durum paneli etkin oturumun sağlayıcı kullanımını ve OpenCode arka plan Shell süreçlerini gösterir. Konuşma durumu ve alt konuşma etkinliği; çalışan, sıkıştırılan ve girdi bekleyen oturumları belirtir. Arka plan Shell sürecini izlemek, ileti düzenleyicisinden Shell isteği göndermekten veya ayrı barındırılan terminal SideCar kullanmaktan farklıdır.

1. Seçilen görüşmenin Location'si (veya hiçbir konuşma seçilmediğinde açık çalışma alanı) için **Durum → Arka Plan Shell'leri** öğesini açın.
2. Sağlandığı yerde komut, kabuk, dizin, durum, PID ve çıkış kodunu inceleyin; mevcut yerel çıktı için **Çıktıyı görüntüle** öğesini seçin.
3. Birini sonlandırmak için çalışırken **Durdur ve kaldır**, çıktıktan sonra **Kaldır** eylemini kullanıp hedefi onaylayın.

Çalışan bir Shell'nin kaldırılması bu işlemi durdurur; çıkış penceresini kapatmak bunu yapmaz. Yenileme/yeniden bağlanma, kaçırılan çıktı olaylarını yeniden oluşturmak yerine mevcut yerel durumu okur.

Görüntüleme anlık görüntüleri OpenCode değişiklikleri, yeniden bağlanma ve görünür talep üzerine yenilenir. Bunlar garantili tekrar günlükleri değildir. Sonuç belirsizse değişiklik işlemini yeniden denemeden önce yetkili durumu yenileyin; yalnızca bir bildirim veya olay kaçırıldı diye tekrar göndermeyin.
