# मिसन

मिसनले टिकाउ परियोजना योजनालाई नेटिभ OpenCode कुराकानीसँग जोड्छन्। coordinator ले योजना र प्रत्यायोजन गर्छ; task tree ले dependency र नतिजा अभिलेख गर्छ। सुरक्षित योजना, admitted input र देखिएको execution फरक तथ्य हुन्।

## सिर्जना, त्यसपछि स्पष्ट सुरु {#create}

1. दायाँ प्यानलको **मिसनहरू** खोली **मिसन सिर्जना गर्नुहोस्** रोज्नुहोस्।
2. **मिसनले के गर्नुपर्छ?** भर्नुहोस् र पहिलो वाक्यबाट पूर्वभरिएको **शीर्षक** (60 character सम्म) जाँच्नुहोस्।
3. **कहिले** मा **एक पटक** वा **हरेक दिन** रोज्नुहोस्। दैनिक काममा देखाइएको time zone जाँच्नुहोस्; **परिवर्तन** ले IANA zone दिन्छ।
4. **विकल्पहरू** विस्तार गरी **प्लेबुक**, **टिप्पणीहरू**, **एजेन्ट र मोडेलहरू**, **कार्य सत्रहरू**, सुरक्षित brief र ऐच्छिक followed conversation हेर्नुहोस्।
5. **बनाउनुहोस्** रोज्नुहोस्। नयाँ प्रविष्टि चयन गरी तयार हुँदा छुट्टै ▶ प्रयोग गर्नुहोस्: एकपटकको काममा **मिसन सुरु गर्नुहोस्**, वा दैनिक schedule मा **तालिका {id} सुरु गर्नुहोस्**।

**सिर्जनाले काम कहिल्यै सुरु गर्दैन।** एकपटकको मिसन तयार हुन्छ; दैनिक schedule paused हुन्छ। सिर्जना वा brief बचतले timer सक्रिय गर्दैन। सिर्जना चयनित project/Location मा सीमित हुन्छ र requested profile तथा task-session नीति स्थिर गर्छ। validation प्रभावित field छेउ हुन्छ; केही पठाइएन भन्ने अस्वीकृतिले सुधारका लागि मस्यौदा राख्छ।

### प्लेबुक {#playbooks}

| प्लेबुक | अभिप्रेत काम |
| --- | --- |
| लचिलो मिसन | coordinator ले objective का लागि dependency-aware योजना रोज्छ। |
| Debugging | निदान, implementation, छुट्टै standards/specification review र नयाँ validation; resolution ले implementer लाई जारी राख्छ। |
| Exploration | अनिश्चितता नक्साङ्कन र मानव प्रश्नसहित सीमित निर्णयमार्फत काम गर्छ। |
| Product delivery | product analysis, architecture, implementation र quality भूमिका समन्वय गर्छ। |

प्लेबुकले समन्वय निर्देशित गर्छ; native permission छल्दैन वा सफलता सुनिश्चित गर्दैन। Exploration का निर्णय प्रश्नको उत्तर CodeNomad interruption dock बाट दिनुहोस् ताकि explicit UI answer अभिलेख होस्, agent लाई approval को नक्कल गर्न नभन्नुहोस्।

## tree पछ्याउनुहोस् र नतिजा पढ्नुहोस् {#tracking}

1. मिसन शीर्षक चयन गर्नुहोस्। अगाडिको chevron ले सूची खुला राख्छ; title field ले अस्थायी picker खोल्छ।
2. केन्द्रीय overview का लागि **सारांश** (eye), वा ठ्याक्कै result, brief र evidence का लागि task node चयन गर्नुहोस्।
3. dependency link र **प्रतिवेदनहरू** पछ्याउनुहोस्; coordinator transcript चाहिँदा **कुराकानी खोल्नुहोस्** प्रयोग गर्नुहोस्।
4. **तपाईंको जवाफ चाहिन्छ** मा **जवाफ दिनुहोस्** रोजेर अनुरोध गर्ने actor को कुराकानी र interruption dock खोल्नुहोस्।

| सूचक | स्थापित गर्ने तथ्य |
| --- | --- |
| Assigned | input admitted भयो; model consumption/काम/completion प्रमाणित छैन। |
| Active | native activity देखियो। |
| Waiting | घोषित dependency पूरा भएका छैनन्। |
| Blocked | अवरोध report भयो, अनिवार्य रूपमा तपाईंका लागि प्रश्न होइन। |
| Needs you | खुला native Form/question वा permission लाई उत्तर चाहिन्छ। |
| Done | task result अभिलेख भयो; evidence र बाँकी native काम जाँच्नुहोस्। |

