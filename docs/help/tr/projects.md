# Projeler ve çalışma ağaçları

Bir proje sekmesi CodeNomad'i arka uç bilgisayarındaki bir klasöre bağlar. Sekme açmak, bir çalışma kopyasına göz atmak ve konuşma ailesini taşımak farklı işlemlerdir.

## Bir proje açın {#open-project}

Yeni bir boş sekme açmak için **Yeni instance** (`+`) veya `Ctrl/Cmd+N` kullanın. **Son sekmeler** ya da **Gözat** üzerinden proje seçin. Geri yüklenecek sekme olmadığında veya son sekme kapatıldığında CodeNomad boş bir sekme gösterir. Klonlama ve geçici sekmeler yerel sunucuyu kullanır.


Son sekmelerde **Aç**, bu penceredeki sekmeye geçer. Yeşil **Başka bir pencerede açık** noktası, projenin sunucusunda bu pencerenin dışında bir bağlantı olduğunu gösterir. Satırı seçmek ayrı bir sekme açar.

[Uzak projeyi sekmede açma](remote-access.md#remote-project-tabs) · [SideCars](browser-sidecars.md#register-sidecar)

Depoyu kopyalamak için **Git Deposunu Klonla** eylemini seçin; **Depo URL'si** ve **Hedef klasör** alanlarını doldurup **Klonla** eylemini seçin. **Hedef klasör**, son klonunuzun bulunduğu klasörde (yoksa en son projenizin yanında) depo adıyla önceden doldurulur. **Göz At** klonu içerecek klasörü seçer; klon klasörünün adı dahil yolu elle de düzenleyebilirsiniz.

Uzak bir sunucuya göz atmak, telefonunuzun veya dizüstü bilgisayarınızın değil, o sunucunun dosya sistemine göz atmak anlamına gelir. Bir projeyi açmak, her sekme için ayrı bir OpenCode arka plan programı oluşturmaz. Konuşmalar yerel OpenCode oturumlarıdır; bunların ömrü sekmenin ömrü değildir.

Klonlama hedefe bir depo yazar. **Hedef klasör zaten varsa önce onu kaldırın.** yıkıcıdır: yalnızca zaten orada olan her şeyin silinebildiği durumlarda etkinleştirin. Emin değilseniz yeni bir hedef kullanın. Başarısız bir klon, mevcut bir projeyi silmek için bir neden değildir; yeniden denemeden önce bildirilen hedefi ve hatayı inceleyin.

Son kullanılanlar kısayoldur. Boş sekmenin eylem menüsü uygun olduğunda **Workspace'i yeniden adlandır** ve **Son kullanılanlardan kaldır** sunar; dosyalar ve konuşmalar korunur. Boş sekme ve hızlı başlatıcıda yerel/uzak proje veya SideCar satırına tıklamak, zaten açık olsa da yeni bir örnek oluşturur. Ayrı **Aç** eylemi (**Açık projeye geç**) mevcut örneği seçer.

Açık sekmeye geçme eylemi sunucusunu bekleyen sekmeyi de seçer ve başlangıçtaki boş sekmeyi kapatır.

## Yeni örnek başlatıcıyı kullanın {#new-instance-launcher}

`+`'ye uzun basın veya sağ tıklayın; Klavye odağı oradayken **Alt+Down**, **Shift+F10** veya Menü tuşunu kullanın.
Tab aramayı açar, oklar ve Enter seçim yapar, Escape odağı `+` düğmesine döndürür.

## Bir projeyi kapatın {#close-stop}

1. Sekmenin kapat düğmesini veya komut paletindeki **Sekmeyi Kapat** öğesini (arayüzde `Ctrl/Cmd+W`) kullanın.
2. Sekmeyi kapatmak o projeyi CodeNomad'de kapatır: CodeNomad projenin olaylarını ve isteklerini izlemeyi bırakır. Oturumlar OpenCode'da çalışmaya devam eder.
3. Konuşmaları yeniden bulmak için klasörü Gözat veya Son Kullanılanlar aracılığıyla tekrar açın.

| Eylem | Kapsam ve etki | Ne yapmaz |
| --- | --- | --- |
| Sekmeyi Kapat | O sekmenin CodeNomad proje bağlantısını kaldırır; aynı klasörde ayrı açılmış başka bir sekme etkilenmez | Proje dosyalarını veya yerel geçmişi silmez, oturumları durdurmaz veya OpenCode'un Location bağlamını kaldırmaz |
| Oturumu durdur | Seçilen görüşmenin yürütülmesi | Projeyi kapatmaz veya geçmişini silmez |

Kapatılan sekmenin gönderilmemiş taslakları ve ekleri, aynı klasörü o pencerede yeniden açtığınızda geri gelir; pencere bunları yeniden yüklenene veya kapanana kadar en son kapatılan 16 proje için tutar. Başlangıç geri yüklemesine dahil değildir.

Bir pencereyi veya tarayıcı sekmesini kapattığınızda ya da yenilediğinizde veya uygulamadan çıktığınızda CodeNomad sunuculardan ilgili proje bağlantılarını bırakmalarını ister. Sunucuya ulaşılamazsa kayıtlar sunucuda kalabilir. Diğer pencerelerin sekmeleri açık kalır. Başlangıçta geri yükleme, kayıtlı sekmeleri yeniden bağlar ve açık geçici klasörleri korur. Yürütmeyi sonlandırmak için ilgili çalıştırmaları açıkça durdurun; paylaşılan hizmetin bakımı için [OpenCode kurulumu](opencode.md) bölümüne bakın.

Başlangıç geri yüklemesi etkinken kalan her sekme kendi panel tercihlerini, Görev seçimini ve okuyucusunu, sohbet veya web önizlemesi seçimini geri yükler. Tarayıcı URL'leri ve geçmişi oturum başına paylaşılır; kayıtlı sayfalar yalnızca web önizlemesi açıkça yeniden açıldığında yüklenir. Bir örneği kapatmak yalnızca o örneğin kayıtlı görünümünü kaldırır; klasörü yeniden açmak yeni bir örnek oluşturur.

Bir tarayıcı sekmesini çoğaltmak, o sekmeye ait ayrı proje bağlantıları açar. Açık kalan bir bağlantı yalnızca tarayıcının bellekten çıkardığı aynı sekme yeniden açıldığında kullanılabilir.

## Uzak sekmeleri geri yükleme {#restore-remote-tabs}

Geri yükleme açıkken yeniden yüklediğinizde uzak sekmelerin sırası, seçimi ve taslakları korunur. Kullanılamayan sunucu bekleyen bir sekme bırakır: sunucu döndüğünde **Yeniden dene**, ya da kullanıcı adı/parola veya **Yeni eşleştirme bağlantısı** alanındaki bağlantıyla **Bağlan** seçin. Diğer sunucular kullanılabilir kalır. **Sunucu bulunamadı**, kayıtlı sunucunun eksik olduğunu gösterir.

**Yeniden dene**, kayıtlı sunucudaki projeye yeniden bağlanır ve gerekirse bağlantıyı yeniden oluşturur.

**Yeniden dene**, başlangıçta otomatik geri yükleme kapalıyken de bekleyen sekmeleri kurtarır. Bildirimler mevcut bekleyen sekmeyi seçer. Onaylanmamış bir konuşma işlemini yeniden göndermeden önce sonucunu kontrol edin.

## Geçici çalışma alanları {#temporary-workspaces}

1. Boş sekmenin üstündeki **Geçici sekme** düğmesini seçin.
2. Boş CodeNomad tarafından yönetilen klasörde çalışın; Git otomatik olarak başlatılmıyor.
3. Sekmeyi kapatırken **Sakla**, **At** veya **İptal** öğesini seçin. Sekme menüsü ayrıca **Proje olarak sakla** öğesini de sunar.

| Seçim | Etki | Kurtarma |
| --- | --- | --- |
| Sakla | Projeyi CodeNomad'de kapatır, klasörü ve konuşmaları korur, geçici durumunu kaldırır ve son kullanılan projelere ekler | Son kullanılanlardan yeniden açın; klasör taşınmaz |
| At | Geçici çalışma alanının konuşmalarını, dosyalarını ve gönderilmemiş taslaklarını siler | Geri alma yok; ihtiyaç duyulan her şeyi önce başka bir yere kaydedin |
| İptal | Geçici çalışma alanını açık bırakır | Çalışmaya devam edin veya daha sonra karar verin |

Hiçbir konuşma, dosya veya gönderilmemiş taslak içermeyen, dokunulmamış bir geçici sekme, kapatıldığında sessizce atılır. Açık geçici sekmeler normal başlangıç geri yüklemesine katılır.

Bir konuşma çalışırken veya klasör başka sekmede/pencerede açıkken At işlemi reddedilir. Önce çalıştırmayı durdurup diğer görünümleri kapatın. Atma başarısız olursa çalışma alanı geçici kalır: üst dizini elle silmek yerine bildirilen sorunu çözüp yeniden deneyin.

## Bir çalışma ağacı seçin veya oluşturun {#select-create-worktree}

1. Bir üst konuşma açıp ileti düzenleyicisindeki çalışma ağacı seçicisini kullanın. Dar yerleşimlerde bu kontrol yalnızca bir ok gösterir.
2. Mevcut keşfedilen bir çalışma ağacını seçin veya **+ Worktree oluştur** öğesini seçin.
3. Oluşturmak için **Ad** girin ve **Worktree oluştur ve kullan** öğesini seçin.

Proje bir depo içindeki klasörse yalnızca o klasörü içeren çalışma ağaçları listelenir. Böyle bir klasörden çalışma ağacı oluşturmak için Git'in onu izlemesi gerekir. Yeni dal adı seçili çalışma kopyasının HEAD revizyonundan başlar. Mevcut dal adı o dalın güncel revizyonunu kullanır; Git başka yerde kullanıma alınmış dalı reddedebilir. Çalışma ağaçları varsayılan `.codenomad/worktrees` konumunu kullanır. Commit edilmemiş değişiklikler özgün çalışma kopyasında kalır; oluşturma bunları yeni çalışma ağacına kopyalamaz.

İleti düzenleyicisindeki seçici, üst konuşmayı ve tüm alt konuşmalarını doğrulanmış bir aile olarak taşır. Alt oturum bu seçiciyi bağımsız değiştiremez. Etkin oturumlar işlemi engeller: önce ailenin tamamlanmasını bekleyin veya yürütmesini durdurun. Yeni taşıma istemeden önce mevcut taşımanın sonuçlanmasını bekleyin; hata durumunda yeniden denemeden önce yenilenen konuşma/çalışma ağacı durumunu inceleyin.

Buna karşılık [Dosyalar](files.md) bölümündeki **İncelenecek çalışma ağacı** yalnızca panelin okuduğu çalışma kopyasını değiştirir. Konuşmayı taşımaz, dal değiştirmez veya sonraki kabuk komutunun çalışacağı yeri değiştirmez.

## Bir çalışma ağacını kaldırma {#remove-worktree}

1. Arayüz çalışma ağacı listesinde, çıkarılabilir bir dal çalışma ağacı için **Worktree sil** öğesini kullanın.
2. Hedef klasörü inceleyin. Yerel değişikliklerin kaybını kabul etmiyorsanız **Zorla sil (yerel değişiklikleri at)** seçeneğini kapalı tutun.
3. Silme işlemini onaylayın ve ortaya çıkan envanteri kontrol edin.

Silme, çalışma ağacının yerel klasörünü kaldırır. Git'in ana çalışma kopyası silinebilir bir hedef değildir. CodeNomad etkilenen konuşma ailelerini kök çalışma kopyasına geri taşır ve çalışma ağacını kaldırmadan önce yerleşimlerini doğrular; etkin oturumlar kaldırmayı engelleyebilir. Silme, commit edilmemiş dosyaların arşivi veya yedeği değildir.

Git değiştirilmiş/izlenmeyen dosyaları reddederse yeniden denemeden önce bu dosyaları koruyun veya temizleyin. Zorla silme bunları açıkça siler. Kilitli dizinde onu kullanan terminalleri, düzenleyicileri, izleyicileri ve arka plan süreçlerini kapatın. Tanılama paylaşımı için hata penceresi **Temizlenmiş sürümü kopyala** eylemini sunar; temizlenmiş metni bile önce gözden geçirin.

## Git'i başlatın veya Git olmadan çalışın {#initialize-git}

1. Git'in mevcut olduğu sıradan bir klasör için **Dosyalar → Değişiklikler** veya **Commitler** öğesini açın.
2. **Git'i başlat** öğesini seçin. Ekstra bir onay gerektirmeden anında harekete geçer.
3. Proje meta verilerinin ve konuşmalarının yenilenmesini bekleyin; Git, CodeNomad dışında başlatılmışsa **Yenile** öğesini kullanın.

Başlatma, depoyu üst dizinde değil, açıkça açılan klasörde oluşturur. Commit oluşturmaz.

Arka uç Git'i çalıştıramazsa, konuşmalar ve sınırlı dosya tarama, yalnızca dizin modunda açıkça açılan klasör için kullanılabilir durumda kalır. Worktree işlemleri ve Git başlatma, bu arka uçta Git gerektirir. Bkz. [kurulum](install.md) ve [Dosyalar](files.md).
