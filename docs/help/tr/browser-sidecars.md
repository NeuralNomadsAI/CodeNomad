# Tarayıcı önizlemeleri ve SideCars

## Bir oturum tarayıcısı açın {#session-browser}

1. Konuşmanın araç çubuğunda **Web önizlemesini aç** öğesini seçin.
2. Kimlik bilgisi içermeyen bir `http://` veya `https://` **Önizleme URL'si** girin, ardından **Önizlemeyi aç** öğesini seçin. Gezinmek, yenilemek ve Geri/İleri gitmek için araç çubuğunu kullanın.
3. Sohbete geri dönmek için önizlemenin kapat düğmesini kullanın. Devam etmek için bu görüşmede tekrar açın.

Bir görüşmedeki `localhost` veya `127.0.0.1` bağlantısına tıklamak, her istemcide o oturumun önizlemesinde otomatik olarak açar: sunucu loopback önizlemelerini proxy'den geçirir, bu yüzden başka bir makinedeki sıradan bir tarayıcıdan da çalışır. Proxy'den geçen loopback önizlemeleri **Ayarlar → Önizleme** ayarına uyar; varsayılan opak mod bunları CodeNomad'dan yalıtır. Harici bağlantılar yeni bir tarayıcı sekmesinde açılmaya devam eder.

Her önizleme kendi proje klasörüne ve oturumuna aittir. Konuşma, proje, Bilgi veya sohbet arasında geçiş yapmak, açıkça açılmış native tarayıcıyı canlı belgesini/geçmişini atmadan gizler. Gizli tarayıcılar otomasyon hedefi değildir. Projeyi/pencereyi kapatmak veya arayüzü yeniden başlatmak canlı belgeyi sonlandırır.

Kaydedilen geçmiş, başlangıç/oturum seçiminde değil, yalnızca o oturumun tarayıcısını açıkça yeniden açtığınızda geri yüklenir. Gönderilmemiş formları, DOM, POST gövdelerini veya JavaScript belleğini değil, URL'leri ve imleci saklar. Geçmiş, oturum başına 32 URL ve paylaşılan düzen bütçesiyle sınırlıdır; eski girişler kırpılabilir. Bir URL'nin geri yüklenmesi yeni bir sayfa yüklemesi gerçekleştirebilir; işlem tekrarı değildir.

## Önizleme origin'leri ve izinleri {#preview-origins}

Önizlemeler görüşmenin içinde kalır; CodeNomad ayrı bir önizleme penceresi açmaz. **Ayarlar → Önizleme** tüm CodeNomad sunucusu için tek bir politika belirler. Bu politika tarayıcı ve uzak görünümlerdeki önizlemelere uygulanır. macOS ve Linux'ta Tauri bir iframe kullanır: yerel pencere loopback üzerinden sunulduğunda token başına yalıtılmış bir origin kullanır, aksi halde seçilen yol origin'ini kullanır ve bu anahtarlara uyar. Electron ve Windows Tauri yerel webview'ları kendi izin, indirme ve açılır pencere davranışlarını korur.

| Origin modu | Etkisi |
| --- | --- |
| Opak (önerilir) | Hiçbir önizleme CodeNomad veya başka bir önizlemeyle origin paylaşmaz. Depolama, çerezler, service worker'lar ve origin'e bağlı tarayıcı API'leri kullanılamaz; bu nedenle bazı web uygulamaları çalışmayabilir. |
| CodeNomad ile aynı origin | Loopback önizlemeleri CodeNomad origin'inde çalışır; harici önizlemeler opak kalır. |
| Ayrılmış önizleme origin'i | Loopback önizlemeleri yapılandırdığınız origin'de çalışır; harici önizlemeler opak kalır. |

**CodeNomad ile aynı origin tam güven demektir.** Önizleme kodu CodeNomad depolamasını, transkriptini ve DOM'unu okuyup değiştirebilir, oturumunuzla uygulama API'lerini çağırabilir ve önizleme kapandıktan sonra da kalan service worker'lar kaydedebilir. Bunu yalnızca kontrol ettiğiniz ve güvendiğiniz bir sunucuda, asla paylaşılan veya uzak bir sunucuda kullanmayın. CodeNomad etkinleştirmeden önce onay ister.

