# Konuşmalar

CodeNomad, yerel OpenCode oturumlarını, devredilen işler için bir hiyerarşi ve bir sonraki göndereceğiniz şey için ayrı kontrollerle konuşmalar olarak sunar.

Mesajlar Markdown, kod, farklar ve desteklenen araç sonucu görüntülerini işler. Metin kopyalama, tam geçmiş araması ve seslendirme gömülü görüntü baytlarını değil, metin izdüşümünü kullanır. **Mesaj içeriği** saklanan parçaları silmeden görünürlüğü değiştirir; [Geçmiş](history.md#operation-reference) görünüm kontrolleriyle temizliği ayırır.

Akıl yürütme ve araç başlıkları her adımın ne kadar sürdüğünü gösterir; süre, adım çalışırken canlı olarak sayılır ve bir saniyenin altındaki süreler gösterilmez. **Mesaj içeriği** içinde **Tokenlar** gösterildiğinde (**Her şey** hazır ayarı bunu gösterir), her ajan mesajı son metninden sonra tek bir token ve maliyet satırıyla biter. Bu satır, yüklenmiş konuşma dökümü içinde mesajı ve **Bu yanıttan araçları ve akıl yürütmeyi kaldır** eyleminin kapsadığı araçları ve akıl yürütmeyi içeren mesajları toplar; akıl yürütme ve önbellek sayıları için satırı genişletin. Yalnızca araç çalıştıran adımların kendi satırı yoktur.

## Mermaid diyagramları {#mermaid}

`mermaid` ve `mmd` kod blokları akış tamamlandıktan sonra Mermaid Tiny ile çizilir. Kod başlığında **Kaynağı göster** / **Diyagramı göster** kullanın; Kopyala kaynak metni korur. Tiny; zihin haritaları, mimari diyagramlar ve KaTeX içermez. Geçersiz, desteklenmeyen veya çok büyük diyagramların kaynağı hata ile gösterilir. Çizim yereldir, ağ erişimi yoktur; sınır 50.000 karakter ve 500 kenardır.

## Konuşmaları bulma ve gezinme {#navigate-conversations}

1. **Session'lar** altında satır seçin veya üst konuşma başlatmak için **Yeni session** eylemini kullanın.
2. Üst konuşmanın okuna tıklayarak alt oturumlarını rozetlerini koruyarak genişletin veya daraltın. Açık ya da kapalı, ok alt konuşmalarının en acil durumunu gösterir: girdi bekliyor, çalışıyor, sıkıştırılıyor veya boşta; erişilebilir etiketi bunları sayar. Oka sağ tıklayıp **Okundu olarak işaretle** öğesini seçerek konuşmanın ve tüm alt oturumlarının **Boşta** ve **Kesildi** rozetlerini tek seferde temizleyin.
3. Listeyi daraltmak için **Session ara…**, **Ana oturumlar** / **Alt oturumlar**, çalışma ağacı filtresini ve **Etkinlik**, **Ad** veya **Çalışma ağacı** sıralamasını kullanın. Arama sonuçlarında, birden fazla konuşmayı tek seferde seçmek veya seçimini kaldırmak için satırların onay kutularının üzerinde sürükleyin.
4. Görüntülediğiniz konuşmaları yeniden ziyaret etmek için kenar çubuğundaki **Geri** ve **İleri** öğesini kullanın.

Konuşmayı açmadan gördüğünüzü belirtmek için **Boşta** veya **Kesildi** rozetine tıklayın (**Temizle**); odaklanmışken Enter/Boşluk da kullanılabilir. Fare veya kalemle bir rozeti basılı tutup diğerlerinin üzerinden sürükleyerek birkaçını temizleyin; dokunarak sürükleme kaydırmaya devam eder. Çalışma ve bekleyen girdi/izin göstergeleri görünür kalır. Görüntülemek **Boşta** rozetini temizler; **Kesildi** için açık bir temizleme hareketi gerekir. Onaylar bu pencerenin oturum durumuyla kaydedilir; yeni bir kesinti rozeti yeniden gösterir. Temizleme yalnızca göstergeyi değiştirir; yeniden yükleme oku mesajları yeniden yüklemeye devam eder.

Normal gezinme hiyerarşiktir; arama/filtre sonuçları her konuşmanın kendi kimliği ve çalışma ağacıyla düz listelenir. **Ayarlar → Genel** içindeki **Alt oturumları otomatik genişlet** varsayılan olarak açıktır. Görünen kapalı bir satır seçiliyse veya seçili konuşmanın altındaysa, oku çalışıyor, sıkıştırılıyor veya girdi bekleniyor durumuna geçtiğinde etkin alt oturumlarına giden yollar açılır. Aynı kural her derinlikte geçerlidir. Zaten etkin bir satırı kaydırarak görünür yapmak, yeni bir durum değişikliğine kadar onu kapalı bırakır. Etkinliğin dalları açmasını önlemek için seçeneği kapatın; elle genişletme ve açık gezinme kullanılabilir kalır. Otomatik açılanlar dahil açık dallar geri yüklemek üzere kaydedilir.

Geri/İleri, liste sırası değil, proje sekmesi başına, pencere başına ziyaret geçmişidir. Bellekte tutulur, kullanılamayan/silinmiş konuşmalar atlanır ve yeniden başlatıldıktan sonra geri yüklenmez. Geri döndükten sonra yeni bir görüşme seçmek ileri yolun yerini alır. Paletin **Önceki Session** / **Sonraki Session**'si bunun yerine görünür listeyi döndürür.

## Arşivleme ve geri yükleme {#archive}

Geçmişi koruyup etkin olmayan dalı normal listeden gizlemek için satır eylemlerinden **Oturumu arşivle** seçeneğini kullanın. Seçili konuşma, çalışan işler ve yanıt bekleyen soruları olan konuşmalar erişilebilir kalır. Arşivleme işi durdurmaz, mesajları silmez ve alt oturumların kendi arşiv durumlarını değiştirmez.

Oturum aramasını açıp **Arşivlenmiş oturumlar** veya **Tüm oturumlar** seçeneğini kullanın. Satırlar **Arşivlendi** olarak işaretlenir ve **Oturumu geri yükle** eylemini sunar. Arşivlenmiş üst oturumların altındakiler dahil çocukları bağımsız bulmak için alt oturumları etkinleştirin. **Arşivlenmemiş oturumlar**, her konuşmanın kendi durumuna göre filtreler. Etkin olmayan dalı normal listeye döndürmek için arşivlenmiş üst oturumu geri yükleyin. Eylem doğrulanmazsa yeniden denemeden önce listeyi yenileyin.

## Ajan, Model ve Düşünme seçimi {#agent-model-thinking}

1. Göndermeden önce ileti düzenleyicisinin altındaki ajan ve model seçicilerini kullanın.
2. Model varyant sunuyorsa **Düşünme** düzeyini seçin; **Varsayılan** OpenCode varsayılanını kullanır.
3. Bir sonucu teşhis ederken sonraki istemi gönderin ve yanıtın aracı/model meta verilerini kontrol edin.

Yeni bir konuşma, siz başka birini seçmedikçe OpenCode'un varsayılan olarak çözümlediği ajanla başlar; bu varsayılanı bir eklenti belirleyebilir. Seçicilerin araç ipuçları kısayollarını gösterir.

Bunlar daha önceki yanıtlara yönelik düzenlemeler değil, sonraki gönderimlere yönelik yürütme seçenekleridir. Eski bir zaman çizelgesi pasajını okumak, ileti düzenleyicisinin mevcut seçimlerini tarihsel meta verilerle değiştirmez. Model görünürlüğü, sık kullanılanlar ve sağlayıcı bağlantıları [Sağlayıcılar](providers.md)'de yönetilir.

## Taslaklar ve ekler {#drafts-attachments}

1. Seçili konuşmada yazın. Konuşma değiştirmek taslağı göndermez, korur.
2. Bu cihazdaki dosyalar için ileti düzenleyicisinin **Diğer eylemler** menüsünde **Dosya ekle…** öğesini seçin ya da dosyaları bırakın veya yapıştırın; proje dosyalarını, aracıları veya becerileri seçmek için `@` yazın.
3. Ek çiplerini inceleyin ve bir sonraki gönderimde kullanılması amaçlanmayan her şeyi kaldırın.

| Giriş | Kaynak ve etki |
| --- | --- |
| Cihaz eki | Seçici, bırakma veya pano, kullanıcı arayüzünü çalıştıran cihazdaki baytları okur; bu bir sunucu yolu değil |
| Proje `@` referansı | Çalışma ağacı dahil konuşmanın arka uçtaki projesi/Location bağlamında çözümlenir |
| Ajan anma | Geçmiş mesajları değiştirmeden seçili ajan referansını ekler |
| Beceri | Location bağlamının becerilerini ada/açıklamaya göre arar ve çıkarılabilir bir beceri seçimi ekler |

Cihaz dosyalarının okunabilir olması ve ek bütçesine uygun olması gerekir: her biri en fazla 5 MiB, 10 dosya ve toplamda 20 MiB. Reddedilen bir dosya eklenmez; Tüm seçimin başarılı olduğunu varsaymak yerine bildirimi inceleyin.

Bir beceri seçildiğinde `@query` jetonu kaldırılır ve bir çip eklenir. Gönderme işlemi, OpenCode tarafından gönderilen mesajla birlikte depolanan talimatları değil, ileti düzenleyicisi seçimini temizler. Geçmiş mesajlar beceri etiketlerini korur. Kuyruğa alınmış bir istemi düzenlerken bir beceriyi kaldırmak, onun yeni gönderimden kaldırılmasını sağlar.

Masaüstünde gönderme, klavye odağını konuşmaya taşır; böylece oklar, sayfa tuşları ve Boşluk konuşmayı kaydırır. Bir karakter yazmak, o karakterle birlikte ileti düzenleyicisine döner. **Diğer eylemler** içindeki **Prompt metnini temizle** (varsayılan **Ctrl/Cmd+K**) ileti düzenleyicisinin taslağını temizler.

Taslaklar paylaşılan OpenCode mesajları değil, istemci çalışma durumudur. Başlangıçta geri yükleme desteklenen ileti düzenleyicisi durumunu koruyabilir; ancak gönderilmemiş taslak veya eki yedek saymayın ve başka cihazda göründüğünü varsaymayın. Başlangıç verilerini temizlemeden veya geri yüklemesi kapalı istemciyi kapatmadan önce önemli metni kaydedin; bkz. [Masaüstü](desktop.md).

## Yanıtlardan dosya açma {#open-files-from-replies}

1. Aracı yanıtları proje dosyalarına göreli ve mutlak yollarla bağlantı verir.
2. Düz bir tıklama, bağlantılı dosyayı sohbetin worktree’sinden okuyarak dosya önizlemesinde açar.
3. Değiştirici tıklamalar (Ctrl/⌘, Shift, orta tıklama) ve oturumun worktree’si dışındaki bağlantılar normal bağlantı davranışını korur.

## Komutlar ve Shell modu {#commands-shell}

1. `/` yazın ve bulunan özel bir komutu seçin, ardından bağımsız değişkenlerini sağlayın.
2. Doğrudan kabuk komutu için boş ileti düzenleyicisinin başına `!` yazarak **Shell modu** durumuna geçin.
3. Komutu gönderin. Shell modundan çalıştırmadan çıkmak için Escape veya boş alanda Backspace kullanın.

Yalnızca bilinen eğik çizgi komut adları özel komut yolunu kullanır; bilinmeyen `/text` sıradan istemdir. Özel komutlar OpenCode tanımlarını kullanır. Dosya/görüntü ekleri bu yolla gönderilmez ve sonraki istem için kalır; argümanlarda kullanılan yapıştırılmış metin argümanlara çözümlenir.

Shell modu, modelin bir komut önerme isteğini değil, yerel bir oturum kabuğu isteğini çalıştırır. Yürütme ana bilgisayarında dosyaları değiştirebilir ve işlemleri başlatabilir. Profil ortamı ayarları bir sonraki istemden, özel komuttan veya kabuk isteğinden önce uygulanır; mevcut bir hizmeti yeniden başlatmazlar. Bkz. [Entegrasyonlar](integrations.md) ve [OpenCode kurulumu](opencode.md).

## Takipleri yönlendirin, sıraya koyun ve düzenleyin {#follow-ups}

1. **Ayarlar → Genel** bölümünde, oturum meşgulken gönderilen takipleri kuyruğa almak için **Gönderilen istemleri kuyruğa al** seçeneğini açın; çalışan görevi yönlendirmek için kapalı bırakın (varsayılan).
2. Oturum meşgulken bu davranışı kullanarak bir takip gönderin. Diğer davranış için ileti düzenleyicisinin **Diğer eylemler** menüsünde **Mesajı kuyruğa ekle** veya **Şimdi yönlendir** öğesini seçin ya da alternatif gönderme kısayolunu kullanın (Windows ve Linux'ta varsayılan **Alt+Enter**, macOS'ta **Cmd+Shift+Return**; bkz. [Kısayollar](shortcuts.md)).
3. İstem kuyruğunda, giriş hala beklemedeyken **Şimdi yönlendir**, **Kuyruğa al**, **Kuyruktaki promptu düzenle** veya **Kuyruktaki promptu kaldır** öğesini kullanın.

| Teslimat | Etki |
| --- | --- |
| Yönlendir | Devam eden yürütme için yerel yönlendirme girişi |
| Kuyruk | Sonradan işlenmek üzere tutulan OpenCode takip girdisi |

Oturum boşta ise normal gönderme, bu anahtardan bağımsız olarak standart hemen gönderme yolunu kullanır ve **Diğer eylemler** alternatifi kullanılamaz. Düzenleme bekleyen istemi ve kaldırılabilir eklerini ileti düzenleyicisine getirir; **Düzenlemeyi iptal et** düzenleme akışından çıkar. OpenCode tarafından işlenmiş istem artık düzenlenebilir bekleyen kayıt değildir. Kaydı kaldırmak yapılmış işi geri almaz.

Kuyruk güncellemesi başarısızsa yeniden denemeden önce güncel kuyruğu inceleyin. Kabul, modelin takip girdisini işlediğinin kanıtı değildir; yeniden bağlanmak tekrar gönderme izni vermez.

## /btw ile yan soru sorun {#side-question}

1. Mevcut bir görüşmede `/btw your question`'yi veya yan soru penceresini açmak için `/btw`'yi gönderin.
2. Cevabı okuyun, **Yanıtı kopyala** öğesini kullanın veya beklemedeyken **Soruyu iptal et** öğesini seçin.
3. İşiniz bittiğinde pencereyi kapatın.

Bu, oturum bağlamını kullanan ayrı bir model isteğidir. Bir araç döngüsü çalıştırmaz, eylemde bulunmaz veya sorusunu/cevabını konuşmaya eklemez. Dosya/resim ekleri ileti düzenleyicisinde kalır; Soruda kullanılan yapıştırılan metin metin olarak dahil edilir. Bu yeni ve kalıcı bir konuşma ya da işi dağıtmanın alternatif bir yolu değil.

Kapatmak ana oturumu kesmeden bekleyen yan isteği iptal eder. Etkin konuşmadan ayrılmak bu geçici pencereyi temizler; gerekeni önce kopyalayın. Boş/hatalı yanıtlar konuşma mesajına dönüşmeden burada gösterilir.

## /goal ile bir hedefe doğru çalışmayı sürdürün {#goal}

1. `/goal` ve ardından bir hedef gönderin, örneğin `/goal Make every test pass`. Oturum, OpenCode'un hedef denetçisi hedefe ulaşıldığına karar verene kadar tur tur çalışmayı sürdürür.
2. Görüşmenin bir hedefi olduğu sürece **Durum**, onu **Tokenlar** üzerinde tek bir satırda gösterir: durumu (**Etkin**, **Duraklatıldı** veya **Ulaşıldı**), hedef ve izin verilen en fazla turdan kullanılan turlar. Hedefin tamamını, son değişikliğin nedeniyle (hedefin neden duraklatıldığı veya neden ulaşıldığı gibi) birlikte okumak için hedefin üzerine gelin veya ona odaklanın.
3. O satırda **Hedefi duraklat** veya **Hedefi sürdür** öğesini kullanın ya da `/goal pause` veya `/goal resume` gönderin. Hedefi kaldırmak için **Hedefi temizle** öğesini veya `/goal clear` komutunu kullanın.

Bir hedef kendi görüşmesine aittir: alt oturumlar ve çatallar hedefsiz başlar. OpenCode; oturumu durdurduğunuzda, bir çalıştırma başarısız olduğunda, ilerleme durduğunda, tur sınırına ulaşıldığında veya hizmet yeniden başladığında hedefi kendisi de duraklatır; devam etmek için sürdürün. Duraklatmak veya temizlemek, yapılmış işi geri almaz. Etkin hedef yokken duraklatmak gibi geçerli olmayan bir komut OpenCode'un iletisini gösterir. Hedef yoksa veya hedef desteği olmayan bir OpenCode hizmetinde satır görünmez.

## Başarısız bir çalıştırmayı çatallayın, geri alın ve kurtarın {#fork-errors}

1. Bir mesajda, bu noktadan sonra orijinali değiştirmeden bir konuşma oluşturmak için **Bu mesajdan sonra fork'la** öğesini seçin.
2. Geri almak için **Buraya kadarki değişiklikleri geri al (mesajları siler)** öğesini dikkatlice inceleyin. Palet, aşamalı geri alma için **Son Mesajı Geri Al** ve **Son Mesajı Yinele** öğesini sunuyor.
3. Yürütme başarısız olursa, tekrar göndermeden önce **Session hatası** öğesini, yanıt hatasını ve tüm **Gönderme başarısız** ayrıntılarını inceleyin.

Çatallama seçilen noktaya kadar konuşma bağlamını kopyalar; Git çalışma ağacı oluşturmaz veya dosyaları yalıtmaz. Geri alma yalnızca gezinme değildir. Devam etmeden önce dosya etkilerini ve geri alma sınırını inceleyin; özgün akışı yeniden yazmadan alternatif konuşma istiyorsanız çatallama kullanın.

Geri sayım içeren bir **Yeniden deneniyor** durumu, OpenCode'un bir sağlayıcı hatasını kendiliğinden yeniden denediği anlamına gelir; tekrar göndermek yerine bekleyin veya oturumu durdurun. Başarısız gönderme, daha yeni yazdıklarınızın üzerine yazmayacaksa denenen taslağı ve ekleri geri getirir. Başarısız çalıştırma araçları zaten yürütmüş olabilir: yeniden denemeden önce [Dosyalar](files.md), bekleyen [istekler](permissions.md) ve OpenCode etkinliğini inceleyin. **Mesajları yeniden yükle** veya **Session'ı yeniden yükle** durumu okur; değişiklik işlemini tekrarlama talimatı değildir. **Session'ı durdur** yürütmeyi keser, dosya veya dış hizmet değişikliklerini geri almaz.
