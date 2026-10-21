# Remote Control

Remote Control ले paired browser वा desktop client लाई inbound network port नखोली चलिरहेको CodeNomad backend प्रयोग गर्न दिन्छ। server password, non-loopback `--host` वा VPN चाहिँदैन। यो [प्रत्यक्ष जडान](remote-access.md) बाट अलग पहुँच मार्ग हो।

## सुरु र pair गर्नुहोस् {#start-and-pair}

1. host मा **सेटिङहरू → रिमोट पहुँच** खोल्नुहोस्।
2. **रिमोट कन्ट्रोल सुरु गर्नुहोस्** रोज्नुहोस्। **रिमोट जडानका लागि तयार** पर्खनुहोस्; पहिलो प्रयोगमा tunnel identity र certificate तयार गर्न समय लाग्न सक्छ।
3. **अर्को उपकरण जडान गर्नुहोस्** मा QR scan वा **लिंक प्रतिलिपि गर्नुहोस्** रोजेर त्यो one-use link अभिप्रेत device मा खोल्नुहोस्।
4. paired browser को site data राख्नुहोस्। backend चल्दा reconnect गर्न tunnel address फेरि खोल्नुहोस्।

link **पाँच मिनेट** मान्य हुन्छ र **एकपटक** सफल हुन्छ। credential झैं लिनुहोस्: प्रयोग गर्ने जोकोही paired device बन्न सक्छ। code URL fragment मा हुन्छ, query string मा होइन। **नयाँ जोडी लिंक बनाउनुहोस्** ले अघिल्लो unused link तुरुन्त अमान्य गर्छ। Stop, backend shutdown र tunnel failure ले बाँकी pairing link रद्द गर्छन्।

अर्को desktop CodeNomad pair गर्न त्यसको गृह पृष्ठमा **CodeNomad सर्भर जडान गर्नुहोस्** रोजी **सर्भर URL** मा link paste गरेर **जडान गर्नुहोस्** रोज्नुहोस्। pairing link **बचत गर्नुहोस्** बाट पनि आफ्नो विन्डो खोल्छ, किनकि खोल्दा नै code खपत हुन्छ। bookmark मा tunnel origin मात्र बचत हुन्छ; code रहँदैन। pairing link मा TLS verification enabled रहन्छ।

## paired device व्यवस्थापन {#paired-devices}

1. host मा **सेटिङहरू → रिमोट पहुँच → रिमोट कन्ट्रोल** फर्कनुहोस्।
2. **जोडिएका उपकरणहरू** र तिनको **अन्तिम पटक:** समय समीक्षा गर्नुहोस्। हरेक device लाई त्यसलाई pair गर्ने platform र browser अनुसार नाम दिइन्छ, जस्तै `iPhone · Safari`।
3. अब जोडिन नहुने device का लागि **हटाउनुहोस्** रोज्नुहोस्।

revocation ले हालका HTTP/SSE जडान र भावी पहुँच दुवै अन्त्य गर्छ। पहुँच फर्काउन नयाँ link बाट pair गर्नुहोस्। device **30 दिन प्रयोग नभएपछि** expire हुन्छ। **32-device सीमा** मा नयाँ pairing ले सबैभन्दा पुरानो last-seen device बदल्छ र त्यसका जडान बन्द गर्छ।

backend ले configuration base को `remote-control-devices.json` मा credential hash राख्छ, raw credential होइन। client मा host-scoped `Secure`, `HttpOnly`, `SameSite=Lax` device cookie हुन्छ। browser lifetime server को 30-दिन inactivity सीमाभन्दा लामो हुन सक्छ; registry नै आधिकारिक हो। site data खाली, browser profile switch वा private browsing गर्दा पुनःpair चाहिन सक्छ।

direct-access password बदल्दा device revoke **हुँदैनन्**। **रिमोट कन्ट्रोल रोक्नुहोस्** ले tunnel disconnect गर्छ तर paired-device सूची राख्छ; authorization हटाउन **हटाउनुहोस्** प्रयोग गर्नुहोस्।

### आफ्नो ठाउँ नगुमाई पुनःpair {#re-pair}

1. client ले **यो उपकरण फेरि जोड्नुहोस्** देखाए त्यो पृष्ठ खुलै राख्नुहोस्।
2. host मा **नयाँ जोडी लिंक बनाउनुहोस्** रोजी **उही client browser/profile** मा खोल्नुहोस्। saved desktop server मा विद्यमान remote-window storage पुनःप्रयोग गर्न नयाँ pairing link बाट reconnect गर्नुहोस्।
3. पर्खिरहेको पृष्ठमा फर्केर **जडान जाँच्नुहोस्** रोज्नुहोस्; पृष्ठमा फेरि focus आउँदा पनि यसले फेरि जाँच्छ।

recovery ले खुला पृष्ठ र मस्यौदा जोगाउँछ; असफल कार्य replay गर्दैन। retry अघि send, answer वा delete लागू भयो कि जाँच्नुहोस्। direct-access password ले Remote Control pairing पुनःप्राप्त गर्न सक्दैन।