**Ayrılmış önizleme origin'i** için CodeNomad'ın sunulduğu tüm origin'lerden farklı bir ana bilgisayar adı kullanın ve `/previews/*` ile WebSocket yükseltmelerini aynı sunucuya yönlendirin. `Host` başlığını, yanıt başlıklarını ve enjekte edilen içerik güvenliği politikasını koruyun; güvenli bağlam API'leri için origin'i TLS üzerinden sunun. CodeNomad origin'e ulaşılıp ulaşılamadığını test edemez; bozuk bir yol önizlemeleri başarısız kılar. Yeniden yazılmış `/previews/<token>/...` ad alanını atlayan kök göreli Worker'lar ve service worker'lar ayrılmış bir origin'de desteklenmez. Çerezleri ayıran şey başka bir port değil, başka bir ana bilgisayar adıdır.

**Sandbox** anahtarları iframe önizlemelerinde formlara, modal iletişim kutularına, açılır pencerelere ve indirmelere izin verir; betikler her zaman gereklidir. **Tarayıcı özellikleri** anahtarları yalnızca önizlemenin kamera, mikrofon, pano okuma/yazma, konum, bildirimler veya tam ekran istemesine izin verir. Tarayıcı yine de izin ister ve tarayıcı site ayarları nihai yetki olarak kalır: bir CodeNomad anahtarı tarayıcı engelini aşamaz ve tarayıcı izni devre dışı bir özelliği geri getiremez. Electron ve Windows Tauri yerel webview'ları bu iframe anahtarlarına uymaz.

Origin modunu, ayrılmış origin'i, sandbox'ı veya özellik politikasını değiştirmek açık bir önizlemeyi yeniden yükler; böylece güven azaltıldıktan sonra daha güvenilir bir belge açık kalmaz.

## Paylaşılan oturum açma işlemleri ve otomasyon sınırları {#signins-automation}

Native önizlemeler aynı masaüstü motoru ve profil/yapılandırma kapsamındaki projeler/oturumlar arasında çerezleri, oturum açma bilgilerini ve site depolamasını paylaşır; bunlar güvenilir CodeNomad arayüzünden ayrıdır. Önizlemede siteden çıkış yapmak aynı depoyu kullanan diğer önizlemeleri etkiler. Belgeler, formlar, oturum depolaması, gezinme geçmişi ve otomasyon bağlantıları oturuma ait kalır. Iframe önizlemeleri tam bir ortak native tarayıcı profili değildir.

| İstemci | Önizleme uygulaması | Ajan tarayıcı otomasyonu | Mobil şablonlar |
| --- | --- | --- | --- |
| Desteklenen masaüstü platformlarında Electron | Yerel Chromium konuğu | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| Windows Tauri | Yerel WebView2 alt öğesi | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| macOS/Linux Tauri | Korumalı alana alınmış iframe | Yerel tarayıcı otomasyonu yok | Yalnızca boyutlar |
| Normal tarayıcı/uzak görünüm | Alternatif iframe görünümü | Yerel native önizleme hedefi yok | Yalnızca boyutlar |

Yerel otomasyon, masaüstü başlangıcında hazırlanır ve açma, gezinme, anlık görüntü, ekran görüntüsü ve sayfa eylemleri için oturuma bağlı `codenomad.browser` aracını kullanır: tıklama, yazma, seçme, üzerine gelme, sürükleme, kaydırma, tuşa basma ve metin bekleme. Aracın kullanılabilirliği her pencere için yetkilendirme değildir: yürütme, sahip olunan arka ucu, yerel yetenekleri, oturumu ve görünür hedefi kontrol eder. Sayfası bu arada gizlenmiş, değiştirilmiş veya başka bir adrese gitmiş bir eylem başka bir sayfaya gönderilmek yerine reddedilir ve hiçbir eylem otomatik olarak tekrarlanmaz. Sayfa içerikleri güvenilmez durumda kalıyor. Hedef yerleştirmeyi yasakladığından iframe başarısız olabilir; korumalarını zayıflatmak yerine harici bir tarayıcı kullanın.

## Altı görünüm alanı şablonundan birini seçin {#templates}

1. Önizlemenin görünüm menüsünü açın.
2. Aşağıdan bir şablon seçin. Portre/manzara girişlerini doğrudan kullanın; ayrı bir döndürme kontrolü yoktur.
3. Mobil öykünmeyi girerken/değiştirirken veya yalnızca boyut içeren bir şablona geri dönerken yerel bir yeniden yükleme beklenebilir.

