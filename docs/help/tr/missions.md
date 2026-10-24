# Görevler

Görevler, kalıcı bir proje planını OpenCode'un kendi konuşmalarıyla birleştirir. Koordinatör planı hazırlar ve işleri devreder; görev ağacı bağımlılıkları ve sonuçları kaydeder. Kaydedilmiş bir plan, kabul edilmiş bir girdi ve gözlemlenen yürütme birbirinden farklı olgulardır.

## Oluşturun, ardından açıkça başlatın {#create}

1. Sağ panelde **Görevler** bölümünü açıp **Görev oluştur** eylemini seçin.
2. **Görev ne yapmalı?** alanını doldurun ve ilk cümleden otomatik doldurulan **Başlık** alanını kontrol edin (en fazla 60 karakter).
3. **Ne zaman** altında **Bir kez** veya **Her gün saat** seçeneğini belirleyin. Günlük işler için gösterilen saat dilimini doğrulayın; **Değiştir** ile bir IANA saat dilimi girebilirsiniz.
4. **Rehber**, **Notlar**, **Ajanlar ve modeller**, **Görev oturumları**, kayıtlı özetler ve isteğe bağlı takip edilen konuşmalar için **Seçenekler** bölümünü genişletin. **İki modeli karşılaştır** seçildiğinde **Model A** ve **Model B** seçicileri ana formda görünür.
5. **Oluştur** eylemini seçin. Yeni kaydı seçip hazır olduğunuzda ayrı ▶ eylemini kullanın: tek seferlik işler için **Görevi başlat**, günlük zamanlama için **{id} zamanlamasını başlat**.

**Oluşturmak hiçbir zaman işi başlatmaz.** Tek seferlik görev hazırlanır; günlük zamanlama duraklatılmış durumdadır. Ne oluşturma ne de özeti kaydetme bir zamanlayıcıyı devreye alır. Oluşturma seçili proje/Location kapsamındadır ve istenen profillerle görev oturumu ilkesini sabitler. Doğrulama mesajları ilgili alanın yanındadır; hiçbir şey gönderilmediğini belirten bir ret durumunda taslak düzeltilebilmesi için korunur. Tek seferlik bir görevin koordinatörü sizin için takip işi gibi ayrı bir görev de hazırlayabilir: bu görev listede **Hazır** olarak görünür ve diğer her görev gibi yalnızca ▶ eylemiyle başlar.

### İş akışı rehberleri {#playbooks}

| Rehber | Amaçlanan çalışma |
| --- | --- |
| Esnek görev | Koordinatör, hedef için bağımlılıkları gözeten bir plan seçer. |
| Hata ayıklama | Teşhis, uygulama, ayrı standart/şartname incelemesi ve yeni doğrulama; çözüm aşamasında uygulayıcıyla devam edilir. |
| Keşif | Belirsizlikleri haritalandırır ve insana sorular yönelterek sınırları belirli kararları ele alır. |
| Ürün teslimatı | Ürün analizi, mimari, uygulama ve kalite rollerini koordine eder. |
| İki modeli karşılaştır | Aynı görevi aynı özetlerle **Model A** ve **Model B** üzerinde çalıştırır; ardından bir **Kör hakem** ikisini tarafsız etiketler altında puanlar ve bir karar verir: **Model A kazandı**, **Model B kazandı**, **Eşdeğer** veya **Sonuçsuz**. |

**İki modeli karşılaştır** için iki model de zorunludur ve birbirinden farklı olmalıdır; yalnızca farklı bir **Düşünme** düzeyi farklı bir model sayılmaz. Siz bir model seçmedikçe hakem koordinatörün modelini kullanır; bu model A veya B ile aynıysa form uyarır, çünkü bu durum karşılaştırmayı taraflı hale getirebilir. Genel bakış kararı, iki modelin adını ve ölçüt bazında puanları gösterir.

