# Yerel entegrasyonlar

CodeNomad OpenCode'un MCP bağlantılarını, eklenti etkinleştirmesini, becerilerini ve özel komutlarını sunar. Bunlar yürütme ana bilgisayarında çalışır. Korumalı [panel uzantılarından](extensions.md) ve [SideCars](browser-sidecars.md) araçlarından ayrıdır.

## Doğru kontrolü seçin {#integration-scopes}

| Entegrasyon | Nerede hareket edilmeli | Denetim neyi değiştirir? |
| --- | --- | --- |
| MCP sunucusu | **Durum → MCP Sunucuları** | Görüntülenen Location'de yerel bağlantı; sunucu kurmaz. |
| Yerel eklenti | **Durum → Eklentiler** | Kalıcı **Genel** veya **Proje** etkinleştirme kuralı; paketi yüklemez/güncellemez/kaldırmaz. |
| Beceri | İleti düzenleyicisinin `@` menüsü | Konuşmanın Location bağlamında sonraki isteme açıkça eklenen ek. |
| Özel komut | İleti düzenleyicisinin `/` menüsü | OpenCode'un o Location için sunduğu komutu çalıştırır. |

Entegrasyonu önce OpenCode'un desteklenen yapılandırmasını ve CLI'yi kullanarak yapılandırın/kurun. Bir paketin kurulması, kaynağının belirtilmesi, kuralının etkinleştirilmesi, bir hizmetin bağlanması ve araçlarının kullanılabilir hale getirilmesi ayrı adımlardır. Yerel entegrasyonlar, OpenCode izinlerine tabi olarak kendi ana makine işlemlerinin ayrıcalıklarına sahiptir; korumalı alana alınmış HTML panelleri değildirler.

## MCP'yi bağlayın veya bağlantısını kesin {#mcp}