graph मा पूरा र retired काम पनि हुन्छन्। task retire गर्दा कुराकानी आफैं रोकिँदैन। **प्रगतिमा** मिसनको lifecycle अवस्था हो, coordinator अहिले चलिरहेको प्रमाण होइन। पूर्ण गद्य केन्द्रीय reader मा हुन्छ, panel task सूचीमा होइन; **प्राविधिक विवरण** ले identifier र requested execution जानकारी समेटेर राख्छ।

### Briefing र update अनुरोध {#briefings}

coordinator लाई प्रारम्भिक योजना, task settlement, मानव पर्खँदा र final report अघि project briefing प्रकाशित गर्न भनिन्छ। यो लेखिएको मूल्याङ्कन हो, live activity counter वा सुनिश्चित periodic heartbeat होइन। briefing पछि map बदलिए notice ले चिनाउँछ।

नयाँ coordinator मूल्याङ्कनका लागि toolbar मुनि **अद्यावधिक माग्नुहोस्** प्रयोग गरी **सारांश** पढ्नुहोस्। **अद्यावधिक मागियो…** भनेको pending हो, उत्तर आएको होइन। **पठाइएको पुष्टि भएन** ले automatic resend अनुमति दिँदैन: छुट्टै नयाँ अनुरोधअघि coordinator कुराकानी खोल्नुहोस्। यो सामान्य native input हो, read-only sandbox होइन; coordinator का सामान्य अधिकार रहन्छन्।

## Profile, प्रत्यायोजन र depth {#profiles}

1. Missions gear वा **सेटिङहरू → मिसनहरू** बाट **नयाँ मिसनका पूर्वनिर्धारित मान** सम्पादन गर्नुहोस्।
2. global default र playbook exception रोजी **सेभ गर्नुहोस्**। सिर्जनामा विशेष requested profile का लागि **विकल्पहरू → एजेन्ट र मोडेलहरू** प्रयोग गर्नुहोस्।
3. **कार्य सत्रहरू** रोज्नुहोस्; यो **प्लेबुक** बाट स्वतन्त्र छ।
4. native recursion सीमा छुट्टै **OpenCode गहिराइ → अधिकतम गहिराइ → स्थानको गहिराइ सुरक्षित गर्नुहोस्** बाट मिलाउनुहोस्।

| सेटिङ | दायरा र असर |
| --- | --- |
| नयाँ मिसन default | **नयाँ** मिसनका लागि मात्र configuration-भरिका default; playbook exception ले सामान्य default override गर्छ। |
| Agent / Model / Thinking | सिर्जनासँग अभिलेख गरिएका requested coordinator/role चयन; पछिको काम मिलाउन busy actor चुपचाप switch हुँदैन। daily run ले frozen requested profile पुनःप्रयोग गर्छन्। |
| Native subagent | task session ले coordinator अन्तर्गत native subagent/all agent प्रयोग गर्छन्। |
| Independent session | घोषित task session ले primary/all agent र स्वतन्त्र कुराकानी प्रयोग गर्छन्; internal native helper अक्षम हुँदैनन्। |
| OpenCode depth | त्यहाँका **सबै** कुराकानीको Location/project कन्फिगरेसन, Missions मात्र होइन। खालीले inherit गर्छ। Save ले OpenCode reload वा चलिरहेका कुराकानी बदल्दैन। |

**नेटिभ पूर्वनिर्धारित** र **विश्वव्यापी पूर्वनिर्धारित विकल्पहरू अपनाउनुहोस्** फरक हुन्: पहिलोले native default माग्छ, दोस्रोले configured global profile प्रयोग गर्छ। catalogue उपलब्धता जाँचिन्छ; requested profile कुराकानीले अहिले प्रयोग गरिरहेको profile को प्रमाण होइन। दुवै task mode का internal helper मा native permission र configured depth लागू रहन्छन्।

default/depth save अपुष्ट भए मस्यौदा राखी अर्को परिवर्तनअघि default **पुनः लोड** वा **स्थानको गहिराइ ताजा गर्नुहोस्**। **प्रभावकारी गहिराइ अज्ञात** लाई शून्य वा disabled नमान्नुहोस्।

## सुरक्षित brief पुनःप्रयोग {#saved-briefs}

1. सिर्जनामा **विकल्पहरू → सुरक्षित विवरणबाट सुरु गर्नुहोस्** विस्तार गरी brief चयन गर्नुहोस्।
2. **बनाउनुहोस्** अघि प्रतिलिपि भएका objective, note, playbook, profile र delegation समीक्षा गर्नुहोस्।
3. पुनःप्रयोगयोग्य मस्यौदालाई नाम दिन **विवरणको रूपमा सुरक्षित गर्नुहोस्** प्रयोग गर्नुहोस्। चयनित एकपटकको मिसन, सकिएकोसमेत, ले पनि **विवरणको रूपमा सुरक्षित गर्नुहोस्** दिन्छ।

