# Görevler

Bir Görev; hedefi, koordinatör konuşmasını, işleri ve sonuçlarını birlikte tutar. Sağ panelde **Görevler** bölümünü açın.

Görevler kullanılamıyorsa **OpenCode ayarları**, eksik veya başarısız bir eklenti için hizmet kurtarmayı açar. Sunucunun yerel Görevler köprüsü kullanılamıyorsa **Sunucu tanılaması**, Ayarlar → Bilgi bölümündeki tanılama raporunu açar.

## Görevleri gösterme veya gizleme {#activation}

**Sağ paneli özelleştir** menüsünde **Görevler** kutusunu işaretleyerek sekmeyi gösterin veya işareti kaldırıp onaylayarak gizleyin. Bu işlem, bağlı OpenCode sunucusunun genel yapılandırmasına `codenomad.missions` ya da `-codenomad.missions` kuralını da yazar. Proje kuralları genel kuralın önüne geçebilir. Kapatma hiçbir şeyi silmez veya duraklatmaz, ancak zamanlanan çalıştırmalar atlanabilir. Yazma başarısız olursa sekme için seçtiğiniz görünürlük korunur. **Sıfırla** yalnızca düzeni değiştirir. **Durum → Eklentiler** bu tam eşleşen genel devre dışı bırakma kuralı için uyarı göstermez; diğer durumlarda **Yeniden etkinleştir** kullanılabilir.

## Görev oluşturma {#create}

Uzak bağlantılar aynı formu ve kontrolleri kullanır. Ağ trafiğini korumak için HTTPS tercih edin.

**Görev oluştur**, oluşturana veya iptal edene kadar ağacın yerine formu gösterir. Oluşturma doğrulanınca görev seçilir; reddedilince form düzenlenebilir kalır.

Alt ajan veya zamanlanmış çalıştırma dahil, projenin herhangi bir konuşmasındaki ajandan ayrı, tek seferlik veya zamanlanmış bir Görev hazırlamasını isteyin. Konuşması değişmez; varsayılan olarak yeni bir koordinatör konuşması oluşturulur. İlgili CodeNomad arka ucunu kullanılabilir tutun. **Otomatik başlat**, yeni Görevin ilk başlatılmasına izin verir; kurtarma özgün sonucu okur. Ajanlar, düzenleyicide oluşturduklarınız dahil projenin tüm zamanlamalarını listeleyebilir, inceleyebilir, başlatabilir, duraklatabilir, durdurabilir, sürdürebilir, şimdi çalıştırabilir, kontrol edebilir, düzenleyebilir ve silebilir. Aynı revizyon ve kabul kontrolleri uygulanır; zamanlamanın açıkça kapatılması korunur. Doğrulanmamış işlem, salt okunur durum sorgusu için özgün isteğini saklar.

### Yapılandırma {#saved-briefs}

Ajanlar, projeye ait her konuşmadan sizin oluşturduklarınız dahil tüm Görevleri okuyabilir. Salt okunur görünümler işleri, sonuçları, temizliği, zamanlanmış çalıştırmaları ve kaynak seçeneklerini kapsar; görüntülemek işi başlatmaz veya yeniden denemez.

Ajanlar ayrıca zamanlamayı tanılayabilir, açık OFF durumunu koruyarak ayarları hazırlayabilir ve doğrulanmış kısmi düzenlemeyi özgün istekle sürdürebilir.

**Yapılandırma**, kayıtlı hedefi, notları, rehberi, profilleri ve görev oturumlarını yükler; adı düzenlenebilir başlık olur. Alanları kontrol edin.

Ajanlar yapılandırmaları okuyabilir, kaydedebilir, değiştirebilir veya yeniden adlandırabilir, kaldırabilir ve onarabilir; mevcut bir Görevin talimatlarını da kaydedebilir. Ayrıca genel veya rehbere özel profil ve görev oturumu varsayılanlarını değiştirebilir, devralmayı geri getirebilir, geçersiz tercihleri sıfırlayabilir ve görev konuşmalarını silme tercihini değiştirebilir. Kitaplık ve bu tercihler CodeNomad profilinin tüm projelerinde geçerlidir. Projenin alt ajan derinliği, boş yapılandırma bloğunun onarımı dahil 1–10 veya **Devral** seçeneğini destekler. Her değişiklik son okunan değeri denetler ve sonradan yapılan insan düzenlemelerini korur.

