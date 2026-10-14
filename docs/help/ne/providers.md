# प्रदायक र खाता

प्रदायक प्रमाणीकरण जोडिएको OpenCode सेवाको हो, ब्राउजर उपकरण वा एउटै CodeNomad परियोजनाको होइन। मोडेल-प्रदर्शन प्राथमिकता, subscription quota र web-search चयनका दायरा फरक छन्।

## मोडेल वा खोज प्रदायक जोड्नुहोस् {#connect}

1. कार्यस्थान खोलेर **सेटिङहरू → प्रदायकहरू** खोल्नुहोस्।
2. **मोडेलहरू** वा **वेब खोज** मा **प्रदायक चयन गर्नुहोस्**, अनि **जडान गर्नुहोस्** रोज्नुहोस्।
3. दिइएको नेटिभ **प्रमाणीकरण विधि** पूरा गर्नुहोस्: API key, OAuth वा command। OAuth मा **प्रमाणीकरण पृष्ठ खोल्नुहोस्** प्रयोग गर्नुहोस् र माग्दा मात्र authorization code बुझाउनुहोस्।
4. सकिएपछि configured-provider row जाँच्नुहोस्; नतिजा अस्पष्ट भए **रिफ्रेस** प्रयोग गर्नुहोस्।

खोज-मात्र integration **वेब खोज** मा देखिन्छन्, **मोडेलहरू** मा होइन। प्रमाणीकरण बचतले मोडेल चयन वा default खोज प्रदायक बदल्दैन। API key र OAuth प्रमाणिकरण विवरण सक्रिय OpenCode सर्भरले बचत गर्छ। ब्राउजरले जडान metadata पाउँछ, सुरक्षित credential secret होइन। environment variable बाट आएको जडान यस UI मा पढ्न-मात्र हो: यहाँ disconnect गर्न खोज्नुको सट्टा यसको स्वामी वातावरण बदल्नुहोस्।

authorization विन्डो रोकिए प्रवाहबाट **प्रमाणीकरण पृष्ठ खोल्नुहोस्**, **यस ट्याबमा खोल्नुहोस्** वा **लिङ्क प्रतिलिपि गर्नुहोस्** प्रयोग गर्नुहोस्। authorization link वा code निदानमा सार्वजनिक नगर्नुहोस्।

## खाता चयन र व्यवस्थापन {#accounts}

1. प्रदायक row मा सुरक्षित credential चयन गर्न **सक्रिय खाता** प्रयोग गर्नुहोस्।
2. अर्को जडान प्रमाणित गर्न **खाता थप्नुहोस्** प्रयोग गर्नुहोस्।
3. अर्को सुरक्षित खाता व्यवस्थापन गर्न पहिले चयन गरी **खाताको नाम बदल्नुहोस्** वा **खाता हटाउनुहोस्** प्रयोग गर्नुहोस्। नाम बदल्न **खाताको नाम** र **बचत गर्नुहोस्** प्रयोग हुन्छ।

चयन, नाम परिवर्तन र हटाइले अन्य परियोजना/क्लाइन्टसमेत OpenCode सेवाभर त्यो integration प्रभावित गर्छन्। credential हटाउँदा ती क्लाइन्ट प्रमाणीकरणविहीन हुन सक्छन्; कुराकानी इतिहास मेटिँदैन वा प्रदायकको रिमोट खाता खारेज हुँदैन। environment जडानलाई लेख्न मिल्ने सुरक्षित credential का रूपमा चयन वा यहाँ हटाउन सकिँदैन। कार्य असफल भए फेरि गर्नुअघि रिफ्रेस गरी **सक्रिय खाता** मिलाउनुहोस्।

### स्वचालित चयनका सीमा {#automatic-selection}

समर्थित integration मा धेरै सुरक्षित credential हुँदा **खाता स्वतः चयन गर्नुहोस्** ले CodeNomad बाट अर्को prompt/custom-command admission अघि quota-आधारित चयनमा opt-in गर्छ। सेटिङ CodeNomad कन्फिगरेसनमा प्रति-integration हो; परिणामको खाता चयन सेवाभर हुन्छ।

