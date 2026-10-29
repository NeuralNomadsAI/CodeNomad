# CodeNomad'i indirin

Windows, macOS ve Linux için ücretsiz ve açık kaynaklı (MIT) masaüstü uygulaması. OpenCode hizmetinize bağlanır; önce [gereksinimleri](install.md#requirements) kontrol edin.

## Masaüstü uygulamaları {#desktop}

{{release}}

{{download-button}}

| Platform | Tauri (önerilen) | Electron |
| --- | --- | --- |
| Windows 10 veya sonrası | [Yükleyici, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 veya üzeri | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (Ubuntu 24.04'te test edildi) | [AppImage, x64](release:tauri-linux-x64) | [Debian paketi, x64](release:electron-linux-x64) |

Her iki sürüm de aynı çalışma alanını sunar. Tauri güncellemeleri uygulamanın içinden yükleyebilir; Electron yeni bir sürüm indirilerek güncellenir ve her platformda yerel tarayıcı otomasyonunu destekler (Tauri yalnızca Windows'ta). [Sürümleri karşılaştırın](install.md#desktop-downloads).

## Paket yöneticileri {#package-managers}

Windows'ta winget, Tauri sürümünü yükler:

```sh
winget install NeuralNomadsAI.CodeNomad
```

CodeNomad'i bağımsız bir sunucu olarak çalıştırıp bir tarayıcıda kullanmak için, Node.js 24 bulunan bir ana bilgisayarda npm ile başlatın:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

[Bağımsız sunucu](server.md#run) sayfası ilk oturum açmayı, genel kurulumu, adresleri ve kimlik doğrulamayı kapsar; [gereksinimler](install.md#requirements) Node.js, Git ve OpenCode'u listeler.

## Kurulum ve ilk başlatma {#verify-and-install}

Yalnızca bu sayfadan veya [resmî sürümlerden](https://github.com/NeuralNomadsAI/CodeNomad/releases) indirin ve güvenilmeyen bir arşivi asla yalnızca bir uyarıyı atlamak için çalıştırmayın.

- **Linux**: AppImage'ı çalıştırılabilir yapın veya Debian paketini kurun; bkz. [Linux üzerine kurulum](install.md#linux-install).
- **macOS**: macOS ilk başlatmayı engellerse bkz. [macOS karantinası](troubleshooting.md#macos-quarantine).
- **Tüm platformlar**: [Gereksinimlerde](install.md#requirements) listelendiği gibi Git'i ve uyumlu bir OpenCode CLI'yi yükleyin, ardından [ilk başlatmada OpenCode'u seçin](install.md#first-launch). Diğer başlatma sorunları [sorun giderme](troubleshooting.md#desktop-launch) bölümünde ele alınır.

## Geliştirmeyi destekleyin {#support-development}

CodeNomad ücretsizdir ve gönüllüler tarafından boş zamanlarında sürdürülür. Size veya ekibinize faydalıysa sponsorluk, bakımının sürmesine ve yeni OpenCode sürümleriyle uyumlu kalmasına yardımcı olur. [CodeNomad'i destekleyin](sponsor.md) sayfası sponsorluğun neleri finanse ettiğini açıklar.

{{funding}}
