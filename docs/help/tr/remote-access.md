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
| Bağımsız, yalnızca HTTPS (varsayılan) | Yalnızca özel geri döngü dinleyicisi | `--host` |
| Bağımsız, yalnızca HTTP | **`--host`**, LAN/joker karakter adresi dahil | Etkin değil |
| Bağımsız, her iki dinleyici | `127.0.0.1`, `--host`'den bağımsız olarak | `--host` |
| Yerel masaüstü arka ucu | HTTP dinleyicisi, ana bilgisayar dahili dinleyicisi de dahil olmak üzere `127.0.0.1`'de kalır | HTTPS etkinleştirildiğinde `--host` |

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

## Yönetici ilkesi {#administrator-policy}

Bir yönetici dinleme adresini sabitleyebilir: `CODENOMAD_LOCKED_HOST` değişkenini sistem genelinde sunucunun kullanması gereken adrese ayarlayın ve CodeNomad'ı yeniden başlatın. Bu adres `--host`, `CLI_HOST` ve **Diğer IP'lerden bağlantılara izin ver** üzerinde önceliklidir; anahtar sonucu gösterir ama değiştiremez. Çalışma arkadaşlarınızın sunucuya şirket ağı üzerinden ulaşması için bir intranet adresi, bu bilgisayarda tutmak için `127.0.0.1` kullanın. Tüm erişimin şirket ağı içinde kalması için ayrıca `CODENOMAD_REMOTE_CONTROL=disabled` ayarlayın ([Uzaktan Kontrol](remote-control.md#administrator-policy)).

## Yükseltme {#upgrading}

Yükseltmeden sonra yeniden oturum açın. Ana bilgisayar adı takma adı, ters proxy veya ayrı barındırılan arayüz için arka uçta `CODENOMAD_ALLOWED_ORIGINS` değerini arayüzün güvenilir origin adreslerine (şema, ana bilgisayar adı ve port) ayarlayın. Yerel LAN istemcileri, değişiklik isteklerinde izin verilen bir `Origin` başlığı göndermelidir. HTTPS origin adresleri, ana bilgisayarın cihazları tünel olmadan eşleştirmesine de olanak tanır; bkz. [Doğrudan HTTPS ile eşleştirin](remote-control.md#direct-https).

Ana bilgisayara özel işlemler için loopback bağlantısı kullanın: SideCar içeriği (`/sidecars/`) ve WebSocket'ler, Uzaktan Kontrol yönetimi (`/api/remote-control/`), eklenti köprüsü (`/api/opencode-plugin/`), uzak proxy'ler (`/api/remote-proxy/`), kayıtlı sunucu yönetimi (`/api/remote-servers/`), parola değişikliği ve belirteçle ilk kurulum. Doğrudan LAN erişimiyle oturum açıldığında da bu işlemler loopback gerektirir. Tek istisna SideCars'tır: ana bilgisayardaki **SideCars'ı HTTPS üzerinden aç** ayarı, içeriklerini ve WebSocket'lerini güvenilir bir HTTPS origin üzerinden oturum açmış tarayıcılara açar ([SideCars](browser-sidecars.md#register-sidecar)). Etkin önizleme içeriği (`/previews/`), geçerli bir yetenek belirteciyle doğrudan LAN erişiminde kullanılabilir.

`/api/sidecars` kayıt API'leri, kimliği doğrulanmış doğrudan LAN istemcileri ve eşleştirilmiş cihazlar için kullanılabilir kalır. Uzaktan Kontrol web önizlemeleri, ana bilgisayarda etkin oldukları sürece yetenek belirteçleriyle kullanılabilir.

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

Oluşturulan sunucu sertifikası 30 gün geçerlidir. Başlangıçta, bitimine üç gün veya daha az kaldığında, gerekli SANs eksikse, sertifika kontrolleri başarısızsa veya özel anahtar dosyası yoksa yenilenir. Oluşturulan CA 365 gün geçerlidir; süresi dolunca, sertifika kontrolleri başarısızsa veya özel anahtarı yoksa değiştirilir; değiştirilmesi sunucu sertifikasını da yeniden üretir. İstemciler yeni CA'ya güvenmelidir. Süreç içinde sürekli yenileme yoktur: uzun süre çalışan kurulumlarda süre dolmadan bilinçli yeniden başlatma planlayın.

Bir istemci bir sertifika uyarısı bildirirse, durdurun ve ana bilgisayar adını, SANs'yi, güven deposunu ve son kullanma tarihini kontrol edin. Doğrulamayı devre dışı bırakmayın veya uyarılara tıklamayı dağıtım prosedürünüz haline getirmeyin. Güvenilir HTTPS, [PWA kurulumu ve mikrofon erişimi](mobile.md) gibi uzak tarayıcı özellikleri için de gereklidir.

## Uzak sunucuyu kaydedin {#saved-servers}

Kimliği doğrulanmış uzak istemciler ana bilgisayarda kayıtlı tüm sunucuları kullanabilir ve yönetebilir; ana sayfa ve **Ayarlar → Sunucular**, ana bilgisayarın yeteneklerinin izin verdiği eylemleri gösterir. Düz LAN HTTP, yeni sunucu parolası ve eşleştirme bağlantısı girişini devre dışı bırakır: “Kimlik bilgilerini girmek için HTTPS veya Uzaktan Kontrol kullanın.” Kayıtlı kimlik bilgileriyle bağlantı kurma ve gizli bilgi içermeyen profilleri ekleme, düzenleme veya kaldırma kullanılabilir.

Yalnızca SSH üzerinden erişilen bir hedef için **Ayarlar → Sunucular** bölümünde **Sunucu ekle** seçeneğini açın, **URL** ve **SSH sunucusu (isteğe bağlı)** alanlarını doldurup **Kaydet** seçeneğini kullanın. Profil çevrimdışı kaydedilir; bağlantı backend'in SSH aktarımını kullanır.

**Ayarlar → Sunucular** bölümünü kullanın: **Sunucu adresi veya bağlantısı** alanına adres ya da eşleştirme bağlantısı yapıştırın veya Enter tuşuna basın. Ekleme, proje açmadan ana bilgisayarda bir profil kaydeder. **Sunucuyu düzenle**, **URL** veya isteğe bağlı **Ad** alanını değiştirir; aynı URL ve TLS ilkesiyle ad değiştirme çevrimdışı çalışır. **Kayıtlı sunucuyu kaldır** onay ister, bağlantıyı unutur ve kaldırmayı kaydeder; kayıt hatasında profil yeniden denemek için kalır. Diğer bağlantılar sürer.

**TLS doğrulamasını atla**, o adresin sertifika hatasından sonra sunulur; adres değişince onay silinir. Eşleştirme her zaman TLS doğrular. **Aç**, sunucunun projelerini gösterir.

**SSH sunucusu (isteğe bağlı)**, backend aktarımı için bir OpenSSH sunucusu veya takma adı kaydeder. Öneriler yerel backend hesabının `~/.ssh/config` dosyasından gelir. CodeNomad adresini bu ana makineden görüldüğü şekilde girin (örneğin gerçek bağlantı noktasıyla `https://127.0.0.1:9898`) ve **Kaydet** seçeneğini kullanın. SSH profilleri aktarımı kullanır. CodeNomad orada kurulu ve çalışıyor olmalıdır. Yerel OpenSSH, anahtarla kimlik doğrulama ve `known_hosts` içinde doğrulanmış bir sunucu anahtarı gereklidir; CodeNomad kimlik doğrulaması ve HTTPS sertifika kontrolleri de geçerlidir.

Yalnızca `multiBackend` değeri `false` ise aşağıdaki ayrı masaüstü penceresi adımlarını kullanın:

1. Masaüstü ana sayfasında **CodeNomad Sunucusuna Bağlan** öğesini seçin. Aynı düğme boş bir **Sunucular** sekmesinde ve **Ayarlar → Uzak Erişim → Sunucular** bölümünde de bulunur.
2. **Sunucuya Bağlan** penceresinde, güvenilir bir HTTPS kaynağını kullanarak **Sunucu adı** ve **Sunucu URL'si** öğesini girin. **Kendinden imzalı sertifikalar için TLS doğrulamasını atla.** öğesini işaretlemeden bırakın; bunun yerine güven oluşturun.
3. Yer imlerine eklemek için **Kaydet** öğesini veya kaydedip açmak için **Bağlan** öğesini seçin. Bu sunucuda oturum açın.

Kayıtlı bir sunucuyu yeniden açmak için ana sayfanın **Sunucular** sekmesinde onu seçin. Yer imleri uzak sunucunun projelerine değil, bu CodeNomad yapılandırmasına aittir. Bir URL'nin kaydedilmesi sunucuyu başlatmaz veya erişim sağlamaz. **Kayıtlı sunucuyu kaldır**, uzak konuşmaları, arka ucu veya kimlik bilgilerini değil, yer işaretini kaldırır.

Uzak pencereler açık kalırken son yerel pencereyi kapatmak sekmelerini korur: uzak penceredeki **Pencere → Yeni pencere** ya da CodeNomad'ı yeniden başlatmak onu yeniden açar.

Uzaktan Kontrol için bunun yerine **Sunucu URL'si** öğesine yeni bir eşleştirme bağlantısı yapıştırın. Yer imi yalnızca tünelin kökenini korur, asla tek kullanımlık eşleştirme kodunu içermez; Cihaz çerezi kaybından sonra yeniden eşleştirme için bkz. [Uzaktan Kontrol](remote-control.md).

### `--connect-server` {#connect-server}

Bu komut, `multiBackend` ayarından bağımsız olarak ayrı bir uzak pencere açar. Kayıtlı bir sunucuyu doğrudan komut satırından açmak için masaüstü uygulamasını sunucunun kayıtlı adıyla veya `https://` URL'siyle `--connect-server <ad>` (ya da `--connect-server=<ad>`) seçeneğiyle başlatın. CodeNomad yalnızca uzak pencereyi açar; denetimler ve oturum açma **Bağlan** ile aynıdır. CodeNomad zaten çalışıyorsa sunucuyu yeni bir pencere yerine geçerli penceresi açar. Hiçbir kayıtlı sunucuyla eşleşmeyen bir URL, ana bilgisayar adıyla kaydedilir. Başlatma değerleri hiçbir zaman kimlik bilgisi taşımaz: kullanıcı adı, parola veya eşleştirme kodu içeren bir URL reddedilir. Windows'ta bir başlatma bağımsız değişkeni `|` içerdiğinde Tauri derlemesi başlamaz; bunun yerine sunucunun URL'sini kullanın veya sunucuyu yeniden adlandırın.