## उपलब्धता र आयु {#lifetime}

| कार्य/अवस्था | असर |
| --- | --- |
| Remote Control सुरु | यस backend लाई जोड्छ र भावी launch का लागि चयन सम्झिन्छ। |
| remote browser बन्द | host backend रोक्दैन वा device revoke गर्दैन। |
| Remote Control रोक्ने | पहुँच disconnect र automatic launch-resume हटाउँछ; device record राख्छ। |
| backend shutdown / अन्तिम desktop window बन्द भई app quit | Remote Control offline हुन्छ। shared OpenCode सेवा चलिरहन सक्छ, तर रोकिएको backend बाट यो UI दिन सक्दैन। |
| Remote Control started छोडेपछि launch | नयाँ pairing link नदिई background मा reconnect हुन्छ। कहिल्यै start नगरिएका installation आफैं enabled हुँदैनन्। |
| resume असफल वा fatal tunnel error | सम्झिएको चयन रहन्छ र host ले त्रुटि देखाउँछ; Remote Control card को refresh icon ले यसको अवस्था फेरि पढ्छ। **रिमोट कन्ट्रोल सुरु गर्नुहोस्** ले अहिले नै retry गर्छ; **रिमोट कन्ट्रोल रोक्नुहोस्** ले चयन हटाउँछ। अन्यथा पछिको launch ले retry गर्छ। |

automatic launch-resume प्रति configuration directory एउटा backend मा सीमित छ। थप tunnel क्षमताका लागि उही configuration मा प्रतिस्पर्धी host नचलाउनुहोस्। desktop exit पछि पनि पुग्नुपर्ने host का लागि छुट्टै व्यवस्थापित [standalone server](server.md) राख्नुहोस्; Remote Control स्वतन्त्र daemon होइन।

## उपलब्ध र अनुपलब्ध सतह {#remote-surface}

paired device ले समान ownership जाँचअन्तर्गत सामान्य project/conversation API प्रयोग, prompt पठाइ, फाइल निरीक्षण र permission/Form उत्तर दिन सक्छन्। pairing शक्तिशाली पहुँच हो, read-only sharing link होइन। tunnel ले host भित्र traffic forward गरे पनि loopback अधिकार कहिल्यै दिँदैन।

| सतह | Remote Control मार्फत |
| --- | --- |
| सामान्य authenticated UI, workspace, कुराकानी र SSE | paired device लाई उपलब्ध। |
| password login/logout, password परिवर्तन, local token bootstrap | अनुपलब्ध; direct authentication disabled भए पनि device credential चाहिन्छ। |
| Remote Control status | paired device ले पढ्न सक्छ; management अनुपलब्ध। Start/Stop, pairing सिर्जना, device सूची र revocation host access path मै रहन्छन्। |
| desktop remote-window/server management र proxy route | अनुपलब्ध (`/api/remote-servers/`, `/api/remote-proxy/`)। |
| SideCar **सामग्री proxy** | अनुपलब्ध (`/sidecars/`)। यसको अर्थ सबै SideCar API blocked **होइन**: paired client ले `/api/sidecars` registration API अझै प्रयोग गर्न सक्छन्। |
| preview सामग्री र automation bridge | अनुपलब्ध (`/previews/`, `/api/opencode-plugin/`)। native desktop क्षमता browser क्षमता बन्दैनन्। |
| WebSocket upgrade | Remote Control ingress मा अनुपलब्ध। |

blocked proxy/WebSocket चाहिने प्रक्रियामा उचित सुरक्षित [प्रत्यक्ष जडान](remote-access.md) प्रयोग गर्नुहोस्। Remote Control त्यसमा स्वतः switch हुँदैन।

## Relay र गोपनीयता {#relay-privacy}

CodeNomad ले [OpenTunnel](https://github.com/anomalyco/opentunnel) प्रयोग गरी machine को shared default tunnel identity मा एउटा random route लिन्छ। Stop ले CodeNomad bridge छोड्छ, अन्य app को shared identity होइन।

TLS CodeNomad backend मा terminate हुन्छ। relay ले ciphertext forward गर्छ र app सामग्री पढ्न सक्दैन, तर hostname, connection timing र traffic size देख्न सक्छ। tunnel certificate/private key host मै रहन्छन्। host tunnel storage र CodeNomad configuration लाई credential झैं सुरक्षित गर्नुहोस्; अनुमान गर्न नसकिने ठेगाना authorization होइन।

`CODENOMAD_REMOTE_CONTROL_API` ले self-hosted OpenTunnel API रोज्छ; unset हुँदा hosted service प्रयोग हुन्छ। यसले tunnel deployment बदल्छ, pairing आवश्यकता वा blocked सतह होइन। credential र निदान व्यवस्थापनका लागि [सुरक्षा](security.md) हेर्नुहोस्।
