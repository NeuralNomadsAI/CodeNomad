# Konuşmalar

CodeNomad, yerel OpenCode oturumlarını, devredilen işler için bir hiyerarşi ve bir sonraki göndereceğiniz şey için ayrı kontrollerle konuşmalar olarak sunar.

Mesajlar Markdown, kod, farklar ve desteklenen araç sonucu görüntülerini işler. Metin kopyalama, tam geçmiş araması ve seslendirme gömülü görüntü baytlarını değil, metin izdüşümünü kullanır. **Mesaj içeriği** saklanan parçaları silmeden görünürlüğü değiştirir; [Geçmiş](history.md#operation-reference) görünüm kontrolleriyle temizliği ayırır.

## Konuşmaları bulma ve gezinme {#navigate-conversations}

1. **Session'lar** altında satır seçin veya üst konuşma başlatmak için **Yeni session** eylemini kullanın.
2. Alt oturumlarını görmek için üst konuşmanın okunu genişletin. Kapalı ok, çalışan veya girdi bekleyen alt konuşmaları gösterebilir.
3. Listeyi daraltmak için **Session ara…**, **Ana oturumlar** / **Alt oturumlar**, çalışma ağacı filtresini ve **Etkinlik**, **Ad** veya **Çalışma ağacı** sıralamasını kullanın.
4. Görüntülediğiniz konuşmaları yeniden ziyaret etmek için kenar çubuğundaki **Geri** ve **İleri** öğesini kullanın.

Normal gezinme hiyerarşiktir; arama/filtre sonuçları her konuşmanın kendi kimliği ve çalışma ağacıyla düz listelenir. Yeni çalışmaya başlayan alt oturum yalnızca etkin konuşmanın ailesi altında otomatik gösterilir. Dalı kapatmak o anda çalışan alt konuşmaların otomatik gösterimini kaldırır.

Geri/İleri, liste sırası değil, proje sekmesi başına, pencere başına ziyaret geçmişidir. Bellekte tutulur, kullanılamayan/silinmiş konuşmalar atlanır ve yeniden başlatıldıktan sonra geri yüklenmez. Geri döndükten sonra yeni bir görüşme seçmek ileri yolun yerini alır. Paletin **Önceki Session** / **Sonraki Session**'si bunun yerine görünür listeyi döndürür.

## Ajan, Model ve Düşünme seçimi {#agent-model-thinking}

1. Göndermeden önce ileti düzenleyicisinin altındaki ajan ve model seçicilerini kullanın.
2. Model varyant sunuyorsa **Düşünme** düzeyini seçin; **Varsayılan** OpenCode varsayılanını kullanır.
3. Bir sonucu teşhis ederken sonraki istemi gönderin ve yanıtın aracı/model meta verilerini kontrol edin.

Bunlar daha önceki yanıtlara yönelik düzenlemeler değil, sonraki gönderimlere yönelik yürütme seçenekleridir. Eski bir zaman çizelgesi pasajını okumak, ileti düzenleyicisinin mevcut seçimlerini tarihsel meta verilerle değiştirmez. Model görünürlüğü, sık kullanılanlar ve sağlayıcı bağlantıları [Sağlayıcılar](providers.md)'de yönetilir.

## Taslaklar ve ekler {#drafts-attachments}

1. Seçili konuşmada yazın. Konuşma değiştirmek taslağı göndermez, korur.
2. Bu cihazdaki dosyalar için **Dosya ekle…** öğesini seçin veya proje dosyalarını, aracıları veya becerileri seçmek için `@` yazın.
3. Ek çiplerini inceleyin ve bir sonraki gönderimde kullanılması amaçlanmayan her şeyi kaldırın.

| Giriş | Kaynak ve etki |
| --- | --- |
| Cihaz eki | Seçici, bırakma veya pano, kullanıcı arayüzünü çalıştıran cihazdaki baytları okur; bu bir sunucu yolu değil |
| Proje `@` referansı | Çalışma ağacı dahil konuşmanın arka uçtaki projesi/Location bağlamında çözümlenir |
| Ajan anma | Geçmiş mesajları değiştirmeden seçili ajan referansını ekler |
| Beceri | Location bağlamının becerilerini ada/açıklamaya göre arar ve çıkarılabilir bir beceri seçimi ekler |

Cihaz dosyalarının okunabilir olması ve ek bütçesine uygun olması gerekir: her biri en fazla 5 MiB, 10 dosya ve toplamda 20 MiB. Reddedilen bir dosya eklenmez; Tüm seçimin başarılı olduğunu varsaymak yerine bildirimi inceleyin.

Bir beceri seçildiğinde `@query` jetonu kaldırılır ve bir çip eklenir. Gönderme işlemi, OpenCode tarafından gönderilen mesajla birlikte depolanan talimatları değil, ileti düzenleyicisi seçimini temizler. Geçmiş mesajlar beceri etiketlerini korur. Kuyruğa alınmış bir istemi düzenlerken bir beceriyi kaldırmak, onun yeni gönderimden kaldırılmasını sağlar.

Taslaklar paylaşılan OpenCode mesajları değil, istemci çalışma durumudur. Başlangıçta geri yükleme desteklenen ileti düzenleyicisi durumunu koruyabilir; ancak gönderilmemiş taslak veya eki yedek saymayın ve başka cihazda göründüğünü varsaymayın. Başlangıç verilerini temizlemeden veya geri yüklemesi kapalı istemciyi kapatmadan önce önemli metni kaydedin; bkz. [Masaüstü](desktop.md).

## Komutlar ve Shell modu {#commands-shell}

1. `/` yazın ve bulunan özel bir komutu seçin, ardından bağımsız değişkenlerini sağlayın.
2. Doğrudan kabuk komutu için boş ileti düzenleyicisinin başına `!` yazarak **Shell modu** durumuna geçin.
3. Komutu gönderin. Shell modundan çalıştırmadan çıkmak için Escape veya boş alanda Backspace kullanın.

Yalnızca bilinen eğik çizgi komut adları özel komut yolunu kullanır; bilinmeyen `/text` sıradan istemdir. Özel komutlar OpenCode tanımlarını kullanır. Dosya/görüntü ekleri bu yolla gönderilmez ve sonraki istem için kalır; argümanlarda kullanılan yapıştırılmış metin argümanlara çözümlenir.

Shell modu, modelin bir komut önerme isteğini değil, yerel bir oturum kabuğu isteğini çalıştırır. Yürütme ana bilgisayarında dosyaları değiştirebilir ve işlemleri başlatabilir. Profil ortamı ayarları bir sonraki istemden, özel komuttan veya kabuk isteğinden önce uygulanır; mevcut bir hizmeti yeniden başlatmazlar. Bkz. [Entegrasyonlar](integrations.md) ve [OpenCode kurulumu](opencode.md).

## Takipleri yönlendirin, sıraya koyun ve düzenleyin {#follow-ups}

1. **Ayarlar → Genel → Takip davranışı** bölümünde **Yönlendir** veya **Kuyruk** öğesini seçin.
2. Oturum meşgulken bu davranışı kullanarak bir takip gönderin. Alternatif gönderme kısayolu diğer davranışı kullanır; [Kısayollar](shortcuts.md)'deki mevcut bağlamayı inceleyin.
3. İstem kuyruğunda, giriş hala beklemedeyken **Şimdi yönlendir**, **Kuyruğa al**, **Kuyruktaki promptu düzenle** veya **Kuyruktaki promptu kaldır** öğesini kullanın.

| Teslimat | Etki |
| --- | --- |
| Yönlendir | Devam eden yürütme için yerel yönlendirme girişi |
| Kuyruk | Sonradan işlenmek üzere tutulan OpenCode takip girdisi |

Oturum boşta ise normal gönderme, meşgul oturum tercihinden bağımsız olarak standart hemen gönderme yolunu kullanır. Düzenleme bekleyen istemi ve kaldırılabilir eklerini ileti düzenleyicisine getirir; **Düzenlemeyi iptal et** düzenleme akışından çıkar. OpenCode tarafından işlenmiş istem artık düzenlenebilir bekleyen kayıt değildir. Kaydı kaldırmak yapılmış işi geri almaz.

Kuyruk güncellemesi başarısızsa yeniden denemeden önce güncel kuyruğu inceleyin. Kabul, modelin takip girdisini işlediğinin kanıtı değildir; yeniden bağlanmak tekrar gönderme izni vermez.

## /btw ile yan soru sorun {#side-question}

1. Mevcut bir görüşmede `/btw your question`'yi veya yan soru penceresini açmak için `/btw`'yi gönderin.
2. Cevabı okuyun, **Yanıtı kopyala** öğesini kullanın veya beklemedeyken **Soruyu iptal et** öğesini seçin.
3. İşiniz bittiğinde pencereyi kapatın.

Bu, oturum bağlamını kullanan ayrı bir model isteğidir. Bir araç döngüsü çalıştırmaz, eylemde bulunmaz veya sorusunu/cevabını konuşmaya eklemez. Dosya/resim ekleri ileti düzenleyicisinde kalır; Soruda kullanılan yapıştırılan metin metin olarak dahil edilir. Bu yeni ve kalıcı bir konuşma ya da işi dağıtmanın alternatif bir yolu değil.

Kapatmak ana oturumu kesmeden bekleyen yan isteği iptal eder. Etkin konuşmadan ayrılmak bu geçici pencereyi temizler; gerekeni önce kopyalayın. Boş/hatalı yanıtlar konuşma mesajına dönüşmeden burada gösterilir.

## Başarısız bir çalıştırmayı çatallayın, geri alın ve kurtarın {#fork-errors}

1. Bir mesajda, bu noktadan sonra orijinali değiştirmeden bir konuşma oluşturmak için **Bu mesajdan sonra fork'la** öğesini seçin.
2. Geri almak için **Buraya kadarki değişiklikleri geri al (mesajları siler)** öğesini dikkatlice inceleyin. Palet, aşamalı geri alma için **Son Mesajı Geri Al** ve **Son Mesajı Yinele** öğesini sunuyor.
3. Yürütme başarısız olursa, tekrar göndermeden önce **Session hatası** öğesini, yanıt hatasını ve tüm **Gönderme başarısız** ayrıntılarını inceleyin.

Çatallama seçilen noktaya kadar konuşma bağlamını kopyalar; Git çalışma ağacı oluşturmaz veya dosyaları yalıtmaz. Geri alma yalnızca gezinme değildir. Devam etmeden önce dosya etkilerini ve geri alma sınırını inceleyin; özgün akışı yeniden yazmadan alternatif konuşma istiyorsanız çatallama kullanın.

Başarısız gönderme, daha yeni yazdıklarınızın üzerine yazmayacaksa denenen taslağı ve ekleri geri getirir. Başarısız çalıştırma araçları zaten yürütmüş olabilir: yeniden denemeden önce [Dosyalar](files.md), bekleyen [istekler](permissions.md) ve OpenCode etkinliğini inceleyin. **Mesajları yeniden yükle** veya **Session'ı yeniden yükle** durumu okur; değişiklik işlemini tekrarlama talimatı değildir. **Session'ı durdur** yürütmeyi keser, dosya veya dış hizmet değişikliklerini geri almaz.
