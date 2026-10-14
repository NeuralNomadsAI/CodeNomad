# प्यानल विस्तार

## स्थापित र अनलाइन विस्तार हेर्नुहोस् {#browse}

1. right-panel ट्याब bar मा **दायाँ प्यानल अनुकूलन गर्नुहोस्** खोल्नुहोस्।
2. separator मुनिको **विस्तारहरू** विस्तार गर्नुहोस्।
3. स्थापित addon र आधिकारिक online catalogue को एउटै सूचीमा खोज्न **विस्तार खोज्नुहोस्** प्रयोग गर्नुहोस्। metadata का लागि प्रविष्टिमा hover/focus गर्नुहोस्।

customization popup खुल्दा disclosure हरेकपटक संक्षिप्तबाट सुरु हुन्छ। स्थापित र online प्रविष्टि extension ID अनुसार एकत्र हुन्छन्; छुट्टै manager विन्डो वा installed/online मोड छैन। catalogue metadata हेर्दा लेखकको panel code download वा execute हुँदैन। catalogue [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions) मा राखिन्छ; समावेश हुनु र दाबी गरिएका लेखक नाम signature वा विश्वासको प्रमाण होइनन्।

catalogue अनुपलब्ध भए स्थापित विस्तार र **ZIP बाट स्थापना गर्नुहोस्…** उपलब्ध रहन्छन्। discovery पुनःप्रयास गर्न refresh गर्नुहोस्। popup संक्षिप्त वा बन्द गर्दा pending review/confirmation UI त्यागिन्छ; चुपचाप केही स्थापना हुँदैन।

## समीक्षा गरी निष्क्रिय स्थापना {#install}

1. catalogue प्रविष्टिमा **स्थापना गर्नुहोस्…**, वा छुट्टै ल्याएको package का लागि **ZIP बाट स्थापना गर्नुहोस्…** रोज्नुहोस्।
2. package ID, लेखक, repository, संस्करण, API/अनुमति र SHA-256 digest समीक्षा गर्नुहोस्। आवश्यक भए technical details विस्तार गर्नुहोस्।
3. publisher प्रमाणित गर्नुहोस् र उपलब्ध भए विश्वसनीय माध्यमबाट digest तुलना गर्नुहोस्।
4. code लाई विश्वास गर्दा मात्र **म यो प्याकेज र यसको लेखकलाई विश्वास गर्छु** चयन गरी **निष्क्रिय रूपमा स्थापना गर्नुहोस्** रोज्नुहोस्।

निरीक्षणले चयनित package download/revalidate गर्छ; लेखक code चलाउँदैन। digest ले ठ्याक्कै byte चिनाउँछ, लेखक पहिचान होइन। catalogue package ठ्याक्कै घोषित GitHub release asset बाट आउँछन्, मनपरी URL बाट होइन। manual package `manifest.json` र self-contained `panel.html` मात्र भएका ZIP हुन्; अमान्य वा असमर्थित package अस्वीकार हुन्छन्।

स्थापनालाई OpenCode restart चाहिँदैन र सक्रियता स्वतः दिँदैन। validation, conflict वा storage असफलताले फरक byte सहित retry को अनुमति दिँदैन। नयाँ स्थापना प्रयासअघि package फेरि निरीक्षण गर्नुहोस्।

## सक्रियता र दायरा बुझ्नुहोस् {#activate-scope}

1. **विस्तारहरू** disclosure माथिको addon row मा फर्कनुहोस्, जुन **दायाँ प्यानल अनुकूलन गर्नुहोस्** भित्र छ। स्थापित निष्क्रिय addon पनि त्यही सूचीमा रहन्छन्।
2. सक्रिय गर्न checkbox चयन गर्नुहोस्। अक्षम गर्न त्यही checkbox खाली गर्नुहोस्।

त्यो checkbox मात्र सक्रियता नियन्त्रण हो: थप manager switch वा प्रति-विन्डो दृश्यता gate छैन। सक्रियता configuration भरिका परियोजनामा हुन्छ, प्रति फोल्डर होइन। रिमोट जडानमा यसले server को installed extension store प्रभावित गर्छ, हेर्ने उपकरण मात्र होइन।

