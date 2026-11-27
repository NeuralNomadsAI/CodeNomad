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

**İstekleri daralt** içeriği gizler; hiçbir şeyi reddetmez, iptal etmez veya yanıtlamaz. Genişletilmiş düzenleyici, kayıtlı boyut veya taslağı değiştirmeden ileti düzenleyicisini geçici olarak en düşük yüksekliğe indirir. İçerik sabit yanıt eylemlerinden bağımsız kaydırılır.

## Soruları ve Formları yanıtlayın {#answer-questions-forms}

1. Amaçlanan isteği genişletin ve alanlarını doldurun veya sunulan seçenekleri seçin.
2. Bir seçim alanı özel yanıtlara izin verdiğinde ek bir metin alanı gösterilir: sunulan bir seçenek yerine kendi yanıtınızı buraya yazın (veya çoklu seçim alanına özel değerler ekleyin). Gerekli tüm soruları yanıtlayın.
3. **Gönder** öğesini seçin; **İptal** öğesini yalnızca yerel iptali istediğinizde bir soru veya Form için kullanın.

Kısmi yanıtlar ve ret taslakları çalışan istemcide kuyruk yenilemeleri ve konuşma değişimleri boyunca korunur. Bunlar gönderilmiş karar veya istemci verileri temizlendikten sonra kurtarma garantisi değildir.

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

Başka istemci isteği sonuçlandırırsa burada kaybolabilir. Zaman aşımı veya başarısız yanıt, OpenCode hizmetinin kararı kabul edip etmediğini kanıtlamaz: yeniden bilinçli seçim yapmadan önce bekleyen istek uzlaştırmasının paneli güncellemesini bekleyin.

## İzin makbuzlarını okuma {#permission-receipts}

1. Yerel araç kartları gizlenmiş olsa bile, ilgili konuşma dökümü içeriğinin yanında **İzin kararları** öğesini arayın.
2. Kaynak mesajı olmayan kararlar için **Oturum izin kararları** öğesini açın.
3. Devam etmek için **Daha fazla karar yükle** öğesini veya okuma hatasından sonra **Yeniden dene** öğesini kullanın.

Karar kayıtları bilinen istekleri/kaynakları, doğrulanmış kararı ve mevcut gerekçe/kaynak bilgisini kaydeder. **CodeNomad'da verilen karar**, **Otomatik karar** ve **Yerel karar** gözlemlenen kaynakları ayırır; OpenCode'da sonuçlandırılmış olması bu pencerede kullanıcının tıkladığının kanıtı değildir.

Karar kayıtları OpenCode mesajı veya izin kuralı düzenleyicisi değil, salt okunur CodeNomad açıklamalarıdır. OpenCode tam geçmiş araması, mesaj kopyalama ve dışa aktarmaya dahil edilmezler. CodeNomad çevrimdışıyken kaçırılan kararları yeniden kuramazlar; başarılı araç sonucu eksik kaydın yerine geçmez. Oturumun silinmesi karar kayıtlarını da kaldırır.

## Konuşma izin modu {#conversation-mode}

Bir konuşma seçin, **Durum → İzinler** bölümünü açın ve bir moda tıklayın. Bölüm kapalıyken şimşek (Özerk) veya kalkan (Denetimli) simgesi bilinen son modu gösterir.

- **Özerk** — OpenCode’un izin kurallarını uygular.
- **Denetimli** — Ajan dosyaları değiştirmeden veya kabuk komutlarını çalıştırmadan önce onay ister. Bu işlemlere ilişkin genel, proje ve konuşma yasakları geçerli kalır; izin veren kurallar onay isteğine dönüşür. OpenCode’a kaydedilen **Her Zaman İzin Ver** onayları, eşleşen istekler için geçerli kalır.

Her iki mod da OpenCode’un oturum kurallarını kullanır. Aynı hizmette aynı konuşmayı açtığınızda bu kurallar OpenCode’un terminal arayüzünde de geçerlidir. **Özerk** moda dönmek yalnızca denetim için eklenen kuralları kaldırır. OpenCode yapılandırma dosyaları değişmez. CodeNomad hiçbir modda istekleri otomatik olarak onaylamaz.

Denetimli mod bir yalıtım ortamı değildir. Okuma, proje dışına erişim ve MCP araçları kendi kurallarına tabi kalır. Açık istekler ilk kurallarını korur.

Bir alt ajanda **İzinler**, kök konuşmanın modunu gösterir ve değiştirir. Mod değişince mevcut alt ajanlar kurallarını korur. Bir alt ajan başka bir alt ajan başlattığında, yeni ajan doğrudan üst ajanının kurallarını kopyalar.

Çatallanan konuşma kaynak konuşmanın kurallarını kopyalar ve kendi modu vardır. CodeNomad hangi kuralların kaldırılacağını doğrulayamazsa kurallar korunur ve mesaj göndermeye devam edebilirsiniz.

Mod doğrulanmadıysa **İzinleri yeniden yükle** seçeneğini kullanın. Başlangıç modunu seçmek için [Yeni konuşmaların izinleri](settings.md#new-conversation-permissions) bölümüne bakın.

## Eksik veya eski istekleri kurtarma {#request-recovery}

1. Bağlantı göstergesini kontrol edin ve aynı arka uca/projeye yeniden bağlanın.
2. Kurtarmanın bekleyen yerel istekleri uzlaştırmasına izin verin; Kapsamın eksik olması durumunda bilinen talepler ve taslaklar korunur.

Geçici kurtarma hataları bildirim oluşturmadan arka planda yeniden denenir. Dahili OpenCode eklentisi bekleyen istekleri listeleyemezse, kurtarma başarılı olana kadar tarayıcı sekmesinde arka uç başına yalnızca bir bildirim gösterilir.

Eksik bir yanıt, yetkili bir boş kuyruk değildir ve eksik eklenti bildirimi bir istemin, yanıtın veya onayın tekrarlanmasına izin vermez. Yapılandırmanın yeniden yüklenmesi yerel Formları/izinleri iptal edebilir; bunu rutin bir istek yenileme düğmesi olarak kullanmayın. Bkz. [Sorun Giderme](troubleshooting.md) ve [OpenCode kurulumu](opencode.md).
