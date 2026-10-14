# Dosyalar ve Git

**Dosyalar** sağ panel sekmesi çalışma kopyasına göz atmayı, yerel değişiklikleri ve commit geçmişini birleştirir. Satır seçmek merkezi okuyucuyu açmaktan farklıdır.

## Çalışma kopyasına göz atın {#browse-workspace}

1. **Dosyalar** öğesini açın ve **Çalışma alanı** öğesini seçin.
2. Başka çalışma kopyası istiyorsanız **İncelenecek çalışma ağacı** seçimini değiştirin; klasörleri gerektiğinde genişletin.
3. Dosya satırını tıklayarak seçin. Merkezi önizlemeyi açıp kapatmak için göz simgesini kullanın.
4. Görünür anlık görüntünün yeniden kontrol edilmesi gerekiyorsa **Yenile** öğesini kullanın.

| Mod | Okur | Konuşma üzerindeki etkisi |
| --- | --- | --- |
| Çalışma alanı | Göz atılan çalışma kopyasındaki dosyalar | Oturumu taşımaz veya dalı kullanıma almaz |
| Değişiklikler | Dizin ve çalışma ağacı değişiklikleri | Git değişiklik işlemleri yalnızca açık eylemlerle gerçekleşir |
| Commitler | Sayfalandırılmış commit geçmişi ve revizyon içerikleri | Salt okunur geçmiş; çalışma kopyasını değiştirmez |

Genişletilmiş klasörler mod değişikliklerinden etkilenmez. Listeleme/durum/geçmiş, önbelleğe alınmış anlık görüntüleri kullanır ve ilgili dosya sistemi değişiklikleri, etkinleştirme veya açık yenileme sonrasında yeniden doğrulanır; panele odaklanmak yeni bir okuma garantisi değildir.

Satır eylemleri arasında **Yolu kopyala** ve istemcinin arka uç yollarının açılmasını desteklediği durumlarda **Varsayılan uygulamayla aç**, **Klasörde göster**, **Dosya yöneticisinde aç** ve **Burada terminal aç** gibi dosya yöneticisi/düzenleyici/terminal eylemleri bulunur. Alan sınırlı olduğunda eylemler **{name} için daha fazla eylem** öğesine taşınabilir; dosya veya klasör adı `{name}`'nin yerine geçer. Uzak bir tarayıcı, sunucu yolunun yerel aygıt yolu olduğunu varsayamaz; bkz. [Uzaktan Kontrol](remote-control.md).

## Kaynağı düzenleyin ve güvenle kaydedin {#edit-save}

1. Çalışma Alanındaki bir metin dosyasını göz simgesiyle açın.
2. Markdown için düzenleme yapmak üzere **Kaynağı göster**, işlenmiş görünümü okumak üzere **Markdown'ı önizle** eylemini seçin.
3. Düzenleyin ve **Kaydet** öğesini seçin veya düzenleyici odaklanmışken **Ctrl/Cmd+S** tuşuna basın.
4. Dosya harici olarak değiştiyse üzerine yazma onayını inceleyin; taslağınızı bu değişikliğin üzerine yazmadan saklamak için **İptal** öğesini seçin.

Kaydetme, bağlantılı çalışma ağacı dahil göz atılan çalışma kopyasındaki gerçek dosyaya yazar; istem göndermez veya düzenlemeyi stage/commit etmez. Kaydetmeden önce yetkili dosya yeniden okunur. Çakışma penceresi **Dosya agent tarafından değiştirildi. Agent'ın değişikliklerinin üzerine yazılsın mı?** der; diğer harici yazıcıların değişikliklerine de aynı özeni gösterin.

Kaydedilmemiş kaynak taslakları okuyucu kapatıldığında veya değiştirildiğinde, proje örneği, dizin ve yol kapsamında arayüz belleğinde korunur. Dosya sistemi yenilemeleri bunları sessizce değiştirmez. Bu kalıcı dosya deposu değildir: istemciyi yeniden başlatmadan/yüklemeden önce önemli düzenlemeleri kaydedin veya kopyalayın. Okuma/yazma hataları taslağı korur. Açık **Yenile** eylemi kaydedilmemiş düzenlemeleri atmadan önce uyarır.

Okuyucunun sonundaki kapatma düğmesi konuşmaya döner; ileti düzenleyicisi okuyucunun altında kullanılabilir kalır. Oturumu/çalışma ağacını değiştirmek seçili okuyucuyu temizler, taslağı kaydetme garantisi vermez. Tarayıcı önizlemesi okuyucunun yerini alır; dosya açmak bu görünümü sohbet moduna döndürür.

## Salt okunur ve sınırlı önizlemeler {#preview-limits}

1. Göz eylemiyle bir görüntüyü, ikili dosyayı veya geçmiş değişikliği açın.
2. Bir fark için, gerektiği şekilde **Bölünmüş görünüme geç** / **Birleşik görünüme geç**, sözcük kaydırma ve değişmemiş bölge kontrollerini kullanın.
3. Sohbete geri dönmek için okuyucuyu kapatın.

| İçerik | Mevcut davranış |
| --- | --- |
| Markdown kaynağı dahil çalışma alanı metni | Açık Kaydet ile düzenlenebilir |
| Çalışma alanı resmi | Salt okunur resim önizlemesi |
| Diğer ikili içerik | Salt okunur, önizlemenin kullanılamadığını belirten alternatif görünüm |
| Değişiklikler/Commitler metin farkı | Her iki tarafı da düzenlemeyen salt okunur karşılaştırma |
| Git görüntü farkı | Tam olarak karşılaştırılan revizyonlardan önceki/sonraki görüntüler |

