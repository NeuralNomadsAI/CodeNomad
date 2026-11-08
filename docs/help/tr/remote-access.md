# Doğrudan uzaktan erişim

Doğrudan erişim, sunucu şifresini kullanarak CodeNomad'in HTTP/HTTPS dinleyicilerine bağlanır. [Uzaktan Kontrol](remote-control.md)'den farklıdır: eşleştirme için LAN bağlantısı veya gelen bağlantı noktası gerekmez ve her iki yol da sessizce diğerine geri dönmez.

## Bir erişim yolu seçin {#access-paths}

| Yol | Neyi yönetiyorsun |
| --- | --- |
| Aynı makine tarayıcısı | Geridöngü bağlamayı koruyun; yazdırılan yerel URL'yi kullanın. |
| LAN veya VPN | Erişilebilir bir arayüz bağlayın, güvenlik duvarını amaçlanan istemcilerle sınırlandırın ve güvenilir HTTPS'yi kullanın. VPN, CodeNomad dinleyicisini sizin için yapılandırmaz. |
| SSH yönlendirme | Arka uç geridöngüsünü bağlı tutun; gerçek yazdırılan bağlantı noktasını iletin. Tünel aktarımı korur ancak CodeNomad kimlik doğrulamasının yerini almaz. |
| Ters proxy | Arka ucu özel/geri döngü arayüzünde tutun; güvenilir TLS'yi proxy'de sonlandırın, yukarı akış atlama noktasını koruyun ve uzun ömürlü SSE'yi ve doğrudan erişim araçlarınızın ihtiyaç duyduğu tüm WebSockets'yi destekleyin. |
| Uzaktan Kontrol | Cihazı ana bilgisayardan eşleştirin; Daha dar yüzeyi ve kullanım ömrü için [Uzaktan Kontrol](remote-control.md)'ye bakın. |

Bağlama, güvenlik duvarı kuralları, bağlantı noktası yönlendirme, DNS veya VPN oluşturmaz. Kimliği doğrulanmamış bir HTTP dinleyicisini İnternette yayınlamayın. Çalışma alanı kökü bir güvenlik korumalı alanı değildir; sunucuyu açığa çıkarmadan önce [Güvenlik](security.md) bölümünü okuyun.

## Doğrudan erişimi etkinleştir {#enable-direct-access}

1. Ana bilgisayarda **Ayarlar → Uzak Erişim** öğesini açın ve **Doğrudan erişim (yerel ağ, gelişmiş)** öğesini genişletin.
2. **Sunucu şifresi** altında **Şifre belirle** veya **Şifreyi değiştir** eylemini seçin; **Yeni şifre** ve **Şifreyi onayla** alanlarını doldurup **Şifreyi kaydet** eylemini seçin. Çalışma zamanından sağlanan parola burada değiştirilemez; bkz. [Güvenlik](security.md).
3. **Dinleme modu** altında **Diğer IP'lerden bağlantılara izin ver** öğesini açın. Yeniden başlatma uyarısını okuyun ve yalnızca geçici kesintiye hazır olduğunuzda **Şimdi yeniden başlat** öğesini seçin.
4. Yeniden başlattıktan sonra **Yenile** öğesini kullanın ve **Erişilebilir adresler** öğesini kontrol edin. Ulaşılabilir HTTPS adresini diğer cihazda açın veya ana bilgisayarda **QR göster** öğesini seçip diğer cihazla tarayın ve ardından oturum açın.

Bu, tek projeyi veya Uzaktan Kontrolü değil, ana bilgisayarın doğrudan dinleme modunu değiştirir. Sunucu localhost dışını dinlerken bölüm kendiliğinden açılır. Otomatik yeniden başlatma yoksa CodeNomad'i elle yeniden başlatın; bağımsız kurulumlarda başlangıç `--host` ayarı tutarlı olmalıdır. Dış erişimi kaldırmak için anahtarı kapatıp yeniden başlatın veya CLI'yi loopback bağlamasıyla başlatın. Bu, eşleştirilmiş Uzaktan Kontrol cihazlarını iptal etmez.

### Dinleyici bağlama matrisi {#binding-matrix}

`--host` varsayılan olarak `127.0.0.1`'ye ayarlanır; `localhost` bu adrese normalleşir. Etkin dinleyiciler için aşağıdaki kurallar geçerlidir:

| Başlatma/mod | HTTP şuraya bağlanır: | HTTPS bağlanır |
| --- | --- | --- |
| Bağımsız, yalnızca HTTPS (varsayılan) | Yalnızca özel geri döngü dinleyicisi (aşağıya bakın) | `--host` |
| Bağımsız, yalnızca HTTP | **`--host`**, LAN/joker karakter adresi dahil | Etkin değil |
| Bağımsız, her iki dinleyici | `127.0.0.1`, `--host`'den bağımsız olarak | `--host` |
| Yerel masaüstü arka ucu | HTTP dinleyicisi, ana bilgisayar dahili dinleyicisi de dahil olmak üzere `127.0.0.1`'de kalır | HTTPS etkinleştirildiğinde `--host` |