brief ले निर्देशन र requested चयन राख्छ, task योजना, नतिजा, कुराकानी, schedule clock वा execution authority होइन। लोड गर्दा सामान्य creation draft भरिन्छ; केही start वा schedule हुँदैन। brief हटाउँदा विद्यमान मिसन/कुराकानी रहन्छन्। **सेटिङहरू → मिसनहरू → सुरक्षित संक्षिप्त विवरणहरू** ले library व्यवस्थापन गर्छ; explicit library reset ले brief हटाउँछ, execution होइन। schedule मा save-as-brief कार्य हुँदैन।

## दैनिक समय, catch-up र followed conversation {#daily-schedules}

daily schedule ले सुरक्षित IANA time zone र civil time प्रयोग गर्छन्, बितेको 24-घण्टा interval होइन। समय schedule कै zone मा देखिन्छ, viewer भन्दा फरक हुँदा label सहित। हरेक run को आफ्नै coordinator र isolated mission map हुन्छ; चयनित schedule ले current task tree र date/outcome history देखाउँछ। केन्द्रीय reader मा पढ्न पुरानो run चयन गर्नुहोस्। इतिहास 30 result मा सीमित छ।

| परिस्थिति | scheduling व्यवहार |
| --- | --- |
| धेरै due दिन छुटेका | settled daily marker भन्दा नयाँ नवीनतम due दिन मात्र चल्छ, हरेक छुटेको दिनको backlog होइन। |
| Spring-forward gap | पहिलो पछिको valid minute मा जान्छ; day-end gap ले सीमा पार गर्छ। |
| दोहोरिएको clock hour | पहिलो occurrence प्रयोग गर्छ; दोस्रो दैनिक run बनाउँदैन। |
| पूरै छुटेको civil day | त्यस दिनको run हुँदैन। |
| घडी पछाडि सर्छ | पहिले processed दिन फेरि due बनाउँदैन। |
| विद्यमान run अझै pending | नयाँ daily run सँग overlap हुँदैन। |

creation time ले पनि eligible दैनिक काम सीमित गर्छ; नयाँ schedule सुरु गर्नु अस्तित्वअघिका मिति process गर्ने अनुमति होइन। उपलब्ध हुँदा **अहिले चलाउनुहोस्** ले छुट्टै manual run सुरु गर्छ; daily clock बदल्दैन वा pending run छल्दैन। देखाइएको next time projection हो, ठ्याक्कै-समय execution प्रत्याभूति होइन।

**पछ्याइएका कुराकानीहरू (ऐच्छिक)** ले चयनित कुराकानीबाट bounded context थप्छ। completed run ले मात्र processed-message cursor अघि बढाउँछ; failed/interrupted run ले चुपचाप context खपत गर्दैन। instruction र context क्षमता नाघे instruction छोट्याउनुहोस् वा followed conversation हटाउनुहोस्, असीमित इतिहास पढिन्छ नमान्नुहोस्।

## आयु र service restart {#lifetime}

| भाग | बन्द गर्दा अर्थ |
| --- | --- |
| CodeNomad ट्याब/विन्डो | दृश्य छुट्छ; native काम वा OpenCode सेवा रोकिँदैन। |
| CodeNomad backend | OpenCode रोकिँदैन। एकपटकको CodeNomad coordination backend उपस्थितिमा निर्भर छ; बन्द हुँदा नयाँ one-time dispatch/control उपलब्ध रहन्छ नमान्नुहोस्। |
| चलिरहेको daily schedule | clock र passage execution OpenCode plugin/service मा चल्छन्, CodeNomad UI र backend बन्द हुँदासमेत। execution host र OpenCode सेवा चलिरहनुपर्छ। |
| OpenCode service restart | process-local schedule job हराउँछन्। चल्नुपर्ने schedule **अवरुद्ध** हुन्छ र स्पष्ट **पुनः सुरु गर्नुहोस्** नगरेसम्म त्यस्तै रहन्छ; CodeNomad फेरि खोल्दा rearm हुँदैन। |

restart पछि pending run जाँचेर तयार हुँदा **पुनः सुरु गर्नुहोस्** रोज्नुहोस्। Resume ले coordinator input दोहोर्‍याएर नपठाई विद्यमान run reconcile गर्छ; interrupted native turn जारी हुने वाचा गर्दैन। restart ले काटेको turn **पुनः सुरुले अवरुद्ध** सहित report बिना सकिएकोमा settle हुन सक्छ। tool side effect retry गर्न restart प्रयोग नगर्नुहोस्।

## Pause, Stop र अनिश्चित परिणाम {#controls-recovery}

