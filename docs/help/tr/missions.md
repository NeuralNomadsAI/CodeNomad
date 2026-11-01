# Görevler

Görevler, kalıcı bir proje planını OpenCode'un kendi konuşmalarıyla birleştirir. Koordinatör planı hazırlar ve işleri devreder; görev ağacı bağımlılıkları ve sonuçları kaydeder. Kaydedilmiş bir plan, kabul edilmiş bir girdi ve gözlemlenen yürütme birbirinden farklı olgulardır.

## Oluşturun, ardından açıkça başlatın {#create}

1. Sağ panelde **Görevler** bölümünü açıp **Görev oluştur** eylemini seçin. Form, oluşturana veya iptal edene kadar görev listesinin ve seçili görevin görev düğümlerinin yerini alır.
2. **Görev ne yapmalı?** alanını doldurun ve ilk cümleden otomatik doldurulan **Başlık** alanını kontrol edin (en fazla 60 karakter).
3. **Ne zaman** altında **Bir kez** veya **Her gün saat** seçeneğini belirleyin. Günlük işler için gösterilen saat dilimini doğrulayın; **Değiştir** ile bir IANA saat dilimi girebilirsiniz.
4. **Rehber**, **Notlar**, **Ajanlar ve modeller**, **Görev oturumları**, projenin **Alt oturum iç içe geçme derinliği** ayarı, kayıtlı özetler ve isteğe bağlı takip edilen konuşmalar için **Seçenekler** bölümünü genişletin. **İki modeli karşılaştır** seçildiğinde **Model A** ve **Model B** seçicileri ana formda görünür.
5. **Oluştur** eylemini seçin. Yeni kaydı seçip hazır olduğunuzda ayrı ▶ eylemini kullanın: tek seferlik işler için **Görevi başlat**, günlük zamanlama için **{id} zamanlamasını başlat**.

**Oluşturmak hiçbir zaman işi başlatmaz.** Tek seferlik görev hazırlanır; günlük zamanlama duraklatılmış durumdadır. Ne oluşturma ne de özeti kaydetme bir zamanlayıcıyı devreye alır. Oluşturma seçili proje/Location kapsamındadır ve istenen profillerle görev oturumu ilkesini sabitler. Doğrulama mesajları ilgili alanın yanındadır; hiçbir şey gönderilmediğini belirten bir ret durumunda taslak düzeltilebilmesi için korunur. Tek seferlik bir görevin koordinatörü sizin için takip işi gibi ayrı bir görev de hazırlayabilir: bu görev listede **Hazır** olarak görünür ve diğer her görev gibi yalnızca ▶ eylemiyle başlar.

Kayıtlı tek seferlik görevler yürütme kontrollerini, görev ağacını, konuşmalarını ve nihai raporlarını korur. Bunları doğrudan sürdürebilir veya tamamlayabilirsiniz. Kayıtlı günlük zamanlamalar mevcut kontrolleriyle listede kalır.

### İş akışı rehberleri {#playbooks}

**Rehber** seçicisinin hemen altında seçili rehberin tek cümlelik açıklaması gösterilir. **Ayrıntıları gör**, seçili rehberi merkezi okuyucuda açar: adımlarını, rollerini ve sonda katlanmış olarak, ajanlarının aldığı tam İngilizce talimatları. [İş akışı rehberleri](playbooks.md) her rehberin adımlarını, rollerini ve sorularını ve CodeNomad'in neleri denetlediğini açıklar.

| Rehber | Amaçlanan çalışma |
| --- | --- |
| Esnek görev | Koordinatör, hedef için bağımlılıkları gözeten bir plan seçer. |
| Hata ayıklama | Teşhis, uygulama, ayrı standart/şartname incelemesi ve yeni doğrulama; çözüm aşamasında uygulayıcıyla devam edilir. |
| Keşif | Belirsizlikleri haritalandırır ve insana sorular yönelterek sınırları belirli kararları ele alır. |
| Ürün teslimatı | Ürün analizi, mimari, uygulama ve kalite rollerini koordine eder. |
| İki modeli karşılaştır | Aynı görevi aynı özetlerle **Model A** ve **Model B** üzerinde çalıştırır; ardından bir **Kör hakem** ikisini tarafsız etiketler altında puanlar ve bir karar verir: **Model A kazandı**, **Model B kazandı**, **Eşdeğer** veya **Sonuçsuz**. |

