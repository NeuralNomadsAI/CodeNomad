# Masaüstü pencereleri ve veriler

## Pencereler, sekmeler ve paylaşılan hizmet {#windows-tabs}

1. Geçerli pencerede başka bir proje/ana sayfa sekmesi açmak için **Yeni instance** öğesini kullanın.
2. Ayrı bir uygulama penceresi için yerel **Pencere → Yeni pencere** (`Ctrl+Shift+N` veya `Cmd+Shift+N`) kullanın.
3. **Ayarlar → Gelişmiş** bölümünde, başka bir başlatmanın yeni bir pencere açmak yerine en son kullanılan pencereye odaklanması gerekiyorsa **İkinci başlatmada mevcut pencereye odaklan** öğesini etkinleştirin.

Proje sekmeleri, seçilen konuşmalar ve düzen bir pencereye aittir. OpenCode oturumları/mesajları paylaşılan yerel OpenCode hizmetine aittir: aynı konuşmayı başka bir pencere görebilir. Sekmeyi kapatmak projeyi CodeNomad'de kapatır; oturumlar OpenCode'da devam eder ve projeyi yeniden açtığınızda bulunur. Pencereyi kapatmak da hizmeti durdurmaz; bkz. [Projeler](projects.md). Kapanan pencereleri bir temsilcinin veya planlanmış Görevin durduğunun kanıtı olarak kullanmayın.

## Tercihler ve başlangıç geri yüklemesi {#preferences-startup}

1. Yapılandırmak istediğiniz pencereden Ayarlar'ı açın. Yerel masaüstü giriş noktaları, açıcının projesi/Location ile tek yerel Tercihler penceresine odaklanır.
2. **Genel → Başlangıç** bölümünde **Önceki durumu geri yükle** öğesini etkinleştirin veya devre dışı bırakın.
3. Bu pencerenin kayıtlı düzenini unutmak için sonuçlarını okuduktan sonra **Kayıtlı durumu temizle** öğesini kullanın.

Geri yükleme, çalışma alanı/SideCar sekmelerini ve etkin oturumları, gönderilmemiş metni, kaydırma konumlarını, panelleri, pencere yerleşimini ve yakınlaştırmayı yeniden açabilir. Bu, yerel konuşma veritabanının bir kopyası değil, pencere başına istemci durumudur. Temizlendiğinde kayıtlı sekmeler, taslaklar ve düzen kaldırılır; CodeNomad yapılandırmasını veya OpenCode konuşmalarını silmez. Gönderilmemiş önemli taslakları önce başka bir yere kaydedin.

Tercihler penceresinin ayrı bir geri yükleme durumu yoktur: Başlangıç, kendisini açan pencereyi hedefler. Bu pencere kapanmışsa veya Tercihler başlangıçta yeniden açıldığı için bilinmiyorsa, Başlangıç en son kullanılan pencereyi izler; başka bir pencere için hazırlanan değişiklik asla uygulanmaz, kontroller önce yeni pencerenin değerini gösterir. Belirli bir pencereyi yapılandırmak için Tercihler'i o pencereden açın. Proje kapsamlı ayarlar aynı şekilde açıcının Location'sini kullanır; biri olmadan kullanılamaz durumda kalırlar.

Tarayıcı ve uzak istemci ayarları, ikinci bir native Preferences sahibi açmak yerine istemciye gömülüdür. Native Preferences açılış hatası bildirilir; bunun yerine gizli bir gömülü ayar ekranı açıldığını varsaymayın.

## Açıkça seçilen masaüstü veri profilleri {#data-profiles}

Açık profil seçilmediyse paketlenmiş başlatmalar o yapılandırma için hatırlanan profili kullanır. Hatırlanan seçim yoksa uygulama varsayılan, `dev` ve `dev-v2` profillerinde geri yüklenebilir durum arar: tek adayı seçer, birden fazlaysa sorar, yoksa varsayılanı kullanır. Seçim profil verilerini taşımaz, birleştirmez veya silmez. Başka profili açıkça açmak için `CODENOMAD_PROFILE` kullanın.

