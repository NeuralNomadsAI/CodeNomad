# समस्या समाधान

असफल कार्यको स्वामी—browser, CodeNomad backend, OpenCode service वा provider—पहिले जाँचेर पुनःप्राप्ति गर्नुहोस्। reply हराउनु mutation असफल भएको प्रमाण होइन; दोहोर्‍याउनुअघि current state फेरि पढ्नुहोस्।

## desktop launch समस्या {#desktop-launch}

### macOS quarantine {#macos-quarantine}

CodeNomad का macOS release हरू Apple द्वारा notarize गरिएका छैनन्, त्यसैले आधिकारिक repository बाट verify गरेको भए पनि download गरिएको प्रतिलिपिको पहिलो launch macOS ले रोक्छ: यसले **"CodeNomad" Not Opened** (Apple ले malware-मुक्त भएको पुष्टि गर्न सकेन) देखाउँछ, वा app damaged छ भन्छ।

1. download स्रोत र installed app path जाँच्नुहोस्।
2. तलको path मा app स्थापित भए quarantine attribute हटाउनुहोस्:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. फेरि launch गर्नुहोस्। **Not Opened** सन्देशका लागि, रोकिएको launch पछि **System Settings → Privacy & Security** मा CodeNomad का लागि **Open Anyway** रोजेर administrator password ले पुष्टि गर्न पनि सकिन्छ।

यसले त्यही app को macOS quarantine attribute बदल्छ। corrupted download मर्मत वा अज्ञात binary विश्वसनीय बनाउँदैन।

### Linux graphics र FUSE {#linux-graphics}

