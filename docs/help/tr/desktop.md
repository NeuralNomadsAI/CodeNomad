# Masaüstü pencereleri ve veriler

## Pencereler, sekmeler ve paylaşılan hizmet {#windows-tabs}

1. Geçerli pencerede başka bir proje/ana sayfa sekmesi açmak için **Yeni instance** öğesini kullanın.
2. Ayrı bir uygulama penceresi için yerel **Pencere → Yeni pencere** (`Ctrl+Shift+N` veya `Cmd+Shift+N`) kullanın.
3. **Ayarlar → Gelişmiş** bölümünde, başka bir başlatmanın yeni bir pencere açmak yerine en son kullanılan pencereye odaklanması gerekiyorsa **İkinci başlatmada mevcut pencereye odaklan** öğesini etkinleştirin.

Proje sekmeleri, seçilen konuşmalar ve düzen bir pencereye aittir. OpenCode oturumları/mesajları paylaşılan yerel OpenCode hizmetine aittir: aynı konuşmayı başka bir pencere görebilir. Proje sekmesini kapatmak projeyi CodeNomad'de kapatır, OpenCode oturumlarını kapatmaz; onları yeniden bulmak için projeyi tekrar açın. Aynı proje bağlantısını gösteren başka bir pencere de sekmesini kapatır ve bir bildirim gösterir; aynı klasörün ayrı açılmış sekmeleri etkilenmez. Bir pencerenin tamamını kapatmak, uygulamadan çıkmak veya yeniden yüklemek proje bağlantılarını geri yükleme için korur; bkz. [Projeler](projects.md). Kapanan pencereleri bir temsilcinin veya planlanmış Görevin durduğunun kanıtı olarak kullanmayın.

Yerel uygulama menüleri, bir pencere yüklendikten sonra CodeNomad'ın arayüz dilini kullanır; o zamana kadar İngilizce görünür. **Yardım → CodeNomad hakkında** (macOS uygulama menüsünde de bulunur), sürüm, güncellemeler ve tanılamayla birlikte **Ayarlar → Bilgi** bölümünü açar.

## Tercihler ve başlangıç geri yüklemesi {#preferences-startup}

1. Yapılandırmak istediğiniz pencereden Ayarlar'ı açın. Yerel masaüstü giriş noktaları, açıcının projesi/Location ile tek yerel Tercihler penceresine odaklanır.
2. **Genel** bölümünde **Önceki durumu geri yükle** öğesini açın veya kapatın.
3. Bu pencerenin kayıtlı düzenini unutmak için **Kaydedilen başlangıç durumunu temizle** öğesini kullanın. Onay istemeden hemen uygulanır.

Geri yükleme, çalışma alanı/SideCar sekmelerini ve etkin oturumları, gönderilmemiş metni, kaydırma konumlarını, panelleri, pencere yerleşimini ve yakınlaştırmayı yeniden açabilir. Bu, yerel konuşma veritabanının bir kopyası değil, pencere başına istemci durumudur. Temizlendiğinde kayıtlı sekmeler, taslaklar ve düzen kaldırılır; CodeNomad yapılandırmasını veya OpenCode konuşmalarını silmez. Gönderilmemiş önemli taslakları önce başka bir yere kaydedin.

Tercihler penceresinin ayrı bir geri yükleme durumu yoktur: bu kontroller, Tercihler'i açan pencereyi hedefler. Bu pencere kapanmışsa veya Tercihler başlangıçta yeniden açıldığı için bilinmiyorsa, kontroller en son kullanılan pencereyi izler; başka bir pencere için hazırlanan değişiklik asla uygulanmaz, kontroller önce yeni pencerenin değerini gösterir. Belirli bir pencereyi yapılandırmak için Tercihler'i o pencereden açın. Proje kapsamlı ayarlar aynı şekilde açıcının Location'sini kullanır; biri olmadan kullanılamaz durumda kalırlar. Tercihler başlangıçta yeniden açıldığında, bu ayarlar ilgili proje açılmayı bitirince yeniden bağlanır; klasör hâlâ başlatılırken veya birkaç sekmede açıkken, Tercihler'i amaçlanan pencereden açana kadar kullanılamaz kalırlar.

Tarayıcı ve uzak istemci ayarları, ikinci bir native Preferences sahibi açmak yerine istemciye gömülüdür. Native Preferences açılış hatası bildirilir; bunun yerine gizli bir gömülü ayar ekranı açıldığını varsaymayın.

## Masaüstü veri profilleri {#data-profiles}

1. Yerel **Ayarlar → Genel** bölümünde, **Önceki durumu geri yükle** altında **Veri profili** öğesini genişletin. Bu bilgisayardaki tüm profiller boyutu, oluşturulma tarihi ve son kullanımıyla listelenir; açık olan en baştadır.
2. Bir sonraki başlatmanın açacağı profili seçin veya **Yeni profil** öğesini seçip harf veya rakamla başlayan, 1-64 küçük harf, rakam, nokta, kısa çizgi veya alt çizgiden oluşan bir ad girin.
3. Hemen geçmek için **… ile yeniden başlat** öğesini seçin; aksi halde seçilen profil bir sonraki başlatmada açılır. Açık profili yeniden seçmek değişikliği iptal eder.

Başka bir yapılandırmanın profilleri listelenir ancak burada seçilemez. Hatırlanan seçim yoksa paketlenmiş başlatma varsayılan, `dev` ve `dev-v2` profillerinde geri yüklenebilir çalışma arar ve bunlardan en son kullanılanı, hiçbirinde yoksa varsayılanı açar. Profil seçmek profil verilerini taşımaz, birleştirmez veya silmez.

