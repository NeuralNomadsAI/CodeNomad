# Ayarlar ve düzen

## Ayarları açın ve kapsamını belirleyin {#open-settings}

1. Ana sayfadan veya komut paletinden **Ayarlar** öğesini açın.
2. Bir bölüm seçin. Yerel Electron ve Tauri pencereleri bir yerel Tercihler penceresini açar veya odaklar; tarayıcı ve uzak görünümler yerleşik ayarlar ekranını kullanır.
3. Ayrılmadan önce ayarın kapsamını ve herhangi bir **Kaydet** eylemini kontrol edin.

Çoğu anahtar hemen uygulanır. Ses, paletler ve Görev tercihleri gibi düzenleyicilerde açık kaydetme kontrolleri vardır. Kaydetmenin başarısız olması değişikliğin uygulandığını doğrulamaz; yeniden denemeden önce ilgili bölümü yeniden açın veya yenileyin.

| Durum | Neyi yönetir |
| --- | --- |
| CodeNomad yapılandırması | Bu yapılandırmayı kullanan istemcilerin arayüz tercihleri, ses, SideCars ve sunucu ayarları. Arayüzdeki “Cihaz” rozeti, aynı yapılandırmayı paylaşan başka istemciden yalıtım garantisi değildir. |
| Pencere/proje sekmesi düzeni | Açık paneller, seçilen sekmeler, okuyucu durumu ve geri yüklenebilir taslaklar/düzen. Bunlar OpenCode yapılandırması değildir. |
| Genel/Proje OpenCode ayarları | Görüntülenen kapsamda yerel eklenti/yapılandırma değişiklikleri. Proje kontrolleri etkin bir proje/Location gerektirir. |
| Masaüstü veri profili | Yerel pencereler, yapılandırma dosyasından ve paylaşılan OpenCode hizmetinden bağımsız olarak geri yükleme durumu ve tarayıcı depolaması. Bkz. [Masaüstü pencereleri ve veriler](desktop.md). |

Görüntü tercihlerinin değiştirilmesi OpenCode'u yeniden başlatmaz veya bir istemi yeniden oynatmaz. Yerel yapılandırma, hizmet bakımı ve kimlik bilgilerinin ayrı etkileri vardır: bkz. [OpenCode kurulumu](opencode.md), [Sağlayıcılar](providers.md) ve [Entegrasyonlar](integrations.md).

## Dil ve görünüm {#language-appearance}

1. **Genel** bölümünde **Dil** öğesini seçin: İngilizce, İspanyolca, Fransızca, Rusça, Japonca, Basitleştirilmiş Çince, İbranice, Almanca, Nepalce veya Türkçe.
2. **Görünüm modu** öğesini seçin: **Otomatik**, **Açık** veya **Koyu**. Otomatik işletim sistemini takip eder.
3. Görüntülenen görünüm için bir palet seçin. Açık ve koyu seçimler bağımsız olarak kaydedilir; Otomatik eşleşeni kullanır.
4. Özel renkler için renk örneklerini ve **Kaydet** öğesini kullanın; **Sıfırla** bu paletin renklerini geri kazandırır. Ayrı bir paleti adlandırmak için **Yeni** öğesini kullanın.

Kullanıcı arayüzü, bir konuşmayı yeniden başlatmadan güncellenir. İbranice sağdan sola düzeni kullanır; kod ve teknik değerler kendi yönlerinde okunabilir durumda kalır. Dil seçimi, mevcut mesajların veya aracı talimatlarının dilini değil, arayüz metnini değiştirir. Yerel işletim sistemi menüleri İngilizce kalabilir.

Renklerin okunması zorlaşırsa yerleşik bir palet seçin veya düzenlenen paleti sıfırlayın. Paletler arasında geçiş yapmak, kaydedilmemiş renk düzenlemelerini iptal etmenizi isteyebilir; bir konuşma taslağını atmaz.

## Paneller ve Durum bölümleri {#panels-status}

1. Panelleri göstermek/gizlemek için dış başlık köşelerindeki **Sol panel** ve **Sağ panel** kontrollerini veya **View** menüsündeki karşılıklarını kullanın.
2. Sağ panelde **Sağ paneli özelleştir** öğesini açın. Yerleşik sekmeleri ve Durum bölümlerini seçmek için onay kutularını kullanın; en az bir Durum bölümü görünür durumda kalır.
3. Yeniden sıralamak için sağ panel sekmelerini sürükleyin. Yerleşik düzen seçeneklerini geri yüklemek için **Sıfırla** öğesini kullanın.

