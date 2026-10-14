# नेटिभ एकीकरण

CodeNomad ले OpenCode का नेटिभ MCP जडान, plugin सक्रियता, skill र custom command उपलब्ध गराउँछ। यी execution host मा चल्छन्। यी sandbox भएका [प्यानल विस्तार](extensions.md) र [SideCars](browser-sidecars.md) भन्दा फरक हुन्।

## सही नियन्त्रण रोज्नुहोस् {#integration-scopes}

| एकीकरण | कहाँ गर्ने | नियन्त्रणले बदल्ने कुरा |
| --- | --- | --- |
| MCP server | **स्थिति → MCP सर्भरहरू** | देखाइएको Location मा नेटिभ जडान; server स्थापना गर्दैन। |
| नेटिभ plugin | **स्थिति → प्लगइनहरू** | स्थायी **विश्वव्यापी** वा **परियोजना** सक्रियता नियम; package स्थापना/अपडेट/हटाइ गर्दैन। |
| Skill | कम्पोजर `@` menu | कुराकानीको Location मा अर्को prompt को स्पष्ट संलग्नक। |
| Custom command | कम्पोजर `/` menu | त्यस Location का लागि OpenCode ले उपलब्ध गराएको command चलाउँछ। |

पहिले OpenCode को समर्थित कन्फिगरेसन र CLI बाट एकीकरण कन्फिगर/स्थापना गर्नुहोस्। package स्थापना, स्रोत घोषणा, नियम सक्षम, सेवा जडान र उपकरण उपलब्ध गराउनु फरक चरण हुन्। नेटिभ integration सँग OpenCode अनुमतिअन्तर्गत आफ्ना host process का अधिकार हुन्छन्; ती sandbox भएका HTML प्यानल होइनन्।

## MCP जोड्नुहोस् वा छुट्याउनुहोस् {#mcp}