| योग्य integration | योग्य खाता प्रकार |
| --- | --- |
| OpenAI / Codex | Codex OAuth subscription खाता, OpenAI pay-as-you-go key होइन। |
| OpenCode Go | Go key, वा **Go प्रदायकका लागि मात्र** प्रयोग हुने OpenCode Console sign-in/key, Zen pay-as-you-go credit होइन। |
| Anthropic | OpenCode को Claude Pro/Max OAuth login, Claude Code login **होइन**। |
| GitHub Copilot | पढ्न मिल्ने premium-request quota सहित OAuth; enterprise-endpoint credential पढ्न मिल्ने उम्मेदवार होइनन्। |
| Coding plan | key-आधारित `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`। |

हालको खाता पूर्ण हुँदा मात्र switch हुन्छ; बढी क्षमता भएको विकल्प हुँदैमा हुँदैन। read ले उम्मेदवार सक्रिय वा refresh token साटासाट नगरी स्पष्ट सुरक्षित credential जाँच्छ। Codex, Copilot र coding plan लाई प्रमाणित उपलब्ध उम्मेदवार चाहिन्छ। Go, Console र Claude ले हालैको native quota failure ले exhausted नचिनाए unknown-quota उम्मेदवार प्रयोग गर्न सक्छन्। OpenCode Go को usage endpoint र Console OAuth usage upstream मा अझै अप्रमाणित छन्, त्यसैले उपलब्धता सुनिश्चित छैन।

यो **चल्दाचल्दै failover होइन**। असफल अनुरोध पुनःप्रयास वा prompt, command अथवा परिवर्तन replay गर्दैन। environment जडान, मनपरी provider, pay-as-you-go balance वा बाह्य Claude Code login घुमाउँदैन। चयन तयारीमा manual खाता परिवर्तनको सम्मान हुन्छ; cross-client account lock छैन। quota/authentication त्रुटिमा **सक्रिय खाता** जाँचेर Usage रिफ्रेस गर्नुहोस् र सचेत पुनःपठाइअघि आवश्यक भए credential स्वामीमार्फत sign in गर्नुहोस्।

## मोडेल दृश्यता, मनपर्ने र Thinking {#models}

1. मोडेल प्रदायकछेउ **मोडेलहरू व्यवस्थापन गर्नुहोस्** रोज्नुहोस्।
2. नाम/ID बाट खोजेर दृश्यता बदल्नुहोस्; **सबै देखाउनुहोस्** र **सबै लुकाउनुहोस्** ले त्यस प्रदायकको selector सूची प्रभावित गर्छन्।
3. कुराकानीको **मोडेल** selector मा **मनपर्नेमा थप्नुहोस्** वा **मनपर्नेबाट हटाउनुहोस्** प्रयोग गर्नुहोस्; **सबै मोडेलहरू देखाउनुहोस्** ले favorites-only filtering छोड्छ।
4. चयनित मोडेलका variant का लागि कम्पोजरमा **सोचाइ** प्रयोग गर्नुहोस्।

दृश्यता र मनपर्नेले CodeNomad selector व्यवस्थित गर्छन्; मोडेल uninstall, credential हटाइ वा अन्य OpenCode क्लाइन्टको प्रयोग रोक्दैनन्। मोडेल लुकाउनु खाता disconnect होइन। Thinking ले पछिका पठाइको model variant रोज्छ, transcript मा भएको reasoning दृश्यता होइन। लुकेका मोडेल **मोडेलहरू व्यवस्थापन गर्नुहोस् → सबै देखाउनुहोस्** बाट फर्काउनुहोस्।

## प्रयोग, token count र म्याद सकिएका login {#usage}

सक्रिय कुराकानीको provider-plan window, reset समय र समर्थित balance का लागि दायाँ प्यानलको **प्रयोग** प्रयोग गर्नुहोस्। यी reading प्रति-सन्देश **टोकनहरू** र लागत अनुमानभन्दा फरक हुन्: subscription quota देखिएको transcript बाट गणना भएको बिल होइन। हराएको, पुरानो वा unknown reading शून्य usage वा बाँकी क्षमताको प्रमाण होइन। Chat सेटिङको **प्रदायक क्रेडिट मौज्दात** ले थप balance प्रदर्शन नियन्त्रण गर्छ।

