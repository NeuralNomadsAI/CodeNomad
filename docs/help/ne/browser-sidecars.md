# ब्राउजर पूर्वावलोकन र SideCars

## सत्र ब्राउजर खोल्नुहोस् {#session-browser}

1. कुराकानी toolbar मा **वेब पूर्वावलोकन खोल्नुहोस्** रोज्नुहोस्।
2. credential नभएको `http://` वा `https://` **पूर्वावलोकन URL** भर्नुहोस्, त्यसपछि **पूर्वावलोकन खोल्नुहोस्** रोज्नुहोस्। नेभिगेट, refresh र Back/Forward का लागि toolbar प्रयोग गर्नुहोस्।
3. chat मा फर्कन पूर्वावलोकनको close बटन प्रयोग गर्नुहोस्। जारी राख्न त्यही कुराकानीमा फेरि खोल्नुहोस्।

कुराकानीमा `localhost` वा `127.0.0.1` लिङ्क क्लिक गर्दा वेब पूर्वावलोकन उपलब्ध भएका client मा त्यही सत्रको वेब पूर्वावलोकनमा खुल्छ। Remote Control मा host ले वेब पूर्वावलोकन बन्द राखेको अवस्थामा, वा अन्य कारणले वेब पूर्वावलोकन उपलब्ध नभएको client मा, यस्ता लिङ्कले सामान्य browser व्यवहार नै राख्छन्। Ctrl+क्लिक (macOS मा ⌘+क्लिक) वा मध्य-क्लिकले लिङ्क browser मा खोल्छ। वास्तविक भण्डारण उपलब्ध नहुने sandbox पूर्वावलोकन फ्रेमभित्र पेजले हालको पेज लोडका लागि मेमोरीमा `localStorage`, `sessionStorage` र `document.cookie` पाउँछ; आफैँ खोलिएको प्रति-टोकन पूर्वावलोकन host ले आफ्नो वास्तविक भण्डारण राख्छ।

प्रत्येक पूर्वावलोकन आफ्नो परियोजना फोल्डर र सत्रको हो। कुराकानी, परियोजना, Info वा chat बदल्दा स्पष्ट खोलिएको नेटिभ guest को live document/history नहटाई लुक्छ। लुकेका guest automation target होइनन्। परियोजना/विन्डो बन्द वा renderer restart गर्दा live document सकिन्छ।

सुरक्षित इतिहास startup/session चयनमा होइन, त्यस सत्रको ब्राउजर स्पष्ट फेरि खोल्दा मात्र फर्किन्छ। यसले URL र cursor राख्छ, नपठाइएका form, DOM, POST body वा JavaScript memory होइन। इतिहास प्रति सत्र 32 URL र साझा layout budget मा सीमित छ; पुराना प्रविष्टि काटिन सक्छन्। URL पुनर्स्थापनाले नयाँ page load गर्न सक्छ; यो transaction replay होइन।

रिमोट प्रोजेक्टका ट्याबहरूले त्यस प्रोजेक्टको CodeNomad सर्भरमार्फत पूर्वावलोकन लोड गर्छन्। ठेगाना पट्टी र सुरक्षित इतिहासले अनुप्रयोगको URL देखाउँछन्। पूर्वावलोकन वा प्रोजेक्ट ट्याब बन्द गर्दा, सर्भर विच्छेद/हटाउँदा वा बाहिरिँदा सक्रिय पृष्ठ र उसका जडानहरू समाप्त हुन्छन्; फेरि खोल्दा सुरक्षित ठेगाना र इतिहासबाट पुनः लोड हुन्छ। सर्भरका sign-in विवरण ब्याकएन्डमै रहन्छन्; प्रोक्सी गरिएका अनुप्रयोग cookies फिल्टर हुन्छन्। पूर्वावलोकनका आन्तरिक लोडिङ ठेगानाहरू CodeNomad भित्रै राख्नुहोस्।

नेटिभ रिमोट पूर्वावलोकनले आन्तरिक लोडिङ ठेगाना निजी राख्न सन्दर्भ मेनु, लिङ्क तान्ने, मुद्रण, पपअप, डाउनलोड, पृष्ठका संवाद र अनुमति अनुरोध बन्द गर्छ। बन्द गर्नुअघि पृष्ठको काम सुरक्षित गर्नुहोस्।

## साझा sign-in र automation सीमा {#signins-automation}