Durum; belirteç bilgilerini, Yolo modunu, sağlayıcı Kullanımı, arka plan işlemlerini, MCP ve Eklentileri içerir. Bir bölümün gizlenmesi, o bölümün hizmetini devre dışı bırakmaz veya izinleri iptal etmez. Dar düzenler, panelleri konuşmayı sıkıştırmak yerine üzerinde gezdirir; bir yüzer panelin açılması diğerini kapatır.

Yerleşik düzen proje değişikliği değil, pencere yerleşimidir. Uzantı onay kutuları farklıdır: yapılandırmayı kullanan tüm projelerde kodu etkinleştirir. **Sıfırla** uzantı onayını değiştirmez. Bkz. [Panel uzantıları](extensions.md).

## Konuşma dökümü ayrıntıları ve ileti düzenleyicisi boyutu {#transcript-composer}

1. Konuşma dökümü ayrıntısı varsayılanlarını seçmek için **Sohbet** öğesini açın. Ön ayarlar **Hiçbir şey**, **Minimal**, **Dengeli** ve **Her şey**'dir; bireysel değişiklikler **Özel** öğesini üretir.
2. Düşünceyi, araç girişlerini/çıkışlarını, teşhisleri ve belirteç ayrıntılarını ayarlayın veya paylaşılan görünürlük kontrolleri için görüşmenin **Mesaj içeriği** açılır penceresini kullanın.
3. **Genel** bölümünde **Mesaj zaman çizelgesi**, **Zaman çizelgesi araç çağrıları**, **Diff görünümü** ve **Takip davranışı** öğesini gerektiği gibi ayarlayın.
4. Yeniden boyutlandırma kontrolünü kullanarak ileti düzenleyicisini yeniden boyutlandırın; uzun taslaklar alanın içinde kayar.

Görünürlük ve genişletme ayarları yalnızca sunumu değiştirir. Saklanan araçları/akıl yürütmeyi kaldırmaz veya model bağlamını sıkıştırmaz. Yıkıcı işlemler için bkz. [Geçmiş ve temizleme](history.md).

İleti düzenleyicisinin yüksekliği ekran klavyesi dahil görünür konuşmayı izler: en az 44 piksel tabanıyla minimum %8, maksimum %60. Elle seçilen yükseklik oran olarak saklanır; dar genişlik ve uzun metin sınırları yükseltmez. Genişletilmiş izin/soru, kayıtlı yüksekliği veya taslağı değiştirmeden düzenleyiciyi geçici küçültür. Yeniden boyutlandırmaya dönmek için isteği daraltın veya sonuçlandırın.

## Bildirimler ve rozetler {#notifications}

1. **Bildirimler** öğesini açın ve izin verilmediyse **İste** öğesini seçin.
2. **Bildirimleri etkinleştir** öğesini etkinleştirin.
3. **Session girdi bekliyor**, **Session boşta kalıyor** ve **Uygulama odaktayken bildir** seçeneklerini belirleyin.

Tarayıcı/İşletim Sistemi izni cihaza ve uygulama kaynağına aittir; kaydedilmiş bir tercih bir reddi geçersiz kılamaz. Engellenirse tarayıcı veya işletim sistemi ayarlarında bildirimleri etkinleştirin ve ardından buraya geri dönün. Desteklenmeyen ortamlar kontrolün devre dışı kalmasına neden olur.

Zil/okunmamış geçmiş sayısı, tarayıcı favicon noktasını ve yerel uygulama rozetini yönlendirir. Yerel rozetler canlı ana pencereleri bir araya getirir; bunlar çalışan oturumların sayısı veya bir işletim sistemi bildiriminin iletildiğinin kanıtı değildir. PWA başlatıcı rozetleri bu özellik tarafından sağlanmaz.

## Gelişmiş seçenekler {#advanced}

1. **Gelişmiş** öğesini açın.
2. Yalnızca ihtiyacınız olan davranışı değiştirin; anahtarlar CodeNomad tercihleri ​​aracılığıyla kaydedilir. Oturum yürütme ortamını değiştirirken **Ortam Değişkenleri** öğesini ayrı olarak düzenleyin.
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

Klavye yapılandırması için [Klavye kısayolları](shortcuts.md); ses kontrolleri için [Ses girişi ve oynatma](voice.md)'yi kullanın. Başlangıç ​​geri yükleme ve kayıtlı masaüstü profillerini silme, [Masaüstü pencereleri ve veriler](desktop.md) kapsamında ele alınmaktadır.
