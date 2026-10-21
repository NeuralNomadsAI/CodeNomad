# Bağımsız sunucu

Projelerinizin ve araçlarınızın bulunduğu yerde CodeNomad'i çalıştırın, ardından tarayıcı kullanıcı arayüzünü yerel olarak veya uzaktan kullanın. Arka uç, dosya sistemi erişimini, Git işlemlerini, kimlik doğrulamayı ve olay dağıtımını sağlar. OpenCode'un paylaşılan hizmeti, konuşmaların ve yürütmenin sahibidir; bir tarayıcının bağlantısı kesildiğinde durdurulacak bir alt sunucu değildir.

Aynı kullanıcı arayüzü [çoklu proje sekmeleri ve çalışma ağaçları](projects.md), [konuşma aileleri ve arka plan etkinliği](conversations.md), [sınırlı geçmiş yükleme, arama ve zaman çizelgesinde gezinme](history.md), [komut paleti ve kısayolları](shortcuts.md) ve [Görevler](missions.md) özelliğini destekler. Tarayıcı ve tablet erişimi, yürütmeyi ana bilgisayarın dışına taşımaz.

## Ana bilgisayarı hazırlayın {#prerequisites}

1. Node.js 24 LTS ve npm'yi yükleyin; havuzun sabitlenmiş derleme çalışma zamanı 24.20.0'dır. Masaüstü paketleri Node/npm'yi içerir.
2. Git'i **arka uç sürecinin PATH** değişkenine ekleyin. Yalnızca WSL içindeki Git, Windows arka ucu için yeterli değildir.
3. OpenCode'u yükleyin veya seçin: gerekli minimum değer **2.1.2**'dir ve **2.1.2** önerilen yeterlilik hedefidir. Daha yeni veya özel derlemeler, test edilmiş sürüm izin verilenler listesine değil, uyumluluk denetimlerine tabi tutulur. Bkz. [OpenCode kurulumu](opencode.md).
4. Sunucunun başlatılacağı klasörü seçin veya `--workspace-root`'yi açıkça iletin.

Git olmadan, konuşmalar yalnızca açıkça açılan fiziksel klasörde kullanılabilir durumda kalır; Git ve çalışma ağacı işlemleri başarısız oluyor. Git'i yükleyin ve PATH değişikliğinden sonra arka ucu yeniden başlatın. Çalışma alanı kökü, aracının yürütülmesini değil, açmayı/göz atmayı sınırlar: bkz. [Güvenlik](security.md).

## Çalıştırın veya kurun {#run}

Bir kurulum yöntemi seçin. Bu ilk çalıştırma örnekleri, kabuk geçmişine parola koymak yerine yerel bir önyükleme kullanıyor:

### npx ile çalıştırın {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Genel olarak yükle {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### Projeye kurun {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad`, varsa projenin yüklü yürütülebilir dosyasını kullanır. Bu, paketi projeye kurar; yapılandırmayı veya OpenCode deposunu projeye özel **yapmaz**.

1. Yazdırılan **Local Connection URL** adresini ana bilgisayarda açın. [Yerel ilk kurulumu](security.md) tamamlayıp kalıcı sunucu parolası kaydedin. HTTPS güveni henüz kurulmadıysa bu işlem yalnızca loopback HTTP kurulum seçeneğini de içerir.
2. Sonraki başlatmalarda `--generate-token`'yi atlayın; alternatif olarak her çalıştırmada `CODENOMAD_SERVER_PASSWORD`'yi besleyin.
3. Kurulu CLI'nin seçeneklerini incelemek için `codenomad --help`'yi kullanın.

Komutlar ön planda çalışır. Terminalin kapatılması veya Ctrl+C'nin gönderilmesi, arka ucu ve Uzaktan Kontrol bağlantısını durdurur. `--launch` yalnızca bir tarayıcıyı açar; sunucuyu daemonize etmez. Gözetimsiz kullanılabilirlik için aynı komutu işletim sistemi işlem/hizmet yöneticiniz altında açık yapılandırma, çalışma dizini, ortam ve yeniden başlatma politikasıyla çalıştırın. Hizmet günlüklerine veya ortak birim dosyasına sır koymayın.