Yürütülebilir dosyayı başlatmadan önce ayarlanan `CODENOMAD_PROFILE` bu seçimi geçersiz kılar; **Veri profili** bu durumda profilleri gösterir ancak birini seçmenize izin vermez. `default` veya `stable` varsayılan profili seçer; geçersiz bir ad ise başka bir profil seçmek yerine başlatmayı engeller. Örneğin, PowerShell'de istenen masaüstü yürütülebilir dosyasını başlatmadan önce:

```powershell
$env:CODENOMAD_PROFILE = "review"
```

Bağımsız bir sunucu yapılandırması için başlatmadan önce `CLI_CONFIG`'yi de ayrı bir yapılandırma dosyasına ayarlayın. Varsayılan `~/.config/codenomad/config.yaml`'dir. Profil adı tek başına o dosyayı veya paylaşılan OpenCode hizmetini değiştirmez.

| Masaüstü veri profiliyle yalıtılmış | Otomatik olarak izole edilmedi |
| --- | --- |
| Pencere/sekme geri yükleme durumu, gönderilmemiş taslaklar ve masaüstü tekil/arka uç kapsamı | OpenCode oturumları, mesajları, sağlayıcı kimlik bilgileri ve yürütme |
| Platform sınırları içinde profile ait native Chromium/WebView depolaması | Yapılandırma paylaşılmışsa CodeNomad yapılandırması/tercihleri, ses hizmeti anahtarları, SideCars ve uzantı etkinleştirmesi |
| Ana makinesi/profili içindeki yerel önizleme depolaması | Açılan projelerdeki dosyalar; uzak sunucuların verileri |

macOS Tauri'de kapsamlı profiller sistem WebKit depolama alanını, oturum açma işlemlerini ve önbelleğini paylaşır; hesap güvenliği izolasyonu olarak profil adlarını kullanmayın. Electron, web verilerini profilinde saklar. Yüklü sürüm ve **Güncelleme akışı** asla başka bir veri profili seçmez. Paketlenmemiş geliştirme lansmanları, açıkça seçilmediği sürece `dev` profilini kullanır.

## Kayıtlı bir profili sil {#delete-profiles}

1. **Veri profili** öğesini yukarıdaki gibi genişletin ve gerekirse listeyi yenileyin.
2. Kaldırılacak profildeki silme düğmesini seçin. Açık profilde bu düğme yoktur.
3. Yalnızca ihtiyacınız olan taslakları/oturum açma bilgilerini koruduktan sonra onaylayın. Yeniden denemeden önce eksik kaldırma raporlarını inceleyin.

Silme işlemi, başka bir yapılandırmadan listelenen bir profil de dahil olmak üzere o profilin kayıtlı sekmelerini, taslaklarını, düzenini ve sahip olunan web depolama/önbellek/oturum açma bilgilerini kaldırır. Açık profili, OpenCode konuşmalarını ve proje dosyalarını korur. Açık veya durumu bilinmeyen bir profil silinemez; ilgili CodeNomad pencerelerini kapatın, listeyi yenileyin ve yeniden deneyin. Tanınmayan içerik, genel olarak silinmek yerine saklanır ve raporlanır.

macOS Tauri'nin ortak WebKit deposu korunur; silinmesi diğer profilleri etkilerdi. Bu temizlik geri alınamaz: korunan OpenCode konuşması, silinmiş gönderilmemiş taslağı geri getirmez. Yalnızca güncel pencereyi sıfırlamak istiyorsanız **Kaydedilen başlangıç durumunu temizle** daha dar kapsamlı eylemdir.

## Yakınlaştırma ve panel geometrisi {#zoom-panels}

1. Yerel **Görünüm → Yakınlaştır**, **Uzaklaştır** veya **Gerçek boyut** kullanın; klavye/tekerlek girişi de ana bilgisayar desteğini takip eder.
2. Paneller arasında geçiş yapmak için sabit dış başlık köşelerinde **Sol panel** ve **Sağ panel** öğesini kullanın. Bu düzen izin verdiğinde çekmeceleri sabitleyin/sabitlemeyi kaldırın.
3. Kontroller artık sığmıyorsa yakınlaştırmayı azaltın veya pencereyi genişletin; dar düzenler kontrolleri menülere ve panelleri kaplamalara taşır.

Ana yerel ve uzak masaüstü pencereleri, uygulama yakınlaştırmasına göre ölçeklenen ve monitörün çalışma alanıyla sınırlanan en az 390 × 600 CSS pikselini ayırır. Yakınlaştırma çok küçük bir pencereyi büyütebilir; uzaklaştırmak zaten daha büyük olanı küçültmez. Tercihler ve tarayıcı önizleme alt öğelerinin ayrı boyut kuralları vardır.

Paneller, yüzmeden önce minimum bir konuşma genişliği bırakır. Konuşma genişliğinin 420 CSS pikselinin altında, zaman çizelgesi gizlenir ve başlık eylemleri taşma menüsünü kullanır; kaydedilen zaman çizelgesi tercihi korunur. Bu geometri değişiklikleri istem taslağınızı veya yerel oturumunuzu değiştirmez. Bkz. [Ayarlar ve düzen](settings.md) ve [Tarayıcı önizlemeleri ve SideCars](browser-sidecars.md).
