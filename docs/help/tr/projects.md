# Projeler ve çalışma ağaçları

Çoklu arka uç etkinse ana sayfada veya `+` başlatıcısında **UZAKLAR** bölümünü genişletin. Kayıtlı CodeNomad sunucusunun yanında **+ Proje**'yi seçin, aynı yerde klasörlere göz atın ve **Aç**'ı seçin. Sunucu eklemek için eşleştirme bağlantısını veya adresi listenin altına yapıştırın. Burada açılan projeler, sunucu çevrimdışı olsa bile simgesi ve adıyla ortak listede kalır. Göz atma, klonlama ve geçici projeler bu bilgisayarı kullanır.

Bir proje sekmesi CodeNomad'i arka uç bilgisayarındaki bir klasöre bağlar. Sekme açmak, bir çalışma kopyasına göz atmak ve konuşma ailesini taşımak farklı işlemlerdir.

**+ Proje**, sunucunun bilinen son proje yolundan başlar. Klasör taşındıysa veya silindiyse **Sunucu kök dizini**'ni seçin. Son kullanılan proje açılırken **İptal** sunucu listesine döndürür.

Son kullanılanlarda yalnızca burada başarıyla açtığınız uzak projeler görünür. Klasörlere göz atmak kısayol eklemez. Kayıtlı kısayollar aynı bağlantı (profil, adres, TLS doğrulama ayarı ve SSH hedefi) için çevrimdışıyken de görünür. Uzak klasör için zaten bekleyen bir sekme varsa o sekme seçilir ve taslakları korunur. Yeniden denemeyi siz başlatırsınız.

Kaldırdığınız kısayol, o klasörü yeniden açana kadar son kullanılan projelerde görünmez.

## Bir proje açın {#open-project}

1. Ana sayfayı açmak için **Yeni instance** (`+`) öğesine tıklayın.
2. **Klasörlere Göz At** öğesini seçin, arka uç klasörünü seçin ve açın; veya **Son Klasörler** altında bir giriş seçin.
3. Depoyu kopyalamak için **Git Deposunu Klonla** eylemini seçin; **Depo URL'si** ve **Hedef klasör** alanlarını doldurup **Klonla** eylemini seçin. **Hedef klasör**, son klonunuzun bulunduğu klasörde (yoksa en son projenizin yanında) depo adıyla önceden doldurulur. **Göz At** klonu içerecek klasörü seçer; klon klasörünün adı dahil yolu elle de düzenleyebilirsiniz.

Uzak bir sunucuya göz atmak, telefonunuzun veya dizüstü bilgisayarınızın değil, o sunucunun dosya sistemine göz atmak anlamına gelir. Bir projeyi açmak, her sekme için ayrı bir OpenCode arka plan programı oluşturmaz. Konuşmalar yerel OpenCode oturumlarıdır; bunların ömrü sekmenin ömrü değildir.

Klonlama hedefe bir depo yazar. **Hedef klasör zaten varsa önce onu kaldırın.** yıkıcıdır: yalnızca zaten orada olan her şeyin silinebildiği durumlarda etkinleştirin. Emin değilseniz yeni bir hedef kullanın.

Son kullanılan kayıtlar birer kısayoldur. **Workspace'i yeniden adlandır** görünen adı değiştirir; **Son kullanılanlardan kaldır** dosyaları veya konuşmaları değil, kısayolu kaldırır. Zaten açık olan bir son kullanılan projeye tıklamak yeni bir sekme açar; mevcut sekmeyi seçmek için bunun yerine projenin **Aç** düğmesini (**Açık projeye geç**) kullanın.

Aynı klasörü iki kez açıp her iki sekmede de aynı konuşmayı seçerek birinde sohbeti, diğerinde web önizlemesini, dosyayı veya Görev raporunu tutun. Her sekme kendi görünümünü, konuşmanın kaydırma konumunu, sağ panel seçimini ve Dosyalar modunu korur; iletiler, yürütme ve proje verileri ortak kalır.

## Yeni örnek başlatıcıyı kullanın {#new-instance-launcher}

1. `+`'ye uzun basın veya sağ tıklayın; Klavye odağı oradayken **Alt+Down**, **Shift+F10** veya Menü tuşunu kullanın.
2. Son projeleri arayın veya **Gözat…**, **Geçici** veya **Klonla…** öğesini seçin.

Normal tıklama ana sayfayı açar. Başlatıcı açık projeye geçer; ana sayfa, bekleyen bir sekme seçilmedikçe yeni bir sekme açar. **UZAKLAR** bölümünde Escape sunuculara döner, listeyi daraltır, ardından başlatıcıyı kapatıp odağı `+`'ya döndürür.

## Bir projeyi kapatın {#close-stop}

