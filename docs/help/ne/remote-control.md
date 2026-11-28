# Remote Control

Remote Control ले paired browser वा desktop client लाई inbound network port नखोली चलिरहेको CodeNomad backend प्रयोग गर्न दिन्छ। server password, non-loopback `--host` वा VPN चाहिँदैन। यो [प्रत्यक्ष जडान](remote-access.md) बाट अलग पहुँच मार्ग हो।

## सुरु र pair गर्नुहोस् {#start-and-pair}

1. host मा **सेटिङहरू → रिमोट पहुँच** खोल्नुहोस्।
2. **रिमोट कन्ट्रोल सुरु गर्नुहोस्** रोज्नुहोस्। **रिमोट जडानका लागि तयार** पर्खनुहोस्; पहिलो प्रयोगमा tunnel identity र certificate तयार गर्न समय लाग्न सक्छ।
3. **अर्को उपकरण जडान गर्नुहोस्** मा QR scan वा **लिंक प्रतिलिपि गर्नुहोस्** रोजेर त्यो one-use link अभिप्रेत device मा खोल्नुहोस्।
4. paired browser को site data राख्नुहोस्। backend चल्दा reconnect गर्न tunnel address फेरि खोल्नुहोस्।

link **पाँच मिनेट** मान्य हुन्छ र **एकपटक** सफल हुन्छ। credential झैं लिनुहोस्: प्रयोग गर्ने जोकोही paired device बन्न सक्छ। code URL fragment मा हुन्छ, query string मा होइन। **नयाँ जोडी लिंक बनाउनुहोस्** ले अघिल्लो unused link तुरुन्त अमान्य गर्छ। backend shutdown ले बाँकी pairing link रद्द गर्छ; Stop र tunnel failure ले tunnel link रद्द गर्छन्।

अर्को डेस्कटपमा CodeNomad खोल्नुहोस् र जोडी बनाउने लिङ्क यो फिल्डमा टाँस्नुहोस्: **सेटिङहरू → सर्भरहरू → सर्भरको ठेगाना वा लिङ्क**।

फेरि जोडी बनाउन सर्भर वा परियोजनाको जडान फाराममा नयाँ लिङ्क टाँस्नुहोस्।

## direct HTTPS मार्फत pair गर्नुहोस् {#direct-https}

