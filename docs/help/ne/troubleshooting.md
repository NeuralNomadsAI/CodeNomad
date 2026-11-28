# समस्या समाधान

## desktop launch समस्या {#desktop-launch}

### macOS quarantine {#macos-quarantine}

CodeNomad का macOS release हरू Apple द्वारा notarize गरिएका छैनन्, त्यसैले आधिकारिक repository बाट verify गरेको भए पनि download गरिएको प्रतिलिपिको पहिलो launch macOS ले रोक्न सक्छ: यसले **"CodeNomad" Not Opened** (Apple ले malware-मुक्त भएको पुष्टि गर्न सकेन) देखाउन सक्छ, वा app damaged छ भन्न सक्छ।

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

owned worktree वा conversation placement verify गर्न नसके मनपरी path वा native storage सम्पादन गर्नुको सट्टा physical folder स्पष्ट खोल्नुहोस्। force-removing ले uncommitted file नष्ट गर्न सक्छ; connection मर्मतका लागि प्रयोग नगर्नुहोस्।

## OpenCode runtime र WSL {#opencode-runtime}

सुरुवात त्रुटिको संवादमा executable र संस्करण जाँच्न **OpenCode सेटिङहरू खोल्नुहोस्** रोज्नुहोस्; वातावरणका अनुकूलित मानहरूका लागि **उन्नत → वातावरण चरहरू (Environment Variables)** मा जानुहोस्।

1. **प्राथमिकताहरू → OpenCode** खोली **OpenCode संस्करण** card (installed version र running service status), त्यसपछि **OpenCode बाइनरी** अन्तर्गतको selected executable जाँच्नुहोस्।
2. आवश्यक runtime नभए समर्थित installation/update प्रयोग गर्नुहोस्। हालको minimum: **2.4.2**; recommended/qualified संस्करण: **2.4.2**।
3. installed CLI running service भन्दा फरक भए shared service restart गर्ने कि स्पष्ट निर्णय गर्नुहोस्।

**OpenCode सेवा पुनः सुरु गर्नुहोस्** **समस्या समाधान** अन्तर्गत उपलब्ध छ र पुष्टि चाहिन्छ। हरेक connected client को सक्रिय काम interrupt गर्छ, तर session history राख्छ। configuration reload छुट्टै हो: process राख्छ तर loaded Location पुनर्निर्माण र pending question/permission रद्द गर्छ। कुनै हानिरहित refresh होइन।

WSL executable मा अभिप्रेत वितरण र Windows localhost forwarding जाँच्नुहोस्। service lifecycle Linux भित्र चल्छ; CodeNomad ले Windows बाट loopback endpoint पुग्नुपर्छ। service registration/database सम्पादन वा अनुमानित Linux process ID लाई Windows बाट signal नगर्नुहोस्।

## login, TLS र direct connectivity {#login-and-tls}

| लक्षण | सुरक्षित जाँच र पुनःप्राप्ति |
| --- | --- |
| **CodeNomad मा फेरि साइन इन गर्नुहोस्** | पृष्ठ खुलै राखी server username/password भरेर **साइन इन गर्नुहोस्** चयन गर्नुहोस्। recovery ले मस्यौदा राख्न त्यहीं reconnect गर्छ; असफल कार्य replay गर्दैन। |
| server पुगिँदैन | backend चलिरहेको र छापिएको address/actual port प्रयोग भएको जाँच्नुहोस्। |
| certificate name/trust त्रुटि | actual hostname/IP लाई certificate SAN सँग जाँचेर intended CA trust वा valid server certificate स्थापना गर्नुहोस्। TLS verification अक्षम नगर्नुहोस्। |
| direct connection refused | प्रभावकारी HTTP/HTTPS binding, firewall र routing जाँच्नुहोस्। |

runtime password हरेक backend start मा दिनुपर्छ; settings बाट सुरक्षित password रहिरहन्छ। [सुरक्षा](security.md), [TLS/binding नियम](remote-access.md) र [server सन्दर्भ](server.md) हेर्नुहोस्।

## Remote Control pairing {#pairing}