Rehber koordinasyona yön verir; OpenCode izinlerini aşmaz veya başarıyı garanti etmez. Keşif akışının karar sorularını CodeNomad'in istek panelinden yanıtlayın; böylece bir ajandan onayı taklit etmesini istemek yerine açık bir arayüz yanıtı kaydedilir.

## Ağacı izleyin ve sonuçları okuyun {#tracking}

1. Görev başlığını seçin. Baştaki ok listeyi açık tutar; başlık alanı geçici bir seçici açar.
2. Merkezi genel bakış için **Özet** (göz) eylemini seçin veya ilgili sonucu, iş özetini ve kanıtları görmek için bir görev düğümünü seçin.
3. Bağımlılık bağlantılarını ve **Raporlar** bölümünü izleyin; koordinatörün konuşma dökümüne ihtiyaç duyduğunuzda **Konuşmayı aç** eylemini kullanın.
4. **Yanıtınız gerekiyor** altında **Yanıtla** eylemiyle istekte bulunan aktörün konuşmasını ve istek panelini açın.

| Gösterge | Neyi gösterir |
| --- | --- |
| Atandı | Girdi kabul edilmiştir; modelin bunu işlemesi, çalışması veya tamamlaması kanıtlanmış değildir. |
| Etkin | OpenCode etkinliği gözlemlenmiştir. |
| Bekliyor | Bildirilen bağımlılıklar henüz karşılanmamıştır. |
| Engellendi | Bir engel bildirilmiştir; bu mutlaka size yöneltilmiş bir soru değildir. |
| Yanıtınızı bekliyor | Açık bir OpenCode Formu/sorusu veya izin isteği yanıt beklemektedir; **Yanıtınız gerekiyor** altında listelenir. |
| Tamamlandı | Bir görev sonucu kaydedilmiştir; kanıtlarını ve OpenCode'da kalan işleri inceleyin. |
| Başarısız / Geri çekildi | Görev başarısız oldu ya da koordinatör onu değiştirdi veya bıraktı. |

Grafik tamamlanan ve plandan çıkarılan işleri de içerir. Bir görevi plandan çıkarmak konuşmasını kendiliğinden durdurmaz. Tek seferlik bir görevde koordinatör, OpenCode alt ajanı olarak başlattığı ve plandan çıkarılan bir görevin konuşmalarını diğer görevlere dokunmadan ayrıca durdurabilir. **Sürüyor**, görevin yaşam döngüsü durumudur; koordinatörün o anda çalıştığının kanıtı değildir. Ayrıntılı metin paneldeki görev listesinde değil, merkezi okuyucudadır; **Teknik ayrıntılar** altında kimlikler ve istenen yürütme bilgileri kapalı tutulur.

### Durum özetleri ve güncelleme istekleri {#briefings}

Koordinatöre ilk plandan sonra, her görev sonuçlandırıldığında, insan yanıtı beklerken ve son rapordan önce bir proje durum özeti yayımlaması talimatı verilir. Bu, yazılmış bir değerlendirmedir; canlı etkinlik sayacı veya garantili periyodik yaşam sinyali değildir. Bir bildirim, durum özetinden sonra haritanın değiştiğini belirtir.

Yeni bir koordinatör değerlendirmesi için araç çubuğunun altındaki **Güncelleme iste** eylemini kullanıp **Özet** bölümünü okuyun. **Güncelleme istendi…**, isteğin beklediğini, henüz yanıtlanmadığını gösterir. **Gönderim doğrulanmadı** otomatik yeniden göndermeye izin vermez: ayrı bir yeni istekte bulunmadan önce koordinatör konuşmasını açın. Bu, salt okunur bir korumalı ortam değil, sıradan bir OpenCode girdisidir; koordinatör normal izinlerini korur.

## Profiller, iş devri ve derinlik {#profiles}