1. प्रविष्टि चयन गरी कार्यअघि current state र कुराकानी जाँच्नुहोस्।
2. फर्काउन मिल्ने hold का लागि pause icon, terminal stop का लागि stop icon र confirmation प्रयोग गर्नुहोस्। one-time tooltip **मिसन रोक्नुहोस्** र **मिसन स्थायी रूपमा रोक्नुहोस्** हुन्; schedule tooltip ले schedule नाम दिन्छन्।
3. नतिजा अपुष्ट भए विद्यमान outcome पढ्न **अवस्था जाँच गर्नुहोस्** / **नियन्त्रणको स्थिति जाँच्नुहोस्** प्रयोग गर्नुहोस्। अनिश्चितता छल्न replacement action नदिनुहोस्।
4. one-time कार्यमा header को **ताजा गर्नुहोस् र पुष्टि नभएको कार्य पुनः पठाउनुहोस्** ले तपाईंको स्पष्ट क्लिकबाट पहिले state जाँच्छ र अझै अपुष्ट ठ्याक्कै त्यही कार्य मात्र resend गर्छ।

one-time Pause ले native mission परिवार interrupt गरी coordination रोक्छ; Stop ले queued family input/delivery पनि रद्द गर्छ र terminal हो। यी bounded कार्य हुन्: **केही उप-एजेन्टहरू अझै चलिरहेका हुन सक्छन्।** को अर्थ stop अधुरो छ। सबै shell/tool प्रभाव रद्द भए नठानी retained result जाँचेर explicit retry प्रयोग गर्नुहोस्। Resume ले interrupted descendant बारे coordinator लाई बताउँछ; कसरी जारी राख्ने उसैले निर्णय गर्छ।

daily Pause/Stop ले scheduling रद्द गरी coordinator र independent specialist समेत registered root actor को interruption माग्छन्, तर **ती कुराकानी वा तिनका descendant रोकिएको प्रमाण दिँदैनन्**। native परिवार जाँच्नुहोस्। Stop terminal हो: stopped schedule ले Play, Resume वा Run now गर्न सक्दैन। **पालो जाँच गर्नुहोस्** ले pending run फेरि नपठाई reconcile गर्छ। अस्थायी scheduled-check failure ले अन्तिम त्रुटि देखाउँछन् र स्वतः retry गर्छन्; user-control reply हराउँदा automatic control resend हुँदैन।

report बिना idle one-time coordinator मा primary ▶ ले verify र recover गर्न सक्छ; योग्य task मा targeted missing-report recovery हुन्छ। recovery ले पहिले native activity, descendant र wait जाँच्छ; unknown activity मा admission अस्वीकार हुन्छ। assignment replay वा योजना प्रतिस्थापन गर्दैन। बाँकी question, permission, shell वा background काम सुल्झाउन कुराकानी खोल्नुहोस्।

**बनाउनुहोस्** अपुष्ट भए विन्डोले submitted request राखेर त्यस परियोजनाको थप creation अक्षम गर्छ; worktree deletion रोकिन सक्छ। refresh ले अवस्था मात्र पढ्छ। editor बन्द/फेरि खोल्दा मर्मत हुँदैन। विन्डो reload अघि mission list जाँच्नुहोस्: reload ले local lock हटाउँछ, **creation असफल भएको प्रमाण होइन**। reload वा restart पछि अन्धाधुन्ध duplicate नबनाउनुहोस्।

## सम्पादन, मेटाइ र कुराकानी सफाइ {#cleanup}

सम्पादनयोग्य एकपटकको मिसनमा **चयन गरिएको मिसन सम्पादन गर्नुहोस्** प्रयोग गर्नुहोस्; conflict भए overwrite नगरी current revision लोड गर्न editor बन्द/फेरि खोल्नुहोस्। daily schedule मा edit/delete नियन्त्रण हुँदैनन्।

1. नचाहिने one-time mission मा **चयन गरिएको मिसन मेटाउनुहोस्…** रोजी confirmation समीक्षा गर्नुहोस्।
2. चाहनुहुन्छ भने पुष्टि अघि **यस मिसनका लागि सिर्जना गरिएका विशेषज्ञ कुराकानीहरू पनि मेटाउनुहोस्** चयन गर्नुहोस्।
3. removed/kept/pending count का लागि **कुराकानी सफाइ** जाँच्नुहोस्। उपलब्ध भए बाँकी recorded cleanup मात्र retry गर्नुहोस्।

मिसन मेट्नु रोक्नुजस्तो होइन; पहिले Stop गरी बाँकी काम जाँच्नुहोस्। coordinator र reused कुराकानी राखिन्छन्। shared, moved, child भएका वा ownership प्रमाणित नसकिने specialist पनि राखिन सक्छन्। partial cleanup rollback हुँदैन र चुपचाप background मा पूरा गरिँदैन। पूरा cleanup इतिहास overview reader मा उपलब्ध रहन्छ।

native काम र service नियन्त्रणका लागि [अनुमति](permissions.md), [कुराकानी](conversations.md) र [OpenCode सेटअप](opencode.md) हेर्नुहोस्।
