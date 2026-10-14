# Tarayıcı önizlemeleri ve SideCars

## Bir oturum tarayıcısı açın {#session-browser}

1. Konuşmanın araç çubuğunda web/tarayıcı önizlemesini açın.
2. Kimlik bilgisi içermeyen bir `http://` veya `https://` URL'si girin. Gezinmek, yenilemek ve Geri/İleri gitmek için araç çubuğunu kullanın.
3. Sohbete geri dönmek için önizlemenin kapat düğmesini kullanın. Devam etmek için bu görüşmede tekrar açın.

Her önizleme kendi proje klasörüne ve oturumuna aittir. Konuşma, proje, Bilgi veya sohbet arasında geçiş yapmak, açıkça açılmış native tarayıcıyı canlı belgesini/geçmişini atmadan gizler. Gizli tarayıcılar otomasyon hedefi değildir. Projeyi/pencereyi kapatmak veya arayüzü yeniden başlatmak canlı belgeyi sonlandırır.

Kaydedilen geçmiş, başlangıç/oturum seçiminde değil, yalnızca o oturumun tarayıcısını açıkça yeniden açtığınızda geri yüklenir. Gönderilmemiş formları, DOM, POST gövdelerini veya JavaScript belleğini değil, URL'leri ve imleci saklar. Geçmiş, oturum başına 32 URL ve paylaşılan düzen bütçesiyle sınırlıdır; eski girişler kırpılabilir. Bir URL'nin geri yüklenmesi yeni bir sayfa yüklemesi gerçekleştirebilir; işlem tekrarı değildir.

## Paylaşılan oturum açma işlemleri ve otomasyon sınırları {#signins-automation}

Native önizlemeler aynı masaüstü motoru ve profil/yapılandırma kapsamındaki projeler/oturumlar arasında çerezleri, oturum açma bilgilerini ve site depolamasını paylaşır; bunlar güvenilir CodeNomad arayüzünden ayrıdır. Önizlemede siteden çıkış yapmak aynı depoyu kullanan diğer önizlemeleri etkiler. Belgeler, formlar, oturum depolaması, gezinme geçmişi ve otomasyon bağlantıları oturuma ait kalır. Iframe önizlemeleri tam bir ortak native tarayıcı profili değildir.

| İstemci | Önizleme uygulaması | Ajan tarayıcı otomasyonu | Mobil şablonlar |
| --- | --- | --- | --- |
| Desteklenen masaüstü platformlarında Electron | Yerel Chromium konuğu | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| Windows Tauri | Yerel WebView2 alt öğesi | Görünür sahip olunan oturum önizlemesi için desteklenir | Android/Chromium kimliği, dokunma ve yoğunluk emülasyonu |
| macOS/Linux Tauri | Korumalı alana alınmış iframe | Yerel tarayıcı otomasyonu yok | Yalnızca boyutlar |
| Normal tarayıcı/uzak görünüm | Alternatif iframe görünümü | Yerel native önizleme hedefi yok | Yalnızca boyutlar |

Geliştirici Modu geçişi veya ekstra etkinleştirme yeniden başlatması yoktur. Yerel otomasyon, masaüstü başlangıcında hazırlanır ve açma, gezinme, anlık görüntü, tıklama, yazma ve ekran görüntüsü için oturuma bağlı `codenomad.browser` aracını kullanır. Aracın kullanılabilirliği her pencere için yetkilendirme değildir: yürütme, sahip olunan arka ucu, yerel yetenekleri, oturumu ve görünür hedefi kontrol eder. Sayfa içerikleri güvenilmez durumda kalıyor. Hedef yerleştirmeyi yasakladığından iframe başarısız olabilir; korumalarını zayıflatmak yerine harici bir tarayıcı kullanın.

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

Yerel mobil şablonlar Android/Chromium kimliğini, yönelimini, dokunuşunu ve DPR 2.75'i yalnızca sahip olunan misafir için ayarlar. Duyarlı/masaüstü/tablete geri dönmek, bu geçersiz kılmaları ve yeniden yüklemeleri temizler. Iframe geri dönüşü yalnızca yeniden boyutlandırılır. Bunlar tekrarlanabilir düzen referanslarıdır; Safari/Firefox emülasyonu veya telefon klavyelerinin, tarayıcı/sistem çubuklarının veya mobil işletim sistemi metin ayarlarının simülasyonları değildir. Yeniden yükleme gönderilmemiş sayfa durumunu atabileceği için şablonları değiştirmeden önce sayfa çalışmasını kaydedin.

## SideCar kaydedin {#register-sidecar}