**İki modeli karşılaştır** için iki model de zorunludur ve birbirinden farklı olmalıdır; yalnızca farklı bir **Düşünme** düzeyi farklı bir model sayılmaz. Siz bir model seçmedikçe hakem koordinatörün modelini kullanır; bu model A veya B ile aynıysa form uyarır, çünkü bu durum karşılaştırmayı taraflı hale getirebilir. Genel bakış kararı, iki modelin adını ve ölçüt bazında puanları gösterir.

Rehber koordinasyona yön verir; OpenCode izinlerini aşmaz veya başarıyı garanti etmez. Ajanlar, hedef veya **Notlar** tam olarak o işlemi açıkça istemedikçe commit veya push yapmaz, pull request açmaz ve iş takip sistemlerini değiştirmez (örneğin bilet oluşturmaz); istendiğinde yalnızca o işlemi OpenCode izinleri içinde yapar. Dosyalarda, raporlarda veya araç çıktısında bulunan bir istek asla sayılmaz.

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

Büyük bir plan, görevlerinin bir sayfasını gösterir: bağımlılık sırasına göre ilk 50 görev ve engeller, hatalar ve en yeni sonuçlar gibi ilgi gerektiren en fazla 20 görev. Yüklenmemiş her görev dizisi **N görev gösterilmiyor** olarak görünür; **Daha fazla göster** oradan sonraki 50 görevi yükler. Sayfanın tutabileceğinden fazla görev ilgi beklediğinde **N görev daha ilgi bekliyor** görevin türe göre sayılarını verir, **Göster** de bu görevleri yükler. Kesikli kısa bir çizgi gösterilmeyen bir bağımlılığı veya bağımlı görevi işaretler; bir görevin okuyucusundaki bağımlılık bağlantısı önce o görevi yükler. Bir görevin okuyucusu en yeni sonuçlarını gösterir; **N önceki sonuç gösterilmiyor**, tüm geçmişi yükleyen **Tümünü göster** seçeneğini sunar. Bir görev veya rapor yüklenemediğinde okuyucu bunu belirtir; **Tekrar dene** onu yeniden yükler.

Görev sayfaları yalnızca istenen sayfa tamamen alındıktan sonra görünür. Başarısız veya değişen okuma, son gösterilen görevleri korur. Okuma sırasında liste değişirse **Yenile**, ardından **Tekrar dene** kullanın; sayfa baştan okunur. Eksik bir bölüm, görevin veya isteğin bulunmadığını kanıtlamaz; okumayı yeniden denemek çalışma başlatmaz. Görevler eklentisi sayfayı sağlayamazsa yeniden bağlandıktan veya eklentiyi yeniden yükledikten sonra deneyin.

### Renkler ve kesintiye uğrayan görevler {#status-colours}

Görev işaretleri, görev düğümü simgeleri ve listenin oku oturum listesinin renklerini kullanır: renk yalnızca şu anda size ihtiyaç duyan şeyi gösterir.

| Renk | Anlamı |
| --- | --- |
| Kırmızı | Sizden bir yanıt bekleniyor; **Yanıtınız gerekiyor** altında listelenir. |
| Sarı, yanıp sönen | Çalışma sürüyor. |
| Turuncu | Görev duraklatıldı veya kesintiye uğradı; devam ettirmek için bir eylem var. |
| Yeşil | Bu pencerede henüz açmadığınız tamamlanmış bir görev; seçtiğiniz anda nötr olur. |
| Mavi | Hazırlanmış bir görev; yazılmış bir istem gibi başlatılmaya hazırdır. |

Geri kalan her şey nötrdür; tamamlanan ve başarısız görev düğümleri de: sonuçlar durum metninde ve simgelerde yer alır. Liste daraltılmışken oku, diğer görevler arasında kırmızı, sarı ve yeşilden en acil olanı alır; daraltılmış oturumlarda olduğu gibi turuncu ve mavi yalnızca kendi satırlarında görünür.

