# Uzaktan Kontrol

Uzaktan Kontrol, eşleştirilmiş bir tarayıcının veya masaüstü istemcisinin, gelen bir ağ bağlantı noktasını açmadan çalışan CodeNomad arka ucunuzu kullanmasına olanak tanır. Sunucu parolası, geridöngüsüz `--host` veya VPN gerektirmez. Bu, [doğrudan bağlantılardan](remote-access.md) ayrı bir erişim yoludur.

## Başlatın ve eşleştirin {#start-and-pair}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim** öğesini açın.
2. **Uzaktan Kontrolü başlat** öğesini seçin. **Uzak bağlantılar için hazır** öğesini bekleyin; ilk kullanımda tünel kimliğinin ve sertifikasının sağlanması zaman alabilir.
3. **Başka bir cihaz bağla** altında, QR kodunu tarayın veya **Bağlantıyı kopyala** öğesini seçin, ardından amaçlanan cihazda o tek kullanımlık bağlantıyı açın.
4. Eşleştirilen tarayıcının site verilerini saklayın. Arka uç çalışırken yeniden bağlanmak için tünel adresini yeniden açın.

Bağlantı **beş dakika** süreyle geçerlidir ve **bir kez** başarılı olur. Bunu bir kimlik bilgisi olarak değerlendirin: Bunu tüketen herkes eşleştirilmiş bir cihaz haline gelebilir. Kod, sorgu dizesinde değil, URL parçasında bulunur. **Yeni eşleştirme bağlantısı oluştur**, önceki kullanılmayan bağlantıyı anında geçersiz kılar. Arka uç kapatma bekleyen eşleştirme bağlantısını iptal eder; durdurma ve tünel arızası bir tünel bağlantısını iptal eder.

Başka bir masaüstü CodeNomad uygulamasında eşleştirme bağlantısını şu alana yapıştırın: **Ayarlar → Sunucular → Sunucu adresi veya bağlantısı**.

Yeniden eşleştirmek için yeni bağlantıyı sunucunun veya projenin bağlantı formuna yapıştırın.

## Doğrudan HTTPS ile eşleştirin {#direct-https}