एउटै desktop engine र profile/configuration दायरामा नेटिभ पूर्वावलोकनले project/session भर cookie, sign-in र site storage साझा गर्छन्, trusted CodeNomad renderer बाट अलग। एउटामा site logout गर्दा त्यही store का अरू पूर्वावलोकन प्रभावित हुन्छन्। document, form, session storage, navigation history र automation attachment सत्रकै स्वामित्वमा रहन्छन्। iframe पूर्वावलोकन पूर्ण साझा native browser profile होइनन्।

| क्लाइन्ट | पूर्वावलोकन कार्यान्वयन | Agent browser automation | Mobile template |
| --- | --- | --- | --- |
| समर्थित desktop प्लेटफर्ममा Electron | नेटिभ Chromium guest; OAuth पप-अप, डाउनलोड र संवाद | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | Android/Chromium पहिचान, touch र density emulation |
| Windows Tauri | नेटिभ WebView2 child; OAuth पप-अप, डाउनलोड र संवाद | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | Android/Chromium पहिचान, touch र density emulation |
| macOS Tauri (14+) | नेटिभ WKWebView child; OAuth पप-अप, डाउनलोड र संवाद | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | WebKit मोबाइल पहिचान र CSS भ्युपोर्ट; नेटिभ इनपुट सीमा |
| Linux Tauri | नेटिभ WebKitGTK child; OAuth पप-अप, डाउनलोड र संवाद | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | WebKit मोबाइल पहिचान र CSS भ्युपोर्ट; नेटिभ घनत्व/इनपुट सीमा |
| सामान्य browser/remote दृश्य | iframe fallback | स्थानीय native preview target छैन | आयाम मात्र |

सबै नेटिभ desktop host मा session-bound `codenomad.browser` ले पूर्वावलोकन खोल्ने, नेभिगेट गर्ने, snapshot/screenshot लिने र click, type, select, hover, drag, scroll, key तथा text-wait action चलाउँछ। execution ले स्वामी backend, native capability, session र देखिने target जाँच्छ। लुकेको, बदलिएको वा नेभिगेट भएको target अस्वीकार हुन्छ; action स्वतः दोहोरिँदैन। पृष्ठ सामग्री अविश्वसनीय रहन्छ। iframe रोक्ने साइटका लागि बाह्य browser प्रयोग गर्नुहोस्।

नेटिभ पूर्वावलोकन म्यानुअल वा agent बाट खुल्छन्, पुनःसुरुवातपछि sign-in राख्छन् र नेटिभ Back/Forward इतिहास प्रयोग गर्छन्। स्थानीय menu/dialog ले पूर्वावलोकन लुकाउँछन्। नेटिभ मोडमा element comment उपलब्ध छैन। WebKit ले script-created closed shadow root पढ्छ; declarative closed root अपारदर्शी रहन्छ। macOS को पहिलो hover ले pointerenter छुटाउन सक्छ र ⌘A ले A keydown बिना नेटिभ चयन गर्छ। GTK clipboard read का लागि स्पष्ट Ctrl+V प्रयोग हुन्छ; write र नेटिभ copy/paste चल्छन्।

नेटिभ पप-अपले पूर्वावलोकनका साइन-इन साझा गर्छन्, `opener`/`postMessage` कायम राख्छन् र मूल पृष्ठसँगै बन्द हुन्छन्। लेखिएका वा पुनर्स्थापित ठेगानामा परिचयपत्ररहित HTTP(S) मात्र अनुमति छ; साइटले खाली र उही मूलका blob कागजात पनि खोल्न सक्छन्। फाइल र एप स्किम रोकिएका छन्। डाउनलोडहरू सुरक्षित अद्वितीय नाममा Downloads मा राखिन्छन्, फाइल मेटिँदैन र स्वतः खोलिँदैन। क्यामेरा, माइक्रोफोन, स्थान र सूचना अस्वीकार गरिन्छन्; वर्गीकृत अनुमतिमा सहमति मागिन्छ र अज्ञात अनुरोधमा त्रुटि देखाइन्छ। Tauri र Electron मा `alert`/`confirm`/`prompt` उपलब्ध छन्; Electron को prompt संवाद पूर्वावलोकनका मुख्य पृष्ठ, पप-अप र उप-फ्रेममा उपलब्ध छ। उपकरण र स्क्रिन छनोट सूचीका उपलब्ध प्रविष्टिहरू स्क्रोल गर्न सकिन्छ। अन्य API इन्जिन र हार्डवेयरमा निर्भर छन्।

