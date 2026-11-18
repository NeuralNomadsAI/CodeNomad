# Yerel entegrasyonlar

CodeNomad OpenCode'un MCP bağlantılarını, eklenti etkinleştirmesini, becerilerini ve özel komutlarını sunar. Bunlar yürütme ana bilgisayarında çalışır. Korumalı [panel uzantılarından](extensions.md) ve [SideCars](browser-sidecars.md) araçlarından ayrıdır.

## Doğru kontrolü seçin {#integration-scopes}

| Entegrasyon | Nerede hareket edilmeli | Denetim neyi değiştirir? |
| --- | --- | --- |
| MCP sunucusu | **Durum → MCP Sunucuları** | Görüntülenen Location'de yerel bağlantı; sunucu kurmaz. |
| Yerel eklenti | **Durum → Eklentiler** | Bir paket bildirimini ekler veya kaldırır ve kalıcı **Genel** veya **Proje** etkinleştirme kuralı belirler; paket eklentisi için o paketin açıkça denetlenmesi veya güncellenmesi. |
| Beceri | İleti düzenleyicisinin `@` menüsü | Konuşmanın Location bağlamında sonraki isteme açıkça eklenen ek. |
| Özel komut | İleti düzenleyicisinin `/` menüsü | OpenCode'un o Location için sunduğu komutu çalıştırır. |

Yerel entegrasyonlar, OpenCode izinlerine tabi olarak kendi ana makine işlemlerinin ayrıcalıklarına sahiptir; korumalı alana alınmış HTML panelleri değildirler.

## MCP'yi bağlayın veya bağlantısını kesin {#mcp}