Tünel engellendiğinde ama arka uca güvenilir HTTPS ile ulaşılabildiğinde, örneğin gerçek sertifikalı bir ters proxy üzerinden, cihazlar bu adreste eşleştirilebilir. Uygun adresler bu arka ucun kendi HTTPS adresleri ve `CODENOMAD_ALLOWED_ORIGINS` içindeki HTTPS origin adresleridir (bkz. [İzin verilen kaynaklar](remote-access.md#upgrading)); geri döngü adları ve düz HTTP asla eşleştirmez. Uzaktan Kontrolün başlatılması gerekmez.

1. Ana bilgisayarda **Ayarlar → Uzak Erişim → Uzaktan Kontrol** öğesini açın.
2. **Doğrudan HTTPS eşleştirme** altında, birden fazlaysa **HTTPS adresi** seçin, ardından **HTTPS eşleştirme bağlantısı oluştur** öğesini seçin.
3. Bağlantıyı, tünel bağlantısında olduğu gibi cihazda açın. Bağlantıya başka bir sayfadan tıklayabilirsiniz.

Bağlantı aynı beş dakika ve tek kullanım kurallarına uyar ve kullanılmayan bağlantının yerini alır; tekrarlanan yanlış kodlar sınırlandırılır. Ters proxy güvenilir TLS'yi sonlandırmalı, özgün `Host` ve `Origin` başlıklarını iletmeli ve arka uca geri döngü veya korumalı bir ağ üzerinden ulaşmalıdır.

Böyle bir cihaz yalnızca HTTPS adresi üzerinden bağlanır, asla tünel üzerinden bağlanmaz; **Eşleştirilmiş cihazlar** bu adresi adının altında gösterir. Uzaktan Kontrolü durdurmak bağlantıyı iptal etmez ve bu cihazların bağlantısını kesmez; **İptal et**, 30 gün kullanılmama, 32 cihaz sınırı veya adresin yapılandırmadan kaldırılması erişimlerini sonlandırır. Bu adreste iptal edilmiş veya süresi dolmuş bir cihaz kimlik bilgisi sunan tarayıcı sunucu parolasına geri dönemez: yeniden eşleştirin veya parolayla oturum açmak için site verilerini temizleyin.

SideCar içeriğinin doğrudan HTTPS istisnası için [kullanılabilir özelliklere](#remote-surface) bakın. Eşleştirme, ana bilgisayardaki bir proxy üzerinden bile loopback ayrıcalığı vermez.

## Eşleştirilmiş cihazları yönetin {#paired-devices}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim → Uzaktan Kontrol** öğesine dönün.
2. **Eşleştirilmiş cihazlar** ve **Son görülme** zamanlarını inceleyin. Her cihaz, onu eşleştiren platform ve tarayıcıya göre adlandırılır; örneğin `iPhone · Safari`.
3. Artık bağlanmaması gereken cihaz için **İptal et** eylemini seçin. **İptal beklemede** görünüyorsa ana makineyi yeniden başlatmadan önce tekrar **İptal et** seçeneğini kullanın.

İptal, cihazın mevcut HTTP/SSE bağlantılarını ve gelecekteki erişimini sonlandırır. Yeniden erişim için yeni bağlantıyla eşleştirin. Cihazın süresi **30 gün kullanılmadığında** dolar. **32 cihaz sınırında**, yeni eşleştirme en uzun süredir görülmeyen cihazın yerini alır ve bağlantılarını kapatır.

Site verilerini temizlemek, tarayıcı profillerini değiştirmek veya özel taramayı kullanmak yeniden eşleştirme gerektirebilir.

Doğrudan erişim parolasını değiştirmek cihazları **iptal etmez**. **Uzaktan Kontrolü durdur** tünelin bağlantısını keser ancak eşleştirilmiş cihaz listesini korur; yetkiyi kaldırmak için **İptal et** eylemini kullanın.

### Yerinizi kaybetmeden yeniden eşleştirin {#re-pair}

1. İstemci **Bu cihazı yeniden eşleştirin** gösterirse bu sayfayı açık bırakın.
2. Ana bilgisayarda ilk bağlantı için yeni bir bağlantı oluşturun: tünel için **Yeni eşleştirme bağlantısı oluştur** öğesini seçin veya **Doğrudan HTTPS eşleştirme** bölümünde ilk **HTTPS adresi** değerini seçip **HTTPS eşleştirme bağlantısı oluştur** öğesini kullanın. Bağlantıyı aynı istemci tarayıcısında veya profilinde açın. Ayrı bir uzak pencere mevcut depolama alanını yeniden kullanır.
3. Bekleme sayfasına dönün ve **Bağlantıyı kontrol et** öğesini seçin; sayfa yeniden odak kazandığında da kontrol tekrarlanır.

Kurtarma, açık sayfayı ve taslakları korur; başarısız bir eylemi tekrarlamaz. Yeniden denemeden önce bir gönderme, yanıtlama veya silme işleminin etkili olup olmadığını kontrol edin. Doğrudan erişim parolası Uzaktan Kontrol eşleştirmesini kurtaramaz.

## Kullanılabilirlik ve kullanım ömrü {#lifetime}

| Eylem/durum | Etki |
| --- | --- |
| Uzaktan Kontrolü başlat | Bu arka ucu bağlar ve sonraki başlatmalar için seçimi hatırlar. |
| Uzak tarayıcıyı kapatın | Ana bilgisayar arka ucunu durdurmaz veya cihazı iptal etmez. |
| Uzaktan Kontrolü durdur | Tünel erişimini keser ve başlangıçta otomatik sürdürme tercihini temizler; cihaz kayıtlarını korur. |
| Arka uç kapatma / son masaüstü penceresi kapatılır ve uygulama sonlandırılır | Uzaktan Kontrol çevrimdışı oluyor. OpenCode'un paylaşılan hizmeti çalışmaya devam edebilir ancak bu kullanıcı arayüzüne durdurulmuş bir arka uç aracılığıyla hizmet veremez. |
| Uzaktan Kontrol başlatıldıktan sonra başlat | Yeni bir eşleştirme bağlantısı vermeden arka planda yeniden bağlanır. Hiç başlatılmayan kurulumlar kendilerini etkinleştirmez. |

Başlangıçta otomatik sürdürme yapılandırma dizini başına tek arka uçla sınırlıdır. Ek tünel kapasitesi için aynı yapılandırmayla birbiriyle yarışan ana bilgisayar süreçleri başlatmayın. Masaüstünden çıktıktan sonra erişilebilir kalması gereken ana bilgisayar için ayrıca yönetilen [bağımsız sunucu](server.md) kurun; Uzaktan Kontrol bağımsız bir daemon değildir.

## Mevcut ve mevcut olmayan yüzeyler {#remote-surface}

Eşleştirilen cihazlar sıradan proje/konuşma API'lerini kullanabilir, istemler gönderebilir, dosyaları inceleyebilir ve aynı sahiplik kontrollerine tabi olan izinleri/Formları yanıtlayabilir. Eşleştirme, salt okunur bir paylaşım bağlantısı değil, güçlü bir erişimdir. Tünel trafiği ana bilgisayar üzerinde dahili olarak iletse bile hiçbir zaman geridöngü ayrıcalıkları vermez.

| Yüzey | Uzaktan Kontrol üzerinden |
| --- | --- |
| Normal kimlik doğrulamalı kullanıcı arayüzü, çalışma alanları, konuşmalar ve SSE | Eşleştirilmiş bir cihazda kullanılabilir. |
| Parolayla giriş/çıkış, parola değişiklikleri, yerel belirteç önyüklemesi | Mevcut değil; doğrudan kimlik doğrulama devre dışı bırakılsa bile cihaz kimlik bilgileri gereklidir. |
| Uzaktan Kontrol durumu | Eşleştirilmiş bir cihaz tarafından okunabilir; yönetim mevcut değildir. Başlat/Durdur, eşleştirme oluşturma, cihaz listesi ve iptal etme, ana bilgisayar erişim yolunda kalır. |
| Kayıtlı sunucular ve arka uç aktarımı | Özellik ve ana bilgisayar yetenekleri izin verdiğinde kimliği doğrulanmış uzak istemciler tüm kayıtlı sunucuları kullanabilir/yönetebilir. Yeni sunucu parolaları/eşleştirme bağlantıları düz LAN HTTP yerine Uzaktan Kontrol veya HTTPS gerektirir. [Kayıtlı sunuculara](remote-access.md#saved-servers) bakın. |
| Masaüstü uzak pencereleri ve pencere proxy'si | Yalnızca ana bilgisayarda (`/api/remote-proxy/`). |
| SideCar içeriği ve WebSocket'leri (`/sidecars/`) | Tünel üzerinden kullanılamaz. Loopback kullanın veya ana bilgisayarda [SideCar için doğrudan HTTPS erişimini](browser-sidecars.md#register-sidecar) etkinleştirin. |
| SideCar kaydı (`/api/sidecars`) | Eşleştirilmiş cihazlar ve kimliği doğrulanmış doğrudan istemciler için kullanılabilir. |
| Web önizleme içeriği | [Bir oturum tarayıcısı açın](browser-sidecars.md#session-browser) |
| Otomasyon köprüsü | Kullanılamaz (`/api/opencode-plugin/`). Native masaüstü yetenekleri tarayıcı yeteneğine dönüşmez. |
| WebSocket yükseltmeleri | Web önizlemelerinde ve eşleştirilmiş cihazlarda [canlı sesli konuşmalarda](voice.md#conversation) kullanılabilir. |

Ana bilgisayara özel proxy/WebSocket yüzeyleri ve Uzaktan Kontrol yönetimi (`/api/remote-control/`) için ana bilgisayarda loopback bağlantısı kullanın. Doğrudan LAN erişiminde de bu işlemler loopback gerektirir; bkz. [İzin verilen kaynaklar](remote-access.md#upgrading).

## Aktarma ve gizlilik {#relay-privacy}

CodeNomad [OpenTunnel](https://github.com/anomalyco/opentunnel) kullanır ve makinenin ortak varsayılan tünel kimliğinde rastgele bir rota alır.

TLS, CodeNomad arka ucunda sonlanır. Röle şifreli metni iletir ve uygulama içeriğini okuyamaz ancak ana bilgisayar adlarını, bağlantı zamanlamasını ve trafik boyutlarını gözlemleyebilir. Tünel sertifikası/özel anahtar ana bilgisayarda kalır. Ana bilgisayarın tünel depolamasını ve CodeNomad yapılandırmasını kimlik bilgileri olarak koruyun; Tahmin edilemeyen bir adres yetkilendirme değildir.

`CODENOMAD_REMOTE_CONTROL_API`, kendi barındırdığınız OpenTunnel API hizmetini seçer; tanımsızsa barındırılan hizmet kullanılır. Bu, eşleştirme gereksinimlerini veya engelli yüzeyleri değil, tünel kurulumunu değiştirir. Kimlik bilgileri ve tanılama işlemleri için [Güvenlik](security.md) sayfasına bakın.

## Yönetici ilkesi {#administrator-policy}

Bir yönetici, bir bilgisayardaki tüm kullanıcılar için Uzaktan Kontrol'ü kapatabilir: `CODENOMAD_REMOTE_CONTROL=disabled` ortam değişkenini sistem genelinde ayarlayın ve CodeNomad'ı yeniden başlatın. Arka uç hiçbir zaman tünel bağlamaz, **Uzaktan Kontrolü başlat** ve eşleştirme bağlantılarını reddeder ve açılışta yeniden bağlanmaz; ayarlarda **Yönetici tarafından devre dışı** görünür. Daha önce eşleştirilmiş cihazlar bağlanamaz ve iptal edebilmeniz için listede kalır. Ayarlanmamış veya boş değer ilke uygulamaz; yalnızca boşluk dahil başka herhangi bir değer arka ucun başlamasını engeller.
