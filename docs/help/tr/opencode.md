# OpenCode kurulumu

## CLI seçin veya kurun {#select-cli}

1. **Ayarlar → OpenCode** öğesini açın ve yürütülebilir dosyayı seçmek için **OpenCode sürümü** altındaki **OpenCode İkili Dosyası** kartını kullanın.
2. Otomatik girişi seçili bırakın veya **Başka bir binary seç…** bölümünü açarak **Binary için gözat…** kullanın ya da bir yol girip **Ekle** öğesini seçin.
3. **Durumu ve güncellemeleri denetle** öğesini kullanın. OpenCode eksikse **OpenCode'u kur ve başlat** öğesini seçin; önce ana bilgisayarı ve kurulum kapsamını inceleyin.
4. Kurulum **Bağlan ve devam et** sunuyorsa, bildirilen sorunu çözdükten sonra bunu kullanın.

**Kullanıcı için kur ve PATH'i yapılandır** bu kullanıcının terminal kurulumunu değiştirir; daha sonra yeni bir terminal açın. Bir tarayıcı CodeNomad sunucusuna bağlanır: dosya seçicisi ve yürütülebilir seçimi, tarama cihazını değil, söz konusu sunucuyu ilgilendirir.

PATH üzerinde önce eski bir OpenCode geliyorsa, sunulan eylem nasıl kurulduğuna bağlıdır. npm ile kurulmuş OpenCode 1.x için **OpenCode {version} sürümünü OpenCode 2 ile değiştir** onay ister, o npm paketini kaldırır ve OpenCode 2'yi aynı npm klasörüne kurar; OpenCode veri klasörü korunur ve OpenCode 2, 1.x konuşmalarını kendisi içe aktarır. Başka bir yolla (winget, Homebrew, elle) kurulmuş eski veya kullanılamayan bir OpenCode asla değiştirilmez: **CodeNomad için OpenCode 2 kur**, OpenCode 2'yi onun yanına, kullanıcı npm klasörüne kurar ve CodeNomad bundan sonra bu kopyayı kullanır. Bu eski komutun kendisi kullanıcı npm klasöründeyse (örneğin `~/.local/bin` içindeki bir bağlantı) ya da bu klasör yazılabilir değilse, kurulum eylemi sunmak yerine nedenini açıklar: komutu taşıyın veya yeniden adlandırın ya da klasör izinlerini düzeltin, ardından **Durumu ve güncellemeleri denetle** seçeneğini seçin. Bir terminaldeki `opencode` komutu yine eski sürümü başlatabilir. Açıkça seçilmiş özel bir yürütülebilir dosya asla değiştirilmez.

**OpenCode sürümü** kartı, sürümü **Kurulu sürüm** değerinden farklı veya bilinmiyorsa **Çalışan hizmet** değerini ayrı gösterir. **Sürüm ayrıntıları** minimum sürümü ve farklıysa önerilen sürümü gösterir.

## Gerekli, önerilen ve doğrulanmamış sürümler {#versions}

| Sınıflandırma | Mevcut gereksinim | Anlamı |
| --- | --- | --- |
| Asgari | OpenCode **2.4.2** | Bu CodeNomad sürümü için gereklidir. Önceki sürümlerle kaydedilen konuşmalar güncellemeden sonra da okunabilir. |
| Önerilen | OpenCode **2.4.2** | CodeNomad **1.2.0** için. |
| Doğrulanmamış | Tam olarak doğrulanmamış daha yeni veya özel bir sürüm | Yalnızca denenmemiş olduğu için reddedilmez; bağlı hizmetin gerçek API sözleşmeleri kontrol edilir. |

## Ana bilgisayar, WSL ve paylaşılan hizmet kapsamı {#execution-host}

Windows'ta seçilen bir WSL yürütülebilir dosyası, seçilen dağıtımın içinde çalışır. Oraya yükleyin/güncelleyin ve bu dağıtımda anlamlı olan yolları kullanın. WSL bağlantısı Windows localhost yönlendirmesine bağlıdır. Windows CLI ve WSL CLI, birbirinin yerine kullanılabilen yürütme ortamları değildir.

