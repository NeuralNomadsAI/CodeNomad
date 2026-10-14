# Uzaktan Kontrol

Uzaktan Kontrol, eşleştirilmiş bir tarayıcının veya masaüstü istemcisinin, gelen bir ağ bağlantı noktasını açmadan çalışan CodeNomad arka ucunuzu kullanmasına olanak tanır. Sunucu parolası, geridöngüsüz `--host` veya VPN gerektirmez. Bu, [doğrudan bağlantılardan](remote-access.md)'den ayrı bir erişim yoludur.

## Başlatın ve eşleştirin {#start-and-pair}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim** öğesini açın.
2. **Uzaktan Kontrolü başlat** öğesini seçin. **Uzak bağlantılar için hazır** öğesini bekleyin; ilk kullanımda tünel kimliğinin ve sertifikasının sağlanması zaman alabilir.
3. **Başka bir cihaz bağla** altında, QR kodunu tarayın veya **Bağlantıyı kopyala** öğesini seçin, ardından amaçlanan cihazda o tek kullanımlık bağlantıyı açın.
4. Eşleştirilen tarayıcının site verilerini saklayın. Arka uç çalışırken yeniden bağlanmak için tünel adresini yeniden açın.

Bağlantı **beş dakika** süreyle geçerlidir ve **bir kez** başarılı olur. Bunu bir kimlik bilgisi olarak değerlendirin: Bunu tüketen herkes eşleştirilmiş bir cihaz haline gelebilir. Kod, sorgu dizesinde değil, URL parçasında bulunur. **Yeni eşleştirme bağlantısı oluştur**, önceki kullanılmayan bağlantıyı anında geçersiz kılar. Durdurma, arka uç kapatma ve tünel arızası, bekleyen eşleştirme bağlantılarını iptal eder.

Başka masaüstü CodeNomad istemcisini eşleştirmek için **Sunucular → Sunucuya Bağlan** yolunu açın, bağlantıyı **Sunucu URL'si** alanına yapıştırıp **Bağlan** eylemini seçin. Yer imi yalnızca tünelin origin adresini saklar; kod saklanmaz. Eşleştirme bağlantılarında TLS doğrulaması etkin kalır.

## Eşleştirilmiş cihazları yönetin {#paired-devices}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim → Uzaktan Kontrol** öğesine dönün.
2. **Eşleştirilmiş cihazlar** ve **Son görülme** zamanlarını inceleyin.
3. Artık bağlanmaması gereken cihaz için **İptal et** eylemini seçin.

İptal, cihazın mevcut HTTP/SSE bağlantılarını ve gelecekteki erişimini sonlandırır. Yeniden erişim için yeni bağlantıyla eşleştirin. Cihazın süresi **30 gün kullanılmadığında** dolar. **32 cihaz sınırında**, yeni eşleştirme en uzun süredir görülmeyen cihazın yerini alır ve bağlantılarını kapatır.

Arka uç, ham cihaz kimlik bilgilerini değil, kimlik bilgisi karmalarını kendi yapılandırma tabanı altında `remote-control-devices.json`'de saklar. İstemci, ana bilgisayar kapsamlı `Secure`, `HttpOnly`, `SameSite=Lax` cihaz çerezine sahiptir. Tarayıcının ömrü, sunucunun 30 günlük hareketsizlik sınırından daha uzun olabilir; kayıt defteri yetkili kalır. Site verilerini temizlemek, tarayıcı profillerini değiştirmek veya özel taramayı kullanmak yeniden eşleştirme gerektirebilir.

Doğrudan erişim parolasını değiştirmek cihazları **iptal etmez**. **Uzaktan Kontrolü durdur** tünelin bağlantısını keser ancak eşleştirilmiş cihaz listesini korur; yetkiyi kaldırmak için **İptal et** eylemini kullanın.

### Yerinizi kaybetmeden yeniden eşleştirin {#re-pair}

1. İstemci cihazın artık eşleştirilmediğini bildirirse bu sayfayı açık bırakın.
2. Ana bilgisayarda **Yeni eşleştirme bağlantısı oluştur** öğesini seçin ve **aynı istemci tarayıcısında/profilinde** açın. Kaydedilmiş bir masaüstü sunucusu için, yeni eşleştirme bağlantısını kullanarak yeniden bağlanın, böylece mevcut uzak pencere depolama alanı yeniden kullanılabilir.
3. Bekleme sayfasına dönün ve kimlik doğrulamayı tekrar kontrol edin.

Kurtarma, açık sayfayı ve taslakları korur; başarısız bir eylemi tekrarlamaz. Yeniden denemeden önce bir gönderme, yanıtlama veya silme işleminin etkili olup olmadığını kontrol edin. Doğrudan erişim parolası Uzaktan Kontrol eşleştirmesini kurtaramaz.

## Kullanılabilirlik ve kullanım ömrü {#lifetime}