1. MCP sunucusunu OpenCode yürütme ana bilgisayarında [OpenCode MCP belgelerini](https://opencode.ai/v2/docs/mcp-servers/) kullanarak yapılandırın.
2. Proje için **Durum → MCP Sunucuları** öğesini açın.
3. Sunucuyu bağlamak veya bağlantısını kesmek için sunucunun yanındaki anahtarı kullanın. Bağlantı göstergesinin yerleşmesini bekleyin.

Anahtar, bildirilen Location için yerel bağlantı API'yi çağırır; yerel cihaz yükleyicisini veya pencere başına görünürlük tercihini değil. Bu Location bağlamını kullanan diğer istemciler bağlantı değişikliğini gözlemleyebilir. Bağlantının kesilmesi sunucu bildirimini kaldırmaz veya yürütülebilir dosyasını kaldırmaz.

Hiçbir sunucu görünmüyorsa etkin Location bağlamını ve yerel yapılandırmasını doğrulayın. Bağlantı başarısız olursa sunucunun yapılandırmasını, gerekli ortamı ve yerel kimlik doğrulama akışını inceleyin; anahtarın OAuth'yi tamamladığını varsaymayın. Yeniden bağlandıktan sonra durumu tekrar kontrol edin. Açık yapılandırma yeniden yüklemesini yalnızca gerektiğinde, [OpenCode kurulumu](opencode.md) bölümünde açıklanan kesintilerle birlikte kullanın.

## Eklentileri Genel veya Proje kapsamında etkinleştirin {#plugins}

1. Yerel eklentiyi OpenCode ile yükleyin/bildirin; daha sonra **Durum → Eklentiler** öğesini açın.
2. Kaynağı, çalışma zamanı hatasını ve yapılandırma hedefi ayrıntılarını incelemek için adının üzerine gelin veya odaklanın.
3. **Genel** veya **Proje** öğesini bilinçli olarak değiştirin. Yazmayı bekleyin ve durum belirsizse **Plugin denetimlerini yenile** öğesini kullanın.

Genel, bağlı daemon'ın keşfedilen genel yapılandırmasını hedefler. Proje devralınmış üst dosyayı değil, etkin Location içindeki yapılandırmayı hedefler. Sonraki Proje kuralı Genel kuralı geçersiz kılabilir; Genel anahtarı Projenin son durumu yerine yine Genel kuralı gösterir. Proje kuralı yoksa Proje çözümlenen Genel durumu devralır.

Bu anahtarlar kaynak bildirimlerini ve ilgisiz yapılandırmayı koruyarak tam etkinleştirme kurallarını düzenler. Eklenti seçeneklerini düzenlemez, paket kurmaz veya dosya kaldırmaz. Yerleşik OpenCode eklentileri kullanıcı etkinleştirme anahtarı olarak sunulmaz. Hedefi Genel'den güvenli ayrılamıyorsa veya etkin Location dışına çıkabiliyorsa Proje devre dışı tutulur.

Yüzey, gizliyken son anlık görüntüsünü korur ve gösterildiğinde, yerel değişikliklerde/yeniden bağlanmada ve açık yenilemede yeniden doğrulanır. Kaydedilmiş bir kural ile canlı çalışma zamanının kullanılabilirliği kısa süreliğine farklılık gösterebilir. Bir eklenti kullanılamıyorsa **OpenCode yapılandırmasını yeniden yükle** öğesini seçmeden önce eklentinin ipucunu ve yerel yapılandırmasını inceleyin; bu eylem yalnızca bu eklentiyi değil, yüklenen tüm Konumları etkiler. Hatalı biçimlendirilmiş yapılandırmanın veya eşzamanlı düzenlemenin üzerine sessizce yazılmaz: sorunu çözün, yenileyin ve açıkça yeniden deneyin.

## Becerileri ekleyin {#skills}

1. İleti düzenleyicisine `@` yazın, Location becerilerini arayıp birini seçin.
2. Dosyalar/aracılarla birlikte çıkarılabilir ekini kontrol edin; amaçlanmamışsa göndermeden önce çıkarın.
3. İstemi gönderin. Beceri etiketleri gönderilen mesajda kalır.

Seçim, yerel beceri kimliğini ekler ve `@query` belirtecini kaldırır; talimatları görünen taslağa yapıştırmaz. Gönderme, OpenCode tarafından o mesajla birlikte depolanan talimatları değil, ileti düzenleyicisi seçimini temizler. Bir ekin kaldırılması daha önceki bir gönderimi geri alamaz.

Beceri kullanılabilirliği küresel bir CodeNomad beceri kataloğundan değil, görüşmenin Location'sinden gelir. Liste yüklenemezse, yeniden denemek için seçiciyi kapatıp yeniden açın; boşsa yerel keşfi/yapılandırmayı kontrol edin. Bkz. [OpenCode beceri belgeleri](https://opencode.ai/v2/docs/skills/) ve [Konuşmalar](conversations.md).

## Özel komutları çalıştır {#commands}

1. İleti düzenleyicisine `/` yazıp mevcut OpenCode komutunu seçin.
2. Bu komut için uygun olanı göndermeden önce argümanlarını sağlayın ve **Ajan**, **Model** ve **Düşünme** öğesini kontrol edin.
3. Onayın net olmadığı durumlarda tekrar tekrar göndermek yerine ortaya çıkan konuşmayı inceleyin.

Aktif Location için komutlar OpenCode'den keşfedilir. Kendi yerel tanımları yürütme davranışını seçebilir; menü bir paket yükleyicisi veya sınırsız bir yapılandırma düzenleyicisi değildir. CodeNomad, yerel özel komut gönderiminden önce profilin oturum ortamını uygular; başarısız bir ortam güncellemesi gönderimi engeller. `/btw`, sıradan bir özel komut değil, CodeNomad'in ayrı geçici soru akışıdır.

Komut tanımları ve yerel konfigürasyon devralımı için [OpenCode komutları dokümantasyonu](https://opencode.ai/v2/docs/commands/)'yi kullanın. Yapılandırma değişikliklerinden sonra öncelikle ilgili yüzeyi yenileyin/yeniden açın; açık yapılandırma yeniden yüklemesini yalnızca çalışma zamanının hâlâ buna ihtiyacı varsa kullanın. Kabul edilmesi muhtemel bir komutu asla yalnızca ekranını yenilemek için tekrar oynatmayın.