| Şablon | CSS görünüm alanı |
| --- | --- |
| Duyarlı görünüm alanı | Kullanılabilir önizleme alanı |
| Masaüstü görünüm alanı | 1440 × 900 |
| Tablet dikey | 768 × 1024 |
| Tablet yatay | 1024 × 768 |
| Mobil dikey | 390 × 844 |
| Mobil yatay | 844 × 390 |

Yerel mobil şablonlar Android/Chromium kimliğini, yönelimini, dokunuşunu ve DPR 2.75'i yalnızca sahip olunan misafir için ayarlar. Duyarlı/masaüstü/tablete geri dönmek, bu geçersiz kılmaları temizler ve sayfayı yeniden yükler. Iframe geri dönüşü yalnızca yeniden boyutlandırılır. Bunlar tekrarlanabilir düzen referanslarıdır; Safari/Firefox emülasyonu veya telefon klavyelerinin, tarayıcı/sistem çubuklarının veya mobil işletim sistemi metin ayarlarının simülasyonları değildir. Yeniden yükleme gönderilmemiş sayfa durumunu atabileceği için şablonları değiştirmeden önce sayfa çalışmasını kaydedin.

## SideCar kaydedin {#register-sidecar}

1. Web aracını CodeNomad arka ucunun ana bilgisayarında ayrı olarak başlatıp `127.0.0.1:<port>` adresinde dinlemesini sağlayın.
2. **Ayarlar → SideCars** öğesini açın. **Ad** ve **Port** öğesini girin; türetilen **Temel yol** öğesini (`/sidecars/<id>`) kontrol edin.
3. **Protokol** öğesini yukarı akış hizmetiyle eşleşecek şekilde ayarlayın ve **Ön ek modu** öğesini seçin.
4. Sekmesini açmak için ana sayfadan **SideCar ekle** öğesini ve ardından **SideCar'ı Aç** öğesini seçin.

| Seçim | Kesin etki |
| --- | --- |
| HTTPS (varsayılan biçim) | CodeNomad, `https://127.0.0.1:<port>` olarak yukarı akışa bağlanır. |
| HTTP | CodeNomad, `http://127.0.0.1:<port>` olarak yukarı akışa bağlanır. Bu, genel CodeNomad bağlantısının TLS ayarını değiştirmez. |
| Ön eki çıkar (varsayılan) | `/sidecars/<id>/path`, `/path` olarak üst hizmete iletilir. |
| Ön eki koru | `/sidecars/<id>/path` değişmeden yukarı yönde iletilir. Hizmetin kendi temel yolunu eşleşecek şekilde yapılandırın. |

Kayıt, istemcilerin paylaştığı sunucu yapılandırmasıdır; hizmeti yüklemez veya başlatmaz. Port, görüntüleyen dizüstü/telefon üzerinde değil, arka uç ana bilgisayarındadır. **Çalışıyor** uygulamanın/kimlik doğrulamasının sağlıklı olduğunu değil, erişilebilirliği gösterir. Kaydı kaldırmak ayrı başlatılmış süreci durdurmaz. Sekmeyi kapatmak da durdurmaz.

Ulaşılamıyorsa arka uçtaki işlemi ve bağlantı noktasını kontrol edin. HTML yüklenir ancak asset/WebSockets başarısız olursa, aracın temel yolunu ve önek modunu kontrol edin. Yanlış bir kaydı amaçlanan ayarlarla yeniden oluşturun; Proxy hatasını geçici olarak çözmek için yukarı akışı herkese açık şekilde göstermeyin. SideCar uygulamaları, sunucu hesabının yetkisine sahip bir terminali veya dosyaları açığa çıkarabilir; kullanıcılarına ve yapılandırmalarına güvenin.

SideCar, korumalı alana alınmış bir önizleme değil, CodeNomad'ın güvenilir bir uzantısıdır: sayfası CodeNomad'ın kendi kaynağıyla (origin) çalışır, bu nedenle betikleri oturum açmış erişiminizle CodeNomad'ı kullanabilir. Yalnızca koduna güvendiğiniz hizmetleri kaydedin. CodeNomad kendi oturum açma çerezlerini hizmete iletmez; hizmetin kendi çerezleri ise korunur. Uzaktan Kontrol, SideCar uygulama proxy trafiğini açığa çıkarmaz; [Uzaktan erişim](remote-access.md) ve [Uzaktan Kontrol](remote-control.md)'de açıklanan uygun doğrudan erişim yolunu kullanın.

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
