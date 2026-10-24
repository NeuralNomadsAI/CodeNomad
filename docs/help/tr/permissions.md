# Sorular ve izinler

OpenCode soruları, Formları ve izin istekleri, konuşma dökümündeki bekleyen araç kartlarında değil, ileti düzenleyicisinin hemen üstündeki istek panelinde yanıtlanır.

## İsteği bulun ve kaynağını kontrol edin {#request-dock}

1. **Girdi Gerekiyor** / **İzin Gerekiyor** durumundaki konuşmayı seçin veya istek panelini yerinde açmak için proje istek rozetini tıklayın.
2. Genişletmeden veya yanıtlamadan önce istek türünü, konuşma başlığını ve kaynağını okuyun.
3. Birkaç istek beklemede olduğunda **Önceki istek** / **Sonraki istek** öğesini kullanın. **Sohbeti görüntüle** öğesini yalnızca kaynağına gitmek istiyorsanız kullanın.

| Kaynak | Anlam ve davranış |
| --- | --- |
| Açık konuşma | İsteği normal biçimde genişletilebilir |
| **Kaynak: …** üst konuşması belirtilen alt ajan | Açık konuşmanın özyinelemeli alt konuşması yerel bağlamdır; üst konuşma bilgisi görünür kalır |
| Diğer konuşma | Kompakt bir önizleme olarak başlar; Mevcut görüşmeden ayrılmadan yanıtlamak için açıkça genişletin |
| Proje isteği / Hizmet isteği | Formun sahibi olan bir konuşma bulunmayabilir; uydurma konuşma bağlantısı gösterilmez |

Yeni istekler düzenlediğiniz isteği değiştirmez veya başka yere yönlendirmez. Kuyruk yenilendiğinde seçim aynı istekte kalır; oklar uçtan başa dönmez. Sonuçlandırmadan sonra ilgisiz başka konuşmanın isteği siz açana kadar küçük önizleme halinde kalır.

**İstekleri daralt** içeriği gizler; hiçbir şeyi reddetmez, iptal etmez veya yanıtlamaz. Genişletilmiş düzenleyici, kayıtlı boyut veya taslağı değiştirmeden ileti düzenleyicisini geçici olarak en düşük yüksekliğe indirir. İçerik sabit yanıt eylemlerinden bağımsız kaydırılır.

## Soruları ve Formları yanıtlayın {#answer-questions-forms}

1. Amaçlanan isteği genişletin ve alanlarını doldurun veya sunulan seçenekleri seçin.
2. Bir seçim alanı özel yanıtlara izin verdiğinde ek bir metin alanı gösterilir: sunulan bir seçenek yerine kendi yanıtınızı buraya yazın (veya çoklu seçim alanına özel değerler ekleyin). Gerekli tüm soruları yanıtlayın.
3. **Gönder** öğesini seçin; **İptal** öğesini yalnızca yerel iptali istediğinizde bir soru veya Form için kullanın.

Kısmi yanıtlar ve ret taslakları çalışan istemcide kuyruk yenilemeleri ve konuşma değişimleri boyunca korunur. Bunlar gönderilmiş karar veya istemci verileri temizlendikten sonra kurtarma garantisi değildir. Başarısız yanıt düzenlenebilir kalır; yeniden denemeden önce bekleyen isteği inceleyin. CodeNomad yanıtı otomatik yeniden göndermez.

Bazı Formlar, tarayıcı akışı için **Harici formu aç** sağlar. Açılan sayfayı başarılı bir yanıt olarak değerlendirmek yerine isteğin talimatlarını izleyin ve durumuna geri dönün. Rastgele sağlayıcı/yetkilendirme Formlarının mutlaka konuşma eserleri olması gerekmez.

Tamamlanan OpenCode soru araçları geçmişte soruyu, seçili yanıtı, seçenek açıklamalarını ve özel metni aynen gösterir. **Diğer seçenekler** seçilmeyen alternatifleri erişilebilir tutar. Bu tamamlanmış sonuçlar canlı istek panelinden ayrıdır.

## Bir izni onaylama veya reddetme {#permission-decisions}

1. İstenen işlemi, kaynakları ve **İstenen diff** öğesini okuyun. Hangi görüşmenin kararı alacağını kontrol edin.
2. İsteğe bağlı olarak bir reddi veya daha güvenli bir alternatifi açıklayan geri bildirimi girin.
3. **Bir Kez İzin Ver**, **Her Zaman İzin Ver** veya **Reddet** öğesini seçin.

| Seçim | Yerel etki | Güvenlik sınırı |
| --- | --- | --- |
| Bir Kez İzin Ver | Bu izin isteğini onaylıyor | İlgisiz gelecekteki operasyonlar için genel onay değil |
| Her Zaman İzin Ver | Geçerli oturum bağlamında eşleşen istekler için OpenCode kalıcı onay seçimini gönderir | CodeNomad veya işletim sistemi genelinde güven anahtarı değildir; yetkilendirilen kaynağı/deseni inceleyin |
| Reddet | İsteğe bağlı geri bildirimle isteği reddeder | Bu istekten önce gerçekleştirilen işi geri almaz |