Altta İptal ve Oluştur yanındaki **Yapılandırmayı kaydet**, yeniden kullanılabilir bir yapılandırma saklar; Görev oluşturmaz veya başlatmaz. Zamanlama ve otomatik başlatma ayrı seçilir. Dişli, Tercihler ve kitaplığı açar; yapılandırmayı silmek mevcut görevleri ve konuşmaları korur.

Kayıtlı bir yapılandırmayı değiştirmek için adını kullanıp **Değiştir**’i seçin. Aynı adı taşıyan birden fazla yapılandırma varsa önce değiştirmek istediğinizi yükleyin. Kitaplıkta yer olduğu sürece yeni ad ayrı bir kopya kaydeder.

### Hedef, Başlık ve Notlar {#mission-instructions}

Tek seferlik Missions için ajanlar başlatabilir, sürdürebilir, mevcut adımdan sonra duraklatabilir, hemen kesebilir, durdurabilir, düzenleyebilir, silebilir, hata sonrası koordinasyonu sürdürebilir ve eksik rapor veya güncelleme isteyebilir. Sizin oluşturduğunuz Missions da panelle aynı kabul ve revizyon kontrollerine tabidir. Açıkça başka bir seçenek belirtilmedikçe silme işlemi, yönetilen oturumları silme tercihinizi kullanır. Onaylanmamış kontroller ve temizlik özgün kimliklerini korur; ajanlar, doğrulanmış kısmi bir işlemi açıkça sürdürmeden önce kayıtlı durumu okur.

**Hedef**, istenen sonucu ve doğrulamasını anlatır. **Başlık**, ağaçtaki addır; boş görevde hedefin ilk cümlesinden en çok 60 karakter alır ve değiştirilebilir. **Notlar**, ajanlara iletilen isteğe bağlı bağlam, kısıtlar veya ek talimatlardır.

### Seçenekler ve rehber {#playbooks}

**Rehber**, koordinatörün çalışma yöntemini seçer; roller ve aşamalar [Rehberler](playbooks.md) sayfasındadır. Yerel izinler geçerlidir. Commit, push, pull request ve iş takip sistemi değişiklikleri için Hedef veya Notlar içinde o eylem açıkça istenmelidir.

### Yetkilendirme ve derinlik {#profiles}

**Görev oturumları**, koordinatör altında yerel alt ajanları veya bağımsız oturumları seçer. İkisi de OpenCode izinlerine ve iç içe geçme sınırlarına tabidir.

**Alt ajan derinliği**, projenin tüm OpenCode konuşmalarını etkiler. **Devral** veya 1–10 seçimi hemen kaydedilir. Etkin derinlik ve izinler gözlenen yapılandırmaya bağlıdır.

Alt ajan derinliği bilgileri etkin kaynağı **OpenCode yapılandırma dosyası:** altında gösterir.

Proje derinliği kaydetmek, alt ajanların bu derinlikte kendi işlerini devretmesine de izin verir ve desteklenen diğer dosya General kısıtlamalarından öncelikli olur. **Devral** eklenen kuralı kaldırır. Kaydetmek OpenCode'u yeniden yüklemez ve çalışan konuşmaları değiştirmez.

### Ajanlar ve modeller {#agents-models}

**Ajanlar ve modeller** altında rol başına Ajan / Model / Düşünme satırı bulunur. Kapalıyken özet istenen seçimleri gösterir. Başlangıç değerleri Tercihlerden gelir; burada yapılan değişiklikler bu Görev içindir.

Dişli, tüm görevlerin veya bir rehberin varsayılanlarını açar; Tercihler her değişikliği hemen kaydeder. Model listeleri konuşma seçicisinin görünürlük ve favorilerini izler. Liste dışındaki kayıtlı seçim korunur.

**İki modeli karşılaştır**, A ve B için farklı modeller gerektirir; yalnızca Düşünme farkı yetmez. Hakem ayrıca seçilmezse koordinatörün modelini kullanır. A veya B'nin hakem olması yanlılık yaratabilir.

Takvim tabanlı zamanlama, koordinatör ve rehberin her rolü için açık bir ajan ve model gerektirir.

### Otomatik başlat {#automatic-start}

**Otomatik başlat**, Zamanlama dışındadır ve varsayılan olarak kapalıdır. Kapalıyken görev duraklatılmış oluşturulur ve daha sonra ▶ ile başlatılır. Açıkken oluşturma doğrulanınca olağan kontroller ve otomatik zamanlama hazırlığıyla başlatma istenir.