Her arka uç, Görevler gibi CodeNomad'in kendi paketlenmiş OpenCode eklentileri için `127.0.0.1` üzerinde ayrıca bir HTTP dinleyicisi tutar. HTTP istenmediğinde veya istenen HTTP dinleyicisi `127.0.0.1` ya da `0.0.0.0` dışında bir adrese bağlandığında, arka uç rastgele bir `127.0.0.1` portunda özel bir HTTP dinleyicisi ekler. Bu dinleyici hiçbir zaman yazdırılmaz veya bağlantı adresi olarak sunulmaz, başka makinelerden erişilemez ve aynı kimlik doğrulamalı uygulamayı sunar.

Somut bir LAN adresinin geridöngü bağlantılarını kabul etmesi gerekmez. `0.0.0.0`, tüm IPv4 arayüzleri anlamına gelir; `::` çift yığınlı joker karakter dinleyicisidir. Bir tarayıcıda joker karakter değil, gerçek ulaşılabilir bir adres kullanın. IPv6 bölge tanımlayıcıları `--host`'de desteklenmez.

Bağımsız bir HTTPS dağıtımı için, [önyükleme prosedürü](security.md) aracılığıyla bir parola ayarlayın ve ardından şunu çalıştırın:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

Yalnızca geri döngü HTTP için, örneğin yerel güvenilir bir proxy'nin arkasında:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

9898 veya 9899 portunu varsaymayın: belirtilmeyen portlar doluyken başka port kullanılabilir. Açıkça verilen sıfır olmayan `--https-port` veya HTTP etkinken `--http-port` portu sabitler ve bağlanamazsa başarısız olur; `0` işletim sisteminden port atamasını ister. Yazdırılan **Local Connection URL** ve **Remote Connection URL** ile yenilenen **Erişilebilir adresler** o çalıştırma için yetkili bilgidir. Tam [sunucu CLI başvurusuna](server.md) bakın.

## Güvenilir TLS'yi yapılandırın {#tls}

### Kendi sertifikanızı sağlayın {#custom-certificates}

1. Subject Alternative Names (SANs) alanı istemcilerin gerçekten kullandığı ana bilgisayar adını veya IP adresini kapsayan sertifika edinin.
2. Hem `--tls-key <path>` hem de `--tls-cert <path>`'yi PEM dosyaları olarak sağlayın. Dağıtımınızın bir CA zincirine/paketine ihtiyacı varsa `--tls-ca <path>`'yi ekleyin.
3. CodeNomad'i yeniden başlatın ve istemci aygıtından sertifikayı ve yazdırılan HTTPS adresini doğrulayın.

Özel sertifika dosyaları başlangıçta okunur ve CodeNomad bunları asla yeniden yazmaz. Yenileme ve yenilenen dosyaları yüklemek için yeniden başlatma sizin sorumluluğunuzdadır. `--tlsSANs` oluşturulan sertifikaları yapılandırır; sağlanan sertifikaya ad ekleyemez. Özel anahtarları koruyun ve yalnızca ana bilgisayar kimliğini doğruladığınız sertifikalara güvenin.

### Oluşturulan yerel CA'yı kullanın {#generated-certificates}

HTTPS etkinken ve anahtar/sertifika çifti sağlanmadığında, CodeNomad, yapılandırma tabanı altında yerel bir CA ve sunucu sertifikası oluşturur:

| Dosya | Amaç |
| --- | --- |
| `tls/ca-cert.pem` | Yönettiğiniz istemcilere güvenli bir şekilde dağıtmak için genel CA sertifikası. |
| `tls/ca-key.pem` | CA özel anahtarı; asla dağıtmayın. |
| `tls/server-cert.pem` | Sunucu sertifikası. |
| `tls/server-key.pem` | Sunucu özel anahtarı; asla dağıtmayın. |

1. `--tlsSANs "host.example.test,192.0.2.10"` kullanarak istemciye yönelik tüm DNS adlarını/IP'lerini ekleyin. Joker karakter bağlama, SANs için tüm LAN adreslerinizi keşfetmez.
2. Sertifikayı oluşturmak/yeniden kontrol etmek için arka ucu yeniden başlatın.
3. Ana makineyi/CA'yı güvenilir bir kanal aracılığıyla doğrulayın ve ardından **yalnızca CA sertifikasını** amaçlanan her istemci/tarayıcı güven deposuna aktarın. Alternatif olarak genel olarak güvenilen bir sertifika veya TLS ters proxy kullanın.