1. Kasıtlı masaüstü izolasyonu için, yürütülebilir dosyayı başlatmadan önce `CODENOMAD_PROFILE`'yi ayarlayın.
2. Bir harf veya rakamla başlayan, 1-64 arası ASCII harf/rakam, nokta, alt çizgi veya kısa çizgiden oluşan bir ad kullanın. Adlar küçük harfe göre normalleştirilmiştir; `default` veya `stable` varsayılan profili seçer.
3. Adlandırılmış bir profil için **Ayarlar → Bilgi → Veri profili** öğesini kontrol edin. Geçersiz bir ad, başka bir profil seçmek yerine başlatmayı engelliyor.

Örneğin, PowerShell'de istenen masaüstü yürütülebilir dosyasını başlatmadan önce:

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

## Diğer kayıtlı profilleri sil {#delete-profiles}

1. Yerel **Ayarlar → Genel → Başlangıç** bölümünde **Diğer kayıtlı profiller** öğesini bulun. Yalnızca makinede başka profiller mevcut olduğunda görünür.
2. Gerekirse listeyi yenileyin, **Sil…** öğesini seçin ve listelenen hedefleri ve atlanan profilleri okuyun.
3. Yalnızca ihtiyacınız olan taslakları/oturum açma bilgilerini koruduktan sonra onaylayın. Yeniden denemeden önce eksik kaldırma raporlarını inceleyin.

Silme işlemi, başka bir yapılandırmadan listelenen profiller de dahil olmak üzere diğer profillerin kayıtlı sekmelerini, taslaklarını, düzenini ve sahip olunan web depolama/önbellek/oturum açma bilgilerini kaldırır. Açık profili, OpenCode konuşmalarını ve proje dosyalarını korur. Açık veya bilinmeyen durum profilleri atlanır; Açıkça yenileyip yeniden denemeden önce ilgili CodeNomad pencerelerini kapatın. Tanınmayan içerik, genel olarak silinmek yerine saklanır ve raporlanır.

macOS Tauri'nin ortak WebKit deposu korunur; silinmesi diğer profilleri etkilerdi. Bu temizlik geri alınamaz: korunan OpenCode konuşması, silinmiş gönderilmemiş taslağı geri getirmez. Yalnızca güncel pencereyi sıfırlamak istiyorsanız **Kayıtlı durumu temizle** daha dar kapsamlı eylemdir.

## Yakınlaştırma ve panel geometrisi {#zoom-panels}

1. Yerel **Görünüm → Yakınlaştır**, **Uzaklaştır** veya **Gerçek boyut** kullanın; klavye/tekerlek girişi de ana bilgisayar desteğini takip eder.
2. Paneller arasında geçiş yapmak için sabit dış başlık köşelerinde **Sol panel** ve **Sağ panel** öğesini kullanın. Bu düzen izin verdiğinde çekmeceleri sabitleyin/sabitlemeyi kaldırın.
3. Kontroller artık sığmıyorsa yakınlaştırmayı azaltın veya pencereyi genişletin; dar düzenler kontrolleri menülere ve panelleri kaplamalara taşır.

Ana yerel ve uzak masaüstü pencereleri, uygulama yakınlaştırmasına göre ölçeklenen ve monitörün çalışma alanıyla sınırlanan en az 390 × 600 CSS pikselini ayırır. Yakınlaştırma çok küçük bir pencereyi büyütebilir; uzaklaştırmak zaten daha büyük olanı küçültmez. Tercihler ve tarayıcı önizleme alt öğelerinin ayrı boyut kuralları vardır.

Paneller, yüzmeden önce minimum bir konuşma genişliği bırakır. Konuşma genişliğinin 420 CSS pikselinin altında, zaman çizelgesi gizlenir ve başlık eylemleri taşma menüsünü kullanır; kaydedilen zaman çizelgesi tercihi korunur. Bu geometri değişiklikleri istem taslağınızı veya yerel oturumunuzu değiştirmez. Bkz. [Ayarlar ve düzen](settings.md) ve [Tarayıcı önizlemeleri ve SideCars](browser-sidecars.md).