Tarayıcıyı kapatmak ayrı çalışan bağımsız arka ucu durdurmaz. Proje sekmesini kapatmak o projenin CodeNomad bağlantısını kaldırır, ancak oturumlar OpenCode'da devam eder; onları yeniden bulmak için projeyi tekrar açın. CodeNomad yerel Location bağlamını hiçbir zaman kaldırmaz. Bir pencerenin tamamını kapatmak, uygulamadan çıkmak veya yeniden yüklemek proje bağlantılarını geri yükleme için korur. Arka ucu kapatmak da OpenCode hizmetini çalışır bırakır. CodeNomad dönene kadar arka uca bağlı özellikler kullanılamaz; ayrı OpenCode zamanlama ömrü için [Görevler](missions.md) sayfasına bakın.

## Adresler ve bağlantı noktaları {#addresses}

Başlangıç, mevcut olduğunda **Local Connection URL** ve **Remote Connection URL** öğesine ek olarak uygun olduğunda **Other Accessible URLs** öğesini yazdırır. Tahmin edilen bir adresi değil, basılı şemayı ve bağlantı noktasını kullanın. Geri döngü URL'sine yalnızca söz konusu makinede erişilebilir; basılı bir LAN adresi yine de yönlendirme ve güvenlik duvarı erişimi gerektirir.

HTTPS **9898**, HTTP **9899** portunu tercih eder. Port belirtilmemişse tercih edilen port doluyken işletim sisteminin atadığı porta geçilir. Açıkça belirtilmiş sıfır olmayan port başka porta geçmez; `0` işletim sisteminin port atamasını ister. Portlar 0 ile 65535 arasında tam sayı kabul eder.

Arka uç, Görevler gibi kendi OpenCode eklentileri için rastgele bir `127.0.0.1` portunda duyurulmayan, kimlik doğrulamalı bir HTTP dinleyicisi de açabilir. Bu dinleyici yazdırılmaz ve bir istemci adresi değildir.

Dinleyicinin erişimi, sertifikalar, VPN/SSH ve ters proxy'ler için [Doğrudan uzaktan erişim](remote-access.md) kullanın. Gelen bağlantı noktası olmadan erişim için [Uzaktan Kontrol](remote-control.md) kullanın.

## Genel CLI referansı {#cli-reference}

Bayraklar karşılık gelen ortam değişkenlerini geçersiz kılar. Değer alan bayraklar gösterilen argümanı kullanır; anahtarlar değer almaz. HTTPS/HTTP değerleri büyük/küçük harfe duyarsız olarak `1`, `true`, `yes`, `y` ve `on` değerlerini etkin sayar; açıklık için `true`/`false` kullanın. Arayüzün otomatik güncellemesi `1`, `true` ve `yes` değerlerini tanır.