### Koordinatörü /goal ile etkin tut {#coordinator-goal}

**Koordinatörü /goal ile etkin tut** tek seferlik Görevler için kullanılabilir ve varsayılan olarak kapalıdır. Etkinleştirildiğinde Görev başlatılınca koordinatörde OpenCode `/goal` devreye girer; Görevi duraklatmak ve sürdürmek bu hedefi de duraklatır ve sürdürür, bitirmek veya durdurmak ise temizler. Görev çalışırken OpenCode yeniden başlatılırsa, Görevler yeniden başlatma nedeniyle duraklatılan hedefi otomatik olarak sürdürür (OpenCode otomasyonları etkinse CodeNomad kapalıyken bile); manuel, duraklama veya tur sınırı duraklatmalarına dokunulmaz. Canlı durum ve denetimler Görev özetinde görünür.

## Zamanlama {#daily-schedules}

Yinelenen bir zamanlaması veya olayı olan görev listede tek satır olarak kalır: her başlatma, aynı koordinatör konuşmasında öncekinin yerini alır ve önceki hâlâ etkinken bekler. Ayrıntısında **Şu durumda başlat**, **İstenen durum**, sonraki uyanma veya denetim, **Başlatılan geçişler** ve **Önceki çalıştırmalar** (son 20 başlatma) görünür. **Otomatik başlat** kapalıyken duraklatılmış olarak oluşturulur. **Seçili görevi düzenle** oluşturma formunu yeniden açar ve sonraki başlatma kaydettiğinizi kullanır. **Seçili görevi sil…** önce zamanlamasını kaldırır. Araç çubuğundaki ⏸ onu bütünüyle, çalışan başlatmayı ve zamanlamasını duraklatır; ▶ ikisini de sürdürür. ■ çalışan başlatmayı durdurur; hiçbir şey çalışmıyorken zamanlamayı kalıcı olarak durdurur ve görevi listede bırakır.

### Ölçütler {#native-scheduling}

