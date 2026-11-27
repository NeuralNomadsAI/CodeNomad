# Geçmiş, arama ve temizleme

Saklanan geçmiş, konuşma dökümünün şu anda görüntüledikleri ve modelin sıkıştırılmış bağlamı ayrıdır. Herhangi bir şeyi silmeden önce gezinmeyi veya filtrelemeyi seçin.

## Tüm geçmişi ara {#full-history-search}

1. Konuşma başlığında **Sohbet geçmişinde ara** öğesini açın veya yapılandırılmış kısayolunu (varsayılan **Ctrl/Cmd+F**) kullanın.
2. **Tüm oturum** veya **Tüm çalışma alanı** öğesini seçin ve bir arama terimi girin.
3. Okunabilir metnin yanı sıra teknik içeriğe de ihtiyacınız varsa **Araçları ve düşünceleri dahil et** öğesini etkinleştirin.
4. Bir alıntı seçin. **Tüm oturum** kapsamında kronolojik sayfalarda ilerlemek için **Sonraki sonuçlar** öğesini kullanın.

**Tüm oturum**, saklanan geçmişte büyük/küçük harfe duyarsız tam ifade arar. **Tüm çalışma alanı**, açık projenin yetkili dizin ve çalışma ağaçlarında en fazla altı terimle arama yapıp en iyi 40 sonucu tek listede sıralar. Her konuşmanın en iyi eşleşmesi önce gelir; başlıklar ve güncel çalışma ağacı etiketleri sıralamayı korur. Terimler alıntılarda ve **Oturumda aç** sonrasında hedef konuşmada vurgulanır. Okunabilir metin ve isteğe bağlı araçlar ile düşünceler aranır.

Konuşma sayfaları gruplar geldikçe **Bu sayfa: … sonuç · … mesaj tarandı** bilgisini gösterir. Proje araması **En iyi sonuçlar: …** ile kısmi tarama veya hariç tutulan dizinlere ilişkin kısa bildirimler gösterir. Sıralanmış arama çalışma ortamında yoksa **Tüm oturum** kullanın. Atlanan mesajlar bildirilir; yeni mesajlar için yeniden arayın.

Proje taraması her konumdaki en yeni en fazla 16.384 kayıtlı mesajdan başlar. **Daha eskiyi ara**, listeyi sonraki eski pencerenin en iyi sonuçlarıyla değiştirir. Bildirim, projenin her konumunda yeniden eskiye incelenen aralığı gösterir. Sıralama yalnızca o pencere içinde geçerlidir. Sorgu, kapsam veya teknik içerik değişikliği, aramayı kapatma ya da oturumdan ayrılma pencereyi sıfırlar. Yeni arama yeni mesajları da içerir.

Arama penceresinin süresi dolarsa veya geçmiş değişirse **Yeni arama başlat**, aynı sorgu ve seçeneklerle en yeni mesajlardan başlar.

## Sonuçları açın ve zaman çizelgesini kullanın {#timeline-navigation}

1. Çevresindeki pasaja atlamak için geçerli oturum arama sonucunu seçin.
2. Söz konusu mesajın ayrı bir önizlemesini açmak için başka bir oturumdan bir sonuç seçin; o konuşmaya isabetin olduğu yerde gitmek için **Oturumda aç** öğesini kullanın.
3. **Mesaj zaman çizelgesi** bölümünde bir alıntı için işaretçinin üzerine gelin veya odaklanın, ardından gezinmek için onu seçin: bloğu en üste gelir ve siz kaydırana kadar işaretçi vurgulu kalır; sonra vurgu, konuşmanın en üstündeki bloğu izler. Saklanan geçmişin uçlarına dönmek için ilk/en son mesaj oklarını kullanın. Oklar konuşmanın üzerinde yüzer; **Genel** bölümünde **İlk/en son mesaj oklarını zaman çizelgesinin altına yerleştir** etkinse zaman çizelgesinin altında, **Mesaj gönder** öğesinin sağındaki köşede dururlar ve bulunduğunuz ucun oku soluk görünür.