1. Web aracını CodeNomad arka ucunun ana bilgisayarında ayrı olarak başlatıp `127.0.0.1:<port>` adresinde dinlemesini sağlayın.
2. **Ayarlar → SideCars** öğesini açın. **Ad** ve **Port** öğesini girin; türetilen **Temel yol** öğesini (`/sidecars/<id>`) kontrol edin.
3. **Protokol** öğesini yukarı akış hizmetiyle eşleşecek şekilde ayarlayın ve **Ön ek modu** öğesini seçin.
4. Sekmesini açmak için ana sayfadan veya yeni örnek başlatıcıdan **SideCar ekle** öğesini ve ardından **SideCar'ı Aç** öğesini seçin.

| Seçim | Kesin etki |
| --- | --- |
| HTTPS (varsayılan biçim) | CodeNomad, `https://127.0.0.1:<port>` olarak yukarı akışa bağlanır. |
| HTTP | CodeNomad, `http://127.0.0.1:<port>` olarak yukarı akışa bağlanır. Bu, genel CodeNomad bağlantısının TLS ayarını değiştirmez. |
| Ön eki çıkar (varsayılan) | `/sidecars/<id>/path`, `/path` olarak üst hizmete iletilir. |
| Ön eki koru | `/sidecars/<id>/path` değişmeden yukarı yönde iletilir. Hizmetin kendi temel yolunu eşleşecek şekilde yapılandırın. |

Kayıt, istemcilerin paylaştığı sunucu yapılandırmasıdır; hizmeti yüklemez veya başlatmaz. Port, görüntüleyen dizüstü/telefon üzerinde değil, arka uç ana bilgisayarındadır. **Çalışıyor** uygulamanın/kimlik doğrulamasının sağlıklı olduğunu değil, erişilebilirliği gösterir. Kaydı kaldırmak ayrı başlatılmış süreci durdurmaz. Sekmeyi kapatmak da durdurmaz.

Ulaşılamıyorsa arka uçtaki işlemi ve bağlantı noktasını kontrol edin. HTML yüklenir ancak asset/WebSockets başarısız olursa, aracın temel yolunu ve önek modunu kontrol edin. Yanlış bir kaydı amaçlanan ayarlarla yeniden oluşturun; Proxy hatasını geçici olarak çözmek için yukarı akışı herkese açık şekilde göstermeyin. SideCar uygulamaları, sunucu hesabının yetkisine sahip bir terminali veya dosyaları açığa çıkarabilir; kullanıcılarına ve yapılandırmalarına güvenin. Uzaktan Kontrol, SideCar uygulama proxy trafiğini açığa çıkarmaz; [Uzaktan erişim](remote-access.md) ve [Uzaktan Kontrol](remote-control.md)'de açıklanan uygun doğrudan erişim yolunu kullanın.

## OpenVSCode Sunucu tarifi {#openvscode}

1. Arka uç ana bilgisayarda Docker'ı geri döngüye bağlı hizmetle çalıştırın:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. **Ad** `VSCode`, **Port** `8000`, **Protokol** `HTTP`, **Ön ek modu** `Preserve prefix`'yi kaydedin.
3. Görüntülenen temel yolun `/sidecars/vscode` olduğunu doğrulayın ve ardından SideCar'yi açın.

Bu kabuk örneği ana dizininizi kapsayıcıya bağlar; düzenleyici yalnızca daha dar bir konuma erişmeli ise onu bağlayın. Hizmetin `--server-base-path` değeri kayıtla tam eşleşmelidir. İşiniz bitince kapsayıcıyı ayrıca durdurun; SideCar silmek kapsayıcıyı veya dosyalarını kaldırmaz.

## ttyd terminal tarifi {#ttyd}

1. Arka uç ana bilgisayarında geri döngüye bağlı yazılabilir bir kabuk terminali başlatın:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. **Ad** `Terminal`, **Port** `7681`, **Protokol** `HTTP`, **Ön ek modu** `Strip prefix`'yi kaydedin.
3. SideCar'yi görüntülenen `/sidecars/terminal` temel yolunda açın.

Terminal, ttyd'yi başlatan hesabın ayrıcalıklarıyla çalışır. `zsh` kullanılamıyorsa farklı bir kabuk seçin. Ttyd'nin varsayılanını değiştirdiyseniz gerçek bağlantı noktasını kullanın ve işiniz bittiğinde ttyd'yi ayrı olarak durdurun. CodeNomad erişimini doğrulayın ve koruyun; yazılabilir bir terminal bir korumalı alan değildir.
