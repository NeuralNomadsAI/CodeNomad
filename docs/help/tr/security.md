# Kimlik doğrulama ve güvenlik

CodeNomad erişimi, OpenCode aracılığıyla arka uç ana bilgisayarında iş yürütmeye olanak tanır. Sunucu parolalarını, tarayıcı oturumlarını ve eşleştirilmiş cihazları güçlü kimlik bilgileri olarak değerlendirin. CodeNomad çok kiracılı bir yürütme korumalı alanı değildir.

## Sunucunun kimlik doğrulama yöntemini seçin {#authentication}

| Yöntem | Süre ve kapsam |
| --- | --- |
| `--password` veya `CODENOMAD_SERVER_PASSWORD` | Bu arka uç sürecine ait çalışma zamanı geçersiz kılmasıdır. Her başlatmada yeniden gerekir; kalıcı kaydedilmez. Yönetilen parola dosyasını geçersiz kılar. |
| Ayarlardan belirlenen parola | Etkin YAML yapılandırmasının yanındaki `auth.json` dosyasına tuzlanmış scrypt özeti kaydeder. Çalışma zamanı geçersiz kılması olmadan sonraki başlatmalarda kullanılır. |
| `--generate-token` | Yerel, tek kullanımlık ilk kurulumu etkinleştirir; yazdırılan belirteç 60 saniye geçerlidir. Yeniden kullanılabilir API belirteci veya Uzaktan Kontrol bağlantısı değildir. |
| Uzaktan Kontrol eşleştirmesi | Ana bilgisayardan yönetilen ayrı cihaz çerezi kimlik doğrulaması; bkz. [Uzaktan Kontrol](remote-control.md). |

Varsayılan kullanıcı adı `codenomad`'dir. Saklanan bir kimlik doğrulama dosyası, kullanıcı adını korur; yalnızca `--username`'yi değiştirmek, saklanan kimliği yeniden adlandırmaz. Yapılandırılmış bir parola, önyükleme modu veya açıkça atlanan kimlik doğrulaması olmadan sunucu başlatmayı reddeder.

Komut bağımsız değişkenlerine veya kabuk geçmişine parola eklemek yerine korumalı bir ortam/hizmet sırrını tercih edin. İşlem ortamınızı veya yapılandırma dizininizi denetleyebilen herhangi biri yine de dağıtımın güvenliğini tehlikeye atabilir.

## İlk kurulumla kalıcı parola belirleyin {#bootstrap}

1. Çalışma zamanı parola geçersiz kılması olmadan yerel olarak başlatın. Önce sertifika kurmadan loopback üzerinden ilk kurulum yapmak için `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch` komutunu kullanın.
2. Arka uç makinesinde yazdırılan **Local Connection URL** adresinde `/auth/token` yolunu açıp `CODENOMAD_BOOTSTRAP_TOKEN:` sonrasında yazdırılan değeri gönderin. Bu çıktıyı paylaşmayın.
3. **Ayarlar → Uzak Erişim → Doğrudan erişim (yerel ağ, gelişmiş) → Sunucu şifresi** öğesini açın.
4. **Şifre belirle** eylemini seçin; **Yeni şifre** ve **Şifreyi onayla** alanlarına en az sekiz karakter girip **Şifreyi kaydet** eylemini seçin.
5. Sonraki başlatmada `--generate-token` seçeneğini kullanmayın ve doğrudan bağlantılarda kayıtlı parolayı kullanın. Uzaktan erişimi açmadan önce [güvenilir HTTPS](remote-access.md) yapılandırın; loopback HTTP kurulum komutu uzaktan dağıtım komutu değildir.

İlk kurulum yalnızca ana bilgisayarın kendi loopback dinleyicisinden kabul edilir; LAN istemcisinden veya Uzaktan Kontrol girişinden kabul edilmez. Kurulumda varsayılan loopback bağlamasını koruyun. Süresi dolmuş veya kullanılmış belirteç için yeni ilk kurulum başlatılmalıdır. Kalıcı parola zaten varsa ilk kurulum oturumu bunun yerine **Şifreyi değiştir** eylemini seçmenizi sağlar.