**Katı boole ortam değişkenleri** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` ve `CODENOMAD_SKIP_AUTH`), büyük/küçük harf ayrımı yapmadan ve baştaki/sondaki boşlukları yok sayarak `1`, `true`, `yes` veya `on` ile anahtarlarını etkinleştirir. `0`, `false`, `no`, `off`, boş veya yalnızca boşluk içeren değerler ve tanımlanmamış değişkenler anahtarları kapalı bırakır. Diğer tüm değerler, ilgili CLI bayrağı verilse bile sunucunun başlamasını engeller. CLI bayrağı, geçerli bir kapalı değerini geçersiz kılarak anahtarı etkinleştirir; aksi halde aşağıdaki `false` varsayılanları uygulanır.

| Bayrak | Ortam değişkeni | Varsayılan ve etki |
| --- | --- | --- |
| `-h, --help` | — | Yardımı yazdırın ve çıkın. |
| `-v, --version` | — | Kurulu paket sürümünü yazdırın ve çıkın. |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`; `localhost`, IPv4 geri döngüsüne normalleşir. IPv6 bölge tanımlayıcıları reddedilir. [Bağlama matrisi](remote-access.md)'ye bakın. |
| `--https <enabled>` | `CLI_HTTPS` | `true`; HTTPS dinleyici. |
| `--http <enabled>` | `CLI_HTTP` | `false`; HTTP dinleyici. En az bir dinleyicinin etkinleştirilmesi gerekir. |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` tercih edilir; `0` otomatik. |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` tercih edilir; `0` otomatik. |
| `--tls-key <path>` | `CLI_TLS_KEY` | Ayarlanmadı; PEM özel anahtarı, `--tls-cert` gerektirir. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | Ayarlanmadı; PEM sertifikası `--tls-key` gerektirir. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Ayarlanmadı; sağlanan sertifikalar için isteğe bağlı PEM CA zinciri. |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Ayarlanmadı; oluşturulan sertifikalar için virgülle ayrılmış ek DNS adları/IP'leri. |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | İşlem çalışma dizini; çalışma alanlarını açmak için kök. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`; tam dosya sistemi taramasına izin ver. Ajan korumalı alan ayarı değil. |
| `--config <path>` | `CLI_CONFIG` | Çözülmüş etkin varsayılan: `~/.config/codenomad/config.yaml`. Açık yerleştirme için bir dizini veya YAML dosyasını kabul eder. |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`; belgelenen seviyeler: `trace`, `debug`, `info`, `warn`, `error`. |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`; aksi takdirde seçilen dosyaya yazın. |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`; çalışma zamanı kimlik doğrulama kullanıcı adı. Saklanan bir kimlik doğrulama dosyası, hiçbir çalışma zamanı parolası onu geçersiz kılmadığında, saklanan kullanıcı adını korur. |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Ayarlanmadı; yalnızca çalışma zamanı parolası, yönetilen kimlik doğrulama dosyasına göre önceliklidir. |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`; Harfler, rakamlar, `_` ve `-` dışındaki karakterler `_` olur. |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`; tek kullanımlık, 60 saniyelik bir yerel önyükleme jetonu yazdırın. |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`; doğrudan dinleyici kimlik doğrulamasını devre dışı bırakır. Tehlikeli: bkz. [Güvenlik](security.md). Uzaktan Kontrol hâlâ cihaz eşleştirmeyi gerektiriyor. |
| `--ui-dir <path>` | `CLI_UI_DIR` | Paketin `public` dizini; açık bir geçersiz kılma, uzak kullanıcı arayüzü çözümlemesi yerine bu kullanıcı arayüzüne hizmet eder. |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Ayarlanmadı; HTTP dinleyicisi aracılığıyla proxy kullanıcı arayüzü. Geliştirme için `--https=false --http=true`'yi kullanın; HTTPS dinleyicisi geliştirici kullanıcı arayüzüne proxy sağlamaz. |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`; otomatik güncellemeyi geçersiz kılar ve mevcut önbelleğe alınmış/paketlenmiş kullanıcı arayüzünü kullanır. |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`; başlangıçta uyumlu uzak kullanıcı arayüzünü kontrol edin. |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`; uzak kullanıcı arayüzü bildirimi. |
| `--launch` | `CLI_LAUNCH` | `false`; Başlatma sonrasında yerel kullanıcı arayüzünü bir tarayıcıda açın. |
| `--upgrade [version]` | — | Varsayılan olarak yükseltme yoktur. İstendiğinde `@neuralnomads/codenomad@latest`'yi veya sağlanan sürümü genel olarak yükleyin ve çıkın. |

Genel referans, kullanıcıya yönelik seçenekleri listeler; masaüstü ana bilgisayarları kendi özel başlatma koordinasyonlarını yönetir.

### Ek dağıtım ortamı {#deployment-environment}