tunnel block भएको तर backend विश्वसनीय HTTPS मार्फत पुग्न सकिने अवस्थामा, जस्तै वास्तविक certificate भएको reverse proxy पछाडि, device हरू त्यो ठेगानामा pair गर्न सक्छन्। योग्य ठेगानाहरू यस backend का आफ्नै HTTPS ठेगाना र `CODENOMAD_ALLOWED_ORIGINS` मा भएका HTTPS origin हुन् ([अनुमति प्राप्त ओरिजिनहरू](remote-access.md#upgrading) हेर्नुहोस्); loopback नाम र plain HTTP कहिल्यै pair हुँदैनन्। रिमोट कन्ट्रोल सुरु गर्नु पर्दैन।

1. host मा **सेटिङहरू → रिमोट पहुँच → रिमोट कन्ट्रोल** खोल्नुहोस्।
2. **प्रत्यक्ष HTTPS जोडी** अन्तर्गत, धेरै भए **HTTPS ठेगाना** छान्नुहोस्, अनि **HTTPS जोडी लिंक बनाउनुहोस्** छान्नुहोस्।
3. tunnel link जस्तै device मा link खोल्नुहोस्। अर्को पृष्ठबाट पनि लिंक खोल्न सक्नुहुन्छ।

link मा उही पाँच मिनेट र एकपटक प्रयोगका नियम लागू हुन्छन् र यसले unused link प्रतिस्थापन गर्छ; बारम्बार गलत code rate-limit हुन्छन्। reverse proxy ले विश्वसनीय TLS terminate गर्नुपर्छ, मूल `Host` र `Origin` header पठाउनुपर्छ, र loopback वा सुरक्षित network मार्फत backend पुग्नुपर्छ।

यस्तो device आफ्नो HTTPS ठेगानाबाट मात्र जोडिन्छ, tunnel बाट कहिल्यै होइन, र **जोडिएका उपकरणहरू** ले उसको नामतल त्यो ठेगाना देखाउँछ। रिमोट कन्ट्रोल रोक्दा link रद्द हुँदैन र यी device disconnect हुँदैनन्; **हटाउनुहोस्**, 30 दिन प्रयोग नहुनु, 32-device सीमा वा configuration बाट ठेगाना हटाउँदा तिनको पहुँच अन्त्य हुन्छ। त्यो ठेगानामा revoke वा expire भएको device credential पठाउने browser server password मा फर्कन सक्दैन: फेरि pair गर्नुहोस्, वा password ले sign in गर्न site data मेटाउनुहोस्।

[उपलब्ध सुविधाहरू](#remote-surface) मा SideCar सामग्रीका लागि प्रत्यक्ष HTTPS को अपवाद हेर्नुहोस्। होस्टको प्रोक्सीबाट पनि जोडी बनाउँदा loopback अधिकार पाइँदैन।

## paired device व्यवस्थापन {#paired-devices}

1. host मा **सेटिङहरू → रिमोट पहुँच → रिमोट कन्ट्रोल** फर्कनुहोस्।
2. **जोडिएका उपकरणहरू** र तिनको **अन्तिम पटक:** समय समीक्षा गर्नुहोस्। हरेक device लाई त्यसलाई pair गर्ने platform र browser अनुसार नाम दिइन्छ, जस्तै `iPhone · Safari`।
3. अब जोडिन नहुने उपकरणका लागि **हटाउनुहोस्** रोज्नुहोस्। **पहुँच हटाउन बाँकी** देखिएमा, होस्ट पुनः सुरु गर्नुअघि फेरि **हटाउनुहोस्** रोज्नुहोस्।

revocation ले हालका HTTP/SSE जडान र भावी पहुँच दुवै अन्त्य गर्छ। पहुँच फर्काउन नयाँ link बाट pair गर्नुहोस्। device **30 दिन प्रयोग नभएपछि** expire हुन्छ। **32-device सीमा** मा नयाँ pairing ले सबैभन्दा पुरानो last-seen device बदल्छ र त्यसका जडान बन्द गर्छ।

site data खाली, browser profile switch वा private browsing गर्दा पुनःpair चाहिन सक्छ।

direct-access password बदल्दा device revoke **हुँदैनन्**। **रिमोट कन्ट्रोल रोक्नुहोस्** ले tunnel disconnect गर्छ तर paired-device सूची राख्छ; authorization हटाउन **हटाउनुहोस्** प्रयोग गर्नुहोस्।

### आफ्नो ठाउँ नगुमाई पुनःpair {#re-pair}

1. client ले **यो उपकरण फेरि जोड्नुहोस्** देखाए त्यो पृष्ठ खुलै राख्नुहोस्।
2. होस्टमा पहिलेकै जडानका लागि नयाँ लिङ्क बनाउनुहोस्: टनेलका लागि **नयाँ जोडी लिंक बनाउनुहोस्** रोज्नुहोस्, वा **प्रत्यक्ष HTTPS जोडी** मा पहिलेकै **HTTPS ठेगाना** छानेर **HTTPS जोडी लिंक बनाउनुहोस्** रोज्नुहोस्। लिङ्क उही क्लाइन्ट ब्राउजर वा प्रोफाइलमा खोल्नुहोस्। छुट्टै रिमोट सञ्झ्यालले आफ्नो भण्डारण पुनः प्रयोग गर्छ।
3. पर्खिरहेको पृष्ठमा फर्केर **जडान जाँच्नुहोस्** रोज्नुहोस्; पृष्ठमा फेरि focus आउँदा पनि यसले फेरि जाँच्छ।

recovery ले खुला पृष्ठ र मस्यौदा जोगाउँछ; असफल कार्य replay गर्दैन। retry अघि send, answer वा delete लागू भयो कि जाँच्नुहोस्। direct-access password ले Remote Control pairing पुनःप्राप्त गर्न सक्दैन।

## उपलब्धता र आयु {#lifetime}

| कार्य/अवस्था | असर |
| --- | --- |
| Remote Control सुरु | यस backend लाई जोड्छ र भावी launch का लागि चयन सम्झिन्छ। |
| remote browser बन्द | host backend रोक्दैन वा device revoke गर्दैन। |
| Remote Control रोक्ने | tunnel पहुँच disconnect र automatic launch-resume हटाउँछ; device record राख्छ। |
| backend shutdown / अन्तिम desktop window बन्द भई app quit | Remote Control offline हुन्छ। shared OpenCode सेवा चलिरहन सक्छ, तर रोकिएको backend बाट यो UI दिन सक्दैन। |
| Remote Control started छोडेपछि launch | नयाँ pairing link नदिई background मा reconnect हुन्छ। कहिल्यै start नगरिएका installation आफैं enabled हुँदैनन्। |

automatic launch-resume प्रति configuration directory एउटा backend मा सीमित छ। थप tunnel क्षमताका लागि उही configuration मा प्रतिस्पर्धी host नचलाउनुहोस्। desktop exit पछि पनि पुग्नुपर्ने host का लागि छुट्टै व्यवस्थापित [standalone server](server.md) राख्नुहोस्; Remote Control स्वतन्त्र daemon होइन।

## उपलब्ध र अनुपलब्ध सतह {#remote-surface}

paired device ले समान ownership जाँचअन्तर्गत सामान्य project/conversation API प्रयोग, prompt पठाइ, फाइल निरीक्षण र permission/Form उत्तर दिन सक्छन्। pairing शक्तिशाली पहुँच हो, read-only sharing link होइन। tunnel ले host भित्र traffic forward गरे पनि loopback अधिकार कहिल्यै दिँदैन।

| सतह | Remote Control मार्फत |
| --- | --- |
| सामान्य authenticated UI, workspace, कुराकानी र SSE | paired device लाई उपलब्ध। |
| password login/logout, password परिवर्तन, local token bootstrap | अनुपलब्ध; direct authentication disabled भए पनि device credential चाहिन्छ। |
| Remote Control status | paired device ले पढ्न सक्छ; management अनुपलब्ध। Start/Stop, pairing सिर्जना, device सूची र revocation host access path मै रहन्छन्। |
| बचत गरिएका सर्भर र ब्याकएन्ड रिले | सुविधा र होस्टको क्षमताले अनुमति दिँदा प्रमाणीकृत रिमोट क्लाइन्टहरूले होस्टमा बचत भएका सबै सर्भर प्रयोग/व्यवस्थापन गर्न सक्छन्। नयाँ सर्भर पासवर्ड वा जोडी बनाउने लिङ्कका लागि रिमोट कन्ट्रोल वा HTTPS चाहिन्छ, साधारण LAN HTTP होइन। [बचत भएका सर्भर](remote-access.md#saved-servers) हेर्नुहोस्। |
| desktop remote window र window proxy | होस्टमा मात्र (`/api/remote-proxy/`)। |
| SideCar सामग्री र WebSocket (`/sidecars/`) | टनेलबाट उपलब्ध छैन। Loopback प्रयोग गर्नुहोस् वा होस्टमा [SideCar को प्रत्यक्ष HTTPS पहुँच](browser-sidecars.md#register-sidecar) खोल्नुहोस्। |
| SideCar दर्ता (`/api/sidecars`) | जोडी बनाइएका उपकरण र प्रमाणीकृत प्रत्यक्ष क्लाइन्टलाई उपलब्ध छ। |
| वेब पूर्वावलोकन सामग्री | [सत्र ब्राउजर खोल्नुहोस्](browser-sidecars.md#session-browser) |
| automation bridge | अनुपलब्ध (`/api/opencode-plugin/`)। native desktop क्षमता browser क्षमता बन्दैनन्। |
| WebSocket upgrade | वेब पूर्वावलोकनका लागि र जोडिएका उपकरणमा [प्रत्यक्ष आवाज कुराकानी](voice.md#conversation) का लागि उपलब्ध। |

होस्टमा सीमित प्रोक्सी/WebSocket र Remote Control व्यवस्थापन (`/api/remote-control/`) का लागि होस्टमा loopback जडान प्रयोग गर्नुहोस्। प्रत्यक्ष LAN पहुँचमा पनि यी कार्यलाई loopback चाहिन्छ; [अनुमति प्राप्त ओरिजिनहरू](remote-access.md#upgrading)।

## Relay र गोपनीयता {#relay-privacy}

CodeNomad ले [OpenTunnel](https://github.com/anomalyco/opentunnel) प्रयोग गरी machine को shared default tunnel identity मा एउटा random route लिन्छ।

TLS CodeNomad backend मा terminate हुन्छ। relay ले ciphertext forward गर्छ र app सामग्री पढ्न सक्दैन, तर hostname, connection timing र traffic size देख्न सक्छ। tunnel certificate/private key host मै रहन्छन्। host tunnel storage र CodeNomad configuration लाई credential झैं सुरक्षित गर्नुहोस्; अनुमान गर्न नसकिने ठेगाना authorization होइन।

`CODENOMAD_REMOTE_CONTROL_API` ले self-hosted OpenTunnel API रोज्छ; unset हुँदा hosted service प्रयोग हुन्छ। यसले tunnel deployment बदल्छ, pairing आवश्यकता वा blocked सतह होइन। credential र निदान व्यवस्थापनका लागि [सुरक्षा](security.md) हेर्नुहोस्।

## प्रशासक नीति {#administrator-policy}

प्रशासकले कम्प्युटरका सबै प्रयोगकर्ताका लागि रिमोट कन्ट्रोल बन्द गर्न सक्छ: वातावरण चर `CODENOMAD_REMOTE_CONTROL=disabled` सम्पूर्ण प्रणालीमा सेट गर्नुहोस्, त्यसपछि CodeNomad पुनः सुरु गर्नुहोस्। ब्याकइन्डले कहिल्यै टनेल जोड्दैन, **रिमोट कन्ट्रोल सुरु गर्नुहोस्** र जोड्ने लिङ्क अस्वीकार गर्छ र सुरु हुँदा पुनः जडान गर्दैन; सेटिङहरूमा **प्रशासकद्वारा निष्क्रिय** देखिन्छ। पहिले जोडिएका उपकरणहरू जडान हुन सक्दैनन् र रद्द गर्न सकियोस् भनेर सूचीमै रहन्छन्। सेट नगरिएको वा खाली भए कुनै नीति लागू हुँदैन; अरू कुनै मान, खाली ठाउँ मात्र भए पनि, ले ब्याकइन्ड सुरु हुन दिँदैन।