`auth.json` uygulama tarafından yönetilir; özeti elle düzenlemeyin veya dosyayı yayımlamayın. Parola CLI/ortamdan geldiyse Ayarlar bunu değiştirmeyi reddeder: mevcut yönetilen parolayı kullanmak için geçersiz kılma olmadan yeniden başlatın veya yerel ilk kurulumla parola belirleyin. Okunamayan/yazılamayan kimlik doğrulama dosyası için kimlik doğrulamayı kapatmak değil, işletim sistemi iznini/yolu onarmak gerekir.

## Tarayıcı oturumları ve iptali {#sessions}

Doğrudan giriş, arka uç belleğinde opak bir oturum ve `codenomad_session` çerezi (veya yapılandırılan adla çerez) oluşturur. Çerezler `HttpOnly`, `SameSite=Lax` özelliklerine sahiptir, `/` kapsamındadır ve HTTPS üzerinden verildiğinde `Secure` olarak işaretlenir. Bunlar tarayıcı oturumu çerezleridir; arka ucun yeniden başlatılması bellekteki oturumları geçersiz kılar. Başarısız değişiklik işlemlerini yeniden göndermek yerine istendiğinde aynı sayfada yeniden kimlik doğrulayın.

Parolayı değiştirmek sonraki kimlik bilgisi kontrollerini değiştirir; önceden verilmiş doğrudan oturumları veya Uzaktan Kontrol cihazlarını **geçersiz kılmaz**. Yetkisiz erişimden şüpheleniyorsanız:

1. Ağ erişimini kısıtlayın ve ana bilgisayarda yeni bir parola belirleyin veya çalışma zamanı sırrınızı değiştirin ve yeniden başlatın.
2. Mevcut doğrudan oturumlarını geçersiz kılmak için arka ucu yeniden başlatın.
3. **Uzaktan Kontrol → Eşleştirilmiş cihazlar** altında tanımadığınız cihazları ayrı ayrı **İptal et** eylemiyle iptal edin. Erişim yolunun tamamını hemen kesmeniz gerekiyorsa Uzaktan Kontrolü durdurun.
4. Etkilenen dosyaları, sağlayıcı hesaplarını ve OpenCode etkinliğini inceleyin. Erişimi durdurmak kabul edilmiş işleri geri almaz.

30 günlük etkinlik dışı kalma süresi ve beş dakikalık eşleştirme bağlantıları için [Uzaktan Kontrol](remote-control.md)'ye bakın. Parola değişikliği cihazın iptali değildir ve bir tünelin durdurulması cihazın silinmesi değildir.

## Aktarımı ve dinleyicinin maruz kalmasını koruyun {#transport}