1. **Yeni görev varsayılanları** ayarını düzenlemek için Görevler dişli simgesini veya **Ayarlar → Görevler** yolunu kullanın.
2. **Uygulanacak kapsam** altında **Tüm görevler** veya bir rehber seçin; ardından **Görev oturumları** ayarını ve **Ajanlar ve modeller** altında her rol için bir satırı (önce koordinatör, sonra rehberin rolleri) belirleyin. Her seçim hemen kaydedilir; Kaydet düğmesi yoktur.
3. Bir rehber kapsamında satırlar, **Genel** olarak işaretlenmiş genel değerleri gösterir. Bir alanı değiştirmek o rolü bu değerlerden başlayarak özelleştirir; geri alma simgesi yeniden genel değerleri kullanır. **Sıfırla** (onaydan sonra) yalnızca gösterilen kapsamın ajanlarını ve modellerini temizler.
4. Oluşturma sırasında belirli profiller istemek için **Seçenekler → Ajanlar ve modeller** yolunu kullanın; **Kaydedilmiş varsayılanları kullan** kayıtlı olanları geri getirir.
5. OpenCode'un özyineleme sınırları için **Alt oturum iç içe geçme derinliği → Proje için belirlenen derinlik** alanını düzenleyin. Enter'a basmak veya alandan çıkmak, değişmiş geçerli bir değeri kaydeder; **Devral** hemen kaydeder; Escape kaydedilmemiş bir değeri atar.

| Ayar | Kapsam ve etki |
| --- | --- |
| Yeni görev varsayılanları | Yapılandırma genelinde yalnızca **yeni** görevleri etkileyen varsayılanlar; rehber istisnası genel varsayılanı geçersiz kılar. |
| Ajan / Model / Düşünme | Oluşturmayla kaydedilen koordinatör/rol tercihleri; meşgul bir aktör sonraki işlere uyması için sessizce değiştirilmez. Günlük çalıştırmalar sabitlenmiş profil tercihlerini yeniden kullanır. |
| OpenCode alt ajanları | Görev oturumları koordinatörün altında subagent/all ajanlarını kullanır. |
| Bağımsız oturumlar | Bildirilen görev oturumları primary/all ajanlarını ve bağımsız konuşmaları kullanır; bu, dahili OpenCode yardımcılarını devre dışı bırakmaz. |
| Alt oturum iç içe geçme derinliği | Yalnızca Görevler için değil, oradaki **tüm** OpenCode konuşmaları için proje yapılandırması. Boş bırakılırsa devralınır. Kaydetme OpenCode'u yeniden yüklemez veya çalışan konuşmaları değiştirmez. |

**Yerel varsayılan** ile **Genel** farklıdır: ilki OpenCode'un kendi varsayılanlarını ister, ikincisi genel seçimi devralır; bir rehber kapsamında yerel varsayılanları seçmek açık bir istisna olarak kalır. Katalog kullanılabilirliği kontrol edilir; istenen profil, bir konuşmanın o anda kullandığı profilin kanıtı değildir. Her iki görev modunda da dahili yardımcı çağrılarını OpenCode izinleri ve yapılandırılmış derinlik yönetir.

Reddedilen veya doğrulanmayan bir seçim asla yeniden gönderilmez: kayıtlı değerler yeniden gösterilir ve **Yeniden yükle** yalnızca bu değerler okunamadığında görünür. Bir derinlik değişikliği doğrulanmadıysa değeriniz korunur; başka bir değişiklik yapmadan önce **Proje derinliğini yenile** eylemini kullanın. **Etkin OpenCode derinliği bilinmiyor** durumunu sıfır veya devre dışı olarak yorumlamayın.

## Kayıtlı bir özeti yeniden kullanın {#saved-briefs}

1. Oluşturma ekranında **Seçenekler → Kayıtlı bir özetle başla** bölümünü genişletip kayıtlı özeti seçin.
2. **Oluştur** eyleminden önce kopyalanan hedefi, notları, rehberi, profilleri ve iş devri tercihini inceleyin.
3. Yeniden kullanılabilir taslağa ad vermek için **Özet olarak kaydet** eylemini kullanın. Seçili tek seferlik bir görev, tamamlanmış olsa bile, aynı **Özet olarak kaydet** eylemini sunar.

