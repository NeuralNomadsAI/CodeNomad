# Ses girişi ve oynatma

## Ses API’sini yapılandırın {#configure}

1. **Ayarlar → Ses** öğesini açın. **Konuşma** kartı, görüşmenizin model sağlayıcısından bağımsız olarak OpenAI uyumlu bir sunucu tarafı bağdaştırıcısı kullanır.
2. **API anahtarı** öğesini, isteğe bağlı olarak **Temel URL**, **Transkripsiyon modeli**, **Konuşma modeli** ve **Varsayılan ses** öğesini girin.
3. Giriş ve çıkış farklı hizmetlere ihtiyaç duyuyorsa **Girdi ve çıktı için ayrı provider'lar** öğesini etkinleştirin, ardından giriş/çıkış anahtarını, temel URL'yi ve model alanlarını doldurun.
4. **Oynatma modu** ve **Çıktı formatı** öğesini, ardından **Kaydet** öğesini seçin (kaydedilmemiş değişiklikler varken kullanılabilir). Test etmeden önce test düğmelerinin yanındaki durumu kontrol edin: **Yapılandırıldı**, **Kısmen yapılandırıldı** veya **API anahtarı eksik**; başarısız bir kaydetme **Kaydetme başarısız** gösterir.

Konuşma ayarları ve anahtarlar, seçilen projeye veya OpenCode sağlayıcı bağlantısına değil, bağlı CodeNomad sunucu yapılandırmasına aittir. Bunu paylaşan diğer istemciler bu ayarları kullanır. Kaydedilen anahtarlar gizlidir: boş bir anahtar alanı kaydedilen değeri tutar; **Kayıtlı anahtarı temizle** kaydedildiğinde kaldırılmasını planlıyor. Kendi uç noktası veya anahtarı olmayan bir yön, paylaşılan ayarları kullanabilir; ayrı bir uç noktanın kendi anahtarına, ayrı bir anahtarın da kendi uç noktasına ihtiyacı vardır. Bir uç noktayı değiştirirken amaçlanan anahtarı açıkça sağlayın ve kaydedilen yapılandırmayı doğrulayın; uç nokta değişiklikleri, farklı bir ana bilgisayara göndermek yerine o yuva için kayıtlı anahtarı temizler.

Arka uç, paylaşılan varsayılanlar için `OPENAI_API_KEY` ve `OPENAI_BASE_URL`'yi de kullanabilir. Kaydedilmiş bir anahtarın temizlenmesi, ortam tarafından sağlanan kimlik bilgilerini kaldırmaz; geri dönüşü kaldırmak istiyorsanız arka uçtaki ortamı değiştirin ve yeniden başlatın.

| Ayar | Anlamı / varsayılan |
| --- | --- |
| Temel URL | OpenAI uyumlu API kökü, varsayılan `https://api.openai.com/v1`. Giriş `audio/transcriptions`'yi kullanır; çıkış `audio/speech`'yi kullanır. |
| Transkripsiyon modeli / Giriş modeli | STT uç noktası tarafından kabul edilen model; varsayılan `gpt-4o-mini-transcribe`. |
| Konuşma modeli / Çıkış modeli | TTS uç noktası tarafından kabul edilen model; varsayılan `gpt-4o-mini-tts`. |
| Varsayılan ses | Sağlayıcının ses tanımlayıcısı; varsayılan `alloy`. Bu bir işletim sistemi ses seçicisi değildir. |
| Akış | Varsayılan. Sağlayıcı ve tarayıcı seçilen formatı desteklediğinde, ses geldiğinde oynatmayı başlatır. |
| Tamponlanmış | Oynatmadan önce sesli yanıtın tamamını bekler. |
| Çıkış formatı | `mp3`, `wav`, `opus` veya `aac`; varsayılan `mp3`. Uyumluluk tarayıcıya/sağlayıcıya göre değişir. |

Bunlar yapılandırılmış hizmete yönelik isteklerdir; her uyumlu uç noktanın her modeli, sesi veya formatı uygulayacağının garantisi değildir.