Oluşturulan sunucu sertifikası 30 gün geçerlidir. Başlangıçta, bitimine üç gün veya daha az kaldığında, gerekli SANs eksikse, sertifika kontrolleri başarısızsa veya özel anahtar dosyası yoksa yenilenir. Oluşturulan CA 365 gün geçerlidir; süresi dolunca, sertifika kontrolleri başarısızsa veya özel anahtarı yoksa değiştirilir; değiştirilmesi sunucu sertifikasını da yeniden üretir. Mevcut bozuk, okunamayan veya eşleşmeyen özel anahtarlar otomatik onarılmaz. İstemciler yeni CA'ya güvenmelidir. Süreç içinde sürekli yenileme yoktur: uzun süre çalışan kurulumlarda süre dolmadan bilinçli yeniden başlatma planlayın.

Bir istemci bir sertifika uyarısı bildirirse, durdurun ve ana bilgisayar adını, SANs'yi, güven deposunu ve son kullanma tarihini kontrol edin. Doğrulamayı devre dışı bırakmayın veya uyarılara tıklamayı dağıtım prosedürünüz haline getirmeyin. Güvenilir HTTPS, [PWA kurulumu ve mikrofon erişimi](mobile.md) gibi uzak tarayıcı özellikleri için de gereklidir.

## Uzak sunucuyu kaydedin {#saved-servers}

1. Ana sayfadaki **Gözat** bölümünde veya boş sekmenin sağ panelinde **Sunucu adresi veya bağlantısı** alanına adres veya bağlantı girin. Yapıştırmak hemen ekler; Enter yazılan metni onaylar. Sunucu kaydedilir, satırı odaklanır ve seçici yerinde kalır; bağlantı tarama için yerel arka ucu da eşleştirir. Taramak için satıra tıklayın. **Ayarlar → Sunucular** aynı alanı sunar.
2. Güvenilir HTTPS kaynağı kullanın. Sertifika ve erişilemeyen sunucu hataları çevrilmiştir; bilgi denetimi teknik ayrıntıları isteğe bağlı gösterir. **TLS doğrulamasını atla** açık seçim gerektirir: yalnızca güvenilir sunucuda kullanıp yeniden onaylayın. Açma eylemi, proje seçilirken profilin ayrı pencere kullanacağını belirtir.
3. Sunucu adı oturum açarken ve gezinirken görünür kalır; alanlar etiketlidir, **Son kullanılanlar** ve **Klasörler** ayrıdır. Eşleştirme hataları sunucuyu adlandırır. **Ayarlar → Sunucular** içindeki **Sunucuyu düzenle** URL ve adı değiştirir; `i` düğmeleri URL/TLS yardımını istek üzerine gösterir.

**Ayarlar → Sunucular** profilleri yönetir (**Sunucuyu düzenle**, **Kayıtlı sunucuyu kaldır**). Kaldırma önce arka uçtaki tarama kimlik bilgilerini ve oturumunu unutur, ardından yer imini kaldırıp sekmelerini kapatır. Uzak projeler ve konuşmalar sunucuda kalır. Yerel arka uç tarama sırlarını yapılandırmasının yanında `remote-server-credentials.json` içinde saklar; bu dosyayı parola gibi koruyun.

Kayıtlı bir sunucuyu doğrudan komut satırından açmak için masaüstü uygulamasını sunucunun kayıtlı adıyla veya `https://` URL'siyle `--connect-server <ad>` (ya da `--connect-server=<ad>`) seçeneğiyle başlatın. CodeNomad yalnızca uzak pencereyi açar; profilin TLS denetimlerini ve yerel uzak pencerenin kendi oturum açma işlemini kullanır. CodeNomad zaten çalışıyorsa sunucuyu yeni bir pencere yerine geçerli penceresi açar. Hiçbir kayıtlı sunucuyla eşleşmeyen bir URL, ana bilgisayar adıyla kaydedilir. Başlatma değerleri hiçbir zaman kimlik bilgisi taşımaz: kullanıcı adı, parola veya eşleştirme kodu içeren bir URL reddedilir. Ad bilinmiyorsa, URL geçersizse veya bağlantı başarısız olursa CodeNomad normal şekilde başlar ve hatayı gösterir. Bağlantı, kendinden imzalı bir sunucu için yerel sertifikanın yüklenmesi gibi bir onay gerektirdiğinde de CodeNomad normal şekilde başlar ve onayı orada ister. Windows'ta bir başlatma bağımsız değişkeni `|` içerdiğinde Tauri derlemesi başlamaz; bunun yerine sunucunun URL'sini kullanın veya sunucuyu yeniden adlandırın.

