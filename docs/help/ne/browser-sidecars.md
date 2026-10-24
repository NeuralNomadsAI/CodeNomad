# ब्राउजर पूर्वावलोकन र SideCars

## सत्र ब्राउजर खोल्नुहोस् {#session-browser}

1. कुराकानी toolbar मा **वेब पूर्वावलोकन खोल्नुहोस्** रोज्नुहोस्।
2. credential नभएको `http://` वा `https://` **पूर्वावलोकन URL** भर्नुहोस्, त्यसपछि **पूर्वावलोकन खोल्नुहोस्** रोज्नुहोस्। नेभिगेट, refresh र Back/Forward का लागि toolbar प्रयोग गर्नुहोस्।
3. chat मा फर्कन पूर्वावलोकनको close बटन प्रयोग गर्नुहोस्। जारी राख्न त्यही कुराकानीमा फेरि खोल्नुहोस्।

कुराकानीमा `localhost` वा `127.0.0.1` लिङ्क क्लिक गर्दा हरेक client मा त्यो सत्रको पूर्वावलोकनमा स्वतः खुल्छ: सर्भरले loopback पूर्वावलोकन proxy गर्छ, त्यसैले अर्को मेसिनको सामान्य browser बाट पनि काम गर्छ। Proxy गरिएका loopback पूर्वावलोकन app सँग same-origin चल्छन्; बाह्य लिङ्कहरू अझै नयाँ browser ट्याबमा खुल्छन्।

प्रत्येक पूर्वावलोकन आफ्नो परियोजना फोल्डर र सत्रको हो। कुराकानी, परियोजना, Info वा chat बदल्दा स्पष्ट खोलिएको नेटिभ guest को live document/history नहटाई लुक्छ। लुकेका guest automation target होइनन्। परियोजना/विन्डो बन्द वा renderer restart गर्दा live document सकिन्छ।

सुरक्षित इतिहास startup/session चयनमा होइन, त्यस सत्रको ब्राउजर स्पष्ट फेरि खोल्दा मात्र फर्किन्छ। यसले URL र cursor राख्छ, नपठाइएका form, DOM, POST body वा JavaScript memory होइन। इतिहास प्रति सत्र 32 URL र साझा layout budget मा सीमित छ; पुराना प्रविष्टि काटिन सक्छन्। URL पुनर्स्थापनाले नयाँ page load गर्न सक्छ; यो transaction replay होइन।

## साझा sign-in र automation सीमा {#signins-automation}

एउटै desktop engine र profile/configuration दायरामा नेटिभ पूर्वावलोकनले project/session भर cookie, sign-in र site storage साझा गर्छन्, trusted CodeNomad renderer बाट अलग। एउटामा site logout गर्दा त्यही store का अरू पूर्वावलोकन प्रभावित हुन्छन्। document, form, session storage, navigation history र automation attachment सत्रकै स्वामित्वमा रहन्छन्। iframe पूर्वावलोकन पूर्ण साझा native browser profile होइनन्।

| क्लाइन्ट | पूर्वावलोकन कार्यान्वयन | Agent browser automation | Mobile template |
| --- | --- | --- | --- |
| समर्थित desktop प्लेटफर्ममा Electron | नेटिभ Chromium guest | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | Android/Chromium पहिचान, touch र density emulation |
| Windows Tauri | नेटिभ WebView2 child | देखिने स्वामित्वभित्रको session पूर्वावलोकनमा समर्थित | Android/Chromium पहिचान, touch र density emulation |
| macOS/Linux Tauri | sandbox भएको iframe | नेटिभ browser automation छैन | आयाम मात्र |
| सामान्य browser/remote दृश्य | iframe fallback | स्थानीय native preview target छैन | आयाम मात्र |

नेटिभ automation desktop startup मै तयार हुन्छ र open, navigate, snapshot, screenshot र page action (click, type, select, hover, drag, scroll, key press र text पर्खने) का लागि session-bound `codenomad.browser` tool प्रयोग गर्छ। tool उपलब्धता हरेक विन्डोको अनुमति होइन: execution ले स्वामी backend, native capability, session र visible target जाँच्छ। बीचमै पृष्ठ लुकेको, बदलिएको वा अर्कै ठाउँ नेभिगेट भएको action अर्को पृष्ठमा पठाइँदैन, अस्वीकार गरिन्छ; कुनै action स्वतः दोहोर्‍याइँदैन। पृष्ठ सामग्री अविश्वसनीय नै हुन्छ। target ले embedding निषेध गर्दा iframe असफल हुन सक्छ; सुरक्षा कमजोर पार्नुको सट्टा बाह्य browser प्रयोग गर्नुहोस्।

## छ viewport template मध्ये एक रोज्नुहोस् {#templates}

1. पूर्वावलोकनको viewport menu खोल्नुहोस्।
2. तलको template चयन गर्नुहोस्। portrait/landscape प्रविष्टि सोझै प्रयोग गर्नुहोस्; छुट्टै rotate नियन्त्रण छैन।
3. mobile emulation प्रवेश/परिवर्तन वा dimensions-only template मा फर्कँदा native reload हुन्छ भन्ने बुझ्नुहोस्।

| Template | CSS viewport |
| --- | --- |
| Responsive viewport | उपलब्ध पूर्वावलोकन ठाउँ |
| Desktop viewport | 1440 × 900 |
| Tablet viewport | 768 × 1024 |
| Tablet landscape | 1024 × 768 |
| Mobile viewport | 390 × 844 |
| Mobile landscape | 844 × 390 |

नेटिभ mobile template ले स्वामित्वको guest मा मात्र Android/Chromium पहिचान, orientation, touch र DPR 2.75 सेट गर्छन्। responsive/desktop/tablet मा फर्कँदा override हटेर reload हुन्छ। iframe fallback ले आकार मात्र बदल्छ। यी पुनरुत्पादनयोग्य layout सन्दर्भ हुन्, Safari/Firefox emulation वा phone keyboard, browser/system bar वा mobile OS text setting को simulation होइनन्। reload ले नपठाइएको page state हटाउन सक्ने भएकाले template बदल्नुअघि पृष्ठ काम बचत गर्नुहोस्।

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

SideCar sandbox गरिएको पूर्वावलोकन होइन, CodeNomad को विश्वसनीय विस्तार हो: यसको पृष्ठ CodeNomad कै origin मा चल्छ, त्यसैले यसका script ले तपाईंको sign-in भएको पहुँचसहित CodeNomad प्रयोग गर्न सक्छन्। जसको code मा विश्वास छ ती सेवा मात्र दर्ता गर्नुहोस्। CodeNomad ले आफ्नै sign-in cookie सेवामा पठाउँदैन, तर सेवाका आफ्नै cookie राखिन्छन्। Remote Control ले SideCar application proxy traffic दिँदैन; [रिमोट पहुँच](remote-access.md) र [Remote Control](remote-control.md) मा भएको उपयुक्त direct-access मार्ग प्रयोग गर्नुहोस्।

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