## Giriş ve çıkışı test edin {#test}

1. Önce uç nokta, anahtar, model ve ses değişikliklerini kaydedin.
2. **Girdiyi test et** öğesini seçin, mikrofon izni verin, konuşun ve ardından **Kaydı durdur** öğesini seçin. Döndürülen transkripsiyonu kontrol edin.
3. Örneği dinlemek için **Oynatmayı test et** öğesini seçin; **Örneği durdur** bunu bitirir.

Oynatma testi seçilen oynatma modunu/formatını hemen kullanır, ancak uç nokta, anahtar, model ve ses kayıtlı ayarlardan gelir. Test girişi bir konuşma istemi göndermiyor. Testler yine de yapılandırılmış konuşma sağlayıcısına ses/metin göndermeye devam eder ve ücretlendirilebilir.

## Bir istemi dikte edin {#dictate}

1. **Ses** bölümünde **Prompt ses girişi** öğesini etkin tutun (varsayılan olarak açıktır).
2. İleti düzenleyicisinde **Diğer eylemler → Dikte et** seçeneğini kullanın ve mikrofona izin verin. **Dikte et: Ses ayarlarını aç** görünürse motoru orada seçin veya yapılandırın, sonra taslağa dönün.
3. Metni almak için **Kaydı durdur ve metne dönüştür**, kaydı atmak için **Dikteyi iptal et** seçeneğini kullanın. Görüşmeyi değiştirmek veya düzenleyiciyi kapatmak da dikteyi iptal eder.
4. Metni inceleyin. Yalnızca taslak ve seçim değişmediyse özgün seçimin yerini alır. Aksi hâlde **Dikte metnini ekle** veya **Dikte metnini sil** seçeneğini kullanın. Dikte taslağı göndermez.

API, Linux’ta Tauri ile WAV yedek modunu kullanıyorsa dikte ve giriş testi kaydı 24 saniyede durur. Kayıt, ses sağlayıcısına göndermek için **Yazıya dök** veya silmek için **İptal** seçeneğini kullanana kadar bu cihazda kalır.

### Masaüstünde motor seçin {#desktop-dictation}

Yerel masaüstü uygulamasında **Tercihler → Ses** bölümünden **Bu cihazdaki dikte motoru** seçeneğini ayarlayın. Seçim cihazdaki tüm projeler için geçerlidir; **Konuşma** kartı bağlı sunucunun API’sini yapılandırmaya devam eder. Tarayıcı ve mobil istemciler yapılandırılmış API sağlayıcısını kullanır ve mikrofon için güvenli bir bağlam gerektirir.

- **Yerel sistem konuşma tanıma**, işletim sisteminin dikte panelini açmadan CodeNomad içinde çalışır. Windows veya macOS’ta uygulamanın dili için yüklü bir yerel tanıyıcı gerekir. Linux’ta veya tanıyıcı ya da dil eksikse, sunuluyorsa Hex’i deneyin.
- Ses bölümünde Hex için eksik bileşenler, her bileşenin indirme boyutu ve toplam boyut gösterilir. **Hex’i etkinleştir** düğmesine bir kez basmak uyumlu dosyaları doğrulayıp yeniden kullanır, eksikleri indirir ve hazır olduğunda Hex’i seçer. İlerlemeyi burada izleyin. **Hex etkinleştirmesini iptal et** ile durdurabilir, seçenek sunulduğunda **Hex etkinleştirmesini sürdür** ile devam edebilirsiniz. Başarısızlık veya iptal durumunda önceki motor seçili kalır. Ayarları açmak, hazır **Hex (yerel)** seçeneğini seçmek veya onunla dikte etmek yeniden indirme başlatmaz.
- Hex, uygun Windows x64/arm64, macOS 15 veya üzeri Apple Silicon ve gerekli kütüphanelerle birlikte glibc 2.36 veya üzeri Linux x64/arm64 cihazlarında sunulur. Intel Mac’ler ile eski glibc veya musl kullanan Linux sistemleri uyumlu değildir. Motor ve modeller CodeNomad yükleyicisinden ayrıdır; terminal veya API anahtarı gerekmez.

