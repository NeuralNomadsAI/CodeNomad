# Ayarlar ve düzen

Deneysel çoklu arka uç etkin olduğunda Tercihler, proje ayarları, sağlayıcılar, istatistikler ve bellek düzenleme için seçili projenin sunucusunu kullanır. Sunucu kullanılamıyorsa proje denetimleri devre dışı kalır. Cihaz ayarları ve SideCars yerel kalır.

## Ayarları açın ve kapsamını belirleyin {#open-settings}

1. Sekme çubuğundaki (macOS masaüstü uygulamasında başlık çubuğundaki) veya ana sayfadaki **Ayarları aç** dişli simgesiyle **Ayarlar** öğesini açın. Model seçicideki **Provider'ları yönet**, Görevler panelinin dişli simgesi veya bildirim geçmişindeki **Ayarlar** dişli simgesi gibi kısayollar ilgili bölümü doğrudan açar.
2. Bir bölüm seçin. Yerel Electron ve Tauri pencereleri bir yerel Tercihler penceresini açar veya odaklar; tarayıcı ve uzak görünümler yerleşik ayarlar ekranını kullanır.
3. Ayrılmadan önce ayarın kapsamını ve herhangi bir **Kaydet** eylemini kontrol edin.

Her değişikliği siz yaptıkça kaydeden Görev tercihleri dahil, çoğu seçim hemen uygulanır. Ses, özel palet renkleri ve Yapılandırma Dosyaları açık bir **Kaydet** eylemini korur. Kaydetmenin başarısız olması değişikliğin uygulandığını doğrulamaz; yeniden denemeden önce ilgili bölümü yeniden açın veya yenileyin. Kısa açıklama için ayar başlığının yanındaki **i** simgesinin üzerine gelin veya odaklanın. Yardım bağlantısı varsa tıklamak, Enter'a basmak veya dokunmak ilgili bölümü arayüz dilinde sistem tarayıcısında ya da ayrı bir sekmede açar. Yalnızca ipucu içeren simgeler dokunulduğunda açıklamayı gösterir. **Ayarlar → Bilgi** bölümünde ayrıca **CodeNomad'i destekleyin** kartı bulunur: **Sponsor olun veya katkıda bulunun**, [CodeNomad'i destekleyin](sponsor.md) sayfasını açar.

| Durum | Neyi yönetir |
| --- | --- |
| CodeNomad yapılandırması | Bu yapılandırmayı kullanan istemcilerin arayüz tercihleri, ses, SideCars ve sunucu ayarları. Rozeti olmayan tercihler de cihaz başına saklanmaz; **Sunucu ayarı**, Ses, SideCars, Uzaktan Kontrol ve Ortam Değişkenleri gibi sunucu tarafı yapılandırmayı işaretler. |
| Pencere/proje sekmesi düzeni | Açık paneller, seçilen sekmeler, okuyucu durumu ve geri yüklenebilir taslaklar/düzen. Bunlar OpenCode yapılandırması değildir. |
| Genel/Proje OpenCode ayarları | Görüntülenen kapsamda yerel eklenti/yapılandırma değişiklikleri. Proje kontrolleri etkin bir proje/Location gerektirir. |
| Masaüstü veri profili | Yerel pencereler, yapılandırma dosyasından ve paylaşılan OpenCode hizmetinden bağımsız olarak geri yükleme durumu ve tarayıcı depolaması. Bkz. [Masaüstü pencereleri ve veriler](desktop.md). |

**İstatistikler**, yalnızca açılan klasörü değil, bağlı OpenCode hizmetinin tamamını (tüm projeler, bağımsız klonlar ve alt oturumlar) son 7, 30, 90 veya 365 gün için kapsar. Açık bir proje gerektirir ve sağlayıcı faturalarını veya abonelik haklarını değil, OpenCode'un kaydettiği token ve maliyetleri gösterir; yenileme sırasında daha önce kaydedilmiş toplamlar görünebilir. Plan kotaları **Kullanım** Durum bölümüne aittir.

Görüntü tercihlerinin değiştirilmesi OpenCode'u yeniden başlatmaz veya bir istemi yeniden oynatmaz. Yerel yapılandırma, hizmet bakımı ve kimlik bilgilerinin ayrı etkileri vardır: bkz. [OpenCode kurulumu](opencode.md), [Sağlayıcılar](providers.md) ve [Entegrasyonlar](integrations.md).

## Dil ve görünüm {#language-appearance}

1. **Genel** bölümünde **Dil** öğesini seçin: İngilizce, İspanyolca, Fransızca, Rusça, Japonca, Basitleştirilmiş Çince, İbranice, Almanca, Nepalce veya Türkçe.
2. **Renk şeması** bölümünde **Mod** seçin: **Otomatik**, **Koyu** veya **Açık**. Otomatik işletim sistemini takip eder.
3. Görüntülenen görünüm için bir palet seçin. Açık ve koyu seçimler bağımsız olarak kaydedilir; Otomatik eşleşeni kullanır.
4. Özel renkler için renk örneklerini ve **Kaydet** öğesini kullanın; **Sıfırla** yerleşik bir paletin renklerini geri yükler. Ayrı bir paleti adlandırmak için **Yeni**, oluşturduğunuz bir paleti kaldırmak için **Sil** öğesini kullanın.

Kullanıcı arayüzü, bir konuşmayı yeniden başlatmadan güncellenir. İbranice sağdan sola düzeni kullanır; kod ve teknik değerler kendi yönlerinde okunabilir durumda kalır. Dil seçimi, mevcut mesajların veya aracı talimatlarının dilini değil, arayüz metnini değiştirir. Yerel masaüstü menüleri, bir CodeNomad penceresi yüklendikten sonra arayüz diline geçer.

Renklerin okunması zorlaşırsa yerleşik bir palet seçin veya düzenlenen paleti sıfırlayın. Paletler arasında geçiş yapmak, kaydedilmemiş renk düzenlemelerini iptal etmenizi isteyebilir; bir konuşma taslağını atmaz.

## Bilgisayarı uyanık tutma {#keep-computer-awake}

**Ayarlar → Genel** bölümündeki **CodeNomad çalışırken bilgisayarı uyanık tut** seçeneği varsayılan olarak kapalıdır. Hiçbir oturum çalışmasa bile yerel bir CodeNomad penceresi açıkken (simge durumuna küçültülmüş olsa bile) sistemin uykuya geçmesini önlemek için açın; ekran yine de kapanabilir. Bu seçenek kapalıyken CodeNomad, bilgisayarı yalnızca bir oturum çalışırken uyanık tutar. Başlığın yanındaki **i**, bu davranışı açıklar. Seçenek yalnızca masaüstü uygulamasının yerel pencerelerinde ve Tercihler penceresinde görünür; tarayıcı ve uzak görünümlerde gizlidir.

## Kalıcı ajan belleği {#agent-memory}

Bellek arızasında gönderim devam eder. CodeNomad oturumun eski bellek talimatlarını kaldırmayı dener; temizleme de başarısız olursa önceki talimatlar başarılı bir yenilemeye kadar kalabilir. İddiaları güncel dosya ve komutlarla doğrulamaya devam edin.

**Tercihler → Genel → Bellek** yolunu açın (tarayıcıda **Ayarlar → Genel**). Bellek varsayılan olarak kapalıdır. Ajanın yararlı bilgileri ve tercihleri konuşmalar arasında saklaması için etkinleştirin. Anahtar bağlı CodeNomad yapılandırması için geçerlidir; kapatmak kayıtları ve geçmişlerini korur. Kapalıyken ajanlar bellek aracı almaz; değişiklik yeniden başlatmadan, birkaç saniye içinde devam eden konuşmalara da uygulanır.

- **Hakkınızda**: bu yapılandırmayı kullanan projeler arasında paylaşılan en fazla 60 kayıt.
- **Proje**: en fazla 200 kayıt. Bu arayüz Tercihler’de seçilen projeyi, gömülü Ayarlar ise ana pencerenin etkin projesini kullanır. Ajanın `codenomad_memory` aracı ve oturum talimatları o oturumun klasörünü kullanır. Sunucu depoyu normalleştirilmiş Git uzak adresiyle, bu yoksa yerel depo yoluyla tanımlar; worktree’ler bu belleği paylaşır. Bu kapsamı seçmek için bir proje açın.

Alt oturumlar dahil her oturum kayıt kurallarını ve sınırlı bir başlık ve tür listesini alır (talimat bloğu en fazla yaklaşık 8.000 karakterdir). Ajana işlem yapmadan önce ilgili kayıtları `codenomad_memory` ile okuması, iddiaları güncel dosya ve komutlarla doğrulaması ve kaydettiklerini belirtmesi söylenir. Boş bellek de kayıt kurallarını alır. Okunamayan kapsamlar kullanılamaz olarak dışarıda bırakılır. OpenCode isteğe bağlı oturum talimatı yeteneğine sahip değilse entegrasyon sessizce devre dışı kalır ve seçiminizi korur.

1. Kapsamı ve kaydı seçin. **Yeni** ve **Değiştirildi**, bu tarayıcı veya masaüstü görünümünde kapsamın son başarılı incelemesinden sonraki değişiklikleri gösterir; geçerli ziyaret boyunca görünür kalırlar.
2. **Başlık**, **Tür** (**Bilgi**, **Tercih** veya **Referans**) ve **Metin** alanlarını düzenleyip **Kaydet** seçeneğini kullanın. Başlık 60, metin 2.000 karakterle sınırlıdır. **İptal** kayıtlı içeriği geri getirir. Kayıt başka yerde değiştiyse **Yeniden yükle** ile inceleyip sonra kaydedin.
3. Kaldırmak için kaydın işlem menüsünü açıp **Unut** işlemini onaylayın. Kayıt etkin bellekten çıkar; yerel Git eski metin dahil geçmişi korur. Unutmak ajanın kullanımını sonlandırır, güvenli veri silme değildir.
4. Bellek doluysa yeniden denemeden önce kayıtları birleştirin veya unutun. Eşleşen başlıklar ya da büyük ölçüde örtüşen metinler mevcut bir kaydı değiştirir; Git önceki metni saklar.

**İnceleme gerekli**, korumaları aşabilecek veya kimlik bilgilerini açığa çıkarabilecek şüpheli talimatları işaretler. Bu kayıtlar burada düzenlenebilir, sınıra dahil edilir ve ajanın başlık listesinden ve okumalarından çıkarılır. Her okumada kontrol edilirler; içeriği düzeltip kaydedin veya **Unut** seçeneğini kullanın. Hatalı biçimli veya okunamayan bellek boş liste yerine hata gösterir; yeniden denemeden önce nedeni giderin.

**Düzenle**, onaydan sonra seçilen kapsamı doğrulayıp birleştirmek için Tercihler’de gösterilen projede yeni bir konuşma açar. Doğrulanamayan kayıtları ve dış referansları korur ve değişiklikleri bildirir. Açık bir proje ve en az bir işaretlenmemiş kaydı bulunan etkin, okunabilir ve yazılabilir bellek gerektirir. Başlatma doğrulanamazsa yeniden denemeden önce projenin konuşmalarını kontrol edin.

Belleği ajan yönetir. Zaten `.claude/…/MEMORY.md` gibi başka bir yerde bellek tutuyorsa ona bir **Referans** kaydeder; dış bellek dosyaları kendi yönetimlerinde kalır. CodeNomad yapılandırma klasöründeki `memory/global/` veya `memory/projects/<id>/` altında kayıt başına bir Markdown dosyası saklar; her kaydetme veya silme yerel Git commit’i oluşturur. Depolama yalnızca yereldir, uzak eşitleme yapılmaz. Yapılandırma ve profil sınırları için [Masaüstü pencereleri ve verileri](desktop.md) bölümüne bakın.

## Paneller ve Durum bölümleri {#panels-status}

**Durum** varsayılan olarak ilk sıradadır; kaydedilmiş sekme sırası önceliklidir. Sekme kullanılabilir kalır. **Sağ paneli özelleştir** içindeki oku, bölümlerin kendisini gizlemeden bölüm onay kutularının listesini daraltır veya genişletir.

**Tokenlar** mesajlarla aynı metrik etiketlerini kullanır. Daraltıldığında girdi, çıktı ve maliyet başlık satırında kalır; genişletildiğinde düşünme de aynı satıra eklenir ve etiketler gerektiğinde alt satırlara geçer. Alt oturumları içeren toplamlar aşağıda gösterilir.

Sabitlenmiş bir paneli yeniden boyutlandırmak için iç kenarını sürükleyin. İşaretçi kenarın dışına çıksa bile sürükleme boyunca tutamaç vurgulanır ve işaretçi yakalama korunur. Bitirmek için bırakın.

1. Panelleri göstermek/gizlemek için dış başlık köşelerindeki **Sol panel** ve **Sağ panel** kontrollerini veya **Görünüm** menüsündeki karşılıklarını kullanın.
2. Sağ panelde **Sağ paneli özelleştir** öğesini açın. Yerleşik sekmeleri ve Durum bölümlerini seçmek için onay kutularını kullanın; en az bir Durum bölümü görünür durumda kalır. Birkaçını tek seferde ayarlamak için bu onay kutularının üzerinde sürükleyin.
3. Yeniden sıralamak için sağ panel sekmelerini sürükleyin. Yerleşik düzen seçeneklerini geri yüklemek için **Sıfırla** öğesini kullanın.

Tüm Durum bölümlerini sürükleyerek veya Yukarı/Aşağı tuşlarıyla sıralayın. Görünürlük ve sıra yeniden yüklemelerde korunur.

Durum; belirteç bilgilerini, Yolo modunu, sağlayıcı Kullanımı, arka plan kabuklarını, MCP ve Eklentileri içerir. Görüşmenin bir [hedefi](conversations.md#goal) olduğu sürece bu bölümlerin üzerindeki bir hedef satırı onu gösterir; bu satır bir bölüm değildir, gizlenemez ve taşınamaz. Bir bölümün gizlenmesi, o bölümün hizmetini devre dışı bırakmaz veya izinleri iptal etmez. Dar düzenler, konuşmayı sıkıştırmak yerine artık sığmayan panelleri kapatır; orada açılan bir panel konuşmanın üzerinde yüzer ve bir yüzer panelin açılması diğerini kapatır.

Yerleşik düzen proje değişikliği değil, pencere yerleşimidir. Uzantı onay kutuları farklıdır: yapılandırmayı kullanan tüm projelerde kodu etkinleştirir. **Sıfırla** uzantı onayını değiştirmez. Bkz. [Panel uzantıları](extensions.md).

## Konuşma dökümü ayrıntıları ve ileti düzenleyicisi boyutu {#transcript-composer}

1. Konuşma dökümü ayrıntısı varsayılanlarını seçmek için **Sohbet** öğesini açın. Ön ayarlar **Hiçbir şey**, **Minimal**, **Dengeli** ve **Her şey**'dir; bireysel değişiklikler **Özel** öğesini üretir.
2. Düşünme, tanılama, araç girdileri, tokenlar, sistem mesajları ve her araç türü için her satırın **Varsayılan durum** ayarını (**Gizli**, **Daraltılmış** veya **Genişletilmiş**) belirleyin ya da bu seçimleri paylaşan, konuşmanın **Mesaj içeriği** açılır penceresini kullanın.
3. **Genel** bölümünde gerektiği gibi **Mesaj zaman çizelgesini göster**, **İlk/en son mesaj oklarını zaman çizelgesinin altına yerleştir**, **Araç çağrısı diff'lerini böl** ve **Gönderilen istemleri kuyruğa al** (oturum çalışırken gönderilen istemleri yönlendirmek yerine kuyruğa alır) seçeneklerini işaretleyin.
4. Yeniden boyutlandırma kontrolünü kullanarak ileti düzenleyicisini yeniden boyutlandırın; uzun taslaklar alanın içinde kayar.

Zaman çizelgesinde, konuşmada gösterilen her yanıt, akıl yürütme, araç, sıkıştırma ve sistem bağlamı için aynı sırayla bir işaretçi bulunur. İşaretçiler **Mesaj içeriği** ayarlarını izler: orada bir araç türünü, akıl yürütmeyi veya sistem mesajlarını gizlemek, bekleyen izni olan araç dışında bunların işaretçilerini de gizler; **Hiçbir şey** tüm araç işaretçilerini gizler. Görünürlük ve genişletme ayarları yalnızca sunumu değiştirir. Saklanan araçları/akıl yürütmeyi kaldırmaz veya model bağlamını sıkıştırmaz. Yıkıcı işlemler için bkz. [Geçmiş ve temizleme](history.md).

İleti düzenleyicisinin yüksekliği ekran klavyesi dahil görünür konuşmayı izler: en az 44 piksel tabanıyla minimum %8, maksimum %60. Elle seçilen yükseklik oran olarak saklanır; dar genişlik ve uzun metin sınırları yükseltmez. Genişletilmiş izin/soru, kayıtlı yüksekliği veya taslağı değiştirmeden düzenleyiciyi geçici küçültür. Yeniden boyutlandırmaya dönmek için isteği daraltın veya sonuçlandırın.

## Bildirimler ve rozetler {#notifications}

Başka bir CodeNomad sunucusundaki proje sekmesinin bildirimleri sunucu adını içerir. **Sohbeti görüntüle** tam olarak o projeyi ve konuşmayı açar; sunucuyu ayırmak bildirimlerini temizler. Görseller ve Web araması ayarları, genel varsayılanlar dahil projenin sunucusuna aittir.

1. **Bildirimler** öğesini açın. Her bildirim türü için nerede görüneceğini işaretleyin: **Ekranda** (geçici bir baloncuk), **Geçmiş** (sekme çubuğundaki, macOS masaüstü uygulamasında başlık çubuğundaki zilin bildirim geçmişinde saklanır) ve **Sistem** (işletim sistemi bildirimi). Birkaçını tek seferde ayarlamak için bir kutu satırı veya sütunu üzerinde sürükleyin.
2. Bir **Sistem** kutusunu işaretlemek gerekirse izin ister. **Sistem bildirimleri** altında, izin eksikken **İste** yeniden izin ister.
3. Bu pencere odaktayken de sistem bildirimlerini almak için **Uygulama odaktayken bildir** seçeneğini etkinleştirin. Aksi halde pencere ekranda açık kalsa bile odakta olmadığında bildirimler görünür.

Varsayılan olarak **Bir oturum yanıtınızı bekliyor** ve **Bir oturum tamamlandı** yalnızca Sistem'e gider; böylece geçici oturum durumları Geçmiş'te birikmez. Bunlar alt ajanları değil ana oturumları ilgilendirir ve sizin durdurduğunuz bir oturum duyurulmaz. Hatalar, tablo ne gösterirse göstersin her zaman ekranda ve Geçmiş'te görünür; kısa ilerleme mesajları ise yalnızca ekranda kalır.

Tarayıcı/İşletim Sistemi izni cihaza ve uygulama kaynağına aittir; kaydedilmiş bir tercih bir reddi geçersiz kılamaz. Engellenirse tarayıcı veya işletim sistemi ayarlarında bildirimleri etkinleştirin ve ardından buraya geri dönün. Desteklenmeyen ortamlarda Sistem sütunu devre dışı kalır.

Yalnızca Geçmiş'e yönlendirilen bildirimleri sayan zil/okunmamış geçmiş sayısı, tarayıcı favicon noktasını ve yerel uygulama rozetini yönlendirir. Yerel rozetler canlı ana pencereleri bir araya getirir; bunlar çalışan oturumların sayısı veya bir işletim sistemi bildiriminin iletildiğinin kanıtı değildir. PWA başlatıcı rozetleri bu özellik tarafından sağlanmaz.

## Gelişmiş seçenekler {#advanced}

1. **Gelişmiş** öğesini açın.
2. Yalnızca ihtiyacınız olan seçenekleri işaretleyin veya işaretini kaldırın; her değişiklik CodeNomad tercihleri aracılığıyla kaydedilir. Oturum yürütme ortamını değiştirmek için sondaki katlanmış **Ortam Değişkenleri** grubunu genişletin.
3. Paylaşılan hizmeti spekülatif olarak yeniden başlatmak yerine ortaya çıkan görünümü veya sonraki gönderimi kontrol edin.

| Seçenek | Etki ve dikkat |
| --- | --- |
| Boş oturumları otomatik temizleme | Yeni oturum oluştururken boş oturumları temizler; korumak istiyorsanız kapalı bırakın. |
| Alt aracı boşta işaretleyicilerini tut | Görünmeyen boşta kalma işaretlerini beş saniye sonra gizlemek yerine görüntülenene kadar korur. |
| Mevcut pencereyi ikinci başlatmaya odakla | Yalnızca yerel masaüstü; sekme oluşturmayı değil, ikinci başlatma penceresi davranışını değiştirir. |
| Sağlayıcı kredi bakiyesi | Kullanımdaki ek bakiyeleri gösterir; kredi satın almaz veya hesap değiştirmez. |
| Yalnızca boşluk değişikliklerini gizle | Stage edilmemiş, yalnızca boşluk/satır sonu değişen dosyaları Değişiklikler ve toplu işlemlerinden çıkarır; stage edilmiş dosyalar görünür kalır. Bkz. [Dosyalar](files.md). |
| Uzun asistan yanıtlarını beklet | Bir akış yanıtı görünümün ötesine geçtiğinde otomatik takibi durdurur. |
| Ortam Değişkenleri | Her istem veya oturum komutundan önce sunucu tarafında uygulanır; okumalar halihazırda çalışmakta olan yürütmeyi güncellemez. Bkz. [OpenCode kurulumu](opencode.md). |

Klavye yapılandırması için [Klavye kısayolları](shortcuts.md); ses kontrolleri için [Ses girişi ve oynatma](voice.md)'yi kullanın. Başlangıç geri yükleme ve masaüstü veri profilleri, [Masaüstü pencereleri ve veriler](desktop.md) kapsamında ele alınmaktadır.