Koordinatörü sonuca varmadan durduğunda ve başka hiçbir şey çalışmıyorken bir görev **Kesintiye uğradı** olur. **Başarısız** olarak gösterilen bir görev de sürdürülebilir. İki durumda da araç çubuğunun ilk düğmesi **Kesintiye uğrayan görevi kurtar** olur: koordinatörden kayıtlı plan ve sonuçlara göre yeniden değerlendirme yapmasını ister ve başarısız bir görevi önce yeniden açar. Koordinatör tek seferlik bir görevi başarısız olarak bitirmez: sizsiz hiçbir şey ilerleyemediğinde **Yanıtınız gerekiyor** altında size bir soru sorar. Bir görevi yalnızca siz durdurursunuz.

### Sorular ve kararlar {#questions}

Size yalnızca koordinatör soru sorar. Görevler ve başlattıkları alt ajanlar açık sorularını seçenekler, kanıtlar ve bir öneriyle birlikte ona geri verir. Sormadan önce koordinatör soruyu kendisi çözmeye çalışır: projeyi okur, araştırır, bir göreve inceleme yaptırır veya kolayca geri alınabilen bir varsayılanı benimseyip varsayım olarak kaydeder. Yalnızca kendisinin çözemediği şeyleri sorar: onayınız, kimlik bilgileri, geri alınması pahalı seçimler veya hedefin açık bıraktığı ürün kararları. Bekleyen soruları **Yanıtınız gerekiyor** altında tek bir formda toplar ve ilgisiz işleri önce başlatır.

**Keşif** akışında karar görevleri bir özet hazırlar ve koordinatör her kararı sonuçlandırır: kanıt yeterli ve seçim kolayca geri alınabiliyorsa kendisi karar verir, soruyu sonrası için **Notlar** içinde tutar ya da size sorar. **Yerel alt ajanlar** ile karar görevinin sonucu kimin karar verdiğini gösterir:

| Etiket | Anlamı |
| --- | --- |
| **Koordinatör kararı** | Koordinatör size sormadan karar verdi; sonuç gerekçesini ve verdiyse geri alma yönergesini gösterir. Değiştirmek için **Konuşmayı aç** üzerinden koordinatöre yazın. |
| **Yanıtınız** | Bu soruyu CodeNomad'in istek panelinde siz yanıtladınız. |

Yalnızca istek panelinde verdiğiniz yanıt **Yanıtınız** sayılır; bir ajan sizin yerinize yanıt veremez. **Yerel alt ajanlar** ile her karar sorusu, sonuçlandırdığı tek kararın etiketiyle biter; örneğin `[decision choose-seam 3fa9c21b]`. Birkaç karar birlikte sorulduğunda her biri kendi etiketine sahip ayrı bir sorudur; iki kararı anan bir soru hiçbirini sonuçlandırmaz. **Bağımsız oturumlar** ile koordinatör bunun yerine her sonucu, kararı kendisinin mi sizin mi verdiğini belirterek **Notlar** içine kaydeder. **Ürün teslimi** akışında, davranış değişikliğini zaten kesin olarak tanımlayan bir hedef onaylanmış belirtim sayılır; aksi halde koordinatör bekleyen onayları toplayarak sizden onay ister.

### Durum özetleri ve güncelleme istekleri {#briefings}

Koordinatöre ilk plandan sonra, her görev sonuçlandırıldığında, insan yanıtı beklerken ve son rapordan önce bir proje durum özeti yayımlaması talimatı verilir. Bu, yazılmış bir değerlendirmedir; canlı etkinlik sayacı veya garantili periyodik yaşam sinyali değildir. Bir bildirim, durum özetinden sonra haritanın değiştiğini belirtir.

Yeni bir koordinatör değerlendirmesi için araç çubuğunun altındaki **Güncelleme iste** eylemini kullanıp **Özet** bölümünü okuyun. **Güncelleme istendi…**, isteğin beklediğini, henüz yanıtlanmadığını gösterir. **Gönderim doğrulanmadı** otomatik yeniden göndermeye izin vermez: ayrı bir yeni istekte bulunmadan önce koordinatör konuşmasını açın. Bu, salt okunur bir korumalı ortam değil, sıradan bir OpenCode girdisidir; koordinatör normal izinlerini korur.

## Bağlam bir görevde nasıl akar {#context-flow}

