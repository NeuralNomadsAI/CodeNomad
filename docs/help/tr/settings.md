# Ayarlar ve düzen

## Ayarları açın ve kapsamını belirleyin {#open-settings}

1. Sekme çubuğundaki (macOS masaüstü uygulamasında başlık çubuğundaki) veya ana sayfadaki **Ayarları aç** dişli simgesiyle **Ayarlar** öğesini açın. Model seçicideki **Provider'ları yönet**, Görevler panelinin dişli simgesi veya bildirim geçmişindeki **Ayarlar** dişli simgesi gibi kısayollar ilgili bölümü doğrudan açar.
2. Bir bölüm seçin. Yerel Electron ve Tauri pencereleri bir yerel Tercihler penceresini açar veya odaklar; tarayıcı ve uzak görünümler yerleşik ayarlar ekranını kullanır.
3. Ayrılmadan önce ayarın kapsamını ve herhangi bir **Kaydet** eylemini kontrol edin.

Her değişikliği siz yaptıkça kaydeden Görev tercihleri dahil, çoğu seçim hemen uygulanır. Ses, özel palet renkleri ve Yapılandırma Dosyaları açık bir **Kaydet** eylemini korur. Kaydetmenin başarısız olması değişikliğin uygulandığını doğrulamaz; yeniden denemeden önce ilgili bölümü yeniden açın veya yenileyin. Açıklamalar, ayar başlığının yanındaki **i** simgesinin arkasındadır: üzerine gelin veya odaklanın ya da dokunmatik ekranda dokunun.

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

## Paneller ve Durum bölümleri {#panels-status}

1. Panelleri göstermek/gizlemek için dış başlık köşelerindeki **Sol panel** ve **Sağ panel** kontrollerini veya **Görünüm** menüsündeki karşılıklarını kullanın.
2. Sağ panelde **Sağ paneli özelleştir** öğesini açın. Yerleşik sekmeleri ve Durum bölümlerini seçmek için onay kutularını kullanın; en az bir Durum bölümü görünür durumda kalır.
3. Yeniden sıralamak için sağ panel sekmelerini sürükleyin. Yerleşik düzen seçeneklerini geri yüklemek için **Sıfırla** öğesini kullanın.

Durum; belirteç bilgilerini, Yolo modunu, sağlayıcı Kullanımı, arka plan kabuklarını, MCP ve Eklentileri içerir. Bir bölümün gizlenmesi, o bölümün hizmetini devre dışı bırakmaz veya izinleri iptal etmez. Dar düzenler, panelleri konuşmayı sıkıştırmak yerine üzerinde gezdirir; bir yüzer panelin açılması diğerini kapatır.

Yerleşik düzen proje değişikliği değil, pencere yerleşimidir. Uzantı onay kutuları farklıdır: yapılandırmayı kullanan tüm projelerde kodu etkinleştirir. **Sıfırla** uzantı onayını değiştirmez. Bkz. [Panel uzantıları](extensions.md).

## Konuşma dökümü ayrıntıları ve ileti düzenleyicisi boyutu {#transcript-composer}

1. Konuşma dökümü ayrıntısı varsayılanlarını seçmek için **Sohbet** öğesini açın. Ön ayarlar **Hiçbir şey**, **Minimal**, **Dengeli** ve **Her şey**'dir; bireysel değişiklikler **Özel** öğesini üretir.
2. Düşünme, tanılama, araç girdileri, tokenlar, sistem mesajları ve her araç türü için her satırın **Varsayılan durum** ayarını (**Gizli**, **Daraltılmış** veya **Genişletilmiş**) belirleyin ya da bu seçimleri paylaşan, konuşmanın **Mesaj içeriği** açılır penceresini kullanın.
3. **Genel** bölümünde gerektiği gibi **Mesaj zaman çizelgesini göster**, **Araç çağrısı diff'lerini böl** ve **Gönderilen istemleri kuyruğa al** (oturum çalışırken gönderilen istemleri yönlendirmek yerine kuyruğa alır) seçeneklerini işaretleyin.
4. Yeniden boyutlandırma kontrolünü kullanarak ileti düzenleyicisini yeniden boyutlandırın; uzun taslaklar alanın içinde kayar.

Zaman çizelgesinde, konuşmada gösterilen her yanıt, akıl yürütme, araç, sıkıştırma ve sistem bağlamı için aynı sırayla bir işaretçi bulunur. İşaretçiler **Mesaj içeriği** ayarlarını izler: orada bir araç türünü, akıl yürütmeyi veya sistem mesajlarını gizlemek, bekleyen izni olan araç dışında bunların işaretçilerini de gizler; **Hiçbir şey** tüm araç işaretçilerini gizler. Görünürlük ve genişletme ayarları yalnızca sunumu değiştirir. Saklanan araçları/akıl yürütmeyi kaldırmaz veya model bağlamını sıkıştırmaz. Yıkıcı işlemler için bkz. [Geçmiş ve temizleme](history.md).

İleti düzenleyicisinin yüksekliği ekran klavyesi dahil görünür konuşmayı izler: en az 44 piksel tabanıyla minimum %8, maksimum %60. Elle seçilen yükseklik oran olarak saklanır; dar genişlik ve uzun metin sınırları yükseltmez. Genişletilmiş izin/soru, kayıtlı yüksekliği veya taslağı değiştirmeden düzenleyiciyi geçici küçültür. Yeniden boyutlandırmaya dönmek için isteği daraltın veya sonuçlandırın.

## Bildirimler ve rozetler {#notifications}

1. **Bildirimler** öğesini açın. Her bildirim türü için nerede görüneceğini işaretleyin: **Ekranda** (geçici bir baloncuk), **Geçmiş** (sekme çubuğundaki, macOS masaüstü uygulamasında başlık çubuğundaki zilin bildirim geçmişinde saklanır) ve **Sistem** (işletim sistemi bildirimi).
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
