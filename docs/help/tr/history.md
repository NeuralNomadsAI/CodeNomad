# Geçmiş, arama ve temizleme

Saklanan geçmiş, konuşma dökümünün şu anda görüntüledikleri ve modelin sıkıştırılmış bağlamı ayrıdır. Herhangi bir şeyi silmeden önce gezinmeyi veya filtrelemeyi seçin.

## Tüm geçmişi ara {#full-history-search}

1. Konuşma başlığında **Sohbet geçmişinde ara** öğesini açın veya yapılandırılmış kısayolunu (varsayılan **Ctrl/Cmd+F**) kullanın.
2. **Tüm oturum** veya **Tüm çalışma alanı** öğesini seçin ve bir arama terimi girin.
3. Okunabilir metnin yanı sıra teknik içeriğe de ihtiyacınız varsa **Araçları ve düşünceleri dahil et** öğesini etkinleştirin.
4. Bir alıntı seçin veya mevcut sayfanın ötesine geçmek için **Sonraki sonuçlar** öğesini kullanın.

Arama, yalnızca ekranda oluşturulmuş konuşma satırlarında değil, saklanan geçmişte düz metin olarak ve büyük/küçük harfe duyarsız yapılır. Çalışma alanı kapsamı, OpenCode hizmetindeki her projeyi değil, açılan projenin yetkili dizin ağacını ve çalışma ağaçlarını izler; sonuçları konuşmaya göre gruplanır ve her grup, konuşmanın başlığıyla ve onu şu anda barındıran çalışma ağacıyla adlandırılır. Dosya/görüntü eki baytları ile sağlayıcının opak durumu aranabilir metin değildir.

**Bu sayfa: … sonuç · … mesaj tarandı** ilerleme satırı, çalışma alanı toplamlarını değil, bu sonuç sayfasını açıklar. Sonuçlar gruplar halinde gelir. Atlanan büyük boyutlu veya desteklenmeyen mesajlar raporlanır; bir isabetin olmaması bu mesajların eşleşme içermediğini kanıtlamaz. Tarama sırasında gelen yeni iletilerin tutarlı bir şekilde dahil edilebilmesi için yeni bir aramaya ihtiyaç vardır.

Boş arama açmak geçmişi taramaz. Sorguyu/kapsamı değiştirmek, pencereyi kapatmak veya oturumdan ayrılmak geçerliliğini yitiren aramayı iptal eder. Okuma başarısızsa **Yeniden dene** eylemini kullanın; bu istem göndermez veya geçmişi değiştirmez.

## Sonuçları açın ve zaman çizelgesini kullanın {#timeline-navigation}

1. Çevresindeki pasaja atlamak için geçerli oturum arama sonucunu seçin.
2. Söz konusu mesajın ayrı bir önizlemesini açmak için başka bir oturumdan bir sonuç seçin; o konuşmaya isabetin olduğu yerde gitmek için **Oturumda aç** öğesini kullanın.
3. **Mesaj zaman çizelgesi** bölümünde bir alıntı için işaretçinin üzerine gelin veya odaklanın, ardından gezinmek için onu seçin. Saklanan geçmişin sonuna dönmek için ilk/en son mesaj kontrollerini kullanın.

Zaman çizelgesi, konuşma dökümü yalnızca sınırlı bir pasaj içerdiğinde bile tam oturum yapısını temsil eder. Atlamalar, araya giren her mesajı getirmek yerine hedefi yükler. Diğer oturum arama önizlemeleri o oturumun tüm metnini yüklemez veya onu seçmez; konuşmayı yalnızca **Oturumda aç** değiştirir.

Araç işaretçileri **Mesaj içeriği** ayarlarını izler: orada gizlenen bir araç türünün işaretçisi olmaz (**Hiçbir şey** ile hiç işaretçi olmaz); izin bekleyen bir araç bunun istisnasıdır. Yalnızca araç çalıştıran bir adım, boş bir ajan işaretçisi olmadan yalnızca araç işaretçilerini gösterir.