Zaman çizelgesi, konuşma dökümü yalnızca sınırlı bir pasaj içerdiğinde bile tam oturum yapısını temsil eder. Atlamalar, araya giren her mesajı getirmek yerine hedefi yükler. Diğer oturum arama önizlemeleri o oturumun tüm metnini yüklemez veya onu seçmez; konuşmayı yalnızca **Oturumda aç** değiştirir.

Araç işaretçileri **Mesaj içeriği** ayarlarını izler: orada gizlenen bir araç türünün işaretçisi olmaz (**Hiçbir şey** ile hiç işaretçi olmaz); izin bekleyen bir araç bunun istisnasıdır. Yalnızca araç çalıştıran bir adım, boş bir ajan işaretçisi olmadan yalnızca araç işaretçilerini gösterir.

Konuşma çok dar olduğunda (420 CSS pikselinin altında) zaman çizelgesi gizlenir; orada arama ve konuşma dökümü kontrollerini kullanın. Kaydedilen görünürlük tercihi, bu duyarlı değişiklik nedeniyle silinmez.

## Doğru geçmiş işlemini seçin {#operation-reference}

Rune'da arama, seçilen daraltılmış sonucu açar. Sonuç gizliyse **Mesaj içeriği** bölümünde türünü veya araç girdilerini gösterip sonucu yeniden seçin. Başka bir oturumdaki gizli sonuç, geçerli konuşmayı açık bırakır.

| Operasyon | Nerede | Kapsam ve sonuç |
| --- | --- | --- |
| Görüntü filtreleme | **Mesaj içeriği** veya **Ayarlar → Sohbet** | Paylaşılan konuşma dökümü görüntüleme tercihleri; içeriği silmeden gizler / daraltır |
| Sıkıştırma | Palet **Session'ı Sıkıştır** | Teknik çıktının silinmesi değil, seçilen oturum için yerel özet/bağlam sıkıştırması |
| Tek yanıtlı temizleme | Mesaj **Diğer eylemler → Bu yanıttan araçları ve akıl yürütmeyi kaldır** | Uygun tamamlanmış teknik parçaları kalıcı olarak kaldırır; son metni korur |
| Oturumun teknik temizliği | Palet **Oturum Araçlarını ve Akıl Yürütmeyi Kaldır** | Sıkıştırma öncesi mesajlar dahil saklanan oturum geçmişinin tamamında planlama yapar; son metni ve mesaj/oturum meta verilerini korur |
| Oturumu sil | Oturum satırı **Session'ı sil** veya seçilen oturumun silinmesi | Onaylandıktan sonra yerel konuşmayı ve onun alt oturumlarını/geçmişini yinelemeli olarak siler; geri alma yok |
| Session'ları Temizle | Komut paleti | Görüntüleme veya bağlam boyutu ayarı değil, daha kapsamlı oturum silme |

**Mesaj içeriği** konuşmalar genelinde geçerlidir. Üst kısmından veya **Ayarlar → Sohbet** bölümünden bir hazır ayar (**Hiçbir şey**, **Minimal**, **Dengeli** veya **Her şey**) seçin, ardından satırları tek tek ayarlayın; **Mesaj içeriği** hazır ayar menüsü bundan sonra **Özel** gösterir. Başka bir hazır ayar seçmek bu satırları korur: onlara dönmek için yeniden **Özel** seçin. Araçları gizlemek araçları devre dışı bırakmaz, izinleri değiştirmez veya saklanan çıktıyı kaldırmaz. Arayüzün akıcı kalması için çok büyük mesajlar atlanan bölümün yerinde **… tane daha göster** kontrolünü gösterir; çok uzun metin veya araç çıktısı ise **Tümünü göster** ile birlikte **Bu mesajın akıcı kalması için … karakter daha gizlendi** satırında durur; çok fazla içerik kaldığında **Tümünü göster** yerine **… tane daha göster** görünür ve bu birkaç adım gerektirebilir. İkisini de açmak yalnızca görüntülemeyi etkiler ve silinmiş içeriği kurtarmaz. Birden fazla satırı tek seferde ayarlamak için göz veya ok düğmelerinin üzerinde sürükleyin: ilk ayrıldığınız düğme değişir ve aynı sütunda üzerinden geçtiğiniz her düğme onun yeni durumunu alır. Konuşma, düğmeyi bıraktığınızda güncellenir.