1. host मा **सेटिङहरू → रिमोट पहुँच** खोलेर Remote Control चलिरहेको जाँच्नुहोस्।
2. नयाँ pairing link बनाएर expiry अघि अभिप्रेत device मा खोल्नुहोस्।
3. client मा **यो उपकरण फेरि जोड्नुहोस्** देखिए host बाट pair गरी client मा **जडान जाँच्नुहोस्** चयन गर्नुहोस्।

pairing link single-use र छोटो आयुका हुन्; direct-access password विकल्प होइन। revoked वा inactivity-expired device credential लाई re-pair चाहिन्छ। अन्तिम desktop window बन्द हुँदा backend र Remote Control रोकिन्छ; enabled service अर्को app launch मा फर्किन्छ। host-only अनुपलब्ध सतह र revocation का लागि [Remote Control](remote-control.md) हेर्नुहोस्।

## provider, plugin र extension अवस्था {#providers-and-addons}

- थपेको plugin असफल भयो वा **पुष्टि भएको छैन** देखाउँछ — OpenCode host बाट package नाम, संस्करण र रजिस्ट्री पहुँच जाँच्नुहोस्। plugin tooltip को त्रुटि सन्दर्भ OpenCode लगमा खोज्नुहोस्। निष्क्रिय plugin का लागि पनि **पुष्टि भएको छैन** देखिन्छ।
- स्थापित extension हराएको — panel customization मा यसलाई सक्रिय गर्नुहोस्। installation/replacement पछि explicit activation र required consent नदिँदासम्म disabled हुन्छ।
- **पूरा टाइमलाइन उपलब्ध छैन** — OpenCode लगमा `codenomad-session-pruning` को लोड त्रुटि हेर्नुहोस्।

[प्रदायक](providers.md), [एकीकरण](integrations.md) र [विस्तार](extensions.md) हेर्नुहोस्।

## इतिहास, pending request र सफाइ {#history-and-requests}

full-history search हाल loaded transcript row मा सीमित छैन। display filter ले नमेटी सामग्री लुकाउँछ; search, compaction, technical cleanup र deletion छुट्याउन [इतिहास](history.md) प्रयोग गर्नुहोस्।

cancelled वा partial cleanup मा अर्को deletion अघि progress/receipt पढ्नुहोस्। cancel ले dispatched batch undo गर्दैन। native database सम्पादन गरी history मर्मत नगर्नुहोस्।

## log र सुरक्षित निदान {#diagnostics}

1. **सेटिङहरू → OpenCode → OpenCode लगहरू हेर्नुहोस्** खोल्नुहोस्। छानिएको कार्यान्वयन होस्टको विश्वव्यापी `opencode.log` फाइल `opencode debug paths log` बाट पत्ता लगाइन्छ। अन्तिम बढीमा 128 KiB देखाइन्छ; **रिफ्रेस** ले फेरि पढ्छ।
2. **प्राथमिकताहरू → OpenCode** मा थप विवरण चाहिँदा मात्र अभिप्रेत **पूर्वनिर्धारित लग स्तर** रोज्नुहोस्। standalone logging मा [server CLI logging विकल्प](server.md) प्रयोग गर्नुहोस्। CodeNomad server ले आफ्नो configuration file सँगै (पूर्वनिर्धारित `~/.config/codenomad`) `logs/server.log` मा आफ्नै log पनि राख्छ; अघिल्लो भरिएको file `server.previous.log` हो।
3. **सेटिङहरू → जानकारी → निदान (Diagnostics)** खोली **बग रिपोर्ट गर्नुहोस्**, **क्लिपबोर्डमा प्रतिलिपि गर्नुहोस्** वा **.txt डाउनलोड गर्नुहोस्** प्रयोग गर्नुहोस्।

logging विवरणले path, output र application data देखाउन सक्छ। log/capture साझा अघि credential, pairing link, network address, private path र conversation content redact गर्नुहोस्। पूर्ण diagnostic report मा path/address हुन्छन्; prefilled bug form ले जानाजानी समावेश गर्दैन। [bug report गर्नुहोस्](support.md#report-a-bug) हेर्नुहोस्।
