# Klavye kısayolları

## Komutları keşfedin ve yardımı açın {#discover-commands}

1. Windows/Linux'ta `Ctrl+Shift+P`'yi veya macOS'ta `Cmd+Shift+P`'yi kullanarak **Komut Paleti** öğesini açın veya görünür düğmesini/menü öğesini kullanın.
2. Bir eylem adı yazın. Palet, uygulama eylemlerini ve mevcut Location bağlamının özel komutlarını içerir; Kullanılabilirlik aktif görünüme bağlıdır.
3. Bu kılavuzu harici bir tarayıcı bağlamında mevcut kullanıcı arayüzü dilinde açmak için **Yardımı aç** komutunu çalıştırın. Yerel **Yardım → CodeNomad Yardımı** aynı kılavuzu açar.

Yardım, uygulama görünümünü ve taslağını değiştirmez. Açılamazsa doğrudan [CodeNomad Yardımı](https://neuralnomadsai.github.io/CodeNomad/) adresini ziyaret edin. Komutun bulunabilir olması özelleştirilebilir kısayolu olduğu anlamına gelmez: kısayol yöneticisi her palet/native menü eylemini değil, arayüzün sabit 49 komutluk kataloğunu kapsar.

## Kaydedin, devre dışı bırakın ve sıfırlayın {#customize}

1. **Ayarlar → Klavye kısayolları** öğesini açın ve eylemi bulmak için **Kısayolları filtrele** öğesini kullanın.
2. **Düzenle** eylemini seçip **Bir tuş birleşimine basın** alanında istediğiniz birleşime basın. Kaydetme bu atamayı saklar.
3. Bu eylemin arayüz bağlamasını kaldırmak için **Devre dışı bırak** öğesini, varsayılanı geri yüklemek için **Sıfırla** öğesini veya tüm arayüz bağlamaları için **Tümünü sıfırla** öğesini kullanın.
4. Çakışan her satırdaki uyarıları çözün; çatışmalar sessizce devre dışı bırakılmaz, raporlanır.

Atamalar CodeNomad arayüz yapılandırmasına kaydedilir ve bunu paylaşan istemcileri etkiler. OpenCode CLI/TUI atamalarını veya native menü kısayollarını düzenlemez. Kayıt uygulamanın arayüz kısayollarını bastırır ancak işletim sistemi/native menü kısayollarını bastıramaz. **İptal**, odak kaybı, bölümün kapanması veya pencereden çıkış kaydı bitirir. Tek başına değiştirici tuşlar ve IME birleşimi yok sayılır; yalın Tab/Shift+Tab odağı taşır.

Kaydetme başarısız olursa eski kısayolu kullanılabilir durumda tutun ve görüntülenen bağlamayı kontrol ettikten sonra yeniden deneyin. Sıfırlama, kazara yapılan bir atamanın güvenli bir şekilde kurtarılmasıdır.

## Arayüz varsayılanları {#renderer-defaults}

`Mod`, Windows/Linux'ta `Ctrl` ve macOS'ta `Cmd` anlamına gelir. Bunlar varsayılan değerlerdir; işletim sisteminin/yerel ana bilgisayarın anahtarı teslim edeceğini garanti etmez. Kapsam önemlidir: Aynı anahtar ana sayfada, ileti düzenleyicisinde veya aramada farklı bir eyleme hizmet edebilir.

| Eylem | Varsayılan |
| --- | --- |
| Komut paletini aç | `Mod+Shift+P` |
| Yeni örnek / Ana sayfada bir klasöre göz atın | `Mod+N` |
| Uygulama sekmesini kapat | `Mod+W` |
| Önceki / sonraki uygulama sekmesi | `Mod+[` / `Mod+]` |
| Uygulama sekmesi 1-9 | `Mod+1`'den `Mod+9`'ye kadar |
| Örneği yeniden adlandırın (sekme bağlamı) | `F2` |
| Yeni oturum | `Mod+Shift+N` |
| Oturumu kapat | `Mod+Shift+W` |
| Önceki / sonraki oturum | `Mod+Shift+[` / `Mod+Shift+]` |
| Oturum sekmesi 1-9 | `Mod+Shift+1`'den `Mod+Shift+9`'ye kadar |
| Örnek bilgisi | `Mod+Shift+L` |
| Oturum geçmişini ara | `Mod+F` |
| Sonraki/önceki arama sonucu (arama odaklı) | `Enter` / `Shift+Enter` |
| İsteme odaklan / İstemi temizle | `Mod+P` / `Mod+K` |
| Model / temsilci seçiciyi aç | `Mod+Shift+M` / `Mod+Shift+A` |
| Model çeşidini seçin | `Mod+Shift+T` |
| Engelleyen araçları arka plana al (ileti düzenleyicisi) | `Mod+B` |
| İstemi gönder | `Enter` |
| Alternatif takip davranışıyla gönder | `Alt+Enter` veya `Mod+Shift+Enter` |
| Yeni satır ekle | `Shift+Enter` veya `Mod+Enter` |
| Önceki / sonraki istem (ileti düzenleyicisi) | `ArrowUp` / `ArrowDown` |
| İstem odağını kaldır / Shell modundan çık | `Escape`, ileti düzenleyicisi bağlamına göre |
| Oturumu durdur | `Escape`'ye iki kez basın; ilk basıldığında onay görüntülenir |
| Yan soruyu gönder (`/btw` penceresi) | `Mod+Enter` |
| Dosyayı kaydet (çalışma alanı düzenleyicisi) | `Mod+S` |

Enter ile göndermenin kapalı olduğu yapılandırmada **İstemi gönder** varsayılanı `Mod+Enter`, **Yeni satır ekle** varsayılanı `Enter` veya `Shift+Enter` olur. Açık kısayol geçersiz kılması bu varsayılanı değiştirir. Etkin atamayı yöneticiyle görün. Önceki/sonraki oturum oturum listesini döner; kısayolu olmayan tarayıcı benzeri **Geri**/**İleri** geçmişi değildir.

## Native tuşlar ve platformun araya girmesi {#native-keys}

Native tuşlar sabittir; karşılık gelen arayüz atamasını değiştirseniz veya kapatsanız da etkin kalır. Özellikle native **New Window**, arayüzde Yeni oturum varsayılanı olan `Mod+Shift+N` birleşimini kullanır. Native menü araya giriyorsa görünür Yeni oturum kontrolünü kullanın veya arayüz eylemini başka tuşa atayın. Benzer biçimde native `Mod+W`, yalnızca uygulama sekmesi yerine pencereyi kapatabilir.

| Yerel eylem | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | View menüsü kontrolleri ve platform web görünümünün yakınlaştırma girdisi |
| Full Screen | Windows/Linux'ta `F11`; MacOS'ta `Ctrl+Cmd+F` | MacOS'ta `Ctrl+Cmd+F` menü hızlandırıcı; menüyü diğer platformlarda kullanın |
| Developer Tools | Windows/Linux'ta `Ctrl+Shift+I`; MacOS'ta `Alt+Cmd+I` | `Alt+Mod+I` |

Normal tarayıcı pencereleri tarayıcı kısayollarını da korur. Tuş birleşimi CodeNomad'e hiç ulaşmıyorsa güvenliği kapatmak veya işletim sistemi genelindeki tuşları değiştirmek yerine başka birleşim seçin.

## Klavye düzenleri ve metin girişi {#layouts-ime}

Rakam sırası ve köşeli parantez kısayolları AZERTY/QWERTZ dahil kayıt, yürütme ve çakışma kontrolünde fiziksel tuş konumlarını kullanır. Diğer tuşlar mantıksal değerlerini kullanır. Kullanacağınız klavyeyle kaydedip gösterilen sonucu kontrol edin.

IME birleşimi sırasında metin girişi önceliklidir. İstem geçmişi ve Escape eylemleri ayrıca odağa, seçici/Shell durumuna ve devam eden işleme bağlıdır; her ArrowUp veya Escape basışının koşulsuz genel eylem olduğunu varsaymayın. Üzerine gelince çıkan ipuçları ve kısayol yöneticisi kalıcı klavye yardım şeridi eklemeden mevcut atamaları gösterir.
