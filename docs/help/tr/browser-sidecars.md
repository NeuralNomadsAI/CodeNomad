# Tarayıcı önizlemeleri ve SideCars

Iframe önizlemeleri ve SideCars, DNS takma adları dahil CodeNomad'ın kendi dinleme adreslerine ve bağlantı noktalarına bağlantıları reddeder. Uygulamanızın sunucusu için ayrı bir bağlantı noktası kullanın.

## Bir oturum tarayıcısı açın {#session-browser}

1. Konuşmanın araç çubuğunda **Web önizlemesini aç** öğesini seçin.
2. Kimlik bilgisi içermeyen bir `http://` veya `https://` **Önizleme URL'si** girin, ardından **Önizlemeyi aç** öğesini seçin. Gezinmek, yenilemek ve Geri/İleri gitmek için araç çubuğunu kullanın.
3. Sohbete geri dönmek için önizlemenin kapat düğmesini kullanın. Devam etmek için aynı sekmede ve görüşmede tekrar açın.

Uzak önizlemelerde service worker devre dışıdır.

Bir görüşmedeki `localhost` veya `127.0.0.1` bağlantısına tıklamak, önizlemelerin kullanılabildiği her istemcide o oturumun web önizlemesinde açar. Remote Control üzerinden host web önizlemelerini kapalı tuttuğunda veya önizlemelerin başka bir nedenle kullanılamadığı bir istemcide bu bağlantılar normal tarayıcı davranışını korur. Ctrl+tıklama (macOS'ta ⌘+tıklama) veya orta tıklama bağlantıyı bunun yerine tarayıcınızda açar.

Sohbete döndüğünüzde veya yerel önizlemeyi aynı penceredeki başka bir sekmeye taşıdığınızda açık sayfa korunur.

Her sekme sohbet/önizleme seçimini kaydeder; oturum ortak URL'yi, görünüm şablonunu ve geçmişi kaydeder. Kaydedilen sayfalar yalnızca oturum tarayıcısını açıkça yeniden açtığınızda yüklenir. URL'ler ve imleç saklanır; canlı formlar, DOM, POST gövdeleri ve JavaScript belleği belgeyle birlikte sona erer. Geçmiş, oturum başına 32 URL ve ortak pencere bütçesiyle sınırlıdır; eski girişler kırpılabilir. URL geri yüklendiğinde sayfa yeniden yüklenebilir.

Uzak önizleme, proje sunucusunu kullanır ve uygulamanın URL’sini gösterir. Önizlemeyi veya sekmeyi kapatmak, sunucu bağlantısını kesmek ya da uygulamadan çıkmak canlı sayfayı sonlandırır. Yeniden açtığınızda adres ve geçmiş yüklenir, kaydedilmemiş çalışmalar yüklenmez. Dahili yükleme adreslerini gizli tutun.

Yerel motorlu uzak önizlemeler dahili yükleme adreslerini gizli tutmak için bağlam menülerini, panoya dışa aktarmayı, bağlantı sürüklemeyi, yazdırmayı, açılır pencereleri, indirmeleri, sayfa iletişim kutularını ve izin istemlerini kapatır. Kapatmadan önce sayfadaki çalışmanızı kaydedin.

Önizleme denetimleri, ana bilgisayar ve uzak proje sunucusu önizlemelerin kullanılabildiğini doğruladığında görünür.

Uzaktan Kontrol için **Web önizlemeleri**, ana bilgisayarda **Ayarlar → Uzak Erişim → Uzaktan Kontrol** altında varsayılan olarak açıktır. Kapatıldığında önizlemeler ve WebSocket bağlantıları sonlanır; yeniden yüklemeden sonra **Web önizlemesini aç** gizlenir. Oturumu kapatmak veya eşleştirilmiş bir cihazın erişimini iptal etmek, o cihazın önizlemelerini ve WebSocket bağlantılarını sonlandırır.

## Paylaşılan oturum açma işlemleri ve otomasyon sınırları {#signins-automation}

Electron ve Windows için Tauri’de otomatik yeniden başlatma (`codenomad.act`, `restart`), incelenen profili, yapılandırmayı ve derlemeyi yeniden açar. Özgün pencere geri yüklenirse yeniden incelenir; yüklenmezse araç pencerenin bulunmadığını bildirir ve başka bir pencereyi incelemez. Yeniden bağlanma sırasında başarıyla tamamlanan inceleme önceliklidir.

Yeniden başlatma iptal edilirse `codenomad.inspect` ile `targets: true` kullanarak açık pencereleri listeleyin, ardından istediğiniz pencereyi `target` değeriyle inceleyin.

Native önizlemeler aynı masaüstü motoru ve profil/yapılandırma kapsamındaki projeler/oturumlar arasında çerezleri, oturum açma bilgilerini ve site depolamasını paylaşır; bunlar güvenilir CodeNomad arayüzünden ayrıdır. Önizlemede siteden çıkış yapmak aynı depoyu kullanan diğer önizlemeleri etkiler. Belgeler, formlar, oturum depolaması, gezinme geçmişi ve otomasyon bağlantıları her oturuma aittir.

Her oturumun tek bir yerel önizlemesi vardır. Yinelenen sekmede **Önizleme başka bir sekmede açık** görünürse **Sekmeye git** seçeneğini kullanın veya aynı pencere içinde taşımak için **Burada aç** seçeneğini seçin. Önceki sekme aynı mesajı gösterir. Önizlemenin bulunduğu sekmeyi kapattığınızda önizlemeyi başka bir sekmede açabilirsiniz.

Bir masaüstü penceresi bir konuşmayı gösterdiği sürece, konuşmanın ajanları önizlemesini OpenCode'un tarayıcı araçlarıyla (OpenCode 2.4 veya üzeri) kontrol edebilir; sayfada betik çalıştırma reddedilir ve macOS ile Linux'taki Tauri uygulamasında geri, ileri gidemez veya yeniden yükleyemezler. Electron'da ve Windows Tauri uygulamasında önizlemenin konsol iletilerini ve ağ isteklerini de okuyabilirler; önizleme tuttuğu sürece istek ve yanıtların başlıklarını ve metin gövdelerini görürler; çerez ve yetkilendirme başlıklarının değerleri hariç. Ajan önizlemeyi bulunduğu sekmede, açık değilse oturum için en son kullanılan sekmede açar. Sayfa eylemleri görünür yerel önizlemeye uygulanır. Sayfalar, gördüğünüz önizlemede olduğu gibi bu bilgisayarın ağı üzerinden yüklenir; bu yüzden OpenCode WSL'de çalışsa bile `localhost` bu bilgisayardır.

Ajan önizlemede işlem yapmadan veya ekran görüntüsü almadan önce bir anlık görüntü alır. Önizleme değişirse komut başka bir önizlemeyi kullanmak yerine durur.

| İstemci | Önizleme uygulaması | Ajan tarayıcı otomasyonu | Mobil şablonlar |
| --- | --- | --- | --- |
| Desteklenen masaüstü platformlarında Electron | Yerel Chromium konuğu; OAuth pencereleri, indirmeler ve iletişim kutuları | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| Windows Tauri | Yerel WebView2 alt öğesi; OAuth pencereleri, indirmeler ve iletişim kutuları | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| macOS Tauri (14+) | Yerel WKWebView alt öğesi; OAuth pencereleri, indirmeler ve iletişim kutuları | Görünür sahip olunan oturum önizlemesi için desteklenir | WebKit mobil kimliği ve CSS görünümü; yerel giriş sınırları |
| Linux Tauri | Yerel WebKitGTK alt öğesi; OAuth pencereleri, indirmeler ve iletişim kutuları | Görünür sahip olunan oturum önizlemesi için desteklenir | WebKit mobil kimliği ve CSS görünümü; yerel yoğunluk/giriş sınırları |
| Normal tarayıcı/uzak görünüm | Alternatif iframe görünümü | Yerel native önizleme hedefi yok | Yalnızca boyutlar |

Yerel modda öğe yorumları kullanılamaz. GTK pano okuması açık Ctrl+V ile yapılır; yazma ve yerel kopyala/yapıştır çalışır. iframe engelleyen siteler için harici tarayıcı kullanın.

Yerel açılır pencereler önizleme oturumlarını paylaşır, `opener`/`postMessage` ilişkisini korur ve açan sayfayla kapanır. Yazılan veya geri yüklenen adresler kimlik bilgisiz HTTP(S) ile sınırlıdır; siteler boş ve aynı kökenli blob belgeleri de açabilir. Dosya ve uygulama şemaları engellenir. İndirmeler temizlenmiş benzersiz adlarla İndirilenler'e kaydedilir; üzerine yazılmaz ve otomatik açılmaz. Kamera, mikrofon, konum ve bildirimler reddedilir; sınıflandırılmış izinler onay ister, bilinmeyen istekler hata gösterir. Tauri ve Electron `alert`/`confirm`/`prompt` destekler; Electron'un prompt iletişim kutusu önizlemenin ana sayfalarında, açılır pencerelerde ve alt çerçevelerde kullanılabilir.

Siteler yerel açılır pencere kapanırken onay isteyebilir. 2.52.6 dahil [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277) sorunundan etkilenen WebKitGTK sürümlerinde, bırakılan dosyalara erişim güvenlik nedeniyle engellendiği için yüklemelerde sayfanın dosya seçicisini kullanın. İlgili CodeNomad penceresini kapatmadan veya yeniden yüklemeden önce sayfadaki çalışmanızı kaydedin.

Tauri macOS/Linux'ta önizlemeye odaklanıp ⌘/Ctrl ile +, − veya 0 tuşlarını ya da uygulamanın yakınlaştırma menüsünü kullanın. Odak başka yerdeyse bu menü eylemleri uygulamayı yakınlaştırır.

## Altı görünüm alanı şablonundan birini seçin {#templates}

1. Önizlemenin görünüm menüsünü açın.
2. Aşağıdan bir şablon seçin. Portre/manzara girişlerini doğrudan kullanın; ayrı bir döndürme kontrolü yoktur.
3. Electron ve Windows Tauri'de mobil öykünmeyi girerken/değiştirirken veya yalnızca boyut içeren bir şablona geri dönerken yerel bir yeniden yükleme beklenebilir.

| Şablon | CSS görünüm alanı |
| --- | --- |
| Duyarlı görünüm alanı | Kullanılabilir önizleme alanı |
| Masaüstü görünüm alanı | 1440 × 900 |
| Tablet dikey | 768 × 1024 |
| Tablet yatay | 1024 × 768 |
| Mobil dikey | 390 × 844 |
| Mobil yatay | 844 × 390 |

Electron ve Windows Tauri'de mobil şablonlar Android/Chromium kimliğini, yönelimini, dokunuşunu ve DPR 2.75'i yalnızca sahip olunan misafir için ayarlar. Duyarlı/masaüstü/tablete geri dönmek, bu geçersiz kılmaları temizler ve sayfayı yeniden yükler. Tauri macOS/Linux, HTTP ve JavaScript için genel WebKit mobil kimliğini uygular ve CSS görünümünü uygulama yakınlaştırması/DPI'dan bağımsız ayarlar; şablon değişimi ve sıfırlama sayfayı yeniden yükler. macOS desteklendiğinde yerel DPR 2,75 kullanır; GTK yoğunluğu sığdırma yakınlaştırmasına ve monitöre bağlıdır. Profiller düzen referansıdır; telefon klavyeleri, sistem çubukları ve mobil metin ayarları kapsam dışındadır. Yeniden yükleme gönderilmemiş sayfa durumunu atabileceği için şablonları değiştirmeden önce sayfa çalışmasını kaydedin.

## SideCar kaydedin {#register-sidecar}

1. Web aracını CodeNomad arka ucunun ana bilgisayarında ayrı olarak başlatıp `127.0.0.1:<port>` adresinde dinlemesini sağlayın.
2. **Ayarlar → SideCars** öğesini açın. **Ad** ve **Port** öğesini girin; türetilen **Temel yol** öğesini (`/sidecars/<id>`) kontrol edin.
3. **Protokol** öğesini yukarı akış hizmetiyle eşleşecek şekilde ayarlayın ve **Ön ek modu** öğesini seçin.
4. **SideCar ekle** öğesini seçin, ardından **Gözat** üzerinden açın. [proje sekmeleri](projects.md#open-project).

Çalışan SideCar, sekmesi kapatıldıktan sonra da son sekmeler listesinde kalır.

| Seçim | Kesin etki |
| --- | --- |
| HTTPS (varsayılan biçim) | CodeNomad, `https://127.0.0.1:<port>` olarak yukarı akışa bağlanır. |
| HTTP | CodeNomad, `http://127.0.0.1:<port>` olarak yukarı akışa bağlanır. Bu, genel CodeNomad bağlantısının TLS ayarını değiştirmez. |
| Ön eki çıkar (varsayılan) | `/sidecars/<id>/path`, `/path` olarak üst hizmete iletilir. |
| Ön eki koru | `/sidecars/<id>/path` değişmeden yukarı yönde iletilir. Hizmetin kendi temel yolunu eşleşecek şekilde yapılandırın. |

Kayıt, istemcilerin paylaştığı sunucu yapılandırmasıdır; hizmeti yüklemez veya başlatmaz. Port, görüntüleyen dizüstü/telefon üzerinde değil, arka uç ana bilgisayarındadır. Kaydı kaldırmak ayrı başlatılmış süreci durdurmaz. Sekmeyi kapatmak da durdurmaz.

Ulaşılamıyorsa arka uçtaki işlemi ve bağlantı noktasını kontrol edin. HTML yüklenir ancak asset/WebSockets başarısız olursa, aracın temel yolunu ve önek modunu kontrol edin. Yanlış bir kaydı amaçlanan ayarlarla yeniden oluşturun; Proxy hatasını geçici olarak çözmek için yukarı akışı herkese açık şekilde göstermeyin. SideCar uygulamaları, sunucu hesabının yetkisine sahip bir terminali veya dosyaları açığa çıkarabilir; kullanıcılarına ve yapılandırmalarına güvenin.

SideCar, korumalı alana alınmış bir önizleme değil, CodeNomad'ın güvenilir bir uzantısıdır: sayfası CodeNomad'ın kendi kaynağıyla (origin) çalışır, bu nedenle betikleri oturum açmış erişiminizle CodeNomad'ı kullanabilir. Yalnızca koduna güvendiğiniz hizmetleri kaydedin. CodeNomad kendi oturum açma çerezlerini hizmete iletmez; hizmetin kendi çerezleri ise korunur.

SideCar içeriği (`/sidecars/`) ve SideCar WebSocket'leri, ana bilgisayarda loopback bağlantısı gerektirir. Bunları başka cihazlardan da açmak için ana bilgisayarda **Ayarlar → SideCars** içindeki **SideCars'ı HTTPS üzerinden aç** seçeneğini açın: bu sunucunun HTTPS adresleri veya TLS ters proxy gibi `CODENOMAD_ALLOWED_ORIGINS` içindeki bir HTTPS origin üzerinden oturum açmış tarayıcılar SideCars açabilir. Düz HTTP, `localhost` adresleri ve Uzaktan Kontrol yalnızca ana bilgisayarda kalır. `/api/sidecars` üzerinden kayıt, eşleştirilmiş cihazlar ve kimliği doğrulanmış doğrudan LAN istemcileri için kullanılabilir. Etkin önizleme içeriği (`/previews/`), geçerli bir yetenek belirteciyle doğrudan LAN erişiminde kullanılabilir; [Uzaktan Kontrol](remote-control.md#remote-surface) web önizlemeleri etkin oldukları sürece yetenek belirteçleriyle kullanılabilir kalır. Doğrudan erişim gereksinimleri için bkz. [İzin verilen kaynaklar](remote-access.md#upgrading).

## OpenVSCode Sunucu tarifi {#openvscode}

1. Arka uç ana bilgisayarda Docker'ı geri döngüye bağlı hizmetle çalıştırın:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. **Ad** `VSCode`, **Port** `8000`, **Protokol** `HTTP`, **Ön ek modu** **Ön eki koru** olacak şekilde kaydedin.
3. Görüntülenen temel yolun `/sidecars/vscode` olduğunu doğrulayın ve ardından SideCar'yi açın.

Bu kabuk örneği ana dizininizi kapsayıcıya bağlar; düzenleyici yalnızca daha dar bir konuma erişmeli ise onu bağlayın. Hizmetin `--server-base-path` değeri kayıtla tam eşleşmelidir. İşiniz bitince kapsayıcıyı ayrıca durdurun; SideCar silmek kapsayıcıyı veya dosyalarını kaldırmaz.

## ttyd terminal tarifi {#ttyd}

1. Arka uç ana bilgisayarında geri döngüye bağlı yazılabilir bir kabuk terminali başlatın:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. **Ad** `Terminal`, **Port** `7681`, **Protokol** `HTTP`, **Ön ek modu** **Ön eki çıkar** olacak şekilde kaydedin.
3. SideCar'yi görüntülenen `/sidecars/terminal` temel yolunda açın.

Terminal, ttyd'yi başlatan hesabın ayrıcalıklarıyla çalışır. `zsh` kullanılamıyorsa farklı bir kabuk seçin. Ttyd'nin varsayılanını değiştirdiyseniz gerçek bağlantı noktasını kullanın ve işiniz bittiğinde ttyd'yi ayrı olarak durdurun. CodeNomad erişimini doğrulayın ve koruyun; yazılabilir bir terminal bir korumalı alan değildir.