| Değişken | Varsayılan ve kapsam |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`; sürüm teklifleri için depo sorgulandı. |
| `CODENOMAD_REMOTE_CONTROL_API` | Ayarlanmadı: barındırılan OpenTunnel API. Şirket içinde barındırılan geçiş dağıtımı için bir API kaynağı ayarlayın. |
| `NODE_EXTRA_CA_CERTS` | Node'un isteğe bağlı ek CA dosyası; eksik OpenCode daemon'ı başlatılırken izin verilen başlangıç ortamıyla iletilir. Çalışan daemon'ı değiştirmez. |

Sağlayıcıya özel kullanım kimlik bilgileri, [Sağlayıcılar](providers.md) belgesinde ele alınmaktadır. Masaüstü veri profili seçimi [Masaüstü](desktop.md) kapsamındadır ve yayın akışı tarafından kontrol edilmez.

## Yapılandırma ve depolama sahipliği {#storage}

Aşağıdaki varsayılan yollar arka uç kullanıcısının ana dizinine göredir. Açık `--config` dizini yapılandırma tabanını değiştirir; YAML dosya adı o dosyayı ve yanındaki durum/depolamayı seçer. Dağıtım için bilinçli olarak tek yapılandırma kimliği kullanıp dizinin tamamını işletim sistemi izinleriyle koruyun.

| Sahip/veri | Varsayılan konum veya kural |
| --- | --- |
| Kararlı CodeNomad tercihleri | `~/.config/codenomad/config.yaml` |
| Değiştirilebilir CodeNomad durumu | `~/.config/codenomad/state.yaml` |
| CodeNomad örneği meta verileri | `~/.config/codenomad/instances/` |
| Şifre karması | Aktif YAML yapılandırmasının yanında `auth.json`; uygulama tarafından yönetilen. |
| Oluşturulan TLS sertifikaları ve özel anahtarlar | Yapılandırma tabanı altında `tls/`. |
| Uzaktan Kontrol rotası, etkin seçim ve cihaz karmaları | Yapılandırma tabanı altında `remote-control-devices.json`. |
| Geçici çalışma alanı kayıt defteri ve klasörleri | Bu tabanın altında `temporary-workspaces.json` ve `temporary-workspaces/`. |
| Kurulu panel uzantıları ve izin makbuzları | Bu tabanın altında `panel-extensions/` ve `permission-receipts/`. |
| İndirilen kullanıcı arayüzü önbelleği | `~/.config/codenomad/ui/`; CLI'nin kullanıcı arayüzü çözümleyicisi, özel bir `--config` ile bile bu ev tabanlı önbelleği kullanır. |
| OpenCode konuşmalar, mesajlar, hizmet kaydı ve sağlayıcı bağlantıları | CodeNomad instance dizini değil, OpenCode'un yürütme ana bilgisayarındaki kendi genel depolama alanı. |
| Masaüstü geri yükleme durumu | Varsayılan `~/.codenomad/client-state/v2/`; profil/pencere kapsamı için [Masaüstü](desktop.md)'ye bakın. |

CodeNomad mevcut paylaşılan arka plan programına bağlanır veya eksikse onu başlatır. Başlangıç ortamı yalnızca yeni başlatılan bir arka plan programını etkiler. Ayrı olarak, yapılandırılmış tam oturum ortamı, tercihler yalnızca görüntülendiğinde veya düzenlendiğinde değil, her istemden, özel komuttan veya oturum kabuğu isteğinden önce uygulanır. Bkz. [OpenCode kurulumu](opencode.md).

## Olaylar ve yeniden bağlanma {#events}

Arka uç paylaşılan OpenCode olay akışını tüketir; çalışma alanı ve CodeNomad olaylarını Server-Sent Events ile tarayıcı istemcilerine dağıtır. Teslimat canlı ve geçicidir: **garantili olay tekrarı yoktur**.

Yeniden bağlandıktan sonra kullanıcı arayüzü yetkili oturumu ve bekleyen istek durumunu yeniden getirir; dosya/yapılandırma geçersizlikleri de yeni okumaları tetikler. Yeniden bağlanma, yanıtı kaybolan bir gönderme, silme, yanıtlama veya başka bir değişiklik işleminin tekrarlanmasına izin vermez. İlk önce ortaya çıkan durumu kontrol edin. Kurtarma işlemi tamamlanmadığında, beklemede olduğu bilinen istekler ve taslaklar korunur; bkz. [İzinler](permissions.md) ve [Sorun Giderme](troubleshooting.md).

## Önizleme paketleri ve bakım {#maintenance}

Önizleme CLI paketini açıkça denemek için:

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

Yalıtılmış CodeNomad ayarlarına ihtiyacınız varsa bilinçli olarak ayrı bir yapılandırma kullanın; bir paketin seçilmesi, paylaşılan OpenCode depolama alanını izole etmez. **Ayarlar → Bilgi → Güncellemeler → Güncelleme akışı**, arka ucun veri kimliğini veya yüklü paketi değil, sunulan sürümleri kontrol eder.

`codenomad --upgrade`, algılanan npm/pnpm/bun yöneticisini (hiçbiri algılanmazsa npm) kullanarak genel kararlı CLI paketini günceller. Çalışan bir sunucuyu yeniden başlatmaz veya OpenCode'u güncellemez. Proje yerel veya önizleme kurulumu için tam olarak npm paketini açıkça güncelleyin. Güncellemeden sonra yönetilen CodeNomad işleminizi bilinçli olarak yeniden başlatın; basılı adreslerini tekrar kontrol edin.

Masaüstü bakımı için [Güncellemeler](updates.md)'ye, kaynak oluşturma komutları için [Destek](support.md)'ye ve sağlayıcı planı kullanımı için [Sağlayıcılar](providers.md)'ye bakın.
