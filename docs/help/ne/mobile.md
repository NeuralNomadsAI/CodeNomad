# मोबाइल र PWA

backend host को काम जारी राख्न phone वा tablet मा browser UI प्रयोग गर्नुहोस्। PWA स्थापनाले UI खोल्ने तरिका बदल्छ, project, credential वा agent execution रहने ठाउँ होइन।

## phone वा tablet बाट जडान {#connect}

1. host मा **सेटिङहरू → रिमोट पहुँच → रिमोट कन्ट्रोल** खोली **रिमोट कन्ट्रोल सुरु गर्नुहोस्** रोज्नुहोस्।
2. mobile device बाट pairing QR scan गरी प्रयोग गरिरहने browser मा link खोल्नुहोस्।
3. वा [प्रत्यक्ष पहुँच](remote-access.md) कन्फिगर गरी host को पहुँचयोग्य trusted HTTPS URL खोल्नुहोस् र server password बाट sign in गर्नुहोस्।

Remote Control लाई device pairing चाहिन्छ; direct connection लाई routing, reachable listener र authentication चाहिन्छ। workstation पुग्न phone मा `localhost` प्रयोग नगर्नुहोस्। site data गुम्दा वा browser profile बदल्दा sign-in/pairing फेरि चाहिन सक्छ; [Remote Control](remote-control.md) हेर्नुहोस्।

## PWA स्थापना {#install-pwa}

1. installation समर्थन गर्ने browser मा trusted HTTPS बाट काम गर्ने CodeNomad URL खोल्नुहोस्।
2. Chrome/Edge र समान browser मा address-bar install वा उपलब्ध हुँदा browser को **Install CodeNomad** प्रयोग गर्नुहोस्। iPhone/iPad Safari मा **Share → Add to Home Screen**; शब्द OS/browser अनुसार फरक हुन्छ।
3. नयाँ launcher खोली यसको browser storage अलग भए त्यहाँ sign-in वा pairing पूरा गर्नुहोस्।

स्थापना प्रति device/browser र origin हुन्छ। phone मा Node, Git वा OpenCode स्थापना, backend सुरुवात वा native desktop integration अनुमति दिँदैन। launcher हटाउँदा host कुराकानी मेटिँदैनन्; पहुँच हटाउँदा paired device छुट्टै revoke गर्नुहोस्।

### सुरक्षित सन्दर्भ र certificate {#secure-context}

remote PWA स्थापना र microphone पहुँचलाई browser ले चिन्ने secure context चाहिन्छ। ठ्याक्कै hostname/IP मिल्ने trusted HTTPS certificate प्रयोग गर्नुहोस्। generated local certificate लाई client device/browser ले स्पष्ट trust गर्नुपर्छ; warning page वा bypass भरपर्दो installation setup होइन। browser localhost अपवाद त्यही device मा लागू हुन्छ, अर्को host को HTTP LAN address मा होइन।

install विकल्प नभए पहिले HTTPS trust र browser support जाँचेर embedded QR/in-app browser होइन पूर्ण browser मा पृष्ठ फेरि खोल्नुहोस्। microphone असफल भए browser/OS site permission र [आवाज](voice.md) हेर्नुहोस्। install ठीक गर्न authentication वा TLS verification बन्द नगर्नुहोस्।

## touch layout मा काम {#touch-layout}

navigation र tool खोल्न **बायाँ प्यानल** र **दायाँ प्यानल** प्रयोग गर्नुहोस्। साँघुरो layout मा desktop-चौडाइ canvas थोपर्नुको सट्टा प्यानल कुराकानीमाथि overlay हुन्छन्; एउटा floating panel खोल्दा अर्को बन्द हुन्छ। ठाउँ सीमित हुँदा conversation-header कार्य overflow menu मा जान्छन्।

कम्पोजरको footer मै Agent, Model र Thinking रहन्छन्। field on-screen keyboard समेत देखिने कुराकानीअनुसार resize हुन्छ; लामो मस्यौदा scroll योग्य रहन्छन्। interruption खोल्दा सुरक्षित उचाइ वा मस्यौदा नबदली कम्पोजर अस्थायी सानो हुन्छ। माथिको dock मा permission/question उत्तर दिँदा action footer पुग्न मिल्ने राख्नुहोस्। [कुराकानी](conversations.md) र [अनुमति](permissions.md) हेर्नुहोस्।

## क्षमता र जडान सीमा {#limits}

| क्षमता | मोबाइल browser / PWA |
| --- | --- |
| project, कुराकानी, file र permission | access control अन्तर्गत जोडिएको backend host मा चल्छन्। device attachment phone बाट upload हुन्छन्; project reference host मा resolve हुन्छन्। |
| native desktop window, OS menu र host-native automation | PWA स्थापनाले दिँदैन। |
| browser preview | native guest-browser क्षमता पाउँदैन; fallback rendering browser सीमामै रहन्छ। |
| SideCar content र WebSocket | connection path मा निर्भर; Remote Control ले SideCar content proxy, preview content र WebSocket upgrade रोक्छ। [ठ्याक्कै प्रतिबन्ध](remote-control.md) हेर्नुहोस्। |
| microphone, clipboard, notification र install prompt | browser/OS support, secure context र user permission मा निर्भर। |
| offline काम | offline backend वा cached API history छैन। static UI asset cache हुन सक्छन्, तर document र API response offline workspace होइनन्। |

backend पहुँचयोग्य राख्नुहोस्। mobile OS suspension वा network switch ले event stream छुटाउन सक्छ; फर्कँदा reconnect र current state refetch हुन्छ, सुनिश्चित event replay हुँदैन। retry अघि कार्य सकियो कि जाँच्नुहोस्। PWA बन्द गर्दा standalone backend रोकिँदैन; host desktop app र backend quit हुँदा अर्को launch सम्म Remote Control अनुपलब्ध हुन्छ।