Doğrudan uzaktan erişimde güvenilir HTTPS kullanın. Düz HTTP, ağın o bölümünü gözlemleyebilen herkese parolaları, oturum çerezlerini ve çalışma içeriğini açığa çıkarır. TLS ters proxy'de sonlanıyorsa arka uca giden bağlantıyı loopback veya başka korunan ağda tutun; proxy TLS, açıkta kalan üst HTTP bağlantısını şifrelemez.

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH`, CodeNomad'in doğrudan dinleyici girişini devre dışı bırakır ve istekleri kimliği doğrulanmış sayar. Sunucuyu dışarı açmayı güvenli **hale getirmez**. Erişimi zorunlu denetleyen bir sınır olmadan ulaşılabilen dinleyici, ulaşan herkese erişim verir; VPN tek başına güvenilir ve güvenilmeyen VPN kullanıcılarını ayırmaz. Her erişim yolunu bağımsız tasarlayıp doğrulamadıysanız kimlik doğrulamayı açık tutun. Bu bayrak kullanılsa da Uzaktan Kontrol eşleştirilmiş cihaz gerektirir.

[Bağlama matrisi ve TLS işlemlerini](remote-access.md), özellikle bağımsız yalnızca HTTP modunu kontrol edin: bu mod `--host` değerine uyar ve düz metni loopback dışına açabilir. Sertifika hatalarını doğrulamayı kapatarak çözmeyin.

**`CODENOMAD_SKIP_AUTH=false` yine de kimlik doğrulamayı devre dışı bırakır.** Bu anahtar ortam değişkeni, `false`, `0` veya boş değerle bile tanımlandığında etkindir. Anahtarı kapatmak için değişkeni tamamen kaldırın; bkz. [CLI başvurusu](server.md#cli-reference).

## Ana makine sınırını anlama {#host-boundary}

`--workspace-root` açılabilecek çalışma alanlarını sınırlar; `--unrestricted-root` gezinme sınırlarını gevşetir. İkisi de işletim sistemi hapishanesi, kapsayıcı, dosya sistemi korumalı alanı veya yetkili OpenCode aracının yapabileceklerine sınır değildir. Ajanlar, kabuk komutları, eklentiler ve MCP araçları yürütme ana bilgisayarının izinleriyle ve kendi kimlik bilgileriyle çalışır.

Gerçek yalıtım gerekiyorsa işletim sistemi hesapları, kapsayıcılar/VM'ler ve OpenCode izin yapılandırmasını kullanın. Yalnızca tek sekme göreceğini düşündüğünüz için cihaza erişim vermeyin. Sunucu yapılandırması ve paylaşılan OpenCode hizmeti başka konuşmaları/projeleri etkileyebilir; ayrı sınırlar için [OpenCode kurulumu](opencode.md), [İzinler](permissions.md) ve [Uzantılar](extensions.md) sayfalarına bakın.

## Kimlik bilgilerini ve teşhis bilgilerini gizli tutun {#privacy}

Sağlayıcı bağlantıları ve genel konuşma deposu OpenCode'a aittir. CodeNomad desteklenen kullanım entegrasyonları için bağlantı meta verilerini ve seçili kimlik bilgilerini sunucuda okur; tarayıcı API'leri sağlayıcının gizli değerlerini döndürmez. Haricen yönetilen OAuth girişinin yenilenmesi sahibine aittir; CodeNomad bu yenileme belirteçlerini takas etmez. Bkz. [Sağlayıcılar](providers.md).

| Veri | Nasıl ele alınmalı |
| --- | --- |
| Parolalar, ilk kurulum belirteçleri, eşleştirme bağlantıları, çerezler | Sorun bildirimlerine, ekran görüntülerine, kabuk dökümlerine veya paylaşılan günlüklere asla yapıştırmayın. |
| `auth.json`, TLS özel anahtarlar, tünel kimliği, yapılandırma sırları | İşletim sistemi izinleri ve şifreli yedeklemelerle koruyun; Destek için dizinlerin tamamını yüklemeyin. |
| Konuşma metni, ekler, çalışma alanı yolları ve uzak adresler | Paylaşmadan önce inceleyip hassas bilgileri gizleyin; kişileri, projeleri veya altyapıyı tanımlayabilirler. |
| Sağlayıcı anahtarları ve ses hizmeti kimlik bilgileri | Yalnızca amaçlanan ayarlara/kimlik bilgisi sahibine girin; hangi sağlayıcının verileri aldığını kontrol edin. Bkz. [Ses](voice.md). |
| Hata ayıklama/izleme günlükleri ve ağ yakalamaları | Yalnızca gerekeni toplayın, yerel olarak inceleyin ve bildirmeden önce hassas bilgileri gizleyin. Diğer araçların çıktısının sır içermediğini varsaymayın. |

**Ayarlar → Bilgi → Hata bildir**, dinleyicileri, adresleri, yolları, kimlik bilgilerini veya konuşma içeriğini önceden doldurmadan sınırlı tanılamalar hazırlar. Göndermeden önce kendiniz eklediğiniz her şeyi inceleyin. Bkz. [Destek](support.md).