extension store चयनित CodeNomad कन्फिगरेसनछेउको `panel-extensions/` हो। एउटै configuration directory प्रयोग गर्ने छुट्टै desktop data profile ले विस्तार अलग **गर्दैनन्**। उल्टो, फरक configuration खोल्नु अन्यत्र स्थापित addon चलाउने अनुमति होइन। फरक बुझ्न [डेस्कटप विन्डो र डेटा](desktop.md) हेर्नुहोस्।

सक्षम प्यानल चयन हुँदा mount हुन सक्छ; लुकाउँदा अस्थायी UI अवस्था हट्न सक्छ। अक्षम गर्दा सक्रियता खारेज हुन्छ। customization को **रिसेट गर्नुहोस्** ले built-in लेआउट मात्र फर्काउँछ, विस्तार सक्षम, अक्षम वा uninstall गर्दैन।

## बदल्नुहोस् वा हटाउनुहोस् {#replace-remove}

1. स्थापित package बदल्न **संस्करण बदल्नुहोस्…** वा उही ID को अर्को ZIP निरीक्षण गर्नुहोस्।
2. नयाँ digest र अनुमति समीक्षा, trust स्वीकार गरी निष्क्रिय स्थापना गर्नुहोस्।
3. प्रतिस्थापनलाई विश्वास गर्ने निर्णयपछि मात्र सामान्य checkbox बाट पुनःसक्रिय गर्नुहोस्।
4. uninstall गर्न लक्ष्य समीक्षा गरी **हटाउनुहोस्…** र **हटाउने पुष्टि गर्नुहोस्** प्रयोग गर्नुहोस्।

अनुमति सूची उही भए पनि हरेक प्रतिस्थापनले सबै परियोजनामा सक्रियता खारेज गर्छ। validation/conflict/storage असफलताले स्थापित package जोगाउँछ। चुपचाप extension update हुँदैन। हटाइले package र सक्रियता सेटिङ मेट्छ, OpenCode सत्र वा परियोजना फाइल होइन। नचाहेको code बाट पुनःप्राप्तिका लागि पहिले अक्षम गर्नुहोस्; प्रमाणित विश्वसनीय package मात्र पुनःस्थापना गर्नुहोस्।

## सन्दर्भ, asset सहमति र sandbox सीमा {#permissions-sandbox}

| Contract | सक्रियताले दिने अनुमति |
| --- | --- |
| API 1 / `session.context` | हालको session identifier (वा कुनै होइन), interface भाषा र रूप। transcript पाठ वा filesystem पहुँच छैन। |
| API 2 / `session.assets.read` plus context | सीमित current-session tool-result image/attachment metadata सूची र समर्थित embedded byte पढ्न स्पष्ट समीक्षा गरिएको अनुमति। सामान्य transcript, file वा URL पहुँच होइन। |

asset पहुँच हाल mount भएको host/session अनुसार हुन्छ, लेखकले छानेको session अनुसार होइन। local/remote reference अनुपलब्ध भनेर सूचीबद्ध हुन सक्छन्; asset API ले मनपरी remote URL ल्याउँदैन वा local file खोल्दैन। सत्र बदल्दा, disconnect वा consent खारेज गर्दा पुरानो पहुँच अमान्य हुन्छ।

लेखक code सीमित iframe मा चल्छ, trusted application renderer मा होइन। native/OpenCode bridge, credential पहुँच, general RPC, form, popup वा download पाउँदैन; network API र बाह्य स्रोत प्रतिबन्धित छन्। विस्तार UI addon हुन्, [OpenCode plugin](integrations.md) होइनन्।

sandbox process/CPU अलगाव वा स्वीकृत code हानिरहित हुने वाचा होइन। शत्रुतापूर्ण विस्तारले renderer अवरुद्ध गर्न सक्छ। विश्वसनीय लेखकका मात्र स्थापना गर्नुहोस्, secret नदिनुहोस्, र अप्रत्याशित व्यवहार भए addon अक्षम/हटाउनुहोस्।
