# CodeNomad kurulumu

Yerel bir masaüstü ana bilgisayarı seçin veya [bağımsız sunucu](server.md)'yi çalıştırın. Her iki durumda da OpenCode, paylaşılan yerel hizmete ve geçmişe sahiptir.

## Masaüstü indirmeleri {#desktop-downloads}

1. [En son sürümü](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest)'yi açın.
2. İşletim sisteminize ve işlemcinize uygun yapıyı seçin.
3. ZIP'i çıkarın veya platform paketini kurun/çalıştırın, ardından CodeNomad'i başlatın.

| Platform | Electron sürümü | Tauri sürümü | Platform notları |
| --- | --- | --- | --- |
| macOS | ZIP, Intel veya Apple Silicon | ZIP, Intel veya Apple Silicon | Paket çalışma zamanı için macOS 13.5 veya üzeri gereklidir. |
| Windows | ZIP, x64 | Yükleyici, x64 | Windows 10 veya sonrası; Tauri WebView2 kullanır. |
| Linux | Debian paketi, x64 | AppImage, x64 | Ubuntu 24.04'te oluşturulmuş ve test edilmiştir; eski dağıtımlarla uyumluluk garanti edilmez. |

Masaüstü sürümleri, arka uç ve OpenCode yükleyicisinin ihtiyaç duyduğu çalışma zamanı kaynaklarını içerir; dolayısıyla bunları kullanmak için ayrı bir Node.js/npm kurulumuna ihtiyacınız yoktur. Git pakete dahil değildir. Yerel tarayıcı otomasyonu Electron ve Windows Tauri'de desteklenir; diğer Tauri platformları iframe önizlemelerini kullanır.

Başlatma sırasında engellenen doğrulanmış bir indirme için, bkz. [platform sorunlarını giderme](troubleshooting.md#desktop-launch). Asla güvenilmeyen bir arşivi yalnızca bir uyarıyı atlamak için çalıştırmayın.

## Linux üzerine kurulum {#linux-install}

İndirilen sürümün bulunduğu klasörde gerçek sürümü ve dosya adını kullanın:

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

Tauri AppImage için:

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

FUSE kullanılamıyorsa AppImage'ın çıkarma ve çalıştırma modunu kullanın:

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

Electron Debian kurulumu, Chromium'un korumalı alanını yapılandırır. Kurulum geçici çözümü olarak korumalı alanı devre dışı bırakmayın. Linux Tauri grafik sorunlarının [hedefli WebKit geçici çözümü](troubleshooting.md#desktop-launch)'si vardır.

## Gereksinimler {#requirements}

| Gereksinim | Nerede bulunması gerektiği | Mevcut gereksinim |
| --- | --- | --- |
| OpenCode CLI | Geçerli olduğu yerde seçilen WSL dağıtımı da dahil olmak üzere seçilen yürütme ana bilgisayarı | Minimum **2.0.27**; **2.0.32** önerilen/uygun hedeftir. Daha yeni veya özel sürümler, test edilmemiş sürüm yasağı yerine sözleşme doğrulamasından geçer. |
| Git | CodeNomad arka uç hesabının `PATH`'si | Depo kimliği, Git işlemleri ve çalışma ağaçları için gereklidir. |
| Node.js/npm | Bağımsız sunucu ve kaynak derleme ana bilgisayarı | Node.js 24 LTS; tekrarlanabilir kaynak derlemeleri `.node-version` (**24.20.0**) kullanır. Masaüstü çalışma zamanı/kurulum kaynaklarına dahildir. |
| Çalışma alanı klasörü | Arka uçtan erişilebilen disk | Uzak bir tarayıcı tarafından çıkarılan yerel cihaz klasörü değil, açıkça açılmış bir fiziksel klasör. |

Windows'ta, komut satırı/üçüncü taraf erişimi etkinleştirilmiş olarak [Windows için Git](https://gitforwindows.org/)'yi yükleyin. Kullanıcı tarafından yazılabilen, kullanıcı başına kurulum yeterlidir. MacOS/Linux'ta [Git'in platform talimatlarını](https://git-scm.com/downloads) kullanın.

`PATH`'yi değiştirdikten sonra, masaüstü uygulamasından tamamen çıkıp yeniden başlatın veya amaçlanan hesap altında bağımsız arka ucu yeniden başlatın. Bir tarayıcının yeniden yüklenmesi arka uç ortamını güncellemez. Yalnızca WSL içinde bulunan Git, Windows arka ucunun Git gereksinimini karşılamaz.

Git olmadan, yine de fiziksel bir klasörü açabilir ve aracıdan kurulum yardımı istemek de dahil olmak üzere yalnızca dizin konuşmalarını kullanabilirsiniz. Depo/çalışma ağacı işlemleri kullanılamıyor; oturum erişimi tam olarak bu klasörle sınırlı kalır. CodeNomad, istemlerden/özel komutlardan önce aracıya arka uç Git kullanılabilirliği hakkında bilgi verir ve kurtarma sonrasında bu uyarıyı kaldırır. Aracının yürütme ana bilgisayarı arka uç ana bilgisayarından farklı olabilir; bu nedenle Git'i yalnızca aracının kabuğu için değil, arka uç için de yükleyin.

## İlk başlatmada OpenCode'u seçin {#first-launch}

1. Kurulumda, mevcut uyumlu bir yürütülebilir dosyayı seçin veya sunulan OpenCode kurulum işlemini kullanın.
2. Bir projeyi açmadan önce çalışma zamanı durumunu doğrulayın.
3. Yürütülebilir dosyayı, kurulumu ve paylaşılan hizmeti ayrı ayrı yönetmek için **Preferences → OpenCode** öğesini tekrar ziyaret edin.

CodeNomad, `PATH` üzerinde uyumlu yürütülebilir dosyaları tercih eder ve açıkça seçilmiş bir yürütülebilir dosyayı destekler. CLI'nin kurulması/güncellenmesi, halihazırda çalışan bir paylaşılan hizmeti sessizce yeniden başlatmaz. Yeniden başlatma/yeniden yükleme sonuçları, WSL ve oturum ortamı için bkz. [OpenCode kurulumu](opencode.md).

## Bunun yerine bir tarayıcı kullanın {#browser-install}

Node.js/npm, Git ve OpenCode'u sunucu ana bilgisayarına yükleyin, ardından [sunucu başlatma prosedürlerini](server.md) kullanın. Basılı adres, yapılandırılmış kimlik doğrulama ve güvenilir bir sertifika ile bağlanın. Bir tarayıcının/PWA'nin canlı bir arka uca ihtiyacı vardır; projelerinizin çevrimdışı bir kopyası değildir.

Bağlantı noktaları, bağlamalar ve TLS için [doğrudan erişim](remote-access.md)'yi kullanın. Bir cihazı gelen bağlantı noktalarını açmadan eşleştirmek için [Uzaktan Kontrol](remote-control.md)'yi kullanın. Geliştirme ve paketleme komutları için bkz. [kaynak derlemeleri](support.md#build-from-source).