İzin onayı araç yürütmesini hemen serbest bırakabilir. Bu bir deneme çalıştırması değildir. Fark/okuma sınırları ve kaynak kimliği kontrolleri, istenen içerik doğrulanamadığında onayı engelleyebilir; başka işlemi varsayımla onaylamak yerine gerçek isteği yenileyip inceleyin.

Başka istemci isteği sonuçlandırırsa burada kaybolabilir. Zaman aşımı veya başarısız yanıt, OpenCode hizmetinin kararı kabul edip etmediğini kanıtlamaz: yeniden bilinçli seçim yapmadan önce bekleyen istek uzlaştırmasının paneli güncellemesini bekleyin. Belirsiz yanıt asla uydurma doğrulanmış karar olarak gösterilmez.

## İzin makbuzlarını okuma {#permission-receipts}

1. Yerel araç kartları gizlenmiş olsa bile, ilgili konuşma dökümü içeriğinin yanında **İzin kararları** öğesini arayın.
2. Kaynak mesajı olmayan kararlar için **Oturum izin kararları** öğesini açın.
3. Devam etmek için **Daha fazla karar yükle** öğesini veya okuma hatasından sonra **Yeniden dene** öğesini kullanın.

Karar kayıtları bilinen istekleri/kaynakları, doğrulanmış kararı ve mevcut gerekçe/kaynak bilgisini kaydeder. **CodeNomad'da verilen karar**, **Otomatik · Yolo** ve **Yerel karar** gözlemlenen kaynakları ayırır; OpenCode'da sonuçlandırılmış olması bu pencerede kullanıcının tıkladığının kanıtı değildir.

Karar kayıtları OpenCode mesajı veya izin kuralı düzenleyicisi değil, salt okunur CodeNomad açıklamalarıdır. OpenCode tam geçmiş araması, mesaj kopyalama ve dışa aktarmaya dahil edilmezler. CodeNomad çevrimdışıyken kaçırılan kararları yeniden kuramazlar; başarılı araç sonucu eksik kaydın yerine geçmez. Oturumun silinmesi karar kayıtlarını da kaldırır.

## Yolo modu ve aile kapsamı {#yolo-mode}

1. Bir görüşme seçin ve **Durum → Yolo Modu** öğesini açın.
2. Yalnızca otomatik izin onayının tüm aile için kabul edilebilir olması durumunda etkinleştirin.
3. Güvenilmeyen çalışmalara devam etmeden önce onu devre dışı bırakın; Bekleyen istekleri ve halihazırda çalışan araçları inceleyin.

Kontrol bir oturumu belirtse de etkili kapsamı çözümlenen aile kökü ve alt konuşmalarıdır: alt oturumdan açmak/kapatmak o aileyi etkiler. OpenCode çatallaması kendi kökü sayılır. Her proje veya bağımsız konuşma için genel onay değildir.

Yolo **yalnızca izinleri** onaylar. Soruları veya Formları yanıtlamaz, eksik bilgi sağlamaz, başarılı yürütme garantisi vermez veya arka uç sahiplik kontrollerini aşmaz. Otomatik onayı CodeNomad arka ucu yapar: arka uç açıkken tek pencereyi kapatmak bunu devre dışı bırakmaya yetmez; durmuş arka uç istek onaylayamaz. Aile ayarı kalıcı kaydedilir ve çalışma alanı yeniden yüklendiğinde geri alınır.

Yolo'nun kapatılması halihazırda kabul edilmiş bir kararı iptal etmez veya dosya/ağ etkilerini geri almaz. **Otomatik · Yolo** makbuzlarını inceleyin ve gerekirse yürütmeyi açıkça durdurun. İnsan kapılarıyla otomasyon için bkz. [Görevler](missions.md).

## Eksik veya eski istekleri kurtarma {#request-recovery}

1. Bağlantı göstergesini kontrol edin ve aynı arka uca/projeye yeniden bağlanın.
2. Kurtarmanın bekleyen yerel istekleri uzlaştırmasına izin verin; Kapsamın eksik olması durumunda bilinen talepler ve taslaklar korunur.
3. **Sorular ve izinler tam olarak kurtarılamadı** uyarısı görünürse, projeyi, nedeni, klasörleri ve etkilenen oturumları belirtir. Bu nedeni giderin (örneğin silinmiş bir çalışma ağacı veya bu projenin dışında çalışan bir oturum); bir sonraki kurtarma geçişi otomatik olarak yeniden dener.

Kurtarma, yalnızca istekleri numaralandırmak için etkin olmayan her çalışma ağacını yüklemez. Eksik bir yanıt, yetkili bir boş kuyruk değildir ve uyarı, bir istemin, yanıtın veya onayın tekrarlanmasına izin vermez. Yapılandırmanın yeniden yüklenmesi yerel Formları/izinleri iptal edebilir; bunu rutin bir istek yenileme düğmesi olarak kullanmayın. Bkz. [Sorun Giderme](troubleshooting.md) ve [OpenCode kurulumu](opencode.md).