Uzak pencere bu bilgisayara dönmenin bir yolunu her zaman bırakır. Uzak pencereler açık kalırken son yerel pencereyi kapatmak sekmelerini korur: uzak penceredeki **Pencere → Yeni pencere** ya da CodeNomad'ı yeniden başlatmak onu yeniden açar. Bir sunucu yüklenemezse penceresi bunu bildirir ve **Yeniden dene**, **Yerel pencere aç** ve **Pencereyi kapat** seçeneklerini sunar; Tauri sürümünde sayfanın yeniden yükleme düğmesini ve **Pencere → Yeni pencere** öğesini kullanın.

Yeni bir Uzaktan Kontrol bağlantısı yapıştırmak tünel kökenini kaydeder ve yerel arka ucu tarama için eşleştirir. Cihaz kimlik bilgisi başlatmalar arasında özel olarak saklanır; kod denemeden sonra silinir. İptal sonrasında **Gözat'a dön** seçeneğini kullanıp **Sunucu adresi veya bağlantısı** alanına yeni bağlantı yapıştırın. Gömülü görünümler cihazın çerezini, ömrünü ve iptalini paylaşır. Sunucu tarafında eşleştirme kullanılamıyorsa uzak sunucuyu güncelleyin veya parolayla giriş için doğrudan dinleyici URL'sini kullanın; tünel adresleri eşleştirme gerektirir. Bkz. [Uzaktan Kontrol](remote-control.md).

## Uzak bir projeyi sekmede açın {#remote-project-tabs}

Masaüstü uygulamasında (Electron veya Windows'ta Tauri), kayıtlı bir sunucu projelerinden birini yerel projelerinizin yanında bu pencerenin bir sekmesinde de açabilir:

1. Ana sayfa veya boş sekmede **Gözat** bölümünden sunucu seçin. Sunucu eklemek için **Sunucu adresi veya bağlantısı** alanını kullanıp satırına tıklayın.
2. Gerekirse etiketli satır içi formda oturum açın. Sunucunun klasörleri, düzenlenebilir bir yolun altında yerinde görünür: içine girmek için bir klasöre veya yukarı çıkmak için **Üst klasör** seçeneğine tıklayın, ardından o klasörü açmak için Enter tuşuna ya da yolun sonundaki oka basın. Sunucunun son projeleri **Son sekmeler** içinde görünür. **Gözat'a dön** sunucu listesine döner.
3. Klasör seçimi boş sekmenin yerine yeni uzak örnek oluşturur ve **Son kullanılanlar** listesine ekler. Ayrı **Aç** eylemi mevcut örneğe geçer. TLS ve Tauri macOS/Linux dahil ayrı pencere kullanılacağı seçim anında belirtilir.

Sekmenin konuşmaları, dosyaları, Git'i, ayarları ve Missions uzak sunucuda çalışır. Gömülü görünüm sunucunun uzak pencere depolamasını paylaşır. Yerel arka uç çerezsiz yeni parola girişiyle özel bir oturum hazırlar. Saklanan parolayı renderer veya yerel ana bilgisayara asla iletmeyin. Kökene bağlı çerez, gömülü URL açılmadan önce renderer üzerinden geçici olarak yerel çerez deposuna aktarılır. Bu çerezi asla günlüklere veya arayüz durumuna kaydetmeyin. Eşleştirilmiş erişim mevcut cihaz çerezini, ömrünü ve iptalini paylaşır; cihaz kimlik doğrulamasını ayırmak ayrı bir mekanizma gerektirir.

Son kullanılan uzak proje için kimlik bilgileri eksikse ana sayfa, yeni sekmenin solundaki **Son sekmeler** ve `+` menüsü proje sekmesini açmadan önce formu yerinde gösterir. Geri yüklenen sekme formu kendi içinde gösterir. Kullanıcı adı her zaman `codenomad`, ilk odak paroladadır ve hatalar yeniden denemek için formda kalır. İptal edilen cihaz için yukarıdaki eşleştirme onarımını kullanın.

Uzak sekmeler başlangıçta geri yüklenir. Gömülü modu olmayan sunucular tam arayüzü gösterir; TLS doğrulamasını atlayan profiller ve macOS/Linux'ta Tauri ayrı pencere açar. Gömülü sayfa kendi sunucusunda kalır ve ana bilgisayarda yalnızca bildirim erişimine sahiptir. Web istemcilerinde ve Uzaktan Kontrol cihazlarında uzak sekme yoktur.

Arka uç taraması, geri döngü, RFC1918 LAN, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS ve `*.ts.net`, IPv6 ULA/link-local ve bu adreslere çözümlenen adlar dahil her kayıtlı profilin hedef adresini kabul eder. Ağ rotalarınız ve TLS yapılandırmanız bağlantıya izin vermelidir. Sertifika doğrulaması kayıtlı profili ve açık TLS onayını izler.