1. Sekmenin kapat düğmesini veya komut paletindeki **Sekmeyi Kapat** öğesini (arayüzde `Ctrl/Cmd+W`) kullanın.
2. Sekmeyi kapatmak o projeyi CodeNomad'de kapatır: CodeNomad projenin olaylarını ve isteklerini izlemeyi bırakır. Oturumlar OpenCode'da çalışmaya devam eder.
3. Konuşmaları yeniden bulmak için klasörü Gözat veya Son Kullanılanlar aracılığıyla tekrar açın.

| Eylem | Kapsam ve etki | Ne yapmaz |
| --- | --- | --- |
| Sekmeyi Kapat | O sekmenin CodeNomad proje bağlantısını kaldırır; aynı klasörde ayrı açılmış başka bir sekme etkilenmez | Proje dosyalarını veya yerel geçmişi silmez, oturumları durdurmaz veya OpenCode'un Location bağlamını kaldırmaz |
| Oturumu durdur | Seçilen görüşmenin yürütülmesi | Projeyi kapatmaz veya geçmişini silmez |

Aynı proje bağlantısını başka bir pencere gösteriyorsa oradaki sekme de kapanır ve o pencere bir bildirim gösterir. Kapatılan sekmenin gönderilmemiş taslakları ve ekleri, aynı klasörü o pencerede yeniden açtığınızda geri gelir; pencere bunları yeniden yüklenene veya kapanana kadar en son kapatılan 16 proje için tutar. Başlangıç geri yüklemesine dahil değildir.

Bir pencerenin tamamını kapatmak, uygulamadan çıkmak veya yeniden yüklemek proje bağlantılarını kapatmaz; normal başlangıç geri yüklemesi yine uygulanır. Yürütmenin bittiğini doğrulamak istiyorsanız ilgili çalıştırmaları açıkça durdurun. CodeNomad yerel Location bağlamlarını hiçbir zaman kaldırmaz; paylaşılan hizmetin bakımı [OpenCode kurulumu](opencode.md) bölümünde açıklanır.

Başlangıç geri yüklemesi etkinken kalan her sekme kendi panel tercihlerini, Görev seçimini ve okuyucusunu, sohbet veya web önizlemesi seçimini geri yükler. Tarayıcı URL'leri ve geçmişi oturum başına paylaşılır; kayıtlı sayfalar yalnızca web önizlemesi açıkça yeniden açıldığında yüklenir. Bir örneği kapatmak yalnızca o örneğin kayıtlı görünümünü kaldırır; klasörü yeniden açmak yeni bir örnek oluşturur.

## Uzak sekmeleri geri yükleme {#restore-remote-tabs}

Çoklu arka uç etkinken kayıtlı uzak projeler sekme sırasını, seçimi ve her sekmenin kendi taslaklarını korur. Kullanılamayan sunucu bekleyen bir sekme bırakır: sunucu döndüğünde **Yeniden dene**, ya da kullanıcı adı/parola veya yeni bir **Eşleştirme bağlantısı** ile **Bağlan** seçin. Diğer sunucular kullanılabilir kalır.

**Yeniden dene**, başlangıçta otomatik geri yükleme kapalıyken de bekleyen sekmeleri kurtarır. Bildirimler mevcut bekleyen sekmeyi seçer. Onaylanmamış bir konuşma işlemini yeniden göndermeden önce sonucunu kontrol edin.

Sunucuyu kaldırmadan veya adresini değiştirmeden önce tüm pencerelerdeki proje sekmelerini kapatın ve Ayarlar hâlâ bu sunucuyu kullanıyorsa **Ayarlar**'ı başka bir projeden yeniden açın. Erişilemeyen proje listesi, kontrol edilene kadar değişikliği engeller.

## Geçici çalışma alanları {#temporary-workspaces}

1. Başlatıcıda **Geçici** öğesini veya ana sayfada **Yeni geçici instance** öğesini seçin.
2. Boş CodeNomad tarafından yönetilen klasörde çalışın; Git otomatik olarak başlatılmıyor.
3. Sekmeyi kapatırken **Sakla**, **At** veya **İptal** öğesini seçin. Sekme menüsü ayrıca **Proje olarak sakla** öğesini de sunar.

| Seçim | Etki | Kurtarma |
| --- | --- | --- |
| Sakla | Projeyi CodeNomad'de kapatır, klasörü ve konuşmaları korur, geçici durumunu kaldırır ve son kullanılan projelere ekler | Son kullanılanlardan yeniden açın; klasör taşınmaz |
| At | Geçici çalışma alanının konuşmalarını, dosyalarını ve gönderilmemiş taslaklarını siler | Geri alma yok; ihtiyaç duyulan her şeyi önce başka bir yere kaydedin |
| İptal | Geçici çalışma alanını açık bırakır | Çalışmaya devam edin veya daha sonra karar verin |

Hiçbir konuşma, dosya veya gönderilmemiş taslak içermeyen, dokunulmamış bir geçici sekme, kapatıldığında sessizce atılır. Açık geçici sekmeler normal başlangıç geri yüklemesine katılır, ancak ana sayfada kapatılan geçici klasörlerin devam ettirilmesi için ayrı bir liste yoktur.

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