Özetler talimatları ve istenen tercihleri saklar; görev planlarını, sonuçları, konuşmaları, zamanlama saatlerini veya yürütme yetkisini saklamaz. Bir özeti yüklemek sıradan oluşturma taslağını doldurur; hiçbir şeyi başlatmaz veya zamanlamaz. Özeti kaldırmak mevcut görevleri/konuşmaları korur. **Ayarlar → Görevler → Kayıtlı özetler** kitaplığı yönetir; kitaplık okunamaz hale gelirse **Kaydedilmiş kitaplığı sıfırla** (onaydan sonra) yürütmeleri değil, kayıtlı özetleri kaldırır. Zamanlamalarda özeti kaydetme eylemi yoktur.

## Günlük saat, kaçırılan günler ve takip edilen konuşmalar {#daily-schedules}

Günlük zamanlamalar geçen 24 saatlik aralığı değil, kayıtlı IANA saat dilimini ve takvim saatini kullanır. Saatler zamanlamanın saat diliminde gösterilir; görüntüleyenin saat diliminden farklıysa belirtilir. Her çalıştırmanın kendi koordinatörü ve yalıtılmış görev haritası vardır; seçili zamanlama güncel görev ağacını ve tarih/sonuç geçmişini gösterir. Geçmiş bir çalıştırmayı seçerek merkezi alanda okuyabilirsiniz. Geçmiş 30 sonuçla sınırlıdır.

| Durum | Zamanlama davranışı |
| --- | --- |
| Birkaç planlı gün kaçırıldı | Kaçırılan her gün için birikmiş işler oluşturmaz; yalnızca sonuçlandırılmış günlük işaretçiden sonraki en son planlı günü çalıştırır. |
| Yaz saatine geçişte oluşan boşluk | Sonraki ilk geçerli dakikaya ilerler; gün sonundaki boşlukta sonraki güne geçer. |
| Saatin tekrarlanması | İlk gerçekleşmeyi kullanır; ikinci bir günlük çalıştırma oluşturmaz. |
| Takvim gününün tamamen atlanması | O gün için çalıştırma yoktur. |
| Saatin geri alınması | Daha önce işlenen bir günü yeniden zamanı gelmiş saymaz. |
| Mevcut çalıştırma hâlâ bekliyor | Yeni günlük çalıştırmayı bununla çakıştırmaz. |

Oluşturulma zamanı da uygun günlük işleri sınırlar; yeni bir zamanlamayı başlatmak, var olmadan önceki tarihleri işleme izni değildir. Sunulduğunda **Şimdi çalıştır** ayrı bir manuel çalıştırma başlatır; günlük saatin yerini almaz veya bekleyen çalıştırmayı aşmaz. Gösterilen sonraki zaman bir hesaplamadır, tam o anda yürütme garantisi değildir.

**Takip edilen konuşmalar (isteğe bağlı)** seçili konuşmalardan sınırlı bağlam ekler. İşlenen mesaj imleçlerini yalnızca tamamlanan çalıştırma ilerletir; başarısız/kesintiye uğrayan çalıştırma bu bağlamı sessizce tüketmez. Talimatlar ve bağlam kapasiteyi aşarsa sınırsız geçmiş okunduğunu varsaymak yerine talimatları kısaltın veya takip edilen konuşmaları kaldırın.

## Çalışma ömrü ve hizmet yeniden başlatmaları {#lifetime}