साइटले नेटिभ पप-अप बन्द गर्दा पुष्टि माग्न सक्छ। Linux मा पोइन्टर लकको सहमति सम्बन्धित विन्डोको माथि देखिन्छ। [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277) बाट प्रभावित WebKitGTK संस्करणहरू, 2.52.6 सहित, मा सुरक्षाका कारण ड्रप गरिएका फाइलको पहुँच रोकिएको हुन्छ; अपलोड गर्न पृष्ठको फाइल छनोट प्रयोग गर्नुहोस्। सम्बन्धित CodeNomad विन्डो बन्द वा पुनः लोड गर्नुअघि पृष्ठको काम सुरक्षित गर्नुहोस्।

Tauri macOS/Linux मा पूर्वावलोकनलाई फोकस गरेर ⌘/Ctrl सँग +, − वा 0 वा एपको जुम मेनु प्रयोग गरी जुम बदल्नुहोस्। फोकस अन्यत्र हुँदा यी मेनु कार्यहरूले एपको जुम बदल्छन्।

## छ viewport template मध्ये एक रोज्नुहोस् {#templates}

1. पूर्वावलोकनको viewport menu खोल्नुहोस्।
2. तलको template चयन गर्नुहोस्। portrait/landscape प्रविष्टि सोझै प्रयोग गर्नुहोस्; छुट्टै rotate नियन्त्रण छैन।
3. Electron र Windows Tauri मा mobile emulation प्रवेश/परिवर्तन वा dimensions-only template मा फर्कँदा native reload हुन्छ भन्ने बुझ्नुहोस्।

| Template | CSS viewport |
| --- | --- |
| Responsive viewport | उपलब्ध पूर्वावलोकन ठाउँ |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 768 × 1024 |
| Tablet landscape | 1024 × 768 |
| Mobile viewport | 390 × 844 |
| Mobile landscape | 844 × 390 |

Electron र Windows Tauri मा mobile template ले स्वामित्वको guest मा मात्र Android/Chromium पहिचान, orientation, touch र DPR 2.75 सेट गर्छन्। responsive/desktop/tablet मा फर्कँदा override हटेर reload हुन्छ। macOS/Linux Tauri ले HTTP र JavaScript मा सामान्य WebKit मोबाइल पहिचान लागू गर्छन् र एपको zoom/DPI बाट स्वतन्त्र CSS भ्युपोर्ट मिलाउँछन्; template परिवर्तन वा reset गर्दा reload हुन्छ। उपलब्ध हुँदा macOS ले नेटिभ DPR 2.75 प्रयोग गर्छ; GTK घनत्व फिट गर्ने zoom र मनिटरअनुसार हुन्छ। screen, platform, pointer/hover media र अधिकतम touch point मा नेटिभ desktop मान रहन्छन्। GTK मोबाइल click ले नेटिभ touch र mouse compatibility event दिन्छ; macOS मा mouse input रहन्छ। iframe fallback ले आकार मात्र बदल्छ। यी layout सन्दर्भ हुन्; फोन keyboard, system bar र मोबाइल text setting दायराबाहिर छन्। reload ले नपठाइएको page state हटाउन सक्ने भएकाले template बदल्नुअघि पृष्ठ काम बचत गर्नुहोस्।

## SideCar दर्ता गर्नुहोस् {#register-sidecar}

1. CodeNomad backend host मा `127.0.0.1:<port>` मा सुन्ने गरी web tool छुट्टै सुरु गर्नुहोस्।
2. **सेटिङहरू → SideCars** खोल्नुहोस्। **नाम** र **पोर्ट** भर्नुहोस्; निकालिएको **आधार मार्ग (Base path)** (`/sidecars/<id>`) जाँच्नुहोस्।
3. upstream सेवासँग मिल्ने **प्रोटोकल** सेट गरी **प्रिफिक्स मोड** रोज्नुहोस्।
4. **SideCar थप्नुहोस्** रोजेर गृह पृष्ठको **SideCar खोल्नुहोस्** बाट ट्याब खोल्नुहोस्।

| चयन | ठ्याक्कै असर |
| --- | --- |
| HTTPS (फारमको पूर्वनिर्धारित विकल्प) | CodeNomad ले upstream लाई `https://127.0.0.1:<port>` बाट जोड्छ। |
| HTTP | CodeNomad ले upstream लाई `http://127.0.0.1:<port>` बाट जोड्छ। यसले सार्वजनिक CodeNomad जडानको TLS सेटिङ बदल्दैन। |
| प्रिफिक्स हटाउनुहोस् (पूर्वनिर्धारित) | `/sidecars/<id>/path` upstream मा `/path` का रूपमा पठाइन्छ। |
| प्रिफिक्स राख्नुहोस् | `/sidecars/<id>/path` नबदली upstream पठाइन्छ। सेवाको आफ्नै base path मिलाउनुहोस्। |

