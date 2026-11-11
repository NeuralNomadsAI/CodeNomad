# Görevler

Bir Görev; hedefi, koordinatör konuşmasını, işleri ve sonuçlarını birlikte tutar. Sağ panelde **Görevler** bölümünü açın.

## Görev oluşturma {#create}

**Görev oluştur**, oluşturana veya iptal edene kadar ağacın yerine formu gösterir. Gruplar aşağıdaki sıradadır.

### Yapılandırma {#saved-briefs}

**Yapılandırma**, kayıtlı hedefi, notları, rehberi, profilleri ve görev oturumlarını yükler; adı düzenlenebilir başlık olur. Alanları kontrol edin.

Altta İptal ve Oluştur yanındaki **Yapılandırmayı kaydet**, yeniden kullanılabilir bir yapılandırma saklar; Görev oluşturmaz veya başlatmaz. Zamanlama ve otomatik başlatma ayrı seçilir. Dişli, Tercihler ve kitaplığı açar; yapılandırmayı silmek mevcut görevleri ve konuşmaları korur.

### Hedef, Başlık ve Notlar {#mission-instructions}

**Hedef**, istenen sonucu ve doğrulamasını anlatır. **Başlık**, ağaçtaki addır; boş görevde hedefin ilk cümlesinden en çok 60 karakter alır ve değiştirilebilir. **Notlar**, ajanlara iletilen isteğe bağlı bağlam, kısıtlar veya ek talimatlardır.

### Seçenekler ve rehber {#playbooks}

**Rehber**, koordinatörün çalışma yöntemini seçer; roller ve aşamalar [Rehberler](playbooks.md) sayfasındadır. Yerel izinler geçerlidir. Commit, push, pull request ve iş takip sistemi değişiklikleri için Hedef veya Notlar içinde o eylem açıkça istenmelidir.

### Yetkilendirme ve derinlik {#profiles}

**Görev oturumları**, koordinatör altında yerel alt ajanları veya bağımsız oturumları seçer. İkisi de OpenCode izinlerine ve iç içe geçme sınırlarına tabidir.

**Alt ajan derinliği**, projenin tüm OpenCode konuşmalarını etkiler. **Devral** veya 1–10 seçimi hemen kaydedilir. Etkin derinlik ve izinler gözlenen yapılandırmaya bağlıdır. Başarısız veya doğrulanmamış kayıt, uyarısını ve açık yenileme işlemini korur.

Proje derinliği kaydetmek, alt ajanların bu derinlikte kendi işlerini devretmesine de izin verir ve desteklenen diğer dosya General kısıtlamalarından öncelikli olur. Uyumsuz proje kuralında uyarı kalır. **Devral** eklenen kuralı kaldırır. Kaydetmek OpenCode'u yeniden yüklemez ve çalışan konuşmaları değiştirmez.

### Ajanlar ve modeller {#agents-models}

**Ajanlar ve modeller** altında rol başına Ajan / Model / Düşünme satırı bulunur. Kapalıyken özet istenen seçimleri gösterir. Başlangıç değerleri Tercihlerden gelir; burada yapılan değişiklikler bu Görev içindir.

Dişli, tüm görevlerin veya bir rehberin varsayılanlarını açar; Tercihler her değişikliği hemen kaydeder. Model listeleri konuşma seçicisinin görünürlük ve favorilerini izler. Liste dışındaki kayıtlı seçim korunur.

**İki modeli karşılaştır**, A ve B için farklı modeller gerektirir; yalnızca Düşünme farkı yetmez. Hakem ayrıca seçilmezse koordinatörün modelini kullanır. A veya B'nin hakem olması yanlılık yaratabilir.

Takvim tabanlı zamanlama, koordinatör ve rehberin her rolü için açık bir ajan ve model gerektirir.

### Otomatik başlat {#automatic-start}

**Otomatik başlat**, Zamanlama dışındadır ve varsayılan olarak kapalıdır. Kapalıyken görev duraklatılmış oluşturulur ve daha sonra ▶ ile başlatılır. Açıkken oluşturma doğrulanınca olağan kontroller ve gerekli yerel ayar onayıyla başlatma istenir.

Oluşturma onayı kaybolursa makbuzu okumak otomatik başlatmaz. Doğrulanmamış asıl isteği koruyun; yeniden oluşturmadan önce listeyi ve konuşmayı kontrol edin.

## Zamanlama {#daily-schedules}

### Ölçütler {#native-scheduling}

Alt ajan derinliği bilgileri etkin kaynağı **OpenCode yapılandırma dosyası:** altında gösterir.

İlk ölçüt **Bir kez, şimdi** olur. **Ölçüt ekle** bir tane daha ekler. Türünü seçin, × ile kaldırın, tutamacıyla sıralayın; odaklı tutamaçta Alt+Yukarı/Aşağı kullanabilirsiniz.