1. [OpenCode MCP दस्तावेज](https://opencode.ai/v2/docs/mcp-servers/) प्रयोग गरी execution host मा MCP server कन्फिगर गर्नुहोस्।
2. परियोजनाका लागि **स्थिति → MCP सर्भरहरू** खोल्नुहोस्।
3. server छेउको switch बाट connect/disconnect गर्नुहोस्। जडान सूचक स्थिर हुन पर्खनुहोस्।

switch ले देखाइएको Location को नेटिभ connection API बोलाउँछ, उपकरण-स्थानीय installer वा प्रति-विन्डो दृश्यता प्राथमिकता होइन। त्यही Location प्रयोग गर्ने अन्य क्लाइन्टले परिवर्तन देख्न सक्छन्। disconnect ले server घोषणा हटाउँदैन वा executable uninstall गर्दैन।

server नदेखिए सक्रिय Location र नेटिभ कन्फिगरेसन जाँच्नुहोस्। जडान असफल भए server कन्फिगरेसन, आवश्यक वातावरण र नेटिभ authentication flow जाँच्नुहोस्; switch ले OAuth पूरा गर्छ नमान्नुहोस्। reconnect पछि स्थिति जाँच्नुहोस्। आवश्यक हुँदा मात्र [OpenCode सेटअप](opencode.md) का अवरोध बुझेर स्पष्ट configuration reload प्रयोग गर्नुहोस्।

## Global वा Project दायरामा plugin सक्रियता {#plugins}

1. OpenCode बाट नेटिभ plugin स्थापना/घोषणा गरेर **स्थिति → प्लगइनहरू** खोल्नुहोस्।
2. स्रोत, runtime failure र configuration-target विवरण हेर्न नाममा hover/focus गर्नुहोस्।
3. **विश्वव्यापी** वा **परियोजना** सचेत रूपमा toggle गर्नुहोस्। write पर्खनुहोस् र अवस्था अस्पष्ट भए **प्लगइन नियन्त्रण ताजा गर्नुहोस्** प्रयोग गर्नुहोस्।

Global ले जोडिएको daemon को पत्ता लागेको global कन्फिगरेसन लक्षित गर्छ। Project ले सक्रिय Location भित्रको कन्फिगरेसन लक्षित गर्छ, inherited ancestor फाइल होइन। पछिको Project नियमले Global override गर्न सक्छ; Global switch ले अन्तिम Project अवस्था भएको अभिनय नगरी Global नियम नै देखाउँछ। Project नियम नभए resolved Global अवस्था inherit हुन्छ।

यी switch ले स्रोत घोषणा र असम्बन्धित कन्फिगरेसन जोगाउँदै ठ्याक्कै सक्रियता नियम थप्छन्। plugin विकल्प सम्पादन, package स्थापना वा फाइल हटाइ गर्दैनन्। built-in OpenCode plugin user सक्रियता switch मा दिइँदैनन्। लक्ष्य Global बाट सुरक्षित अलग गर्न नसके वा सक्रिय Location बाहिर जाने भए Project अक्षम हुन्छ।

सतह लुकेको बेला अन्तिम snapshot राख्छ र देखाउँदा, नेटिभ परिवर्तन/reconnect र स्पष्ट refresh मा पुनःजाँच्छ। सुरक्षित नियम र live runtime उपलब्धता छोटो समय फरक हुन सक्छन्। plugin अनुपलब्ध रहिरहे **OpenCode कन्फिगरेसन पुनः लोड गर्नुहोस्** रोज्नुअघि tooltip र नेटिभ कन्फिगरेसन जाँच्नुहोस्; त्यसले यो plugin मात्र होइन सबै loaded Location प्रभावित गर्छ। बिग्रिएको कन्फिगरेसन वा समकालीन सम्पादन चुपचाप overwrite हुँदैन: समाधान, refresh र स्पष्ट retry गर्नुहोस्।

## skill जोड्नुहोस् {#skills}

1. कम्पोजरमा `@` टाइप गरी Location का उपलब्ध skill खोजेर एउटा चयन गर्नुहोस्।
2. फाइल/agent छेउको हटाउन मिल्ने संलग्नक जाँच्नुहोस्; नचाहिए पठाउनुअघि हटाउनुहोस्।
3. prompt पठाउनुहोस्। पठाइएको सन्देशसँग skill label रहन्छन्।

चयनले नेटिभ skill ID जोडेर `@query` token हटाउँछ; देखिने मस्यौदामा निर्देशन paste गर्दैन। पठाउँदा कम्पोजर चयन खाली हुन्छ, त्यस सन्देशसँग OpenCode ले सुरक्षित गरेका निर्देशन होइनन्। संलग्नक हटाउँदा पहिलेको पठाइ undo हुँदैन।

skill उपलब्धता कुराकानीको Location बाट आउँछ, global CodeNomad catalogue बाट होइन। सूची लोड नभए picker बन्द गरी फेरि खोलेर retry गर्नुहोस्; खाली भए native discovery/configuration जाँच्नुहोस्। [OpenCode skill दस्तावेज](https://opencode.ai/v2/docs/skills/) र [कुराकानी](conversations.md) हेर्नुहोस्।

## custom command चलाउनुहोस् {#commands}

1. कम्पोजरमा `/` टाइप गरी उपलब्ध नेटिभ command रोज्नुहोस्।
2. argument दिएर command अनुसार बुझाउनुअघि **एजेन्ट**, **मोडेल** र **सोचाइ** जाँच्नुहोस्।
3. acknowledgement अस्पष्ट भए बारम्बार पठाउनुको सट्टा नतिजाको कुराकानी जाँच्नुहोस्।

command सक्रिय Location का लागि OpenCode बाट पत्ता लाग्छन्। आफ्नै नेटिभ परिभाषाले execution व्यवहार रोज्न सक्छ; menu package installer वा असीमित configuration editor होइन। CodeNomad ले native custom-command पठाउनुअघि प्रोफाइल सत्र वातावरण लागू गर्छ; environment update असफल भए पठाइ रोकिन्छ। `/btw` CodeNomad को छुट्टै क्षणिक प्रश्न flow हो, सामान्य custom command होइन।

command परिभाषा र native configuration inheritance का लागि [OpenCode command दस्तावेज](https://opencode.ai/v2/docs/commands/) प्रयोग गर्नुहोस्। कन्फिगरेसन परिवर्तनपछि पहिले सम्बन्धित सतह refresh/reopen गर्नुहोस्; runtime लाई अझै चाहिँदा मात्र स्पष्ट configuration reload गर्नुहोस्। प्रदर्शन refresh गर्नकै लागि सम्भवतः admitted command replay नगर्नुहोस्।
