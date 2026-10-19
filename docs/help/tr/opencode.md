# OpenCode kurulumu

CodeNomad, yürütme ana bilgisayarındaki paylaşılan bir OpenCode hizmetine bağlanır. CLI'yi seçmek, dosyalarını güncellemek, hizmeti yeniden başlatmak ve yapılandırmayı yeniden yüklemek farklı işlemlerdir; hiçbiri diğerinin alternatifi değildir.

## CLI seçin veya kurun {#select-cli}

1. **Ayarlar → OpenCode** öğesini açın ve yürütülebilir dosyayı seçmek için **OpenCode Binary** öğesini kullanın.
2. Sunucunun PATH'sini, ardından kullanıcı npm kurulumunu tercih etmek için otomatik seçimi etkin bırakın; veya **Binary için gözat…** kullanın veya bir yol girin ve **Ekle** öğesini seçin.
3. **Durumu ve güncellemeleri denetle** öğesini kullanın. OpenCode eksikse **OpenCode'u kur ve başlat** öğesini seçin; önce ana bilgisayarı ve kurulum kapsamını inceleyin.
4. Kurulum **Bağlan ve devam et** sunuyorsa, bildirilen sorunu çözdükten sonra bunu kullanın.

Kurulum, diğer istemcilerle paylaşılan standart bir kullanıcı kurulumu için paketlenmiş Node/npm'yi kullanır. **Kullanıcı için kur ve PATH'i yapılandır** bu kullanıcının terminal kurulumunu değiştirir; daha sonra yeni bir terminal açın. Bir tarayıcı CodeNomad sunucusuna bağlanır: dosya seçicisi ve yürütülebilir seçimi, tarama cihazını değil, söz konusu sunucuyu ilgilendirir.

Yüklü yürütülebilir dosya ve çalışan hizmetin farklı sürümleri olabilir. Başka bir yürütülebilir dosyanın seçilmesinin canlı arka plan programının yerini aldığını varsaymak yerine **Sürüm ayrıntıları** öğesini kontrol edin. Kurulum meşgulse veya yürütülebilir dosya kilitliyse, yükleyicinin veya işlemin onu serbest bırakmasını bekleyin ve yeniden denemeden önce durumu kontrol edin; Rakip yükleyicileri çalıştırmayın.

## Gerekli, önerilen ve doğrulanmamış sürümler {#versions}

| sınıflandırma | Mevcut gereksinim | Anlamı |
| --- | --- | --- |
| Asgari | OpenCode **2.0.27** | Gerekli yerel eklenti çalışma zamanı; daha eski bir kararlı çalışma zamanı, birlikte verilen eklentileri yükleyemez. |
| Önerilen | OpenCode **2.0.32** | Teknik alt sınırdan farklı, doğrulanan hedef. |
| Doğrulanmamış | Tam olarak doğrulanmamış daha yeni veya özel bir sürüm | Yalnızca denenmemiş olduğu için reddedilmez; bağlı hizmetin gerçek API sözleşmeleri kontrol edilir. |

Gerekli oturum, izin, Form, gelen kutusu ve oturum-ortam sözleşmelerinin de mevcut olması gerekir. Yürütülebilir bir sürüm tek başına bağlı hizmetin bunları desteklediğini kanıtlamaz. Kurulum, desteklenmeyen bir çalışan hizmet bildirirse desteklenen bir CLI seçin/yükleyin ve hazır olduğunuzda açık paylaşılan hizmet yeniden başlatmayı kullanın.

## Ana bilgisayar, WSL ve paylaşılan hizmet kapsamı {#execution-host}

Windows'ta seçilen bir WSL yürütülebilir dosyası, seçilen dağıtımın içinde çalışır. Oraya yükleyin/güncelleyin ve bu dağıtımda anlamlı olan yolları kullanın. WSL bağlantısı Windows localhost yönlendirmesine bağlıdır. Windows CLI ve WSL CLI, birbirinin yerine kullanılabilen yürütme ortamları değildir.

OpenCode, küresel hizmet kaydına, oturumlarına, mesajlarına ve veritabanına sahiptir. CodeNomad, pencere veya proje başına özel bir OpenCode veritabanı oluşturmaz. Sekmeyi kapatmak Location bağlamını kaldırmadan projeyi CodeNomad'de kapatır; oturumlar OpenCode'da devam eder ve projeyi yeniden açtığınızda bulunur. Pencereyi veya CodeNomad arka ucunu kapatmak paylaşılan arka plan programını durdurmaz; bkz. [Projeler](projects.md).

## Güncelleme, yeniden başlatma veya yeniden yükleme {#maintenance}

1. **Ayarlar → OpenCode** bölümünde **Durumu ve güncellemeleri denetle** öğesini seçin.
2. Yüklü CLI dosyalarını değiştirmek için teklif edildiğinde **OpenCode {version} sürümüne güncelle** öğesini seçin. Tamamlanmasını bekleyin.
3. Çalışan hizmet durumunu gözden geçirin. **Paylaşılan hizmeti yeniden başlat** öğesini yalnızca seçilen kurulumu bağlı her istemci için etkinleştirmek istediğinizde kullanın.
4. Hiçbir şey yüklemeden işlemi yeniden başlatmak için **Sorun giderme** öğesini genişletin ve **OpenCode hizmetini yeniden başlat** öğesini seçip onaylayın.