Wayland/NVIDIA मा तुरुन्त बन्द हुने Tauri AppImage लाई WebKitGTK को DMA-BUF/GBM renderer ले असर गरेको हुन सक्छ। लक्षित environment override सहित downloaded AppImage चलाउनुहोस्:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron ले Chromium प्रयोग गर्छ र उही host मा विकल्प हो। FUSE नभएर AppImage mount नभएको हो भने `--appimage-extract-and-run` प्रयोग गर्नुहोस्; [Linux स्थापना](install.md#linux-install) हेर्नुहोस्। यी उपायलाई Electron sandbox अक्षम गर्नुपर्दैन।

## Git र workspace उपलब्धता {#git-and-workspaces}

1. agent shell मा मात्र होइन backend खाताको `PATH` मा Git जाँच्नुहोस्।
2. नभए त्यस host/account मा Git स्थापना गरी updated environment लिन CodeNomad backend restart गर्नुहोस्।
3. workspace reopen/refresh गरी repository status जाँच्नुहोस्।

Git बिना directory-only कुराकानी उपलब्ध रहन्छन्; worktree र Git नियन्त्रण हुँदैनन्। Windows मा WSL भित्र मात्र Git पर्याप्त होइन। repository नभएको ज्ञात folder ले **Git सुरु गर्नुहोस्** दिन सक्छ; Git executable नै नहुनु फरक अवस्था हो र पहिले ठीक गर्नुपर्छ। [आवश्यकता](install.md#requirements) र [फाइल](files.md) हेर्नुहोस्।

owned worktree वा conversation placement verify गर्न नसके मनपरी path वा native storage सम्पादन गर्नुको सट्टा physical folder स्पष्ट खोल्नुहोस्। अनिश्चित move/removal पछि कुन placement वास्तविक छ हेर्न refresh गर्नुहोस्। force-removing ले uncommitted file नष्ट गर्न सक्छ; connection मर्मतका लागि प्रयोग नगर्नुहोस्।

## OpenCode runtime र WSL {#opencode-runtime}

1. **प्राथमिकताहरू → OpenCode** खोली **OpenCode संस्करण** card (installed version र running service status), त्यसपछि **OpenCode बाइनरी** अन्तर्गतको selected executable जाँच्नुहोस्।
2. आवश्यक runtime नभए समर्थित installation/update प्रयोग गर्नुहोस्। हालको minimum: **2.1.2**; recommended/qualified: **2.1.2**।
3. installed CLI running service भन्दा फरक भए shared service restart गर्ने कि स्पष्ट निर्णय गर्नुहोस्।

**OpenCode सेवा पुनः सुरु गर्नुहोस्** **समस्या समाधान** अन्तर्गत उपलब्ध छ र पुष्टि चाहिन्छ। हरेक connected client को सक्रिय काम interrupt गर्छ, तर session history राख्छ। configuration reload छुट्टै हो: process राख्छ तर loaded Location पुनर्निर्माण र pending question/permission रद्द गर्छ। कुनै हानिरहित refresh होइन।

WSL executable मा अभिप्रेत वितरण र Windows localhost forwarding जाँच्नुहोस्। service lifecycle Linux भित्र चल्छ; CodeNomad ले Windows बाट loopback endpoint पुग्नुपर्छ। service registration/database सम्पादन वा अनुमानित Linux process ID लाई Windows बाट signal नगर्नुहोस्।

custom/newer संस्करण incompatible नभई unverified हुन सक्छ। संस्करण बदल्नुअघि वास्तविक contract error पढ्नुहोस्। session environment sync असफल भए execution-host environment/connection ठीक गर्नुहोस्: synchronization बिना CodeNomad prompt पठाउँदैन। [OpenCode](opencode.md) हेर्नुहोस्।

## login, TLS र direct connectivity {#login-and-tls}

| लक्षण | सुरक्षित जाँच र पुनःप्राप्ति |
| --- | --- |
| **CodeNomad मा फेरि साइन इन गर्नुहोस्** | पृष्ठ खुलै राखी server username/password भरेर **साइन इन गर्नुहोस्** चयन गर्नुहोस्। recovery ले मस्यौदा राख्न त्यहीं reconnect गर्छ; असफल कार्य replay गर्दैन। |
| server पुगिँदैन | backend चलिरहेको र छापिएको address/actual port प्रयोग भएको जाँच्नुहोस्। unreachable जाँच मात्र login expired प्रमाण होइन। |
| provider authentication अस्वीकार | स्वामीमार्फत provider login मर्मत गर्नुहोस्; provider OAuth ठीक गर्न CodeNomad server password नबदल्नुहोस्। |
| certificate name/trust त्रुटि | actual hostname/IP लाई certificate SAN सँग जाँचेर intended CA trust वा valid server certificate स्थापना गर्नुहोस्। TLS verification अक्षम नगर्नुहोस्। |
| direct connection refused | प्रभावकारी HTTP/HTTPS binding, firewall र routing जाँच्नुहोस्। desktop वा dual-listener mode को HTTP loopback मै रहन्छ; standalone HTTP-only को binding फरक छ। |

authentication recovery पछि अनिश्चित reply भएको mutation हातैले retry गर्नुअघि state जाँच्नुहोस्। runtime password हरेक backend start मा दिनुपर्छ; settings बाट सुरक्षित password रहिरहन्छ। [सुरक्षा](security.md), [TLS/binding नियम](remote-access.md) र [server सन्दर्भ](server.md) हेर्नुहोस्।

## Remote Control pairing {#pairing}

1. host मा **सेटिङहरू → रिमोट पहुँच** खोलेर Remote Control चलिरहेको जाँच्नुहोस्।
2. नयाँ pairing link बनाएर expiry अघि अभिप्रेत device मा खोल्नुहोस्।
3. client मा **यो उपकरण फेरि जोड्नुहोस्** देखिए host बाट pair गरी client मा **जडान जाँच्नुहोस्** चयन गर्नुहोस्।

pairing link single-use र छोटो आयुका हुन्; direct-access password विकल्प होइन। revoked वा inactivity-expired device credential लाई re-pair चाहिन्छ। अन्तिम desktop window बन्द हुँदा backend र Remote Control रोकिन्छ; enabled service अर्को app launch मा फर्किन्छ। host-only अनुपलब्ध सतह र revocation का लागि [Remote Control](remote-control.md) हेर्नुहोस्।

## provider, plugin र extension अवस्था {#providers-and-addons}

| समस्या | पुनःप्राप्ति |
| --- | --- |
| गलत provider account/quota | selected native account र **प्रयोग** जाँच्नुहोस्। quota display token/cost total होइन। अनिश्चित account परिवर्तनपछि refresh; चयनले उही सेवाका अरू client असर गर्न सक्छ। |
| बाह्य स्वामित्वको OAuth expired | OpenCode, Claude Code वा credential owner बाट फेरि sign in गर्नुहोस्। CodeNomad ले refresh token साट्दैन। |
| automatic rotation switch हुँदैन | opt-in eligibility र current account साँच्चै full छ कि जाँच्नुहोस्। pre-admission नीति हो, in-flight failover वा prompt replay होइन। |
| plugin अवस्था पुरानो | **प्लगइन नियन्त्रण ताजा गर्नुहोस्** र tooltip scope/target जाँच्नुहोस्; runtime activation लाई native refresh पर्खनुपर्न सक्छ। अनिश्चित write बारम्बार toggle नगर्नुहोस्। |
| **मिसन नियन्त्रण उपलब्ध छैन** | यसले बताएको कारण पछ्याउनुहोस्। OpenCode ले Missions plugin लोड गरेको छैन भने refresh गर्नुहोस्, रहिरहे **OpenCode कन्फिगरेसन पुनः लोड गर्नुहोस्** प्रयोग गर्नुहोस्; plugin लोड हुन असफल भए Plugins सूचीमा यसको त्रुटि पढ्नुहोस्; server ले आफ्नो स्थानीय Missions जडान खोल्न सकेन भने server log जाँच्नुहोस्, किनकि OpenCode reload गर्दा मद्दत हुँदैन। Missions standalone server मा पनि चल्छन्। |
| स्थापित extension हराएको | panel customization मा एउटै activation checkbox जाँच्नुहोस्। installation/replacement पछि explicit activation र required consent नदिँदासम्म disabled हुन्छ। |
| extension asset denied | current mounted session को API 2 asset-read consent जाँच्नुहोस्। extension स्थापना मनपरी file/history पढ्ने अनुमति होइन। |

[प्रदायक](providers.md), [एकीकरण](integrations.md) र [विस्तार](extensions.md) हेर्नुहोस्।

## इतिहास, pending request र सफाइ {#history-and-requests}

full-history search हाल loaded transcript row मा सीमित छैन। display filter ले नमेटी सामग्री लुकाउँछ; search, compaction, technical cleanup र deletion छुट्याउन [इतिहास](history.md) प्रयोग गर्नुहोस्।

pending-request recovery अपूर्ण भए CodeNomad ले coverage नभएकोलाई खाली लाम नठानी ज्ञात queue र answer draft राख्छ। लगातार दुई अपूर्ण recovery पछि यसले परियोजना, कारण, फोल्डर र प्रभावित सत्रको नाम दिँदै एक पटक चेतावनी दिन्छ; चेतावनी **परियोजना र ट्याबहरू** सूचना वर्गमा पर्छ (पूर्वनिर्धारित रूपमा स्क्रिनमा र इतिहासमा; **सेटिङहरू → सूचनाहरू** हेर्नुहोस्)। liveness check ले अस्थायी failure retry गर्छ। compaction-सम्बन्धी deferral request रद्द भएको होइन। draft राख्नुहोस्, service connection जाँच्नुहोस् र फेरि उत्तरअघि current request state प्रयोग गर्नुहोस्।

cancelled वा partial cleanup मा अर्को deletion अघि progress/receipt पढ्नुहोस्। cancel ले dispatched batch undo गर्दैन। native database सम्पादन गरी history मर्मत नगर्नुहोस्। Mission uncertainty मा अर्को run बनाउने वा automatic replay को सट्टा **अवस्था जाँच गर्नुहोस्**/refresh recovery प्रयोग गर्नुहोस्; [मिसन](missions.md) ले restart र lifetime सीमा बताउँछ।

## log र सुरक्षित निदान {#diagnostics}

1. स्थिति हेर्न **उदाहरण जानकारी (Instance Info)** खोल्नुहोस्; **सर्भर लगहरू देखाउनुहोस्** ले उपलब्ध output देखाउँछ।
2. **प्राथमिकताहरू → OpenCode** मा थप विवरण चाहिँदा मात्र अभिप्रेत **पूर्वनिर्धारित लग स्तर** रोज्नुहोस्। standalone logging मा [server CLI logging विकल्प](server.md) प्रयोग गर्नुहोस्।
3. **सेटिङहरू → जानकारी → निदान (Diagnostics)** खोली **बग रिपोर्ट गर्नुहोस्**, **क्लिपबोर्डमा प्रतिलिपि गर्नुहोस्** वा **.txt डाउनलोड गर्नुहोस्** प्रयोग गर्नुहोस्।

logging विवरणले path, output र application data देखाउन सक्छ। log/capture साझा अघि credential, pairing link, network address, private path र conversation content redact गर्नुहोस्। पूर्ण diagnostic report मा path/address हुन्छन्; prefilled bug form ले जानाजानी समावेश गर्दैन। [सहयोग](support.md#report-a-bug) हेर्नुहोस्।