| Bileşen | Kapatılması ne anlama gelir |
| --- | --- |
| CodeNomad proje sekmesi | Projeyi CodeNomad'de kapatır; yerel işler OpenCode'da devam eder ve projeyi yeniden açtığınızda konuşmalar bulunur. |
| Pencerenin tamamı, uygulamadan çıkış veya arayüzün yeniden yüklenmesi | Proje bağlantılarını geri yükleme için korur; OpenCode işlerini veya hizmetini durdurmaz. |
| CodeNomad arka ucu | OpenCode'u durdurmaz. Tek seferlik CodeNomad koordinasyonu arka ucun varlığına bağlıdır; kapalıyken yeni tek seferlik iş atama/kontrol olanaklarının kullanılabilir kalacağını varsaymayın. |
| Çalışan günlük zamanlama | Saat ve çalıştırma yürütmesi, CodeNomad arayüzü ve arka ucu kapalıyken de OpenCode eklentisinde/hizmetinde sürer. Yürütme ana bilgisayarı ve OpenCode hizmeti çalışır durumda kalmalıdır. |
| OpenCode hizmetinin yeniden başlatılması | Sürece bağlı zamanlama işleri kaybolur. Çalışması istenen zamanlama, açıkça **Sürdür** seçilene kadar **Kesintiye uğradı** durumuna geçer; CodeNomad'i yeniden açmak onu devreye almaz. |

Yeniden başlatmadan sonra bekleyen çalıştırmayı inceleyip hazır olduğunuzda **Sürdür** eylemini seçin. Sürdürme mevcut çalıştırmayı, koordinatör girdisini iki kez göndermeden uzlaştırır; kesilen OpenCode turunun devam edeceğini vaat etmez. Yeniden başlatmanın kestiği bir tur, **Yeniden başlatmayla kesildi** durumuyla raporsuz sonlanmış olarak sonuçlandırılabilir. Yeniden başlatmayı araçların yan etkilerini yeniden deneme yöntemi olarak kullanmayın.

Görevler masaüstü uygulamalarıyla ve bağımsız bir CodeNomad [sunucusuyla](server.md) çalışır. Panel **Görev Kontrolü kullanılamıyor** gösterdiğinde mesajı nedeni belirtir:

| Neden | Ne yapmalı |
| --- | --- |
| OpenCode çalışma alanı hazır değil | Projeyi yeniden bağlayın, ardından yenileyin. |
| OpenCode, Görevler eklentisini yüklemedi | Biraz sonra yenileyin; sorun sürerse **Ayarlar → OpenCode** içindeki **OpenCode yapılandırmasını yeniden yükle** eylemini kullanın. |
| OpenCode, Görevler eklentisini yükleyemedi | Hatasını Eklentiler listesinde okuyun, düzeltildikten sonra yenileyin. |
| CodeNomad sunucusu yerel Görevler bağlantısını (127.0.0.1) açamadı | Sunucu günlüğünü kontrol edin; OpenCode'u yeniden yüklemek işe yaramaz. |

## Duraklatma, durdurma ve belirsiz sonuçlar {#controls-recovery}

1. Kaydı seçip işlem yapmadan önce güncel durumunu ve konuşmasını inceleyin.
2. Sürdürülebilir bir bekletme için duraklatma simgesini; kalıcı durdurma için durdurma simgesini ve onayını kullanın. Tek seferlik işlerin ipuçları **Görevi duraklat** ve **Görevi kalıcı olarak durdur** şeklindedir; zamanlama ipuçları ilgili zamanlamayı adlandırır.
3. Sonuç doğrulanmadıysa mevcut sonucu okumak için **Durumu denetle** / **Kontrol durumunu denetle** eylemlerini kullanın. Belirsizliği aşmak için yeni bir ikame eylem göndermeyin.
4. Tek seferlik eylemlerde başlıktaki **Yenile ve onaylanmamış işlemi yeniden gönder**, önce durumu kontrol eder; yalnızca açık tıklamanız üzerine hâlâ doğrulanmamış aynı eylemi yeniden gönderir.

Tek seferlik Duraklat, görevin OpenCode konuşma ailesini kesintiye uğratıp koordinasyonu bekletir; Durdur ayrıca ailede sıradaki girdileri/teslimatları iptal eder ve kalıcıdır. Bunlar sınırlı işlemlerdir: **Bazı alt ajanlar hâlâ çalışıyor olabilir.** durdurmanın tamamlanmadığını gösterir. Tüm kabuk/araç etkilerinin iptal edildiğini varsaymak yerine korunan sonucu inceleyip açık yeniden deneme eylemini kullanın. Sürdürme, koordinatöre kesintiye uğrayan alt konuşmaları bildirir; işin nasıl devam edeceğine koordinatör karar vermelidir.