**Araç grupları** satırında her çağrıyı ayrı göstermek için göz düğmesini kapatın veya grupları varsayılan olarak açmak için ok düğmesini kullanın. Her araç türünün kendi görünürlük ayarı geçerliliğini korur. **Her şey** grupları varsayılan olarak açar; diğer hazır ayarlarda gruplar daraltılmış kalır.

## Bir oturumu sıkıştırın {#compact-session}

1. Amaçlanan konuşmayı seçin.
2. Komut paletinden **Session'ı Sıkıştır** öğesini çalıştırın.
3. Yeniden denemeye karar vermeden önce yerel sıkıştırma sonucunu bekleyin veya **Sıkıştırma başarısız** öğesini inceleyin.

Sıkıştırma, OpenCode'un oturuma devam etmek için kullandığı bağlamı değiştirir. Daha önce saklanmış mesajların silineceğini vaat etmez: tam geçmiş araması ve teknik temizlik sıkıştırma öncesi içeriğe hâlâ ulaşabilir. Saklanan hassas geçmişi silmek yerine sıkıştırmayı kullanmayın.

## Araçları ve akıl yürütmeyi kaldırın {#technical-cleanup}

1. Tek yanıtlı eylemi seçin veya seçilen oturum için **Oturum Araçlarını ve Akıl Yürütmeyi Kaldır** öğesini çalıştırın.
2. Planlanan araç/akıl yürütme sayılarını ve atlanan içerik uyarılarını gözden geçirin.
3. **Kaldır** öğesini onaylayın. Tüm oturum çalışması için konuşma dökümünün üzerindeki ilerlemeyi takip edin ve gerekirse iptal kontrolünü kullanın.

Yalnızca uygun, tamamlanmış araçlar ve akıl yürütme parçaları kaldırılır. Etkin/tamamlanmamış içerik budanmaz; OpenCode'un okuduğu haliyle (ekli dosyalar dahil) boyutu 16 MB üzerinde olan bir mesaj da budanmaz ve atlanan içerik sayılır; onayladığınız kapsamı sessizce genişletmek yerine değişmiş içerik reddedilir. Son metin ve mesaj/oturum meta verileri korunur, ancak kaldırılan teknik çıktı geri alınamaz. Onaylamadan önce gereken her şeyi koruyun.

Oturum temizliği bütün oturum için atomik değildir. Sonraki mesaj çakışır veya başarısız olursa önceki başarılı kaldırmalar kalır. **İptal sonraki toplu işlemleri durdurur; zaten gönderilmiş toplu işlemi geri almaz**; o işlem yine de tamamlanabilir.

## Oturumları silme ve temizleme {#delete-scrub}

Üst oturumu silmek tüm alt oturumlarını ve geçmişlerini de siler. Onaylamadan önce konuşma ailesini inceleyin. Görev uzmanı temizliği farklıdır: alt oturumları olan oturumları korur.

1. Tam olarak hangi konuşmanın gitmesi gerektiğini bildiğinizde belirli bir satırın **Session'ı sil**'sini tercih edin.
2. Daha kapsamlı bakım için **Session'ları Temizle** öğesini çalıştırın ve **Session'ları Derin Temizle** onayını okuyun.

Her iki temizlik de yalnızca boş, etkin olmayan ve alt oturumu bulunmadığı doğrulanan oturumları siler. Favoriler ve üst oturumları başka bir klasörde işaretlenmiş olsa da korunur.

Temizlik sırasında bir konuşma kaybolursa gönderilmemiş metni ve ekleri projenin yeni konuşma yazma alanında bulabilirsiniz. Geçerli taslağın üzerine yazmadan kayıtlı bir taslağı açmak için **Taslağı değiştir** seçeneğini kullanın. Projeyi yeniden açtığınızda da taslağı kurtarabilirsiniz.

Silme konuşmaları kaldırır; Git commitlerini kaldırmaz ve dosya sistemi/harici etkileri geri almaz. Temizlik kısmen başarılı olursa silinmiş oturumlar silinmiş kalır. Yeniden denemeden önce kalan listeyi ve hataları inceleyin. Çatallama/geri alma için [Konuşmalar](conversations.md), geçici klasör veya çalışma ağacı silme için [Projeler](projects.md) sayfalarına bakın.