Görev haritası, görevin ortak ve kalıcı belleğidir. Hedefi ve **Notlar** bölümünü, her işi kendi **İş özeti**, bağımlılıkları (**… öğesine bağlı**) ve durumuyla, tamamlanan işler için kaydedilen **Raporlar** bölümünü (özet, **Kanıt**, **Önerilen sonraki adımlar** ve varsa **Yapılandırılmış rapor**), koordinatörün durum özetlerini ve **Plan değişiklikleri** bölümünü içerir. OpenCode haritayı projeyle birlikte saklar; bu nedenle harita konuşmalardan ve yeniden başlatmalardan sonra da kalır. Görev Kontrolü onu gösterir ve kurtarma ondan devam eder. Her katılımcı onun belirli bir bölümünü alır:

| Katılımcı | Ne alır |
| --- | --- |
| Koordinatör | Her turda hedefi, notları ve rehber talimatlarını. Gerektiğinde haritanın tamamını okur; saklanan konuşması okuduğu her sonucu tutar, ancak OpenCode model bağlamını [sıkıştırabilir](history.md#compact-session). |
| İş (**Yerel alt ajanlar**) | Koordinatörün sıradan bir OpenCode alt ajan çağrısında ilettiği atamasını: hedef, işin başlığı ve özeti, rolünün talimatları ve bağlı olduğu işler. Koordinatör yanına önceki sonuçlar gibi bağlam ekleyebilir. |
| İş (**Bağımsız oturumlar**) | Aynı atamayı kendi konuşmasında bir mesaj olarak. Her turda ayrıca hedefi, notları ve açık atamalarını alır ve haritanın tamamını okuyabilir. |
| Bir işin başlattığı yardımcılar | Üst konuşmalarının çağrıya yazdıklarını. Rehberler her üst konuşmaya, yardımcılarının ihtiyaç duyduğu kapsamı, kısıtları ve güvenlik kurallarını iletmesini söyler. |

Sonuçlar aynı yoldan geri döner. Yerel alt ajan sonucunu kendisini başlatan konuşmaya, genellikle koordinatöre döndürür; koordinatör bunu işin raporu olarak kaydeder. Bağımsız oturum kendi raporunu kaydeder ve CodeNomad bu raporun özetini koordinatöre mesaj olarak iletir.

Sonraki bir iş, önceki çalışmaya iki yolla dayanır. Bağımlılıklar çalışmanın sırasını belirler: koordinatör bir işi, bağlı olduğu işler tamamlandığında başlatır ve ilgili sonuçları özete ya da atamanın yanına koyar; bağımsız oturumlar bu raporları haritada da okuyabilir. Tamamlanmış bir işin kendi konuşmasını sürdürmek için koordinatör, o konuşmayı yeniden kullanan bir devam işi bildirir: devam işi orada, OpenCode'un [sıkıştırmış](history.md#compact-session) olabileceği o konuşmanın güncel bağlamıyla sürer; daha önceki ayrıntılar arama için saklanan geçmişte kalır. Hata ayıklama rehberi iki incelemeyi de uygulayıcıya bu şekilde geri verir. **Bağımsız oturumlar** ile koordinatör bir işi mevcut bir ana konuşmaya da atayabilir; bu konuşma, ilgisiz önceki çalışmalar dahil kendi bağlamını korur. Aksi halde iş kendi atamasıyla yeni bir konuşmada başlar ve başka bir işin konuşma dökümü ona koordinatör ya da bir arama aracılığıyla ulaşır. **İki modeli karşılaştır** rehberinde hakemin ataması ve bağlamı hedefi ve notları içermez; özeti anonimleştirilmiş çıktıları taşır.

Günlük bir zamanlamada her çalıştırma kendi koordinatörü ve haritasıyla başlar. İlk mesajı, zamanlamanın talimatlarını ve son tamamlanan çalıştırmadan bu yana [takip edilen konuşmalarına](#daily-schedules) eklenen yeni kullanıcı ve asistan metnini içerir; önceki çalıştırmaların sonuçları zamanlamanın geçmişinde kalır. Bir çalıştırma içinde başlatılan konuşmalar o çalıştırmanın haritasını okuyabilir. Yeni bir tek seferlik görev de yeni bir haritayla başlar: sonuçları aktarmak için onları hedefine veya **Notlar** bölümüne yazın ya da koordinatörün, hedefini ve notlarını kendisinin yazdığı bir devam görevi hazırlamasına izin verin.

### Önceki konuşmalarda arayın {#context-search}

CodeNomad çalıştığı sürece projedeki her ajan konuşması, görev koordinatörleri ve işler dahil, CodeNomad'in oturum arama aracına (`codenomad.session_search`, OpenCode'un Code Mode özelliği üzerinden kullanılır) sahiptir. Araç, konuşmanın proje klasöründeki kayıtlı konuşmalarda **Tüm çalışma alanı** [aramasıyla](history.md#full-history-search) aynı sıralamayla arar ve her konuşmanın başlığı ve kimliğiyle kısa alıntılar, ayrıca bir konuşmanın tamamını okumanın yolunu döndürür. OpenCode araç izinleri geçerlidir. Ajan, kendisi karar verdiğinde veya hedef, notlar ya da mesajınız bunu istediğinde arar; örneğin önceki bir görevin veya işin vardığı sonucu bulmak için. CodeNomad kapalıyken yürüyen günlük bir çalıştırma bu araç olmadan çalışır.

## Profiller, iş devri ve derinlik {#profiles}

Derinliği kaydetmek, proje yapılandırmasında etkin yerel zamanlamaları korur. Projedeki açık bir `schedules:false` kapalı kalır; derinliği kaldırmak zamanlama ayarını korur. Yerel ayarlar kaydedilmeden önce aynı katmandaki JSON ve JSONC dosyalarının çakışması giderilmelidir.

1. **Yeni görev varsayılanları** ayarını düzenlemek için Görevler dişli simgesini veya **Ayarlar → Görevler** yolunu kullanın.
2. **Uygulanacak kapsam** altında **Tüm görevler** veya bir rehber seçin; ardından **Görev oturumları** ayarını ve **Ajanlar ve modeller** altında her rol için bir satırı (önce koordinatör, sonra rehberin rolleri) belirleyin. Her seçim hemen kaydedilir; Kaydet düğmesi yoktur.
3. Bir rehber kapsamında satırlar, **Genel** olarak işaretlenmiş genel değerleri gösterir. Bir alanı değiştirmek o rolü bu değerlerden başlayarak özelleştirir; geri alma simgesi yeniden genel değerleri kullanır. **Sıfırla** (onaydan sonra) yalnızca gösterilen kapsamın ajanlarını ve modellerini temizler.
4. Oluşturma sırasında belirli profiller istemek için **Seçenekler → Ajanlar ve modeller** yolunu kullanın; **Kaydedilmiş varsayılanları kullan** kayıtlı olanları geri getirir.
5. OpenCode'un özyineleme sınırları için **Alt oturum iç içe geçme derinliği → Proje için belirlenen derinlik** alanını burada veya oluşturma sırasında **Seçenekler** altında düzenleyin. Enter'a basmak veya alandan çıkmak, değişmiş geçerli bir değeri kaydeder; **Devral** hemen kaydeder; Escape kaydedilmemiş bir değeri atar.

| Ayar | Kapsam ve etki |
| --- | --- |
| Yeni görev varsayılanları | Yapılandırma genelinde yalnızca **yeni** görevleri etkileyen varsayılanlar; rehber istisnası genel varsayılanı geçersiz kılar. |
| Ajan / Model / Düşünme | Oluşturmayla kaydedilen koordinatör/rol tercihleri; meşgul bir aktör sonraki işlere uyması için sessizce değiştirilmez. Günlük çalıştırmalar sabitlenmiş profil tercihlerini yeniden kullanır. |
| OpenCode alt ajanları | Görev oturumları koordinatörün altında subagent/all ajanlarını kullanır. |
| Bağımsız oturumlar | Bildirilen görev oturumları primary/all ajanlarını ve bağımsız konuşmaları kullanır; bu, dahili OpenCode yardımcılarını devre dışı bırakmaz. |
| Alt oturum iç içe geçme derinliği | Yalnızca Görevler için değil, oradaki **tüm** OpenCode konuşmaları için proje yapılandırması. Boş bırakılırsa devralınır: **Devral**, proje geçersiz kılmasını ve boş bıraktığı ya da yalnızca genel **Görselleri bir kez sakla** değerini içeren `experimental` bloğunu kaldırır. OpenCode projenin `experimental` bloğunu bir bütün olarak okur; bu nedenle orada tutulan diğer deneysel ayarlar genel derinliği gizlemeye devam eder. OpenCode'un yerleşik **General** alt ajanı varsayılan olarak alt ajan başlatamaz, bu yüzden konuşmaları hiç iç içe geçmez: herhangi bir proje derinliğini kaydetmek, alt ajanların o derinliğe kadar kendi alt ajanlarını başlatmasına izin veren ve diğer yapılandırma dosyalarındaki General kısıtlamalarından öncelikli olan bir kuralı da aynı dosyaya ekler (1 derinliğinde OpenCode'un derinlik sınırı iç içe geçmeyi yine engeller); **Devral** onu kaldırır. **Etkin OpenCode derinliği** altında düzenleyici, General alt ajanlarının iç içe geçip geçemeyeceğini belirtir. Proje General'ı eski biçimde tek bir `permission` değeriyle ya da hem `task` hem `subagent` zaten ayarlanmış olarak tanımlıyorsa yalnızca derinlik kaydedilir ve düzenleyici bunu belirtir: General için alt ajanlara o dosyada kendiniz izin verin. Kaydetme OpenCode'u yeniden yüklemez veya çalışan konuşmaları değiştirmez. |

**Yerel varsayılan** ile **Genel** farklıdır: ilki OpenCode'un kendi varsayılanlarını ister, ikincisi genel seçimi devralır; bir rehber kapsamında yerel varsayılanları seçmek açık bir istisna olarak kalır. Katalog kullanılabilirliği kontrol edilir; istenen profil, bir konuşmanın o anda kullandığı profilin kanıtı değildir. Her iki görev modunda da dahili yardımcı çağrılarını OpenCode izinleri ve yapılandırılmış derinlik yönetir.

Her **Model** listesi, konuşmanın **Model** seçicisinin gösterdiklerini aynı adlarla ve sağlayıcıya göre gruplanmış olarak gösterir: gizlenen modeller yer almaz ve yalnızca favorilere yönelik filtreleme açıkken diğer modeller de yer almaz (bkz. [Model görünürlüğü, favoriler ve Düşünme](providers.md#models)). Araç desteği olmayan modeller de yer almaz. Liste dışındaki kayıtlı bir model seçili kalır. **Kullanılamıyor**, seçicinin şu anda sunamadığı kayıtlı bir modeli işaretler: model projenin güncel kataloğunda yoktur, kullanımdan kaldırılmıştır veya araç desteği yoktur.

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

Yerel bir zamanlamada **Teknik ayrıntılar** bölümünü genişleterek **Ana taşıyıcı** ve **Uzlaştırma taşıyıcısı** bilgilerini, bunların yerel takvimlerini ve varsa **Temizlik uzlaştırma bekliyor** durumunu görebilirsiniz. Bu teknik konuşmalarda mesaj yazma eylemi bulunmaz ve bunlar olağan konuşma ve kaynak seçicilerinde görünmez. Teknik uyanmalar, başlıklar ve bağlam sıkıştırma, sağlayıcılara HTTP isteği göndermeden yerel modeli kullanır; yerel olaylar ve istatistikler bunları yine de içerebilir, ancak gerçek geçişlerin olağan model maliyetleri korunur. Bağlam sıkıştırma, konuşma ve takvim kimliğini koruyarak işlenen bağlamı sınırlar. Saklanan yerel mesajlar ve olaylar, tamamlanmış bir zamanlama açıkça temizlenene kadar birikebilir; saklanan 30 Mission sonucu ayrıdır. Derinlik denetimi ve **Zamanlama**, **Geçerli deneysel blok** belgesini gösterir; derinlik denetimi **Projenin yazma hedefi** bilgisini ayrıca belirtir.

| Bileşen | Kapatılması ne anlama gelir |
| --- | --- |
| CodeNomad proje sekmesi | Projeyi CodeNomad'de kapatır; yerel işler OpenCode'da devam eder ve projeyi yeniden açtığınızda konuşmalar bulunur. |
| Pencerenin tamamı, uygulamadan çıkış veya arayüzün yeniden yüklenmesi | Proje bağlantılarını geri yükleme için korur; OpenCode işlerini veya hizmetini durdurmaz. |
| CodeNomad arka ucu | OpenCode'u durdurmaz. Çalışan tek seferlik bir görev sürer: koordinatörü, OpenCode alt ajanı olarak yürüyen görevleri ve görev araçları OpenCode içinde çalışır. Bağımsız oturumlara görev atama ve raporlarını koordinatöre iletme, koordinatörün hazırladığı görevler, plandan çıkarılan bir görevin konuşmalarını durdurma, kurtarma ve Görev Kontrolü arka ucu bekler; OpenCode hizmetinin yeniden başlatılmasından sonra tek seferlik bir görevi sürdürmek de öyle. |
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

Tek seferlik Duraklat devam eden işin bitmesine izin verir: koordinatör ve alt ajanları bulundukları adımı tamamlar, yeni bir şey başlatmaz ve durur; bu sırada panelde şu görünür: **Duraklatılıyor: devam eden adımlar tamamlanıyor.** **Şimdi kes** ise onları hemen durdurur: görevin OpenCode konuşma ailesini kesintiye uğratıp koordinasyonu bekletir. Durdur da kesintiye uğratır, ailede sıradaki girdileri/teslimatları iptal eder ve kalıcıdır. Kesintiler sınırlı işlemlerdir: **Bazı alt ajanlar hâlâ çalışıyor olabilir.** birinin tamamlanmadığını gösterir. Tüm kabuk/araç etkilerinin iptal edildiğini varsaymak yerine korunan sonucu inceleyip açık yeniden deneme eylemini kullanın. Sürdürme, koordinatöre neyin duraklatıldığını veya kesildiğini bildirir; işin nasıl devam edeceğine koordinatör karar verir.

Günlük Duraklat/Durdur zamanlamayı iptal eder ve koordinatörle bağımsız uzmanlar dahil kayıtlı kök aktörlerin kesilmesini ister; ancak **bu konuşmaların veya alt konuşmalarının durduğunu kanıtlamaz**. OpenCode konuşma ailelerini inceleyin. Durdurma kalıcıdır: durdurulmuş zamanlama Başlat, Sürdür veya Şimdi çalıştır eylemlerini kullanamaz. **Çalıştırmayı denetle** bekleyen çalıştırmayı tekrar göndermeden uzlaştırır. Geçici zamanlanmış denetim hataları son hatayı gösterir ve otomatik yeniden denenir; kullanıcı kontrolüne ait yanıtın kaybolması kontrolün otomatik yeniden gönderilmesine yol açmaz.

Raporunu vermeden boşta kalan tek seferlik koordinatör için ana ▶ eylemi doğrulama ve kurtarma yapabilir; uygun görevlerde eksik rapora yönelik hedefli kurtarma bulunur. Kurtarma önce OpenCode etkinliğini, alt konuşmaları ve beklemeleri kontrol eder; etkinlik bilinmiyorsa girdiyi kabul etmez. Atamaları yeniden göndermez veya planı değiştirmez. Çözülmemiş sorular, izinler, kabuklar veya arka plan işleri için konuşmaları açın.

**Oluştur** sonucu doğrulanmadıysa pencere gönderilen isteği korur ve o proje için yeni oluşturmayı engeller; çalışma ağacının silinmesi de bekletilebilir. Yenileme yalnızca durumu okur. Düzenleyiciyi kapatıp açmak bunu düzeltmez. Pencereyi yeniden yüklemeden önce görev listesini inceleyin: yeniden yükleme yerel kilidi temizler, fakat **oluşturmanın başarısız olduğunun kanıtı değildir**. Yeniden yükleme veya yeniden başlatma sonrasında kontrol etmeden mükerrer görev oluşturmayın.

## Konuşmaları düzenleyin, silin ve temizleyin {#cleanup}

Form hâlâ yüklenirken amaç veya notlar değişirse, form bunları doldurmak yerine görevin siz açtıktan sonra değiştiğini belirtir; güncel sürümü düzenlemek için **Yeniden aç** seçeneğini kullanın.

Kabul edilmiş zamanlanmış geçiş sırasında talimat ve not düzenlemeleri geçişin geçmişine ve gelecek geçişlerin ayarlarına kaydedilir. İş açıklamaları, profiller ve yürütme kimlikleri korunur. Oluştur ve Düzenle aynı takvim doğrulamasını kullanır; önizleme, düzenlenen son izinli zamanı gecikmiş olsa bile kayıtlı sonraki uyanışa uygular.

Yerel dal kaynağı worktree bulunmayan dalları da içerir ve yalnızca yerel referansları okur. Seçici en fazla 200 yerel dalı destekler; daha büyük listelerde kaynak kullanılamaz olarak gösterilir. Etkinleştirme mümkün olduğunda **Başlat** ve **Sürdür** tam yapılandırma yollarıyla onay ister. Yerel zamanlama etkin değilken **Şimdi çalıştır** bir açıklamayla devre dışı kalır; OpenCode yapılandırmasında `experimental.schedules` ayarını etkinleştirip yenileyin. Etkinleştirme yanıtı kaybolursa sonuç denetimi için özgün istek korunur.

İlk Play öncesinde **Seçenekler** altındaki takip edilen konuşmaları koruyarak anlık ve koşulsuz başlatmaya dönebilirsiniz. Play, tamamlanmış ve kararlı mesaj önekini okuyup sabitler (kaynak başına en fazla 32 mesaj, toplam başlatma girdisi 16.384 karakter içinde). Eksik, taşınmış veya kapasiteyi aşan kaynaklar açıklamayla başlatmayı engeller. Yeniden deneme, özgün sabit bağlamı ve başlatma kimliğini korur.

Makbuz okuması kısmi hazırlığı doğruladığında **Tekrar dene** görünür. Tıklama aynı makbuzu yeniden denetler ve yalnızca ilk kaydedilen değişikliği sürdürür; görev duraklatılmış kalır.

Yeni hazırlanmış bir görevin ilk başlatılmasından önce başlık, talimatlar, notlar, çalışma kitabı, istenen ajan/model/düşünme, görev oturumu modu ve **Zamanlama** düzenlenebilir. Aynı Görevi koruyarak anlık, gecikmeli, yinelenen ve koşullu başlatmalar arasında geçiş yapabilirsiniz. Kaydetme görevi duraklatılmış tutar ve yeni, boş bir koordinatör hazırlar; ilk konuşma korunur. Yalnızca Play işi başlatır veya zamanlamayı etkinleştirir. Başlatmadan sonra talimatlar ve notlar etkin görevin düzenleme kurallarına uyar. Kaydetme onaylanmazsa **Kayıtlı isteği yenile** ilk sonucu okur; kısmi hazırlık başlatmayı, metin düzenlemeyi ve silmeyi engellediği sürece aynı isteği koruyun.

Düzenlenebilir tek seferlik görevde **Seçili görevi düzenle** eylemini kullanın. Kilitli hazırlık alanlarının yanındaki açıklamaları okuyun. Revizyon çakışmasında **Güncel yapılandırmayı yeniden yükle** eylemini seçin, ardından yeniden kaydetmeden önce korunan taslağınızı incelemek için **Karşılaştırma için önceki taslak** bölümünü açın. Kaydedilmiş günlük zamanlamalar kendi araç çubuklarındaki kontrolleri kullanır.

1. Artık gerek duymadığınız tek seferlik görev için **Seçili görevi sil…** eylemini seçip onayı inceleyin.
2. Onaylamadan önce isteğe bağlı olarak **Bu görev için oluşturulan uzman konuşmalarını da sil** seçeneğini işaretleyin.
3. Kaldırılan/korunan/bekleyen sayılarını **Konuşma temizliği** bölümünde kontrol edin. Sunuluyorsa yalnızca kaydedilmiş, kalan temizliği yeniden deneyin.

Görevi silmek durdurmakla aynı şey değildir; önce Durdur'u kullanıp kalan işleri inceleyin. Koordinatörler ve yeniden kullanılan konuşmalar korunur. Paylaşılan, taşınan, alt konuşması bulunan veya sahipliği doğrulanamayan uzmanlar da korunabilir. Kısmi temizlik geri alınmaz ve arka planda sessizce tamamlanmaz. Konuşma temizliği 0 bekleyen gösterse bile silme doğrulaması beklenirken görev kartı kaybolabilir. Silme doğrulanana kadar özgün **Tekrar dene** eylemini kullanmaya devam edin; aynı silme isteği ve seçenekler korunur. Genel bakış okuyucusu tamamlanan en son 20 temizliği tutar. Görevleri silmek projedeki depolama alanlarını boşaltır: daha eski silinmiş görevler otomatik olarak temizlenir.

OpenCode işleri ve hizmet kontrolleri için [İzinler](permissions.md), [Konuşmalar](conversations.md) ve [OpenCode kurulumu](opencode.md) sayfalarına bakın.