| Eylem | Kapsam ve etki | Güvenli kurtarma |
| --- | --- | --- |
| CLI'yi güncelleyin | Desteklenen yüklü yürütülebilir dosyayı değiştirir; çalışan arka plan programını dolaylı olarak yeniden başlatmaz. | Bir arızadan sonra hem yüklü hem de çalışan sürümleri kontrol edin; yalnızca hatayı çözdükten sonra açıkça yeniden deneyin. |
| Hizmeti yeniden başlat | Paylaşılan süreci değiştirir ve bağlı tüm OpenCode istemcilerindeki etkin işleri keser; oturum geçmişi kalır. | Yeniden bağlanıp konuşmaları ve zamanlanmış Görevleri inceleyin; yeniden başlatma otomatik devam anlamına gelmez. |
| OpenCode yapılandırmasını yeniden yükle | Süreci korur ancak tüm istemcilerdeki **yüklü her Location** bağlamını yeniden kurar. Bekleyen izinleri/Formları iptal eder, terminalleri/arka plan komutlarını kapatır; etkin işler kesilebilir. | Yeniden yükledikten sonra kaynakları ve bekleyen işleri kontrol edin. Yanıt kayboldu diye istemi veya değişiklik işlemini tekrarlamayın. |

Kaydedilmiş bir yapılandırma veya yüklü eklenti kullanılamadığında ve kesinti kabul edilebilir olduğunda **OpenCode yapılandırmasını yeniden yükle** öğesini açıkça kullanın. Zararsız bir ekran yenileme değildir. CodeNomad, daha yeni çalışan bir arka plan programının sürümünü düşürmek için seçilen eski bir CLI'yi kullanmayacaktır.

## Oturum ortamı {#session-environment}

1. **Ayarlar → Gelişmiş → Ortam Değişkenleri** öğesini açın.
2. Profilin geçersiz kılmalarını ekleyin, değiştirin veya kaldırın.
3. Geçerli ortamı söz konusu konuşmaya uygulamak için sonraki istemi, özel komutu veya oturum kabuğu isteğini CodeNomad aracılığıyla gönderin.

Bu, her göndermeden önce sunucu tarafında uygulanan bir yapılandırma profili ayarıdır. Yalnızca bir görüşmeyi açmak/okumak veya ayarları kaydetmek yerel oturumu değiştirmez. Bir geçersiz kılmayı kaldırmak, yürütme ana bilgisayarının devralınan değerini geri yükler veya orada yoksa kaldırır. Ortamın uygulanmaması, eski değerleri kullanmak yerine gönderimi engeller.

Ortam, ilgili OpenCode oturumunda sonraki yerel kabuk başlatmalarını yönetir. Çalışan süreçler mevcut ortamlarını korur. Sağlayıcıları, MCP/LSP sunucularını, bağımsız terminalleri veya yalnızca Location kapsamındaki arka plan kabuklarını **yeniden yapılandırmaz**. Her kuyruk istemi kendi ortamını saklamaz; başka OpenCode istemcisi aynı oturum ortamını değiştirebilir. Tamamen OpenCode içinde oluşturulmuş alt oturumların CodeNomad gönderim anı güncellemesi aldığını varsaymayın.

Durdurulan bir hizmet başlatılırken izin verilen değişkenler de iletilir; Mevcut bir arka plan programına bağlanmak onun süreç ortamını değiştirmez. WSL'de değerler Windows PATH/HOME ile değil Linux yürütme ortamıyla birleştirilir. Bu geçersiz kılmaları değiştirmek, OpenCode'un veritabanının veya hizmet kaydının yerini değiştirmez.

## Yerel yapılandırma dosyalarını düzenleyin {#configuration-files}

1. **Ayarlar → Yapılandırma Dosyaları** yolunu açıp **Dosya** seçimini yapın.
2. Görüntülenen yolu kontrol edin, düzenleyin ve ardından **Kaydet** öğesini seçin.
3. Dosyayı yeniden okumak için **Yeniden yükle** öğesini kullanın; bu **OpenCode yapılandırmasını yeniden yükle** değil.

Bu düzenleyici, **CodeNomad sunucu kullanıcısının** `.config/opencode` dizini altında yalnızca listelenen genel `opencode.json` ve `opencode.jsonc` dosyalarını gösterir. Bu, rastgele bir dosya düzenleyicisi, bir Proje yapılandırma seçicisi veya bir WSL/özel keşif arka plan programının bu dosyayı okuyacağının garantisi değildir. Hedefi doğrulamak için görüntülenen yolu kullanın; diğer kökler için arka plan programının kendi araçlarını kullanın.

Kaydetme, dosyayı metin olarak yazar; yerel yapılandırmanın tamamını doğrulamaz veya OpenCode'u yeniden başlatmaz/yeniden yüklemez. Düzenlemeleri diğer istemcilerle koordine edin: Bu yüzey, harici değişiklik birleştirme olanağı sunmaz. Önemli konfigürasyonu değiştirmeden önce bir kopyasını saklayın. Dosyaları değiştirmek veya kirli bir taslağı yeniden yüklemek, bunun atılıp atılmayacağını sorar.

Konfigürasyona özel iş akışları için bkz. [Entegrasyonlar](integrations.md), [Sağlayıcılar](providers.md), [Görevler](missions.md) ve [OpenCode belgeleri](https://opencode.ai/v2/docs/).