Atlama yüklenirken eski bölüm görünür kalır. Yeni atlama veya konuşma dökümüne elle müdahale, eski gezinmeyi geçersiz kılar; başarısız atlama görünür bölümü korur. Tüm projeyi tekrar tekrar yüklemek yerine hedefi yeniden deneyin. Geçmişi okumak ileti düzenleyicisindeki ajan/model seçimini değiştirmez.

Konuşma çok dar olduğunda (420 CSS pikselinin altında) zaman çizelgesi gizlenir; orada arama ve konuşma dökümü kontrollerini kullanın. Kaydedilen görünürlük tercihi, bu duyarlı değişiklik nedeniyle silinmez.

## Doğru geçmiş işlemini seçin {#operation-reference}

| Operasyon | Nerede | Kapsam ve sonuç |
| --- | --- | --- |
| Görüntü filtreleme | **Mesaj içeriği** veya **Ayarlar → Sohbet** | Paylaşılan konuşma dökümü görüntüleme tercihleri; içeriği silmeden gizler / daraltır |
| Sıkıştırma | Palet **Session'ı Sıkıştır** | Teknik çıktının silinmesi değil, seçilen oturum için yerel özet/bağlam sıkıştırması |
| Tek yanıtlı temizleme | Mesaj **Diğer eylemler → Bu yanıttan araçları ve akıl yürütmeyi kaldır** | Uygun tamamlanmış teknik parçaları kalıcı olarak kaldırır; son metni korur |
| Oturumun teknik temizliği | Palet **Oturum Araçlarını ve Akıl Yürütmeyi Kaldır** | Sıkıştırma öncesi mesajlar dahil saklanan oturum geçmişinin tamamında planlama yapar; son metni ve mesaj/oturum meta verilerini korur |
| Oturumu sil | Oturum satırı **Session'ı sil** veya seçilen oturumun silinmesi | Onaylandıktan sonra yerel konuşmayı ve onun alt oturumlarını/geçmişini yinelemeli olarak siler; geri alma yok |
| Session'ları Temizle | Komut paleti | Görüntüleme veya bağlam boyutu ayarı değil, daha kapsamlı oturum silme |

**Mesaj içeriği** konuşmalar genelinde geçerlidir. Üst kısmından veya **Ayarlar → Sohbet** bölümünden bir hazır ayar (**Hiçbir şey**, **Minimal**, **Dengeli** veya **Her şey**) seçin, ardından satırları tek tek ayarlayın; **Mesaj içeriği** hazır ayar menüsü bundan sonra **Özel** gösterir. Araçları gizlemek araçları devre dışı bırakmaz, izinleri değiştirmez veya saklanan çıktıyı kaldırmaz. Arayüzün akıcı kalması için çok büyük mesajlar atlanan bölümün yerinde **… tane daha göster** kontrolünü gösterir; çok uzun metin veya araç çıktısı ise **Tümünü göster** ile birlikte **Bu mesajın akıcı kalması için … karakter daha gizlendi** satırında durur; çok fazla içerik kaldığında **Tümünü göster** yerine **… tane daha göster** görünür ve bu birkaç adım gerektirebilir. İkisini de açmak yalnızca görüntülemeyi etkiler ve silinmiş içeriği kurtarmaz.

## Bir oturumu sıkıştırın {#compact-session}

1. Amaçlanan konuşmayı seçin.
2. Komut paletinden **Session'ı Sıkıştır** öğesini çalıştırın.
3. Yeniden denemeye karar vermeden önce yerel sıkıştırma sonucunu bekleyin veya **Sıkıştırma başarısız** öğesini inceleyin.