1. MCP sunucusunu OpenCode yürütme ana bilgisayarında [OpenCode MCP belgelerini](https://opencode.ai/v2/docs/mcp-servers/) kullanarak yapılandırın.
2. Proje için **Durum → MCP Sunucuları** öğesini açın.
3. Sunucuyu bağlamak veya bağlantısını kesmek için sunucunun yanındaki anahtarı kullanın. Bağlantı göstergesinin yerleşmesini bekleyin.

Bu Location bağlamını kullanan diğer istemciler bağlantı değişikliğini gözlemleyebilir. Bağlantının kesilmesi sunucu bildirimini kaldırmaz veya yürütülebilir dosyasını kaldırmaz.

Bağlantı başarısız olursa sunucunun yapılandırmasını, gerekli ortamı ve kimlik doğrulamayı kontrol edin; anahtar OAuth'yi tamamlamaz.

## Eklentileri Genel veya Proje kapsamında etkinleştirin {#plugins}

CodeNomad tarafından yönetilen eklentiler, normal eklenti listesinin ve bu listedeki etkinleştirme, güncelleme ve kaldırma denetimlerinin dışında tutulur.

**CodeNomad eklentileri ilgilenmenizi gerektiriyor** için ayrıntıları **i** ile açın. Devre dışı bir eklenti **Yeniden etkinleştir** sunar; kullanmadan önce gösterilen yapılandırma kapsamını kontrol edin.

1. [Eklentiyi ekleyin](#plugin-sources) veya OpenCode yapılandırmasında bildirin; daha sonra **Durum → Eklentiler** öğesini açın.
2. Kaynağı, çalışma zamanı hatasını ve yapılandırma hedefi ayrıntılarını incelemek için adının üzerine gelin veya odaklanın.
3. **Genel** veya **Proje** öğesini bilinçli olarak değiştirin. Yazmayı bekleyin ve durum belirsizse **Plugin denetimlerini yenile** öğesini kullanın.
4. Bir paketten kurulmuş eklenti için adının yanındaki simgeyi kullanın. Menüsü tam işlemi adlandırır: paket için **… güncellemelerini denetle** veya daha yeni bir sürüm bulunduğunda **… güncelle**.

Genel, bağlı daemon'ın keşfedilen genel yapılandırmasını hedefler. Proje devralınmış üst dosyayı değil, etkin Location içindeki yapılandırmayı hedefler. Sonraki Proje kuralı Genel kuralı geçersiz kılabilir; Genel anahtarı Projenin son durumu yerine yine Genel kuralı gösterir. Proje kuralı yoksa Proje çözümlenen Genel durumu devralır.

Yerleşik OpenCode eklentileri kullanıcı etkinleştirme anahtarı olarak sunulmaz. Hedefi Genel'den güvenli ayrılamıyorsa veya etkin Location dışına çıkabiliyorsa Proje devre dışı tutulur.

Paket güncellemesi, araç ipucunda belirtildiği gibi, o paketi kullanan her Location için OpenCode'un paylaşılan önbelleğindeki paketi değiştirir; etkinleştirme kurallarını değiştirmez, OpenCode'u yeniden başlatmaz veya yapılandırmayı yeniden yüklemez. Yerel, yerleşik ve SDK tarafından sağlanan eklentilerin paket eylemi yoktur.

## Eklenti ekleyin veya kaldırın {#plugin-sources}

1. **Durum → Eklentiler** içinde **+** menüsünü açıp **Eklenti ekle…** öğesini seçin.
2. npm kayıt defterinden bir paket (`name`, `name@1.2.3`, `@scope/name@^1`) veya bir Git deposu (`github:owner/repo`, `git+https://…`) girin.
3. Eklenti yalnızca bu projede çalışmayacaksa **Genel** seçili kalsın, ardından **Ekle** öğesini seçin.
4. Yeni satır, OpenCode bildirene kadar **Kuruluyor** gösterir.

Bir eklentiyi kaldırmak için adının yanındaki menüyü açıp **Genel kapsamından kaldır** veya **Proje kapsamından kaldır** öğesini seçin. O kapsamın yapılandırma dosyasındaki bildirimi ve etkinleştirme kuralları silinir; eklentinin başka bir bildirimi kaldıkça devre dışı bırakma kuralı ve daha önceki bir bildirimin hâlâ tanımladığı etkinleştirme kuralı kalır. Tanımını kaybedecek bir etkinleştirme kuralı bu projenin yapılandırmasından da silinir, aksi halde OpenCode bu adla bir kayıt paketi indirirdi; CodeNomad'ın düzenlemediği bir dosyadaysa kaldırma reddedilir. OpenCode'un paket önbelleği yerinde kalır. OpenCode'un tanımlayamadığı bir eklentinin (devre dışı ya da yüklenmeden önce başarısız) kuralları, menüsü aynı kaldırmayı sunan ayrı bir satırda kalır.

Eklentinin kodu OpenCode içinde sizin izinlerinizle çalışır. Bir **Proje** girdisi, o klasör OpenCode'da her açıldığında çalışır ve OpenCode masaüstü uygulaması bölümleri olan paketler bunları yalnızca **Genel** kapsamdan yükler; böyle bir paket başka yerde bildirildiğinde araç ipucu bunu belirtir. Yerel yollar, yapılandırma değişkenleri ve eklenti kimlikleri burada reddedilir: yerel eklentileri yapılandırma dosyasında bildirin. Bu Location için geçerli bir yapılandırmada zaten bildirilmiş bir paket, sürümü, aralığı veya biçimi ne olursa olsun reddedilir.

Kurulu paketin sürümü eklenti adının yanında görünür. Git eklentilerinde ayrıntılar commit'i içerir; sürüm kullanılamıyorsa adın yanında yedi karakterlik commit görünür. Ayrıntıları, **Güncelleme mevcut** bilgisini ve başarısız bir kurulumda hatayı OpenCode günlüğündeki referansıyla görmek için adın üzerine gelin veya odaklanın.

## Becerileri ekleyin {#skills}

1. İleti düzenleyicisine `@` yazın, Location becerilerini arayıp birini seçin.
2. Dosyalar/aracılarla birlikte çıkarılabilir ekini kontrol edin; amaçlanmamışsa göndermeden önce çıkarın.
3. İstemi gönderin. Beceri etiketleri gönderilen mesajda kalır.

Bir ekin kaldırılması daha önceki bir gönderimi geri alamaz.

Beceri kullanılabilirliği küresel bir CodeNomad beceri kataloğundan değil, görüşmenin Location'sinden gelir. Bkz. [OpenCode beceri belgeleri](https://opencode.ai/v2/docs/skills/) ve [Konuşmalar](conversations.md).

## Özel komutları çalıştır {#commands}

1. İleti düzenleyicisine `/` yazıp mevcut OpenCode komutunu seçin.
2. Bu komut için uygun olanı göndermeden önce argümanlarını sağlayın ve **Ajan**, **Model** ve **Düşünme** öğesini kontrol edin.
3. Onayın net olmadığı durumlarda tekrar tekrar göndermek yerine ortaya çıkan konuşmayı inceleyin.

Aktif Location için komutlar OpenCode'den keşfedilir. `/btw`, sıradan bir özel komut değil, CodeNomad'in ayrı geçici soru akışıdır.

Komut tanımları ve yerel konfigürasyon devralımı için [OpenCode komutları dokümantasyonu](https://opencode.ai/v2/docs/commands/)'yi kullanın. Yapılandırma değişikliklerinden sonra öncelikle ilgili yüzeyi yenileyin/yeniden açın; açık yapılandırma yeniden yüklemesini yalnızca çalışma zamanının hâlâ buna ihtiyacı varsa kullanın. Kabul edilmesi muhtemel bir komutu asla yalnızca ekranını yenilemek için tekrar oynatmayın.
## Eklentilerdeki entegrasyonlar {#integration-rows}

**Durum → Eklentiler** içindeki **+**, **Entegrasyon ekle…** veya **Eklenti ekle…** seçeneklerini açar. Entegrasyon seçicisi incelenmiş katalogdaki kurulmamış girdileri listeler. Kapsamı ve **Kur** seçeneğini seçin: CodeNomad seçilen katalog kimliğini kurar. Yerel entegrasyonlar **Yalnızca genel** kapsamını kullanır. **Katalog kullanılamıyor**, **Yenile** sunar; **{date} tarihli katalog**, güncel olmayan son geçerli kataloğu belirtir.

Vurgu renkli durum satırından **Blender içine kur**, **Blender güncelle** veya görüntülenen konuşmayı açık bir belgeye **bağla** seçin (birkaç belge arasından seçmek için **Bağla…**). Zincir simgesi ve belge bir bağlantıyı gösterir; kesmek için seçin. Bir konuşma, aracısı entegrasyonu ilk kez kullandığında da kendiliğinden bağlanır.

Satırın **…** menüsü bağlantı durumuyla başlar, örneğin **Blender: 1 açık belge** veya **Blender kapalı**. Ardından **Belgeler**, **Uygulamaya kur…**, **Uygulamayı güncelle…** veya **Uygulamaya yeniden kur…** ([aşağıya bakın](#application-installation)), paketin güncelleme denetimi, **Genel kapsamından kaldır** veya **Proje kapsamından kaldır** ve **Plugin denetimlerini yenile** sunar. Bağlantıyı kesmek onay olmadan tek tıklamadır ve yalnızca bu konuşmayı etkiler: uygulama açık kalır, bölümü kurulu kalır ve diğer konuşmalar bağlantılarını korur.

Katalogdan kurulum, uygulama bölümünün kurulumu/güncellenmesi ve kaldırma onay gerektirir. Önce **İptal** odaklanır; onay eylemi 600 ms sonra kullanılabilir olur. Etkinleştirme, eklenti güncellemeleri, bağlama ve bağlantıyı kesme doğrudan çalışır.

Kaldırma uyarısı eklentiyi ve tam kapsamı adlandırır. **İptal** odaklanır; **Genel/Proje kapsamından kaldır** 600 ms sonra kullanılabilir ve açık bir işlem gerektirir. Kullanan konuşmalarda kullanılabilirliği ve bağlantıları kesebilir; Genel kapsam diğer projeleri de etkileyebilir. Yalnızca onaylanan bildirim ve yukarıda açıklanan etkinleştirme kuralları kaldırılır; önbellek, uygulama dosyaları ve kayıtlı bağlantı ipuçları korunur. Yapılandırma değişirse yeniden seçim ve onay gerekir.

## Uygulama entegrasyonunu kurun veya güncelleyin {#application-installation}

**Durum → Eklentiler** içinde, güncel durumu eylemi sunduğunda entegrasyonun durum satırındaki **Blender içine kur** veya **Blender güncelle** seçeneğini, ya da **…** menüsündeki **Uygulamaya kur…**, **Uygulamayı güncelle…** veya **Uygulamaya yeniden kur…** seçeneğini seçin. Yeniden kurulum, uygulama açık veya kapalı olsun, uygulama bölümünü yeniden yazar. Konuşma veya açık belge olmadan da kullanılabilir.

Onay, uygulamayı ve yükleyiciyi sağlayan **entegrasyon paketinin sürümünü** belirtir. İkisini ve makine uyarısını denetleyin: kurulum OpenCode'un çalıştığı makinede yapılır; bu uzak bir makine olabilir. İlk odak **İptal** üzerindedir. Devam etmek için açıkça onaylayın.

WSL, açık bir uygulama uyumlu görünse bile uygulama içine kurulumu her zaman reddeder. Uygulamayı desteklenen bir makinede açın.

Kurulum veya güncellemeden sonra uygulamayı açıp entegrasyonunu denetleyin.

Bir hata sonucu belirsiz bırakırsa o isteği tekrarlamayın: önce uygulamayı inceleyin, ardından gerekirse yeni bir işlem ve onay başlatın.