Usage ले चयनित नेटिभ credential पछ्याउँछ। `anthropic`/`claude` मार्फत Claude ले OpenCode को Anthropic OAuth प्रयोग गर्छ। `claude-code` provider ले daemon होस्टको Claude Code login, त्यसको WSL वितरणसमेत, प्रयोग गर्छ: `CLAUDE_CODE_OAUTH_TOKEN`, त्यसपछि सुरक्षित login; `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` वा `~/.claude` ले फाइल भण्डारण निर्धारण गर्छन्; स्थानीय macOS ले Keychain प्रयोग गर्न सक्छ। CodeNomad ले एउटा Claude login को सट्टा अर्को राख्दैन।

प्रदायक login म्याद सकिए यसको स्वामी—OpenCode, Claude Code वा Codex CLI—मार्फत refresh/sign in गरी CodeNomad रिफ्रेस गर्नुहोस्। CodeNomad ले बाह्य स्वामित्वका refresh token साट्दैन। CodeNomad सर्भर-login expiry छुट्टै हो: असफल प्रदायक अनुरोध फेरि पठाइन्छ नठानी CodeNomad reconnect/sign in गर्नुहोस्। [समस्या समाधान](troubleshooting.md) हेर्नुहोस्।

### ऐच्छिक usage वातावरण variable {#usage-environment}

यी **CodeNomad ब्याकएन्ड प्रक्रियाको** वातावरणमा सुरु गर्नुअघि सेट गर्नुहोस्। यी usage-reader credential हुन्, ब्राउजर सेटिङ वा मोडेल-चयन नियन्त्रण होइनन्। सत्रको **वातावरण चरहरू (Environment Variables)** editor बदल्दा यी reader का लागि चलिरहेको ब्याकएन्डको `process.env` अद्यावधिक हुँदैन। बदल्दा अभिप्रेत वातावरणमा ब्याकएन्ड पुनः सुरु गर्नुहोस्; usage-reader variable का लागि मात्र साझा OpenCode सेवा restart नगर्नुहोस्।

| Usage integration | वातावरण variable |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, नभए `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| OpenCode Go थप usage | `OPENCODE_GO_WORKSPACE_ID` र `OPENCODE_GO_AUTH_COOKIE` सँगै |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — platform key, inference key भन्दा फरक |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | नेटिभ credential अनुपलब्ध हुँदा `COMMAND_CODE_API_KEY` fallback |

token/cookie लाई shell इतिहास, screenshot र report बाहिर राख्नुहोस्। ऐच्छिक reader प्रदायक API र credential वैधतामा निर्भर छन्; variable कन्फिगर गर्नु उपयोगी quota data को प्रत्याभूति होइन।

## Web-search default र Project override {#web-search}

1. **सेटिङहरू → प्रदायकहरू → वेब खोज** मा प्रमाणीकरण चाहिने खोज integration जोड्नुहोस्।
2. Global कन्फिगरेसनका लागि **पूर्वनिर्धारित खोज** रोज्नुहोस्।
3. सक्रिय Location मा override गर्न **हालको परियोजनाका लागि** प्रयोग गर्नुहोस्। प्रभावकारी नतिजाका लागि **यस परियोजनामा खोज** जाँच्नुहोस्।

परिवर्तन स्वतः बचत हुन्छन्। **पूर्वनिर्धारित / विरासत** ले inherited कन्फिगरेसन वा सुरक्षित नेटिभ चयन प्रयोग गर्छ; Project override Global भन्दा अघि पर्छ। **निष्क्रिय** ले चयनित दायरामा खोज बन्द गर्छ; **स्वचालित प्रदायक** ले नेटिभ स्वचालित provider चयन माग्छ। environment बाट आएको चयन पढ्न-मात्र देखिन्छ।

प्रदायक चयन Project-दायरामा भए पनि खोज credential सेवा-global रहन्छन्। key बचतले त्यसलाई खोज default चयन गर्दैन। read/save असफल भए पुनःप्रयासअघि रिफ्रेस गर्नुहोस्; अन्धाधुन्ध कन्फिगरेसन नबदल्नुहोस्। नेटिभ विवरणका लागि [OpenCode दस्तावेज](https://opencode.ai/v2/docs/) र [OpenCode सेटअप](opencode.md) हेर्नुहोस्।