Ubuntu 24.04 glibc gereksinimini karşılar, Ubuntu 22.04 karşılamaz. Hex, konuşulan dili İngilizce ve Fransızca da dahil olmak üzere [Parakeet’in desteklediği diller](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) arasından otomatik algılar. Bu liste uygulama dilinden bağımsızdır.

Yerel tanıma bu cihazın mikrofonunu kullanır ve yerel uygulamada açılan WSL projelerinde de çevrimdışı çalışır. Uyumlu bir uzak pencerede **Dikte et**, ayrı **Bu cihazda dikte et** penceresini açar. Gösterilen hedefi doğrulayıp **Ses girişini başlat**, **Kaydı durdur ve metne dönüştür** ve **Dikte metnini ekle** seçeneklerini kullanın; taslağa yalnızca metin döner. Uzak proje için sunucu bağlantısı yine gerekir.

Linux’ta uzak bir Tauri penceresinde **Girdiyi test et**, dikte motorunu değiştirmeden sunucunun ses API’sini sınar. API için her kaydı onaylamadan önce yerel mikrofon iletişim kutusundaki sunucu adresini kontrol edin. Kayıt, PulseAudio veya PipeWire’ın PulseAudio hizmetini kullanır ve yukarıda açıklanan 24 saniyelik WAV sınırı her zaman geçerlidir.

## Mesajları yüksek sesle oku {#playback}

1. TTS kullanılabiliyorsa bir mesajda **Mesajı seslendir** eylemini veya bir araç çağrısında aynı eylemi kullanın.
2. Bitirmek için aynı kontrolde **Oynatmayı durdur** öğesini kullanın; başka bir okumayı başlatmak geçerli okumayı durdurur.
3. Sonraki istekler için **Konuşma** bölümünde kayıtlı sesi, modeli, modu veya formatı değiştirin.

Oynatma, anlatımlı bir ekran görüntüsünü değil, CodeNomad'in metin projeksiyonunu kullanır: ikili/görüntü baytları ve izin makbuzları konuşma içeriği değildir. Bir istem çalıştırmaz veya seçilen OpenCode modelini değiştirmez.

Otomatik konuşma seslendirmesi için ileti düzenleyicisinin **Diğer eylemler** menüsünden **Konuşma modunu etkinleştir** seçeneğini kullanın; bu mod o proje sekmesi için geçerlidir ve yeniden yüklemeden sonra korunmaz. Açıkken CodeNomad, gönderdiğiniz her istemle birlikte ajandan yanıtına kod çitleri arasında kısa bir `spoken` özetiyle başlamasını ister. Etkin ana oturumda yalnızca bu tamamlanmış blok okunur; her yanıtı veya alt ajanı otomatik okumaz. **Konuşma modunu devre dışı bırak** kuyruğu durdurur ve artık özeti istemez. Mikrofon girişine başlamak da etkin seslendirmeyi durdurur. Konuşma modu, desteklenen bir biçimde yapılandırılmış ses oynatımı gerektirir.

## Veri akışı ve gizlilik {#privacy}

Yerel dikte sesi cihazda tutar ve API’ye geçmez. **API sağlayıcısı** kullanılırsa ses CodeNomad sunucusu üzerinden yapılandırılmış transkripsiyon uç noktasına gider. Sentez metni sunucu üzerinden TTS uç noktasına gider; dönen ses istemcide oynar. API anahtarları sunucuda kalır.

Dikte edilen veya okunan içerik için güvendiğiniz bir uç nokta kullanın. OpenCode kimlik bilgileri konuşmaya otomatik olarak yetki vermez. Anahtar veya uç nokta değişiklikleri yalnızca gelecekteki istekleri etkiler. Sunucuyu başkalarına açmadan önce [Güvenlik](security.md) konusuna bakın.
