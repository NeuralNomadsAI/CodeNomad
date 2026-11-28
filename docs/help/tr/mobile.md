# Mobil ve PWA

Ana bilgisayarda çalışmayı sürdürmek için telefon veya tabletin tarayıcı arayüzünü kullanın. PWA kurmak projelerin, kimlik bilgilerinin veya ajan yürütmesinin yerini değil, arayüzün açılış biçimini değiştirir.

## Bir telefon veya tabletten bağlanın {#connect}

Kayıtlı sunucular boş sekmedeki **Gözat** ve Ayarlar → Sunucular üzerinden kullanılabilir. [Uzak sekmeleri geri yükleme](projects.md#restore-remote-tabs).

1. Ana bilgisayarda **Ayarlar → Uzak Erişim → Uzaktan Kontrol** öğesini açın, ardından **Uzaktan Kontrolü başlat** öğesini seçin.
2. Eşleştirme QR kodunu mobil cihazınızla tarayın ve bağlantıyı kullanmaya devam etmek istediğiniz tarayıcıda açın.
3. Alternatif olarak, [doğrudan erişim](remote-access.md)'yi yapılandırın, ana bilgisayarın ulaşılabilir güvenilir HTTPS URL'sini açın ve sunucu parolasıyla oturum açın.

Uzaktan Kontrol, cihaz eşleştirmeyi gerektirir; doğrudan bağlantılar yönlendirme, ulaşılabilir bir dinleyici ve kimlik doğrulama gerektirir. İş istasyonunuza ulaşmak için telefonda `localhost`'yi kullanmayın. Site verilerini kaybetmek veya tarayıcı profillerini değiştirmek, yeniden oturum açmayı veya eşleştirmeyi gerektirebilir; bkz. [Uzaktan Kontrol](remote-control.md). Tünel engelliyse bunun yerine güvenilir bir HTTPS adresinde eşleştirin; bkz. [Doğrudan HTTPS ile eşleştirin](remote-control.md#direct-https).

## PWA kurun {#install-pwa}

1. Kurulumu destekleyen bir tarayıcıda güvenilir HTTPS üzerinden çalışan CodeNomad URL'sini açın.
2. Chrome/Edge ve benzeri tarayıcılarda, adres çubuğu yükleme işlemini veya sunulduğunda tarayıcının **Install CodeNomad** işlemini kullanın. iPhone/iPad Safari'de **Share → Add to Home Screen** öğesini kullanın; tam ifade işletim sistemine/tarayıcıya bağlıdır.
3. Yeni başlatıcıyı açın ve tarayıcı depolama alanı ayrıysa orada oturum açmayı veya eşleştirmeyi tamamlayın.

Kurulum cihaz/tarayıcı ve origin bazındadır. Telefona Node, Git veya OpenCode kurmaz, arka uç başlatmaz veya native masaüstü entegrasyonu sağlamaz. Başlatıcıyı kaldırmak ana bilgisayardaki konuşmaları silmez; erişimi kaldırırken eşleştirilmiş cihazı ayrıca iptal edin.

### Güvenli içerik ve sertifikalar {#secure-context}

Uzaktan PWA kurulumu ve mikrofon erişimi tarayıcının tanıdığı güvenli bağlam gerektirir. Kullanılan ana bilgisayar adı/IP ile tam eşleşen güvenilir HTTPS sertifikası kullanın. Oluşturulan yerel sertifikaya istemci cihazı/tarayıcı açıkça güvenmelidir; uyarı sayfasını aşmak güvenilir kurulum değildir. Tarayıcının localhost istisnası başka bilgisayarın HTTP LAN adresine değil, o cihaza uygulanır.

Kurulumu düzeltmek için kimlik doğrulamayı veya TLS doğrulamayı kapatmayın.

## Dokunmatik yerleşimlerle çalışın {#touch-layout}

Gezinmeyi ve araçları açmak için **Sol panel** ve **Sağ panel** kontrollerini kullanın. Dar düzenlerde paneller, masaüstü genişliğinde bir tuvali zorlamak yerine konuşmayı üst üste bindirir; bir yüzer panelin açılması diğerini kapatır. Yüzer oturum panelinde bir oturum seçmek, zaten gösterilen oturum olsa bile seçiminizi göstermek için paneli kapatır; **Geri** ve **İleri** paneli açık tutar. Konuşma başlığı eylemleri, alan sınırlı olduğunda taşma menüsüne taşınır.

İleti düzenleyicisi Ajan, Model ve Düşünme kontrollerini alt satırında tutar. Alanın yüksekliği, ekran klavyesi kapalıyken konuşma alanının yüksekliğine göre belirlenir. Klavye açıldığında kontroller ve mesajlar için yer bırakmak üzere alan geçici olarak küçülebilir; kayıtlı yükseklik oranı değişmez. Uzun taslaklar yine kaydırılabilir. Yalnızca dokunmatik cihazlarda gönderme ekran klavyesini yeniden açmaz; böylece yanıtı okuyabilirsiniz, devam etmek için ileti düzenleyicisine dokunun. Bir oturum çalışırken ileti düzenleyicisinin **Diğer eylemler** menüsü, normal gönderiminizin yapmadığı davranışı (**Mesajı kuyruğa ekle** veya **Şimdi yönlendir**) donanım klavyesi kısayolu gerektirmeden sunar. İstek açmak kayıtlı yükseklik veya taslağı değiştirmeden ileti düzenleyicisini geçici küçültür. İzin/soruları üstündeki istek panelinde, yanıt eylemlerinin bulunduğu sabit alt bölüm erişilebilir kalacak şekilde yanıtlayın. Bkz. [Konuşmalar](conversations.md) ve [İzinler](permissions.md).

## Yetenek ve bağlantı sınırları {#limits}

| Yetenek | Mobil tarayıcı / PWA |
| --- | --- |
| Projeler, konuşmalar, dosyalar ve izinler | Erişim kontrollerine bağlı olarak bağlı arka uç ana bilgisayarda çalışın. Cihaz ekleri telefondan yüklenir; proje referansları ana bilgisayarda çözümlenir. |
| Yerel masaüstü pencereleri, işletim sistemi menüleri ve ana makineye özgü otomasyon | PWA kurulduğunda sağlanmaz. |
| Tarayıcı önizlemesi | Yerel konuk tarayıcı yetenekleri kazanmaz; geri dönüş oluşturma tarayıcıyla sınırlı kalır. |
| SideCar içeriği ve WebSockets | Bağlantı yoluna bağlıdır; Uzaktan Kontrol SideCar içerik proxy'sini engeller ve ana makine izin verdiği sürece web önizlemelerini WebSocket bağlantılarıyla birlikte sunar. [Tüm kısıtlamalara](remote-control.md) bakın. |
| Mikrofon, pano, bildirimler ve yükleme istemi | Tarayıcı/işletim sistemi desteğine, güvenli içeriğe ve kullanıcı izinlerine bağlıdır. |
| Çevrimdışı çalışma | Çevrimdışı arka uç veya önbelleğe alınmış API geçmişi yok. Statik kullanıcı arayüzü varlıkları önbelleğe alınabilir ancak belgeler ve API yanıtları çevrimdışı bir çalışma alanı değildir. |

Arka ucu erişilebilir tutun. Yeniden denemeden önce işlemin tamamlanıp tamamlanmadığını kontrol edin. PWA kapatmak bağımsız arka ucu durdurmaz; ana bilgisayardaki masaüstü uygulamasından ve arka uçtan çıkmak Uzaktan Kontrolü sonraki başlatmaya kadar kullanılamaz yapar.

Yüklü PWA dahil her tarayıcı sekmesi, açık projelerini, seçili konuşmalarını, gönderilmemiş taslaklarını ve kaydırma konumlarını o sekme için saklar: sayfa yeniden yüklendiğinde veya mobil işletim sistemi onu uygulama değişikliği ya da ekran kilidinden sonra yeniden yüklediğinde geri gelirler. Yeni bir sekme veya işletim sisteminin tamamen kapattığı bir PWA boş sekmeyle açılır. Bunu sekme için **Ayarlar → Genel → Önceki durumu geri yükle** ile kapatın.