| Eylem/durum | Etki |
| --- | --- |
| Uzaktan Kontrolü başlat | Bu arka ucu bağlar ve sonraki başlatmalar için seçimi hatırlar. |
| Uzak tarayıcıyı kapatın | Ana bilgisayar arka ucunu durdurmaz veya cihazı iptal etmez. |
| Uzaktan Kontrolü durdur | Erişimi keser ve başlangıçta otomatik sürdürme tercihini temizler; cihaz kayıtlarını korur. |
| Arka uç kapatma / son masaüstü penceresi kapatılır ve uygulama sonlandırılır | Uzaktan Kontrol çevrimdışı oluyor. OpenCode'un paylaşılan hizmeti çalışmaya devam edebilir ancak bu kullanıcı arayüzüne durdurulmuş bir arka uç aracılığıyla hizmet veremez. |
| Uzaktan Kontrol başlatıldıktan sonra başlat | Yeni bir eşleştirme bağlantısı vermeden arka planda yeniden bağlanır. Hiç başlatılmayan kurulumlar kendilerini etkinleştirmez. |
| Başlangıçta sürdürmenin başarısız olması veya kritik tünel hatası | Hatırlanan tercih korunur; ana bilgisayarda **Yenile** ile inceleyin. **Uzaktan Kontrolü durdur** tercihi temizler; etkin kalırsa sonraki başlatmada yeniden denenir. |

Başlangıçta otomatik sürdürme yapılandırma dizini başına tek arka uçla sınırlıdır. Ek tünel kapasitesi için aynı yapılandırmayla birbiriyle yarışan ana bilgisayar süreçleri başlatmayın. Masaüstünden çıktıktan sonra erişilebilir kalması gereken ana bilgisayar için ayrıca yönetilen [bağımsız sunucu](server.md) kurun; Uzaktan Kontrol bağımsız bir daemon değildir.

## Mevcut ve mevcut olmayan yüzeyler {#remote-surface}

Eşleştirilen cihazlar sıradan proje/konuşma API'lerini kullanabilir, istemler gönderebilir, dosyaları inceleyebilir ve aynı sahiplik kontrollerine tabi olan izinleri/Formları yanıtlayabilir. Eşleştirme, salt okunur bir paylaşım bağlantısı değil, güçlü bir erişimdir. Tünel trafiği ana bilgisayar üzerinde dahili olarak iletse bile hiçbir zaman geridöngü ayrıcalıkları vermez.

| Yüzey | Uzaktan Kontrolyla |
| --- | --- |
| Normal kimlik doğrulamalı kullanıcı arayüzü, çalışma alanları, konuşmalar ve SSE | Eşleştirilmiş bir cihazda kullanılabilir. |
| Parolayla giriş/çıkış, parola değişiklikleri, yerel belirteç önyüklemesi | Mevcut değil; doğrudan kimlik doğrulama devre dışı bırakılsa bile cihaz kimlik bilgileri gereklidir. |
| Uzaktan Kontrol durumu | Eşleştirilmiş bir cihaz tarafından okunabilir; yönetim mevcut değildir. Başlat/Durdur, eşleştirme oluşturma, cihaz listesi ve iptal etme, ana bilgisayar erişim yolunda kalır. |
| Masaüstü uzak pencere/sunucu yönetimi ve proxy rotaları | Kullanılamıyor (`/api/remote-servers/`, `/api/remote-proxy/`). |
| SideCar **içerik proxy'si** | Kullanılamaz (`/sidecars/`). Bu, tüm SideCar API'lerinin engellendiği anlamına **gelmez**: eşleştirilmiş istemciler yine de `/api/sidecars` kayıt API'lerine erişebilir. |
| Önizleme içeriği ve otomasyon köprüsü | Kullanılamaz (`/previews/`, `/api/opencode-plugin/`). Native masaüstü yetenekleri tarayıcı yeteneğine dönüşmez. |
| WebSocket yükseltmeleri | Uzaktan Kontrol girişinde kullanılamaz. |

Bir iş akışı engellenmiş bir proxy/WebSocket yüzeyi gerektirdiğinde uygun şekilde korunan bir [doğrudan bağlantı](remote-access.md) kullanın. Uzaktan Kontrol otomatik olarak bu yola geçmez.

## Aktarma ve gizlilik {#relay-privacy}

CodeNomad [OpenTunnel](https://github.com/anomalyco/opentunnel) kullanır ve makinenin ortak varsayılan tünel kimliğinde rastgele bir rota alır. Durdurmak, diğer uygulamaların kullandığı ortak kimliği değil, CodeNomad köprüsünü serbest bırakır.

TLS, CodeNomad arka ucunda sonlanır. Röle şifreli metni iletir ve uygulama içeriğini okuyamaz ancak ana bilgisayar adlarını, bağlantı zamanlamasını ve trafik boyutlarını gözlemleyebilir. Tünel sertifikası/özel anahtar ana bilgisayarda kalır. Ana bilgisayarın tünel depolamasını ve CodeNomad yapılandırmasını kimlik bilgileri olarak koruyun; Tahmin edilemeyen bir adres yetkilendirme değildir.

`CODENOMAD_REMOTE_CONTROL_API`, kendi barındırdığınız OpenTunnel API hizmetini seçer; tanımsızsa barındırılan hizmet kullanılır. Bu, eşleştirme gereksinimlerini veya engelli yüzeyleri değil, tünel kurulumunu değiştirir. Kimlik bilgileri ve tanılama işlemleri için [Güvenlik](security.md) sayfasına bakın.
