# Destek ve kaynak derlemeleri

Hata raporları, güncel sürümler ve katkılar için depoyu kullanın. [Sorun giderme kılavuzu](troubleshooting.md), bir sorunu bildirmeden önce güvenli kurtarmayı kapsar.

## Hata bildirin {#report-a-bug}

1. **Ayarlar → Bilgi → Tanılama** öğesini açın.
2. GitHub sorun formunu açmak için **Hata bildir** öğesini seçin.
3. Önceden doldurulan sürüm/istemci bilgilerini inceleyin. En küçük yeniden üretme örneğini, beklenen davranışı ve gerçek sonucu ekleyip GitHub üzerinden gönderin.

Eylem, CodeNomad ve OpenCode sürümlerini (kurulu olandan farklıysa çalışan OpenCode hizmetininki dahil), işletim sisteminizi, istemci türünü (web tarayıcısında tarayıcının kullanıcı aracısıyla birlikte) ve sunucunun işletim sistemini önceden doldurur. Dinleyici adreslerini, çalışma alanı yollarını, kimlik bilgilerini veya konuşma metnini önceden doldurmaz. Formu açmak bir sorun göndermiyor.

Daha fazla tanılama gerekiyorsa **Panoya kopyala** veya **.txt indir** ayrı rapor üretir. Bu kapsamlı rapor yerel yolları ve ağ adreslerini içerebilir: eklemeden önce inceleyip hassas bilgileri gizleyin. Otomatik rapor kimlik doğrulama sırlarını hariç tutsa da ekran görüntüsü veya günlük alıntısı sır içerebilir.

GitHub formunun alanları uyumsuzsa CodeNomad aynı rapor bilgileriyle düz bir sorun bildirimi açar. Formu okumadaki geçici hata açılmasını engellemez. Her zaman [sorun listesini](https://github.com/NeuralNomadsAI/CodeNomad/issues) elle kullanabilirsiniz.

## Topluluk ve sürümler {#community}

| Kaynak | Kullanım |
| --- | --- |
| [CodeNomad deposu](https://github.com/NeuralNomadsAI/CodeNomad) | Kaynak, proje etkinliği ve belgeler. |
| [Sorunlar](https://github.com/NeuralNomadsAI/CodeNomad/issues) | Tekrarlanabilir bir hatayı veya özellik isteğini açmadan önce mevcut raporları arayın. |
| [Çekme istekleri](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | Önerilen değişiklikleri inceleyin veya bir katkıyı koordine edin. |
| [Son sürüm](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Kararlı indirme paketleri. |
| [Tüm sürümler](https://github.com/NeuralNomadsAI/CodeNomad/releases) | Yayınlanan önizlemeler ve sürüm notları. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | Proje kuruluşu. |
| [MIT lisansı](../../../LICENSE) | Lisans koşulları. |

CodeNomad kontrolleri yerine yerel OpenCode yapılandırmasıyla ilgili sorunlar için, [OpenCode belgelerine](https://opencode.ai/v2/docs/) ve [yukarı akış sürümleri](https://github.com/anomalyco/opencode/releases)'ye bakın.

## Kaynaktan derleyin {#build-from-source}

`.node-version` ile sabitlenen Node.js **24.20.0**, npm, Git ve uyumlu OpenCode CLI kullanın. Komutları geliştirme çalışma kopyasında çalıştırın:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev`, Electron geliştirme ana bilgisayarını başlatır. Tauri'yi kullanmak için önce Rust araç zinciri dahil olmak üzere [platform oluşturma önkoşullarını](https://v2.tauri.app/start/prerequisites/)'yi yükleyin ve ardından şunu çalıştırın:

```sh
npm run dev:tauri
```

Geliştirme değişiklikleri, bağımsız olarak çalışan OpenCode arka plan programının yüklü sürümünü değil, geliştirme ana bilgisayarını etkiler. Yerel paketlemenin uygun hedef araçlara ihtiyacı vardır; hedef işletim sistemi üzerinde derlemeleri tercih edin.

### Derleyin ve doğrulayın {#build-and-validate}

| Komut, depo kökünden | Amaç |
| --- | --- |
| `npm run build` | Electron uygulama kaynaklarını oluşturun. |
| `npm run build:tauri` | Tauri uygulamasını yerel önkoşullarıyla derleyin. |
| `npm run build:ui` | Tarayıcı kullanıcı arayüzünü oluşturun. |
| `npm run build --workspace @neuralnomads/codenomad` | Bağımsız sunucuyu ve paketlenmiş varlıkları oluşturun. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Electron Debian sürümünü paketleyin. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Bir Linux Tauri AppImage'ı paketleyin. |
| `npm run typecheck` | Kökün yapılandırılmış TypeScript çalışma alanlarını kontrol edin. |
| `npm run test:help` | Tüm genel yardım yerel ayarlarını ve bağlantılarını doğrulayın. |
| `npm run build:help` | `dist/help`'de bağımsız kamu yardımını oluşturun. |

Yardım derlemesi çalışan CodeNomad veya OpenCode hizmeti gerektirmez. Paketleme için [BUILD.md](../../../BUILD.md), kapsamlı doğrulama ve PR kuralları için [CONTRIBUTING.md](../../../CONTRIBUTING.md) sayfalarına bakın; hedef pakette gerçekten bulunan betikleri kullanın.

## Paket haritası ve katkı {#contribute}

| Paket | Sorumluluk |
| --- | --- |
| `packages/server` | Çalışma alanı/API/Git kontrolleri, OpenCode bağlantısı, kimlik doğrulama, olaylar ve ses. |
| `packages/ui` | SolidJS çalışma alanı, kontroller, yerelleştirme ve tarayıcı yardımı giriş noktası. |
| `packages/electron-app` | Electron pencereler, yerel entegrasyon ve paketleme. |
| `packages/tauri-app` | Tauri pencereler, platform entegrasyonu ve paketleme. |
| `packages/remote-tunnel` | Arka uç tarafı OpenTunnel taşıma çalışma zamanı. |

1. Örtüşen çalışmayı uygulamaya koymadan önce ilgili konunun kapsamını tartışın.
2. `dev` üzerinden dal oluşturup değişikliği odaklı tutun.
3. Etkilenen alan için kontrolleri çalıştırın, davranışın yanı sıra kullanıcı yardımını da güncelleyin ve PR'nizi `dev`'de hedefleyin.

Herkese açık yardım kaynakları `docs/help/<locale>/` dizinindedir. Çeviride her İngilizce başlığın açık kimliğini, düzeyini ve sırasını koruyun; çevrilmiş başlıklar derin bağlantıları bozmamalıdır. [Yardım bakım sözleşmesi](../../../dev-docs/USER_HELP.md) sıkı eksiksizlik denetimlerini ve statik yayımlama hattını açıklar.