Proje sekmesini kapatmak projeyi CodeNomad'de kapatır; oturumlar OpenCode'da devam eder ve projeyi yeniden açtığınızda yeniden görünür. Bir pencerenin tamamını kapatmak, uygulamadan çıkmak veya yeniden yüklemek proje bağlantılarını geri yükleme için korur; ne bu eylemler ne de arka ucun kapanması paylaşılan arka plan programını durdurur. Bkz. [Projeler](projects.md).

## Başlangıçta başlat {#login-start}

**Ayarlar → OpenCode** içindeki **Başlangıçta başlat**, oturum açtığınızda işletim sisteminin OpenCode hizmetini arka planda başlatmasını sağlar; CodeNomad kapalıyken de çalışır. Siz açana kadar kapalı kalır, bir sonraki oturum açılışınızda etkinleşir ve CodeNomad sunucusunu çalıştıran bilgisayardaki hesabınız için geçerlidir. **OpenCode İkili Dosyası** kartında seçilen yürütülebilir dosyayı başlatır; başka bir yerel yürütülebilir dosya seçmek onu günceller, aksi halde öncekini başlatmaya devam eder.

| Sistem | OpenCode'u ne başlatır | Çökmeden sonra |
| --- | --- | --- |
| Windows | Hesabınız için gizli bir zamanlanmış görev; parola veya yönetici hakkı gerekmez. Bir WSL yürütülebilir dosyası kendi dağıtımında başlar. | Yeniden başlatılmaz. |
| macOS | Bir LaunchAgent. | macOS yeniden başlatır. |
| Linux | Oturum açılışında başlayan bir systemd kullanıcı hizmeti; linger etkinleştirilmez. | systemd yeniden başlatır. |

Kapatmak yalnızca o görevi, LaunchAgent'ı veya hizmeti kaldırır; çalışan bir OpenCode çalışmaya devam eder. CodeNomad sunucusu WSL içinde veya oturum açılışında başlatma olmayan başka bir sistemde çalıştığında **Bu sistemde kullanılamaz.** görünür.

## Güncelleme, yeniden başlatma veya yeniden yükleme {#maintenance}

1. **Ayarlar → OpenCode** bölümünde **Durumu ve güncellemeleri denetle** öğesini seçin.
2. Yüklü CLI dosyalarını değiştirmek için teklif edildiğinde **OpenCode {version} sürümüne güncelle** öğesini seçin. Tamamlanmasını bekleyin.
3. Çalışan hizmet durumunu gözden geçirin. **Paylaşılan hizmeti yeniden başlat** öğesini yalnızca seçilen kurulumu bağlı her istemci için etkinleştirmek istediğinizde kullanın.
4. Hiçbir şey yüklemeden işlemi yeniden başlatmak için **Sorun giderme** öğesini genişletin ve **OpenCode hizmetini yeniden başlat** öğesini seçip onaylayın.

| Eylem | Kapsam ve etki |
| --- | --- |
| CLI'yi güncelleyin | Desteklenen yüklü yürütülebilir dosyayı değiştirir; çalışan arka plan programını dolaylı olarak yeniden başlatmaz. |
| Hizmeti yeniden başlat | Paylaşılan süreci değiştirir ve bağlı tüm OpenCode istemcilerindeki etkin işleri keser; oturum geçmişi kalır. |
| OpenCode yapılandırmasını yeniden yükle | Süreci korur. Tüm bağlı istemciler için bekleyen izinleri/Formları iptal eder, terminalleri/arka plan komutlarını kapatır ve etkin işleri kesintiye uğratabilir. |

