# Ses girişi ve oynatma

## Konuşmayı yapılandırın {#configure}

1. **Ayarlar → Konuşma** öğesini açın. **Konuşma** kartı, görüşmenizin model sağlayıcısından bağımsız olarak OpenAI uyumlu bir sunucu tarafı bağdaştırıcısı kullanır.
2. **API anahtarı** öğesini, isteğe bağlı olarak **Temel URL**, **Transkripsiyon modeli**, **Konuşma modeli** ve **Varsayılan ses** öğesini girin.
3. Giriş ve çıkış farklı hizmetlere ihtiyaç duyuyorsa **Girdi ve çıktı için ayrı provider'lar** öğesini etkinleştirin, ardından giriş/çıkış anahtarını, temel URL'yi ve model alanlarını doldurun.
4. **Oynatma modu** ve **Çıktı formatı** öğesini, ardından **Kaydet** öğesini seçin. Test etmeden önce **Kaydedildi**, **Yapılandırıldı** veya **Kısmen yapılandırıldı** öğesini kontrol edin.

Konuşma ayarları ve anahtarlar, seçilen projeye veya OpenCode sağlayıcı bağlantısına değil, bağlı CodeNomad sunucu yapılandırmasına aittir. Bunu paylaşan diğer istemciler bu ayarları kullanır. Kaydedilen anahtarlar gizlidir: boş bir anahtar alanı kaydedilen değeri tutar; **Kayıtlı anahtarı temizle** kaydedildiğinde kaldırılmasını planlıyor. Kendi uç noktası veya anahtarı olmayan bir yön, paylaşılan ayarları kullanabilir; ayrı bir uç noktanın kendi anahtarına, ayrı bir anahtarın da kendi uç noktasına ihtiyacı vardır. Bir uç noktayı değiştirirken amaçlanan anahtarı açıkça sağlayın ve kaydedilen yapılandırmayı doğrulayın; uç nokta değişiklikleri, farklı bir ana bilgisayara göndermek yerine o yuva için kayıtlı anahtarı temizler.

Arka uç, paylaşılan varsayılanlar için `OPENAI_API_KEY` ve `OPENAI_BASE_URL`'yi de kullanabilir. Kaydedilmiş bir anahtarın temizlenmesi, ortam tarafından sağlanan kimlik bilgilerini kaldırmaz; geri dönüşü kaldırmak istiyorsanız arka uçtaki ortamı değiştirin ve yeniden başlatın.

| Ayar | Anlamı / varsayılan |
| --- | --- |
| Temel URL | OpenAI uyumlu API kökü, varsayılan `https://api.openai.com/v1`. Giriş `audio/transcriptions`'yi kullanır; çıkış `audio/speech`'yi kullanır. |
| Transkripsiyon modeli / Giriş modeli | STT uç noktası tarafından kabul edilen model; varsayılan `gpt-4o-mini-transcribe`. |
| Konuşma modeli / Çıkış modeli | TTS uç noktası tarafından kabul edilen model; varsayılan `gpt-4o-mini-tts`. |
| Varsayılan ses | Sağlayıcının ses tanımlayıcısı; varsayılan `alloy`. Bu bir işletim sistemi ses seçicisi değildir. |
| Akış | Sağlayıcı ve tarayıcı seçilen formatı desteklediğinde, ses geldiğinde oynatmayı başlatır. |
| Tamponlanmış | Oynatmadan önce sesli yanıtın tamamını bekler. |
| Çıkış formatı | `mp3`, `wav`, `opus` veya `aac`; varsayılan `mp3`. Uyumluluk tarayıcıya/sağlayıcıya göre değişir. |

Bunlar yapılandırılmış hizmete yönelik isteklerdir; her uyumlu uç noktanın her modeli, sesi veya formatı uygulayacağının garantisi değildir. Başarısız kaydetme hata bırakır; başka bir değişiklik yapmadan önce konfigürasyonu inceleyin.

## Giriş ve çıkışı test edin {#test}

1. Önce uç nokta, anahtar, model ve ses değişikliklerini kaydedin.
2. **Girdiyi test et** öğesini seçin, mikrofon izni verin, konuşun ve ardından **Kaydı durdur** öğesini seçin. Döndürülen transkripsiyonu kontrol edin.
3. Örneği dinlemek için **Oynatmayı test et** öğesini seçin; **Örneği durdur** bunu bitirir.

Oynatma testi seçilen oynatma modunu/formatını hemen kullanır, ancak uç nokta, anahtar, model ve ses kayıtlı ayarlardan gelir. Test girişi bir konuşma istemi göndermiyor. Testler yine de yapılandırılmış konuşma sağlayıcısına ses/metin göndermeye devam eder ve ücretlendirilebilir.