**i** düğmesi [zamanlama yardımını](missions.md#native-scheduling) açar.

İlk ölçüt **Bir kez, şimdi** olur. **Ölçüt ekle** bir tane daha ekler. Türünü seçin, × ile kaldırın, tutamacıyla sıralayın; odaklı tutamaçta Alt+Yukarı/Aşağı kullanabilirsiniz.

Bir kez şimdi, N saatte bir, günlük, haftanın günleri, ayın günü ve cron seçenekleri vardır. Kayıtlı saat dilimi kullanılır; sistemden farklıysa dilim alanı görünür. Seçilen günün bulunmadığı ay atlanır. Bir kez şimdi, zamanı Başlat'ta alır; koşul bu tek fırsatı çalıştırmadan tüketebilir. OpenCode hizmeti ve yürütme makinesi kullanılabilir olmalıdır.

Başlatma veya sürdürme sırasında zamanlama projenin OpenCode yapılandırmasında otomatik hazırlanır.

### Olaylar ve birleşimler {#scheduling-conditions}

**Depo etkinliği → Olay** seçin, ardından aynı karttaki isteğe bağlı filtreleri kullanın. Git commit’leri, otomatik algılanan GitHub, GitLab veya Gitea deposunun olaylarıyla aynı menüdedir. Algılama Contribute ile ortaktır: önce `upstream`, sonra `origin`. Üçü de yeni ve birleştirilmiş PR/MR ile yeni issue olaylarını ve `dependabot[bot]` dahil isteğe bağlı **Yazar** filtresini destekler. Olay seçimi depoyu sabitler; kayıtlı ölçütler hedeflerini korur.

Kontroller OpenCode makinesindeki `gh`, `glab` veya `tea` kullanır, CodeNomad kapalıyken de çalışır; herkese açık depolar anonim okunabilir. Kendi sunucunuz için o sunucuya bağlı CLI gerekir. **github.com**, oturum açmış `gh` ile hesap bildirimleri ve Dependabot uyarıları da sunar; [bildirim](https://docs.github.com/en/rest/activity/notifications) veya [uyarı okuma](https://docs.github.com/en/rest/dependabot/alerts) erişimi gerekir. Okunma durumu korunur; düzeltilen veya kapatılan uyarılar da kapsanır. **GitHub deposu** boş kayıtlı bildirimler hesabı kapsar. İlk başlatma referansı belirler.

Olaylar; yerel commitleri, yeni mesajları veya açık proje dosyalarını izler. Kaynağı ilgili ölçütün içinde seçin. Arama, aksanlı harfler dâhil büyük ve küçük harfleri ayırt etmez. Arama sırasında sayfada eşleşme olsa bile seçicide **Daha fazla kaynak yükle** ile devam edin. Yeni mesajlar için seçilen konuşma geçişe bağlam da sağlar. Ölçüt türünü değiştirmek kaynağını temizler. Düzenleme, kayıtlı konuşma bağlamını korur.

**veya**, bitişik zamanları veya olayları birleştirir. **eğer**, zamanlardan sonraki olayları koşul yapar: son başarılı geçişten beri biri değişmiş olmalıdır.

Baştaki tetikleyiciler 15 dakikada bir kontrol edilir. İlk Başlat referansı kurar; başarı ilerletir, başarısızlık korur. Geçişler çakışmaz.

### Sayaçlar ve geçmiş {#scheduling-limits}

**Koordinatör oturumu** her geçiş için varsayılan olarak **Yeni oturum** kullanır. Zamanlama veya olay varsa **Mevcut oturum** ile bu projenin aynı yürütme Location’ındaki kök konuşması seçilir. Her geçiş, konuşma geçmişini, başlığı ve izinleri koruyarak yapılandırılmış ajan ve modelle orada sürer. Görev kontrolleri mevcut işleri de etkiler. Her geçişin sonucu ve günlüğü geçmişte ayrı tutulur. Her başlatmada konuşma, koordinatörün aracısına, modeline ve düşünmesine geçirilir.

Bir ajandan zamanlamayı kendi geçerli kök konuşmasıyla hazırlamasını isteyebilirsiniz. Geçişler, konuşma boşta kalana kadar bekler.

Gösterilemeyen kayıtlı kural, açıkça değiştirilene kadar korunur; düzenlemeden önce bitiş ve sınırları inceleyin.

**Takip edilen konuşmalar** altında **Konuşma ekle** ile bir konuşma seçin; anında Görev için kullanılabilir. Başlatmadan önce seçimi değiştirin veya × düğmesiyle kaldırın.

Yerel Git başvurusunu izlemek için **Yerel dalda yeni commit'ler** seçeneğini kullanın. Uzak dal için **Uzak dalda yeni commit'ler** seçeneğini ve `dev` gibi bir dal adı girin. Kontrol, yerel fetch olmadan algılanan depoyu doğrudan okur. İki kontrol arasındaki birden fazla commit tek geçiş başlatır.

## Ağaç ve sonuçlar {#tracking}

Şevron işleri açar; satıra tıklamak Görevi veya işi seçer. Eylemler başlıkta kalır. İşi olmayan Görevde şevron yoktur. Filtre yüklenen kayıtları daraltır. Tek seferlik ve tekrarlanan Görevler tek listede, en son etkinlik önce sıralanır; süren planlı çalıştırma en üsttedir.

Göz, merkezi özeti açar ve seçimi izler. Konuşmayı aç, ilgili koordinatöre veya işe gider. ⋯ menüsü uygun güncelleme, kesinti, yapılandırma ve düzenleme işlemlerini içerir.

Seçim, genişletilmiş bölümler ve okuyucu her proje sekmesine aittir ve onunla birlikte geri yüklenir. Aynı projeye ait sekmeler farklı raporları okuyabilir veya birinde raporu, diğerinde konuşmayı, dosyayı ya da web önizlemesini tutabilir. Okuyucuyu açmak veya kapatmak yalnızca o sekmeyi değiştirir; Görev çalışmaları ve tamamlanan sonuçların okundu onayları pencere içinde ortak kalır.

Liste sonuna yaklaşınca yeni kayıtlar ve işler otomatik yüklenir. İşler yüklenemezse devam etmek için **Tekrar dene** kullanın.

### Renkler ve durumlar {#status-colours}

Bayrak Görevin durumunu, şevron işlerinin dikkat durumunu gösterir; tekrarlanan kayıtta tekrar simgesi vardır. Kırmızı yanıt bekler, sarı gözlenen çalışmayı gösterir. Turuncu duraklatma simgesi duraklamayı belirtir: siz sürdürene kadar hiçbir şey devam etmez veya başlamaz; turuncu uyarı üçgeni kesintiyi belirtir. Yeşil, incelenmeyi bekleyen bir Görevi, işi veya başarılı çalıştırmayı gösterir.

Vurgu renkli kum saati **Zamanlanmış çalıştırma bekleniyor** demektir: sonraki uyanma doğrulanmıştır. Vurgu rengi palete bağlıdır. Vurgu renkli olağan simge hazırlığı veya başlamamış işi belirtir. İncelenmiş tamamlanmalar ve durdurulmuş zamanlamalar nötrdür; durum metnini okuyun.

Seçim veya yeşil iş simgesine tıklama/süpürme sonuçları onaylar; şevron menüsünde **Okundu olarak işaretle** bulunur. **İncelenecek başarılı çalıştırma** için etkin pencerede tekrarlanan satırı açıkça seçin veya **Okundu olarak işaretle** kullanın. Zamanlama etkinse simge beklemeye, aksi durumda nötre döner. Zaten seçili satıra gelen yeni sonuçlar okunmamış kalır. Geri çekilen işin geçmişi tutulur.

### Sorular ve kararlar {#questions}

Koordinatör yapabildiğini çözer; kalan karar, onay veya kimlik bilgilerini sorar. Kesinti alanında yanıtlayın. Keşif, koordinatör kararını sizin yanıtınızdan ayırır; bağımsız oturumlar kararları Notlara kaydeder. Bkz. [Rehberler](playbooks.md).

### İlerleme raporları {#briefings}

Kilometre taşı raporları koordinatörün değerlendirmesidir. ⋯ üzerinden güncelleme isteyin ve özette okuyun.

## Bağlam ve sonuçlar {#context-flow}

Yeni görev ve geçişlerin kendi planı vardır. Yararlı geçmiş sonuçları Hedef veya Notlara koyun.

### Önceki konuşmaları arama {#context-search}

CodeNomad çalışırken ajanlar kayıtlı proje konuşmalarını arayabilir. Önceki sonuçlar önemliyse bunu isteyin; tam bağlam otomatik devralınmaz.

## Kapatma ve yeniden başlatma {#lifetime}

CodeNomad'ı kapatmak yerel işi durdurmaz. Etkin yerel programlar hizmet/makine kullanılabilirken çalışabilir; sağlıklı takvimler hizmet yeniden başlatılınca sürer. Açık duraklamalar, durdurmalar ve belirsiz sonuçlar engellerini korur.

Bazı koordinasyon ve kurtarma işlemleri CodeNomad sunucusunu gerektirir.

Çalışan tek seferlik Görev, projeyi açık tutan bir CodeNomad penceresi yokken de işlerini atamayı ve raporlarını iletmeyi sürdürür. CodeNomad'da değiştirilen ortam değişkenleri ve izin ayarları, proje açıldığında bu konuşmalara yeniden uygulanır.

## Duraklatma, durdurma ve doğrulanmamış işlemler {#controls-recovery}

Tek seferlik Duraklat, yeni iş başlatmadan mevcut adımları bitirir; hemen kesme, doğrudan kesinti ister. Durdur kalıcıdır ve onay gerekir. Programı duraklatmak gelecekteki başlatmaları kapatır ve mevcut geçişin kesilmesini ister. Araç etkileri devam edebilir.

Doğrulanmamış asıl isteği koruyun: Yerel program görünümü veya düzenleyici açıkken CodeNomad sonuçlanana kadar isteği otomatik yeniden okur ve yalnızca tam olarak kaydedilmiş kısmi bir hazırlığı kendiliğinden yeniden dener. Sunulduğunda tek seferlik Görev denetimleri için **Durumu denetle**, sıradan tek seferlik oluşturma için **Görev haritasını yenile** seçeneğini kullanın; yerine başka işlem oluşturmayın.

## Düzenleme, silme ve konuşma temizliği {#cleanup}

İş konuşması temizliği tek seferlik Görevlerin seçeneğidir. Yerel programları silmek konuşmalarını korur.

⋯ düzenleme aynı formu açar. İlk başlatmadan önce kilitsiz hazırlık alanları, sonra izin verilen talimat ve Notlar düzenlenebilir. Kilitli alanlar nedenini belirtir.

Silmeden önce işi durdurun. Tek seferlik Görev doğrudan kaldırılır. Programı silmek önce gelecek başlatmaları kapatır. İş konuşmalarını silme tercihi yalnızca uygun konuşmaları etkiler; koordinatörler, yeniden kullanılan/paylaşılan veya sahipliği doğrulanamayan konuşmalar tutulur. Temizlik kalan işi ve açık yeniden denemeleri gösterir.