Önizleme okumaları sınırlıdır; büyük/desteklenmeyen içerik sınırsız yüklenmek yerine kullanılamaz olabilir. Geçmiş görüntülerin yerine hiçbir zaman mevcut çalışma ağacı dosyası kullanılmaz. Önizleme hatası dosyanın yokluğunu göstermez. Yalnızca önizleme almak için revizyonu değiştirmeden dosyayı uygun harici uygulamada açın.

## Stage, unstage ve commit işlemleri {#stage-commit}

1. **Değişiklikler** öğesini seçin ve **Staged Değişiklikler** ile **Değişiklikler** öğesini inceleyin.
2. **Dosyayı stage et** / **Dosyayı unstage et** öğesini kullanın, karşılık gelen seçili dosyalar eylemi için birkaç satır seçin veya satırları bölümler arasında sürükleyin.
3. **Staged Değişiklikler** öğesinin üst kısmına bir mesaj girin ve ardından **Commit** öğesini seçin.

Daraltılmış bölüm başlıkları sürükle-bırak hedefi olmaya devam eder. Bölümleri daraltmak veya mod değiştirmek durumlarını ve commit mesajı taslağını korur. Stage/unstage göz atılan çalışma ağacının indeksini değiştirir; commit yalnızca stage edilmiş içeriği kaydeder. Unstage, çalışma ağacındaki düzenlemeyi geri almaz.

Özellikle ajanlar veya başka istemci de aynı yere yazıyorsa commit öncesinde stage edilmiş dosyaları inceleyin. Başarısız commit otomatik yeniden gönderilmez. Yeniden denemeden önce durumu/geçmişi yenileyip hatayı inceleyin; kayıp yanıt hiçbir commit oluşmadığının kanıtı değildir.

## Commit geçmişini okuyun {#commit-history}

1. **Commitler** bölümünü seçip mesajını ve değişen dosyalarını okumak için bir commit seçin.
2. Yüklenen seti filtrelemek için **Yüklenen commitleri filtrele…** öğesini veya başka bir sayfa getirmek için **Eski commitleri yükle** öğesini kullanın.
3. Değişen dosyayı göz simgesiyle açın.

Metin geçmişi commiti ilk üst commitiyle (kök committe boş bir tabanla) karşılaştırır. HEAD'i değiştirmez veya oturumları taşımaz. Yüklenen commitleri filtrelemek sunucu genelinde Git günlüğü araması değildir. Yeni commitlerden sonra güncel geçmişten başlamak için yenileyin; mevcut sayfalama başlangıçtaki geçmiş anlık görüntüsünü korur.

## Boşluk ve satır sonları {#whitespace-line-endings}

1. **Ayarlar → Gelişmiş → Yalnızca boşluk değişikliklerini gizle** öğesini açın.
2. Değişiklikler listesinden gizlenen, yalnızca boşluk içeren stage edilmemiş düzenlemeleri incelemek istiyorsanız ayarı kapatın.
3. Commit öncesinde gerçek farkı ve stage edilmiş içeriği inceleyin.

Ayar varsayılan olarak açıktır. Ana etkisi, uygun stage edilmemiş, izlenen metin değişikliklerini Değişiklikler listesinden, sayılardan, seçimden, toplu stage ve sürükleme işlemlerinden gizlemektir. Gizlenen dosyalar stage edilmeden kalır. Stage edilmiş dosyalar ile izlenmeyen, eklenen/silinen/yeniden adlandırılan ve ikili dosyalar görünür kalır. Algılama başarısızsa veya desteklenmiyorsa tahmin etmek yerine dosyalar görünür tutulur.

Git'in liste algılaması iç boşlukları, yalnızca CRLF değişikliklerini ve eklenen/kaldırılan son yeni satırları göz ardı edebilir. Fark okuyucunun boşluk karşılaştırması daha dardır: girinti ve sondaki boşluklar/sekmeler, iç boşlukların tamamı değil. Stage ve Commit, görüntüleme tercihinden bağımsız olarak her zaman tam içerik üzerinde hareket eder.

Satır sonu ve bayt sırası işareti farklılıkları, vurgulanan satırlar yerine gerçeklere dayalı bir not üretebilir. Ayarın kapatılması, düzenleyicinin her satır sonu/BOM değişikliğini veya her aynı uzunluktaki sondaki boşluk değişimini çizmesini sağlayamaz. Görsel olarak boş bir fark, aynı baytların kanıtı değildir.

## Git'i başlat {#initialize-git}

1. **Değişiklikler** veya **Commitler** öğesini depo olmayan bir klasörde açın.
2. **Git'i başlat** öğesini seçin; onay gerekmeden hemen çalışır.
3. Proje/oturum yenilenmesini bekleyin; hazır olduğunuzda stage ve commit işlemlerini açıkça yapın.

Başlatma `.git` dizinini açıkça açılan klasörde oluşturur; üst dizini başlatmaz veya ilk commiti oluşturmaz. Arka uçta Git yoksa yalnızca dizin konuşmaları ve Çalışma Alanına göz atma kullanılabilir kalır; başlatma ve Git işlemleri kullanılamaz. Belirsiz hata durumunda yeniden denemeden önce yenileyin; başlatma isteği otomatik yeniden gönderilmez. Bkz. [Projeler](projects.md).