Akış başarısızsa **Tamponlanmış** seçeneğini ve `mp3` biçimini deneyin, kaydedip yeniden test edin. “Yapılandırıldı” başarılı sağlayıcı kimlik doğrulamasını veya codec oynatımını değil, ayarları doğrular. Yeniden denemeden önce sunucu ana bilgisayarından uç noktaya erişimi, sağlayıcının model/ses adlarını ve kotayı kontrol edin.

## Bir istemi dikte edin {#dictate}

1. **Konuşma** bölümünde **Prompt ses girişi** öğesini etkinleştirin.
2. İleti düzenleyicisinde mikrofon kontrolünü (**Ses girişini başlat**) basılı tutun ve bu cihazda mikrofon erişimine izin verin.
3. Durdurmak ve yazıya dökmek için bırakın. Bunun yerine eylem menüsü girişini kullanırken **Ses girişini başlat** öğesini ve ardından **Kaydı durdur ve metne dönüştür** öğesini seçin.
4. İstemi normal şekilde göndermeden önce eklenen metni inceleyin ve düzenleyin.

Transkripsiyon metni geçerli seçime ekler; bunu otomatik olarak OpenCode'a göndermez. Mikrofon kontrolü yalnızca STT yapılandırıldığında ve istemci kaydetmeyi desteklediğinde görünür. Kayıt, CodeNomad uzak bir sunucuda çalıştığında bile istemci aygıtının mikrofonunu kullanır.

Eksik bir kontrol için geçiş düğmesini ve STT yapılandırmasını kontrol edin. İzin hataları için, hem tarayıcı hem de işletim sistemi gizlilik ayarlarında mikrofona izin verin. Uzaktan tarayıcı kaydı, normalde güvenilen HTTPS olan güvenli bir bağlama ihtiyaç duyar; bkz. [Mobil erişim](mobile.md) ve [Doğrudan uzaktan erişim](remote-access.md). İleti düzenleyicisini değiştirmek veya kapatmak, onun kayıt yaşam döngüsünü sona erdirir; gönderilmemiş sesin kurtarılabilir olduğuna güvenmeyin. Yazdığınız taslak, sonucu gözden geçirebileceğiniz yer olarak kalır.

## Mesajları yüksek sesle oku {#playback}

1. TTS kullanılabiliyorsa mesajın **Mesajı seslendir** eylemini kullanın.
2. Farklı bir okumaya başlamadan önce aynı aktif kontrolde **Oynatmayı durdur** öğesini kullanın.
3. Sonraki istekler için **Konuşma** bölümünde kayıtlı sesi, modeli, modu veya formatı değiştirin.

Oynatma, anlatımlı bir ekran görüntüsünü değil, CodeNomad'in metin projeksiyonunu kullanır: ikili/görüntü baytları ve izin makbuzları konuşma içeriği değildir. Bir istem çalıştırmaz veya seçilen OpenCode modelini değiştirmez. Tarayıcı ses desteği ve sağlayıcı yanıtları, bir format seçilebilir olsa bile oynatmayı yine de engelleyebilir.

Otomatik konuşma seslendirmesi için ileti düzenleyicisinin eylemlerinden **Konuşma modunu etkinleştir** seçeneğini kullanın. Etkin ana oturumda tamamlanmış, kod çitleri arasındaki `spoken` bloğuyla başlayan asistan metnini okur; her yanıtı veya alt ajanı otomatik okumaz. Gerektiğinde bu çıktı biçimini isteyin. **Konuşma modunu devre dışı bırak** kuyruğu durdurur. Mikrofon girişine başlamak da etkin seslendirmeyi durdurur. Anahtar ses girişiyle birlikte veya konuşma modu zaten açıkken görünür; etkinleştirmek için çalışan TTS gerekir.

## Veri akışı ve gizlilik {#privacy}

Mikrofon sesi istemcinizden CodeNomad arka ucuna, oradan yapılandırılmış STT uç noktasına gider. Sentezlenecek metin arka uç üzerinden yapılandırılmış TTS uç noktasına gider; dönen ses istemcide oynar. API anahtarları sunucuda kalır ve kayıtlı değerler olarak ayar formuna döndürülmez.

Dikte edilen veya okunan materyal için güvendiğiniz bir uç nokta kullanın. Bu, çevrimdışı bir transkripsiyon garantisi değildir ve OpenCode kimlik bilgileri konuşmaya otomatik olarak yetki vermez. Bittiğinde kaydetmeyi/oynatmayı durdurun; Bir anahtarın veya uç noktanın değiştirilmesi, bir sağlayıcıya halihazırda gönderilmiş olan verileri değil, gelecekteki istekleri etkiler. Bir sunucuyu diğer kullanıcıların kullanımına açmadan önce [Güvenlik](security.md) konusuna bakın.