Kaydedilmiş bir yapılandırma veya yüklü eklenti kullanılamadığında, çalışan hizmet destekliyorsa **Sorun giderme** altında bulunan **OpenCode yapılandırmasını yeniden yükle** öğesini kullanın. Uyarıyı okuyup onaylayın: yeniden yükleme, bağlı tüm istemcilerdeki etkin çalışmayı kesintiye uğratabilir. CodeNomad, daha yeni çalışan bir arka plan programının sürümünü düşürmek için seçilen eski bir CLI'yi kullanmayacaktır.

## Oturum ortamı {#session-environment}

1. **Ayarlar → Gelişmiş** öğesini açın ve **Ortam Değişkenleri** bölümünü genişletin.
2. Değer ekleyin, düzenleyin veya kaldırın. Kaydedilmiş adlar salt okunurdur. Rune’da değişkeni seçin, değerini düzenleyin ve **Kaydet** seçeneğini kullanın.
3. Geçerli ortamı söz konusu konuşmaya uygulamak için sonraki istemi, özel komutu veya oturum kabuğu isteğini CodeNomad aracılığıyla gönderin.

Bu bir yapılandırma profili ayarıdır. Yalnızca bir görüşmeyi açmak/okumak veya ayarları kaydetmek yerel oturumu değiştirmez. Bir geçersiz kılmayı kaldırmak, yürütme ana bilgisayarının devralınan değerini geri yükler veya orada yoksa kaldırır.

Ortam, ilgili OpenCode oturumunda sonraki yerel kabuk başlatmalarını yönetir. Çalışan süreçler mevcut ortamlarını korur. Sağlayıcıları, MCP/LSP sunucularını, bağımsız terminalleri veya yalnızca Location kapsamındaki arka plan kabuklarını **yeniden yapılandırmaz**. Her kuyruk istemi kendi ortamını saklamaz; başka OpenCode istemcisi aynı oturum ortamını değiştirebilir. Tamamen OpenCode içinde oluşturulmuş alt oturumların CodeNomad gönderim anı güncellemesi aldığını varsaymayın.

Durdurulan bir hizmet başlatılırken izin verilen değişkenler de iletilir; Mevcut bir arka plan programına bağlanmak onun süreç ortamını değiştirmez. WSL'de değerler Windows PATH/HOME ile değil Linux yürütme ortamıyla birleştirilir.

## Yerel yapılandırma dosyalarını düzenleyin {#configuration-files}

1. **Ayarlar → Yapılandırma Dosyaları** yolunu açıp **Dosya** seçimini yapın.
2. Görüntülenen yolu kontrol edin, düzenleyin ve ardından **Kaydet** öğesini seçin.
3. Dosyayı yeniden okumak için **Yeniden yükle** öğesini kullanın; bu **OpenCode yapılandırmasını yeniden yükle** değil.

Bu düzenleyici, **CodeNomad sunucu kullanıcısının** `.config/opencode` dizini altında yalnızca listelenen genel `opencode.json` ve `opencode.jsonc` dosyalarını gösterir. Bu, rastgele bir dosya düzenleyicisi, bir Proje yapılandırma seçicisi veya bir WSL/özel keşif arka plan programının bu dosyayı okuyacağının garantisi değildir. Hedefi doğrulamak için görüntülenen yolu kullanın; diğer kökler için arka plan programının kendi araçlarını kullanın.

Kaydetme, dosyayı metin olarak yazar; yerel yapılandırmanın tamamını doğrulamaz veya OpenCode'u yeniden başlatmaz/yeniden yüklemez. Düzenlemeleri diğer istemcilerle koordine edin: Bu yüzey, harici değişiklik birleştirme olanağı sunmaz. Önemli konfigürasyonu değiştirmeden önce bir kopyasını saklayın. Dosyaları değiştirmek veya kirli bir taslağı yeniden yüklemek, bunun atılıp atılmayacağını sorar.

Konfigürasyona özel iş akışları için bkz. [Entegrasyonlar](integrations.md), [Sağlayıcılar](providers.md), [Görevler](missions.md) ve [OpenCode belgeleri](https://opencode.ai/v2/docs/).