Bir kez şimdi, N saatte bir, günlük, haftanın günleri, ayın günü ve cron seçenekleri vardır. Kayıtlı saat dilimi kullanılır; sistemden farklıysa dilim alanı görünür. Seçilen günün bulunmadığı ay atlanır. Bir kez şimdi, zamanı Başlat'ta alır; koşul bu tek fırsatı çalıştırmadan tüketebilir. OpenCode hizmeti ve yürütme makinesi kullanılabilir olmalıdır.

### Olaylar ve birleşimler {#scheduling-conditions}

**Depo etkinliği → Olay** seçin, ardından aynı karttaki isteğe bağlı filtreleri kullanın. Git commit’leri, otomatik algılanan GitHub, GitLab veya Gitea deposunun olaylarıyla aynı menüdedir. Algılama Contribute ile ortaktır: önce `upstream`, sonra `origin`. Üçü de yeni ve birleştirilmiş PR/MR ile yeni issue olaylarını ve `dependabot[bot]` dahil isteğe bağlı **Yazar** filtresini destekler. Olay seçimi depoyu sabitler; kayıtlı ölçütler hedeflerini korur.

Kontroller OpenCode makinesindeki `gh`, `glab` veya `tea` kullanır, CodeNomad kapalıyken de çalışır; herkese açık depolar anonim okunabilir. Kendi sunucunuz için o sunucuya bağlı CLI gerekir. **github.com**, oturum açmış `gh` ile hesap bildirimleri ve Dependabot uyarıları da sunar; [bildirim](https://docs.github.com/en/rest/activity/notifications) veya [uyarı okuma](https://docs.github.com/en/rest/dependabot/alerts) erişimi gerekir. Okunma durumu korunur; düzeltilen veya kapatılan uyarılar da kapsanır. **GitHub deposu** boş kayıtlı bildirimler hesabı kapsar. İlk başlatma referansı belirler. Her kontrol on saniyede en fazla 50 kayıtlık dört sayfa okur; eksik erişim, API sınırı veya eksik pencere kaynağı kullanılamaz bırakır. Özetler geçiş girdisine eklenir ve başarıdan sonra tüketilir.

Olaylar; başka programın/Görevin başarısını, yerel commitleri, yeni mesajları veya açık proje dosyalarını izler. Kaynağı ilgili ölçütün içinde seçin. Arama yokken kaydırdıkça devamı yüklenir; okuma başarısız olursa aynı yerde **Tekrar dene** görünür. Arama, aksanlı harfler dâhil büyük ve küçük harfleri ayırt etmez. Arama sırasında sayfada eşleşme olsa bile seçicide **Daha fazla kaynak yükle** ile devam edin. Yeni mesajlar için seçilen konuşma geçişe bağlam da sağlar. Ölçüt türünü değiştirmek kaynağını temizler. Düzenleme, kayıtlı konuşma bağlamını korur.

**veya**, bitişik zamanları veya olayları birleştirir. **eğer**, zamanlardan sonraki olayları koşul yapar: son başarılı geçişten beri biri değişmiş olmalıdır. **aksi halde**, olaylardan sonraki zamanı yedek yapar: önceki yuvasından veya etkinleştirilmesinden beri üstteki ölçütler geçiş başlatmamışsa çalışır. Sonraki olaylar bu yedeği koşullandırır.

Baştaki tetikleyiciler 15 dakikada bir kontrol edilir. İlk Başlat referansı kurar; başarı ilerletir, başarısızlık korur. Okunamayan kaynak açıklamayla engeller. Geçişler çakışmaz.

### Sayaçlar ve geçmiş {#scheduling-limits}

**Koordinatör oturumu** her geçiş için varsayılan olarak **Yeni oturum** kullanır. Zamanlama veya olay varsa **Mevcut oturum** ile bu projenin aynı yürütme Location’ındaki kök konuşması seçilir. Her geçiş, konuşma geçmişini, başlığı ve izinleri koruyarak yapılandırılmış ajan ve modelle orada sürer. Görev kontrolleri mevcut işleri de etkiler. Her geçişin sonucu ve günlüğü geçmişte ayrı tutulur; seçilen konuşma kaybolursa müdahaleniz gerekir.

Seçilen program durumunu, sonraki uyanma/kontrolü, başlatılmış/başarılı geçişleri ve geçmişi gösterir. Son 30 sonuç saklanır; toplam sayaçlar korunur. Kabul edilen **Şimdi çalıştır** sayılır. Gösterilemeyen kayıtlı kural, açıkça değiştirilene kadar korunur; düzenlemeden önce bitiş ve sınırları inceleyin.

### Mevcut günlük programlar {#existing-daily-schedules}

Kendi kontrollerini ve saat dilimini korurlar. Hizmet yeniden başlayınca kesintiye uğramış günlük kayıtlar Devam gerektirir. Kaçırılan tüm günler yerine son uygun günü telafi ederler. Sonuçlar seçilen kayıttadır.

## Ağaç ve sonuçlar {#tracking}

Şevron işleri açar; satıra tıklamak Görevi veya işi seçer. Eylemler başlıkta kalır. İşi olmayan Görevde şevron yoktur. Filtre yüklenen kayıtları daraltır.

Göz, merkezi özeti açar ve seçimi izler. Konuşmayı aç, ilgili koordinatöre veya işe gider. ⋯ menüsü uygun güncelleme, kesinti, yapılandırma ve düzenleme işlemlerini içerir.

Liste sonuna yaklaşınca yeni kayıtlar ve işler otomatik yüklenir. İş sayfaları görünen satırlardan bağımsız önbellekte kalır. Okuma hatası son görünümü korur ve açık yeniden deneme sunar. Okumak iş başlatmaz; arka plan okumasını başlık gösterir.

### Renkler ve durumlar {#status-colours}

Bayrak Görevin durumunu, şevron işlerinin dikkat durumunu gösterir; tekrarlanan kayıtta tekrar simgesi vardır. Kırmızı yanıt bekler, titreşen sarı gözlenen çalışmayı, turuncu duraklama/kesintiyi, yeşil görülmemiş sonucu, mavi hazırlığı veya başlamamış işi gösterir.

Seçim, yeşil iş simgesine tıklama/süpürme veya şevron menüsünden okundu işaretleme sonuçları temizler. Engel her zaman insan sorusu değildir; rapor, tüm yerel işlemlerin sona erdiğini kanıtlamaz. Geri çekilen işin geçmişi tutulur.

### Sorular ve kararlar {#questions}

Koordinatör yapabildiğini çözer; kalan karar, onay veya kimlik bilgilerini sorar. Kesinti alanında yanıtlayın. Keşif, koordinatör kararını sizin yanıtınızdan ayırır; bağımsız oturumlar kararları Notlara kaydeder. Bkz. [Rehberler](playbooks.md).

### İlerleme raporları {#briefings}

Kilometre taşı raporları koordinatörün değerlendirmesidir. ⋯ üzerinden güncelleme isteyin ve özette okuyun. Teslim doğrulanmazsa önce konuşmayı inceleyin.

## Bağlam ve sonuçlar {#context-flow}

Kalıcı plan Hedefi, Notları, iş talimatlarını, bağımlılıkları ve sonuçları tutar. Koordinatör hedef, notlar ve rehberi alır; yerel işler üstlerinin atamasını, bağımsız işler ayrıca açık atamalarını alır. Yardımcılara bağlamı üstleri iletir. Kör hakem anonim karşılaştırma verisi alır.

Yeni görev ve geçişlerin kendi planı vardır. Yararlı geçmiş sonuçları Hedef veya Notlara koyun. OpenCode model bağlamını sıkıştırırken kayıtlı geçmişi koruyabilir.

### Önceki konuşmaları arama {#context-search}

CodeNomad çalışırken ajanlar kayıtlı proje konuşmalarını arayabilir. Önceki sonuçlar önemliyse bunu isteyin; tam bağlam otomatik devralınmaz.

## Kapatma ve yeniden başlatma {#lifetime}

CodeNomad'ı kapatmak yerel işi durdurmaz. Etkin yerel programlar hizmet/makine kullanılabilirken çalışabilir; sağlıklı takvimler hizmet yeniden başlatılınca sürer. Açık duraklamalar, durdurmalar ve belirsiz sonuçlar engellerini korur. Mevcut günlük kayıtlar Devam gerektirir.

Bazı koordinasyon ve kurtarma işlemleri CodeNomad sunucusunu gerektirir. Paneldeki bağlantı/eklenti hatasını izleyin.

## Duraklatma, durdurma ve doğrulanmamış işlemler {#controls-recovery}

Tek seferlik Duraklat, yeni iş başlatmadan mevcut adımları bitirir; hemen kesme, doğrudan kesinti ister. Durdur kalıcıdır ve onay gerekir. Programı duraklatmak gelecekteki başlatmaları kapatır ve mevcut geçişin kesilmesini ister. Araç etkileri devam edebilir.

Doğrulanmamış asıl isteği koruyun. Yerine başka işlem göndermek yerine durum kontrolü, makbuz yenileme veya sunulan yeniden denemeyi kullanın. Pasif yenileme yeniden göndermez. Onaydan sonra kontroller güncel görünümü bekleyebilir. Kurtarma önce yerel etkinlik ve bekleyen istekleri kontrol eder.

## Düzenleme, silme ve konuşma temizliği {#cleanup}

İş konuşması temizliği tek seferlik Görevlerin seçeneğidir. Yerel programları silmek konuşmalarını korur.

⋯ düzenleme aynı formu açar. İlk başlatmadan önce kilitsiz hazırlık alanları, sonra izin verilen talimat ve Notlar düzenlenebilir. Kilitli alanlar nedenini belirtir. Çakışmada güncel yapılandırmayı yükleyip önceki taslağı karşılaştırın.

Silmeden önce işi durdurun. Tek seferlik Görev doğrudan kaldırılır; doğrulanmamış silme asıl yeniden denemesini korur. Programı silmek önce gelecek başlatmaları kapatır. İş konuşmalarını silme tercihi yalnızca uygun konuşmaları etkiler; koordinatörler, yeniden kullanılan/paylaşılan veya sahipliği doğrulanamayan konuşmalar tutulur. Temizlik kalan işi ve açık yeniden denemeleri gösterir.