Sıkıştırma, OpenCode'un oturuma devam etmek için kullandığı bağlamı değiştirir. Daha önce saklanmış mesajların silineceğini vaat etmez: tam geçmiş araması ve teknik temizlik sıkıştırma öncesi içeriğe hâlâ ulaşabilir. Saklanan hassas geçmişi silmek yerine sıkıştırmayı kullanmayın.

## Araçları ve akıl yürütmeyi kaldırın {#technical-cleanup}

1. Tek yanıtlı eylemi seçin veya seçilen oturum için **Oturum Araçlarını ve Akıl Yürütmeyi Kaldır** öğesini çalıştırın.
2. Planlanan araç/akıl yürütme sayılarını ve atlanan içerik uyarılarını gözden geçirin.
3. **Kaldır** öğesini onaylayın. Tüm oturum çalışması için konuşma dökümünün üzerindeki ilerlemeyi takip edin ve gerekirse iptal kontrolünü kullanın.

Yalnızca uygun, tamamlanmış araçlar ve akıl yürütme parçaları kaldırılır. Etkin/tamamlanmamış içerik budanmaz; onayladığınız kapsamı sessizce genişletmek yerine değişmiş içerik reddedilir. Son metin ve mesaj/oturum meta verileri korunur, ancak kaldırılan teknik çıktı geri alınamaz. Onaylamadan önce gereken her şeyi koruyun.

Oturum temizliği bütün oturum için atomik değildir. Sonraki mesaj çakışır veya başarısız olursa önceki başarılı kaldırmalar kalır. **İptal sonraki toplu işlemleri durdurur; zaten gönderilmiş toplu işlemi geri almaz**; o işlem yine de tamamlanabilir.

Meşgul depolama hatası durumunda mevcut yürütme/depolama işinin bitmesini bekleyin. Değiştirilen mesaj hatası için yeniden yükleyin ve tekrar seçin. Kullanılamayan bir eklenti için CodeNomad'i yeniden bağlayın/yeniden açın ve yeniden denemeden önce hatayı inceleyin. Belirsiz bir yanıtın ardından kalan içeriği yenileyin ve değerlendirin; hiçbir şeyin olmadığını ya da tüm oturumun temizlendiğini varsaymayın.

## Oturumları silme ve temizleme {#delete-scrub}

Üst oturumu silmek tüm alt oturumlarını ve geçmişlerini de siler. Onaylamadan önce konuşma ailesini inceleyin. Görev uzmanı temizliği farklıdır: alt oturumları olan oturumları korur.

1. Tam olarak hangi konuşmanın gitmesi gerektiğini bildiğinizde belirli bir satırın **Session'ı sil**'sini tercih edin.
2. Daha kapsamlı bakım için **Session'ları Temizle** öğesini çalıştırın ve **Session'ları Derin Temizle** onayını okuyun.
3. Yalnızca boş oturumların, tamamlanmış alt ajan oturumlarının ve kullanılmayan çatallanmaların kaldırılmasını kabul ediyorsanız onaylayın.

Scrub, mevcut projenin bilinen oturum adayları üzerinde çalışır ve boş ana oturumlardan fazlasını kaldırabilir. Bu bir arşivleme işlemi değildir ve geri dönüşü yoktur. Bunu yalnızca meşgul bir kenar çubuğunu gizlemek için kullanmayın. Bağımsız **Boş session'ları otomatik temizle** tercihi daha dardır: yüklenmemiş bir konuşma dökümünü boş olarak değerlendirmek yerine bir oturumun gerçekten boş olup olmadığını kontrol eder.

Silme konuşmaları kaldırır; Git commitlerini kaldırmaz ve dosya sistemi/harici etkileri geri almaz. Temizlik kısmen başarılı olursa silinmiş oturumlar silinmiş kalır. Yeniden denemeden önce kalan listeyi ve hataları inceleyin. Çatallama/geri alma için [Konuşmalar](conversations.md), geçici klasör veya çalışma ağacı silme için [Projeler](projects.md) sayfalarına bakın.
