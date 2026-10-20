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
| Bağımsız, yalnızca HTTPS (varsayılan) | Etkin değil | `--host` |
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

9898 veya 9899 portunu varsaymayın: belirtilmeyen portlar doluyken başka port kullanılabilir. Açıkça verilen sıfır olmayan `--https-port` veya `--http-port` portu sabitler ve bağlanamazsa başarısız olur; `0` işletim sisteminden port atamasını ister. Yazdırılan **Local Connection URL** ve **Remote Connection URL** ile yenilenen **Erişilebilir adresler** o çalıştırma için yetkili bilgidir. Tam [sunucu CLI başvurusuna](server.md) bakın.

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

1. Masaüstü ana sayfasında **Sunucular** öğesini ve ardından **Sunucuya Bağlan** öğesini seçin.
2. Güvenilir bir HTTPS kaynağını kullanarak **Sunucu adı** ve **Sunucu URL'si** öğesini girin. **Kendinden imzalı sertifikalar için TLS doğrulamasını atla.** öğesini işaretlemeden bırakın; bunun yerine güven oluşturun.
3. Yer imlerine eklemek için **Kaydet** öğesini veya kaydedip açmak için **Bağlan** öğesini seçin. Bu sunucuda oturum açın.

Yer imleri uzak sunucunun projelerine değil, bu CodeNomad yapılandırmasına aittir. Bir URL'nin kaydedilmesi sunucuyu başlatmaz veya erişim sağlamaz. **Kayıtlı sunucuyu kaldır**, uzak konuşmaları, arka ucu veya kimlik bilgilerini değil, yer işaretini kaldırır.

Uzaktan Kontrol için bunun yerine **Sunucu URL'si** öğesine yeni bir eşleştirme bağlantısı yapıştırın. Yer imi yalnızca tünelin kökenini korur, asla tek kullanımlık eşleştirme kodunu içermez; Cihaz çerezi kaybından sonra yeniden eşleştirme için bkz. [Uzaktan Kontrol](remote-control.md).