दर्ता क्लाइन्टले साझा गर्ने server configuration हो; यसले सेवा स्थापना वा सुरु गर्दैन। port backend host को हो, हेर्ने laptop वा phone को होइन। **चलिरहेको छ** ले पहुँचयोग्यता जनाउँछ, tool application/authentication स्वस्थ छ भन्ने होइन। दर्ता हटाउँदा छुट्टै चलाइएको प्रक्रिया रोकिँदैन। ट्याब बन्द गर्दा पनि रोकिँदैन।

पहुँच नभए backend मा process र port जाँच्नुहोस्। HTML खुले पनि asset/WebSocket असफल भए tool को base path र prefix mode जाँच्नुहोस्। गलत दर्ता चाहेको सेटिङमा फेरि बनाउनुहोस्; proxy त्रुटि छल्न upstream सार्वजनिक नगर्नुहोस्। SideCar अनुप्रयोगले server खाताको अधिकारमा terminal वा फाइल देखाउन सक्छन्; प्रयोगकर्ता र कन्फिगरेसनलाई विश्वास गर्नुपर्छ।

SideCar sandbox गरिएको पूर्वावलोकन होइन, CodeNomad को विश्वसनीय विस्तार हो: यसको पृष्ठ CodeNomad कै origin मा चल्छ, त्यसैले यसका script ले तपाईंको sign-in भएको पहुँचसहित CodeNomad प्रयोग गर्न सक्छन्। जसको code मा विश्वास छ ती सेवा मात्र दर्ता गर्नुहोस्। CodeNomad ले आफ्नै sign-in cookie सेवामा पठाउँदैन, तर सेवाका आफ्नै cookie राखिन्छन्।

SideCar सामग्री (`/sidecars/`) र SideCar WebSocket लाई होस्टमा loopback जडान चाहिन्छ। `/api/sidecars` मार्फत दर्ता जोडी बनाइएका उपकरण र प्रमाणीकृत प्रत्यक्ष LAN क्लाइन्टलाई उपलब्ध छ। सक्रिय पूर्वावलोकन सामग्री (`/previews/`) वैध क्षमता टोकनसहित प्रत्यक्ष LAN पहुँचमा उपलब्ध छ; [Remote Control](remote-control.md#remote-surface) का वेब पूर्वावलोकन सक्षम रहँदा आफ्नो क्षमता टोकनसहित उपलब्ध रहन्छन्। प्रत्यक्ष पहुँचका आवश्यकताका लागि [स्तरोन्नति](remote-access.md#upgrading) हेर्नुहोस्।

## OpenVSCode Server विधि {#openvscode}

1. backend host मा loopback मा बाँधेर Docker चलाउनुहोस्:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. **नाम** `VSCode`, **पोर्ट** `8000`, **प्रोटोकल** `HTTP`, **प्रिफिक्स मोड** **प्रिफिक्स राख्नुहोस्** दर्ता गर्नुहोस्।
3. देखिएको base path `/sidecars/vscode` भएको जाँचेर SideCar खोल्नुहोस्।

यो shell विधिले home directory container मा mount गर्छ; editor लाई कम पहुँच चाहिने भए साँघुरो mount प्रयोग गर्नुहोस्। सेवाको `--server-base-path` दर्तासँग ठ्याक्कै मिल्नुपर्छ। सकिएपछि container छुट्टै रोक्नुहोस्; SideCar मेटाउँदा container वा फाइल हट्दैनन्।

## ttyd terminal विधि {#ttyd}

1. backend host मा loopback मा बाँधिएको writable shell terminal सुरु गर्नुहोस्:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. **नाम** `Terminal`, **पोर्ट** `7681`, **प्रोटोकल** `HTTP`, **प्रिफिक्स मोड** **प्रिफिक्स हटाउनुहोस्** दर्ता गर्नुहोस्।
3. देखाइएको `/sidecars/terminal` base path मा SideCar खोल्नुहोस्।

terminal ttyd सुरु गर्ने खाताको अधिकारमा चल्छ। `zsh` नभए अर्को shell रोज्नुहोस्। ttyd को default बदलेको भए वास्तविक port प्रयोग गर्नुहोस्, र सकिएपछि ttyd छुट्टै रोक्नुहोस्। CodeNomad पहुँच प्रमाणित र सुरक्षित गर्नुहोस्; writable terminal sandbox होइन।