Günlük Duraklat/Durdur zamanlamayı iptal eder ve koordinatörle bağımsız uzmanlar dahil kayıtlı kök aktörlerin kesilmesini ister; ancak **bu konuşmaların veya alt konuşmalarının durduğunu kanıtlamaz**. OpenCode konuşma ailelerini inceleyin. Durdurma kalıcıdır: durdurulmuş zamanlama Başlat, Sürdür veya Şimdi çalıştır eylemlerini kullanamaz. **Çalıştırmayı denetle** bekleyen çalıştırmayı tekrar göndermeden uzlaştırır. Geçici zamanlanmış denetim hataları son hatayı gösterir ve otomatik yeniden denenir; kullanıcı kontrolüne ait yanıtın kaybolması kontrolün otomatik yeniden gönderilmesine yol açmaz.

Raporunu vermeden boşta kalan tek seferlik koordinatör için ana ▶ eylemi doğrulama ve kurtarma yapabilir; uygun görevlerde eksik rapora yönelik hedefli kurtarma bulunur. Kurtarma önce OpenCode etkinliğini, alt konuşmaları ve beklemeleri kontrol eder; etkinlik bilinmiyorsa girdiyi kabul etmez. Atamaları yeniden göndermez veya planı değiştirmez. Çözülmemiş sorular, izinler, kabuklar veya arka plan işleri için konuşmaları açın.

**Oluştur** sonucu doğrulanmadıysa pencere gönderilen isteği korur ve o proje için yeni oluşturmayı engeller; çalışma ağacının silinmesi de bekletilebilir. Yenileme yalnızca durumu okur. Düzenleyiciyi kapatıp açmak bunu düzeltmez. Pencereyi yeniden yüklemeden önce görev listesini inceleyin: yeniden yükleme yerel kilidi temizler, fakat **oluşturmanın başarısız olduğunun kanıtı değildir**. Yeniden yükleme veya yeniden başlatma sonrasında kontrol etmeden mükerrer görev oluşturmayın.

## Konuşmaları düzenleyin, silin ve temizleyin {#cleanup}

Düzenlenebilir tek seferlik görevde **Seçili görevi düzenle** eylemini kullanın; çakışma olursa üzerine yazmak yerine güncel revizyonu yüklemek için düzenleyiciyi kapatıp açın. Günlük zamanlamalarda düzenleme/silme kontrolleri yoktur.

1. Artık gerek duymadığınız tek seferlik görev için **Seçili görevi sil…** eylemini seçip onayı inceleyin.
2. Onaylamadan önce isteğe bağlı olarak **Bu görev için oluşturulan uzman konuşmalarını da sil** seçeneğini işaretleyin.
3. Kaldırılan/korunan/bekleyen sayılarını **Konuşma temizliği** bölümünde kontrol edin. Sunuluyorsa yalnızca kaydedilmiş, kalan temizliği yeniden deneyin.

Görevi silmek durdurmakla aynı şey değildir; önce Durdur'u kullanıp kalan işleri inceleyin. Koordinatörler ve yeniden kullanılan konuşmalar korunur. Paylaşılan, taşınan, alt konuşması bulunan veya sahipliği doğrulanamayan uzmanlar da korunabilir. Kısmi temizlik geri alınmaz ve arka planda sessizce tamamlanmaz. Tamamlanan temizlik geçmişi genel bakış okuyucusunda kullanılabilir kalır.

OpenCode işleri ve hizmet kontrolleri için [İzinler](permissions.md), [Konuşmalar](conversations.md) ve [OpenCode kurulumu](opencode.md) sayfalarına bakın.
