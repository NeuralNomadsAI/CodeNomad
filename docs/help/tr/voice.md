# Dikte, oynatma ve sesli sohbet

## Ses ayarlarını yapılandırın {#configure}

**Tercihler → Ses** bölümünü açın (tarayıcıda veya uzak pencerede **Ayarlar → Ses**). **Dikte**, **Oynatma** ve **Sohbet** kartlarının her biri kendi durumunu gösterir.

1. Yerel masaüstü uygulamasında **Dikte** kartından [cihazın motorunu](#desktop-dictation) seçin. Tarayıcı ve mobil istemciler yalnızca API kullanır.
2. API ile dikte ve oynatma için iki karttan birinde **API erişim bilgileri** bölümünü açın. **API anahtarı** ve gerekirse **Temel URL**, **Transkripsiyon modeli** ve **Konuşma modeli** alanlarını doldurun. İki ayrı hizmet için **Girdi ve çıktı için ayrı provider'lar** seçeneğini açın, ilgili alanları doldurun ve **Kaydet** düğmesine basın.
3. **Oynatma** kartı **Sağlayıcı** bilgisini gösterir. **Varsayılan ses**, **Oynatma modu** ve **Çıktı formatı** seçeneklerini ayarlayıp **Kaydet** düğmesine basın.

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
2. **API girdisini test et** öğesini seçin, mikrofon izni verin, konuşun ve ardından **Kaydı durdur** öğesini seçin. Döndürülen transkripsiyonu kontrol edin.
3. Örneği dinlemek için **Oynatmayı test et** öğesini seçin; **Örneği durdur** bunu bitirir.

Oynatma testi seçilen modu ve biçimi hemen kullanır, ancak uç nokta, anahtar, model ve ses kayıtlı ayarlardan gelir. **API girdisini test et**, dikte motorundan bağımsız olarak sesi yapılandırılmış API sağlayıcısına gönderir. Sohbete bir istem göndermez. Sağlayıcı bu testleri ücretlendirebilir.

## Bir istemi dikte edin {#dictate}

1. **Ses** bölümünde **Prompt ses girişi** öğesini etkin tutun (varsayılan olarak açıktır).
2. **Diğer eylemler** menüsünde **Dikte modu** seçeneğini işaretleyin. Diğer modu seçmeden önce etkin modun işaretini kaldırın.
3. **Diğer eylemler** yanındaki mikrofonu basılı tutup konuşun, ardından metne dönüştürmek için bırakın. İstenirse mikrofon izni verin. Uyumlu uzak pencerede tıklamak yerel kayıt denetimlerini açar.
4. Metni inceleyin. Yalnızca taslak ve seçim değişmediyse özgün seçimin yerini alır. Aksi hâlde yeniden dikte etmeden önce normal modda **Dikte metnini ekle** seçeneğini veya **Dikte metnini sil** seçeneğini kullanın. Dikte taslağı göndermez.

API, Linux’ta Tauri ile WAV yedek modunu kullanıyorsa dikte ve giriş testi kaydı 24 saniyede durur. Kayıt, ses sağlayıcısına göndermek için **Yazıya dök** veya silmek için **İptal** seçeneğini kullanana kadar bu cihazda kalır.

API için sıkıştırılan kayıtlar da boyut sınırında durur ve **Yazıya dök** ile **İptal et** seçeneklerini sunar.

### Masaüstünde motor seçin {#desktop-dictation}

Yerel masaüstü uygulamasında **Tercihler → Ses → Dikte** bölümünden **Bu cihazdaki dikte motoru** seçeneğini ayarlayın. Seçim cihazdaki tüm projeler için geçerlidir. **API sağlayıcısı**, bağlı sunucunun ayarlarını kullanır ve mikrofon için güvenli bir bağlam gerektirir.

- Kayıtlı motor kullanılamıyorsa burada varsa **Hex (yerel)** veya **API sağlayıcısı** seçin. Intel Mac’lerde ve macOS 15 öncesi sürümlerde **API sağlayıcısı** kullanın.
- Ses bölümünde Hex için eksik bileşenler, her bileşenin indirme boyutu ve toplam boyut gösterilir. **Hex’i etkinleştir** düğmesine bir kez basmak uyumlu dosyaları doğrulayıp yeniden kullanır, eksikleri indirir ve hazır olduğunda Hex’i seçer. İlerlemeyi burada izleyin. **Hex etkinleştirmesini iptal et** ile durdurabilir, seçenek sunulduğunda **Hex etkinleştirmesini sürdür** ile devam edebilirsiniz. Başarısızlık veya iptal durumunda önceki motor seçili kalır. Ayarları açmak, hazır **Hex (yerel)** seçeneğini seçmek veya onunla dikte etmek yeniden indirme başlatmaz.
- Hex, uygun Windows x64/arm64, macOS 15 veya üzeri Apple Silicon ve gerekli kütüphanelerle birlikte glibc 2.36 veya üzeri Linux x64/arm64 cihazlarında sunulur. Intel Mac’ler ile eski glibc veya musl kullanan Linux sistemleri uyumlu değildir. Motor ve modeller CodeNomad yükleyicisinden ayrıdır; terminal veya API anahtarı gerekmez.

Ubuntu 24.04 glibc gereksinimini karşılar, Ubuntu 22.04 karşılamaz. Hex, konuşulan dili İngilizce ve Fransızca da dahil olmak üzere [Parakeet’in desteklediği diller](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) arasından otomatik algılar. Bu liste uygulama dilinden bağımsızdır.

Hex, kayıt başladığında modelini arka planda yükler ve son diktenin ardından üç dakika hazır tutar.

Yerel tanıma, yerel uygulamada açılan WSL projelerinde de çevrimdışı çalışır. Uyumlu bir uzak pencerede **Bu cihazda dikte et** penceresini açmak için mikrofona tıklayın. Hedefi doğrulayın ve bu penceredeki kayıt ve ekleme denetimlerini kullanın. Taslağa yalnızca metin döner. Uzak proje için sunucu bağlantısı yine gerekir.

Linux’ta uzak bir Tauri penceresinde **API girdisini test et**, dikte motorunu değiştirmeden sunucunun ses API’sini sınar. API için her kaydı onaylamadan önce yerel mikrofon iletişim kutusundaki sunucu adresini kontrol edin. Kayıt, PulseAudio veya PipeWire’ın PulseAudio hizmetini kullanır ve yukarıda açıklanan 24 saniyelik WAV sınırı her zaman geçerlidir.

Gemini Live ve OpenAI Realtime, Linux’taki uzak Tauri pencerelerinde kullanılamaz: bu pencereler dikte ve girdi sınaması için yerel kayıt aracını kullanır, WebKit ise mikrofona doğrudan erişimi engeller.

## Mesajları yüksek sesle oku {#playback}

1. TTS kullanılabiliyorsa bir mesajda **Mesajı seslendir** eylemini veya bir araç çağrısında aynı eylemi kullanın.
2. Bitirmek için aynı kontrolde **Oynatmayı durdur** öğesini kullanın; başka bir okumayı başlatmak geçerli okumayı durdurur.
3. Ses, mod veya formatı **Oynatma** kartında, modeli **API erişim bilgileri** bölümünde değiştirip kaydedin.

Oynatma, anlatımlı bir ekran görüntüsünü değil, CodeNomad'in metin projeksiyonunu kullanır: ikili/görüntü baytları ve izin makbuzları konuşma içeriği değildir. Bir istem çalıştırmaz veya seçilen OpenCode modelini değiştirmez.

## Sesli sohbet {#conversation}

Gemini Live ve OpenAI Realtime yalnızca bu pencereyi açan sunucudaki oturumlarda kullanılabilir.

**Sohbet** kartında bir **Sohbet motoru** seçin:

- **Klasik** yalnızca desteklenen bir formatta oynatma ayarı gerektirir. **Diğer eylemler** menüsünde **Konuşma modu** seçeneğini işaretleyin. CodeNomad etkin ana oturumda yanıtın tamamlanan `spoken` özetini seslendirir. Mod, kapatılana veya sayfa yeniden yüklenene kadar proje sekmesinde geçerlidir.
- **Gemini Live** ve **OpenAI Realtime** için ayrı **API anahtarı**, **Model** ve isteğe bağlı **Ses** ayarlanır. Seçtiğiniz sağlayıcının ayarlarını kaydedin. Hedef oturumu açın, **Diğer eylemler** menüsünde **Konuşma modu** seçeneğini, sağlayıcının onay penceresi açıldığında **Kabul et ve başlat** seçeneğini kullanın. Mikrofona izin verin.

Onay penceresi açıkken sağlayıcı kullanılamaz hâle gelirse **Ses ayarları** ile sohbet kartını açın.

Ses modeli başta sabitlenen oturumun durumunu, görünür son yanıtı ve yakın tarihli hataları okuyabilir. Dosyalara erişemez. Ajana bir istek göndermesini istediğinizde, ekranda onay almadan doğrudan sizin mesajınız olarak gönderir. [Konuşmanın izin modu](permissions.md#conversation-mode) ve ajanın soruları geçerliliğini korur.

Sunucu, oturum açmış kullanıcı başına veya Uzaktan Kontrol’de eşleştirilmiş cihaz başına aynı anda bir canlı sohbete izin verir. **Durdur**, sesi kapatır ve sohbet dökümünü açık bırakır. Döküm, pencere kapanana kadar bellekte kalır; ajana gönderilen istekler oturum mesajı olarak kalır. İki dakika konuşulmadığında, toplam sekiz dakika dolduğunda, hedef değiştiğinde, pencere kapandığında veya bağlantı kesildiğinde sohbet sona erer. Otomatik yeniden bağlantı veya sağlayıcı değişimi yapılmaz.

OpenAI Realtime’da **Yanıtı kes** oynatmayı durdurur ve mevcut yanıtın iptal edilmesini ister. Gemini Live’da **Oynatmayı durdur** yalnızca bu cihazdaki sesi keser; Gemini yanıt üretmeye ve ajana istek göndermeye devam edebilir.

## Veri akışı ve gizlilik {#privacy}

Yerel dikte sesi cihazda tutar ve API’ye geçmez. **API sağlayıcısı** kullanılırsa ses CodeNomad sunucusu üzerinden yapılandırılmış transkripsiyon uç noktasına gider. Sentez metni sunucu üzerinden TTS uç noktasına gider; dönen ses istemcide oynar. API anahtarları sunucuda kalır.

**Gemini Live** veya **OpenAI Realtime** kullanıldığında Google ya da OpenAI; mikrofon sesini, proje adını, dalı, çalışma ağacını, oturum başlığını ve durumunu alır. Görünür son ajan yanıtının metni ve yakın tarihli hatalar da sağlayıcıya gönderilebilir. Kullanım bedeli seçilen sağlayıcıdaki hesabınıza yansıyabilir.

Dikte ettiğiniz, seslendirdiğiniz veya paylaştığınız içerik için güvendiğiniz bir sağlayıcı kullanın. OpenCode kimlik bilgileri ses hizmetlerine otomatik erişim sağlamaz. Sunucuyu başkalarına açmadan önce [Güvenlik](security.md) konusuna bakın.
