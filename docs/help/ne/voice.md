# आवाज input र playback

## वाचन कन्फिगर गर्नुहोस् {#configure}

1. **सेटिङहरू → वाचन (Speech)** खोल्नुहोस्। **वाचन (Speech)** card ले कुराकानीको model provider बाट स्वतन्त्र OpenAI-compatible server-side adapter प्रयोग गर्छ।
2. **API कुञ्जी**, ऐच्छिक **आधार URL**, **ट्रान्सक्रिप्शन मोडेल**, **वाचन मोडेल (TTS)** र **पूर्वनिर्धारित आवाज** भर्नुहोस्।
3. input र output लाई फरक सेवा चाहिँदा **इनपुट र आउटपुटका लागि छुट्टाछुट्टै प्रदायक** सक्षम गरी input/output key, base URL र model field भर्नुहोस्।
4. **प्लेब्याक मोड** र **आउटपुट ढाँचा**, अनि **बचत गर्नुहोस्** रोज्नुहोस्। परीक्षणअघि **बचत गरियो**, **कन्फिगर गरियो** वा **आंशिक रूपमा कन्फिगर** जाँच्नुहोस्।

speech सेटिङ र key जोडिएको CodeNomad server configuration का हुन्, चयनित परियोजना वा OpenCode provider connection का होइनन्। साझा गर्ने अन्य क्लाइन्टले पनि प्रयोग गर्छन्। सुरक्षित key लुकाइन्छ: खाली key field ले सुरक्षित मान राख्छ; **बचत गरिएको कुञ्जी सफा गर्नुहोस्** ले बचत गर्दा हटाउने तय गर्छ। आफ्नै endpoint र key दुवै नभएको दिशाले साझा सेटिङ प्रयोग गर्न सक्छ; छुट्टै endpoint लाई आफ्नै key र छुट्टै key लाई आफ्नै endpoint चाहिन्छ। endpoint बदल्दा अभिप्रेत key स्पष्ट दिनुहोस् र सुरक्षित कन्फिगरेसन जाँच्नुहोस्; अर्को host मा पठाउनुको सट्टा endpoint परिवर्तनले त्यस slot को सुरक्षित key हटाउँछ।

backend ले साझा default का लागि `OPENAI_API_KEY` र `OPENAI_BASE_URL` पनि प्रयोग गर्न सक्छ। सुरक्षित key खाली गर्दा environment-provided credential हट्दैन; fallback हटाउन चाहनुहुन्छ भने backend वातावरण बदलेर पुनः सुरु गर्नुहोस्।

| सेटिङ | अर्थ / default |
| --- | --- |
| Base URL | OpenAI-compatible API root, default `https://api.openai.com/v1`। input ले `audio/transcriptions`; output ले `audio/speech` प्रयोग गर्छ। |
| Transcription model / Input model | STT endpoint ले स्वीकार्ने model; default `gpt-4o-mini-transcribe`। |
| Speech model / Output model | TTS endpoint ले स्वीकार्ने model; default `gpt-4o-mini-tts`। |
| Default voice | प्रदायक voice identifier; default `alloy`। OS voice picker होइन। |
| Streaming | provider र browser ले चयनित format समर्थन गर्दा audio आउनासाथ playback सुरु हुन्छ। |
| Buffered | बजाउनुअघि पूरा audio response पर्खन्छ। |
| Output format | `mp3`, `wav`, `opus` वा `aac`; default `mp3`। अनुकूलता browser/provider अनुसार फरक हुन्छ। |

यी कन्फिगर सेवामा अनुरोध हुन्, हरेक compatible endpoint ले हरेक model, voice वा format समर्थन गर्छ भन्ने प्रत्याभूति होइन। save असफल भए त्रुटि देखिन्छ; अर्को परिवर्तनअघि configuration जाँच्नुहोस्।

## input र output परीक्षण {#test}

1. पहिले endpoint, key, model र voice परिवर्तन बचत गर्नुहोस्।
2. **इनपुट परीक्षण** रोजेर microphone अनुमति दिनुहोस्, बोल्नुहोस्, अनि **रेकर्डिङ रोक्नुहोस्**। फर्किएको transcription जाँच्नुहोस्।
3. नमूना सुन्न **प्लेब्याक परीक्षण गर्नुहोस्** रोज्नुहोस्; **नमूना रोक्नुहोस्** ले अन्त्य गर्छ।

playback परीक्षणले चयनित मोड/format तुरुन्त प्रयोग गर्छ, तर endpoint, key, model र voice सुरक्षित सेटिङबाट आउँछन्। input परीक्षणले कुराकानी prompt पठाउँदैन। परीक्षणले पनि कन्फिगर speech provider लाई audio/text पठाउँछन् र शुल्क लाग्न सक्छ।

streaming असफल भए **बफर्ड** चयन गरी `mp3` प्रयास गर्नुहोस्, बचत र पुनःपरीक्षण गर्नुहोस्। “Configured” ले सेटिङ पुष्टि गर्छ, सफल provider authentication वा codec playback होइन। पुनःप्रयासअघि server host बाट endpoint उपलब्धता, provider model/voice नाम र quota जाँच्नुहोस्।

## बोलेर prompt लेख्नुहोस् {#dictate}

1. **प्रम्प्ट ध्वनि इनपुट** लाई **वाचन (Speech)** मा सक्षम गर्नुहोस्।
2. कम्पोजरमा microphone नियन्त्रण (**ध्वनि इनपुट सुरु गर्नुहोस्**) थिचेर राख्नुहोस् र यस उपकरणमा microphone पहुँच अनुमति दिनुहोस्।
3. छोडेर रोकी transcription गर्नुहोस्। action-menu प्रविष्टि प्रयोग गर्दा **ध्वनि इनपुट सुरु गर्नुहोस्**, अनि **रेकर्डिङ रोक्नुहोस् र ट्रान्सक्राइब गर्नुहोस्** रोज्नुहोस्।
4. सामान्य रूपमा prompt पठाउनुअघि घुसाइएको पाठ समीक्षा र सम्पादन गर्नुहोस्।

transcription ले हालको selection मा पाठ राख्छ; स्वतः OpenCode लाई बुझाउँदैन। STT कन्फिगर र क्लाइन्टले recording समर्थन गर्दा मात्र microphone नियन्त्रण देखिन्छ। CodeNomad remote server मा चले पनि recording क्लाइन्ट उपकरणकै microphone बाट हुन्छ।

नियन्त्रण नभए toggle र STT configuration जाँच्नुहोस्। permission त्रुटिमा browser/OS दुवै privacy सेटिङमा microphone अनुमति दिनुहोस्। remote browser recording लाई सुरक्षित सन्दर्भ, सामान्यतः trusted HTTPS, चाहिन्छ; [मोबाइल पहुँच](mobile.md) र [प्रत्यक्ष रिमोट पहुँच](remote-access.md) हेर्नुहोस्। कम्पोजर छोड्दा वा बन्द गर्दा recording lifecycle सकिन्छ; नपठाएको audio फर्कन्छ भन्ने भर नपर्नुहोस्। नतिजा समीक्षा गर्ने ठाउँ टाइप गरिएको मस्यौदा नै हो।

## सन्देश वाचन {#playback}

1. TTS उपलब्ध हुँदा सन्देशमा **सन्देश वाचन गर्नुहोस्** प्रयोग गर्नुहोस्।
2. अर्को वाचन सुरु गर्नुअघि उही सक्रिय नियन्त्रणमा **वाचन रोक्नुहोस्** प्रयोग गर्नुहोस्।
3. पछिका अनुरोधका लागि **वाचन (Speech)** मा सुरक्षित voice, model, mode वा format बदल्नुहोस्।

playback ले CodeNomad को text projection प्रयोग गर्छ, screenshot को वर्णन होइन: binary/image byte र permission receipt speech सामग्री होइनन्। prompt चलाउँदैन वा चयनित OpenCode model बदल्दैन। format चयनयोग्य भए पनि browser audio समर्थन र provider response ले playback रोक्न सक्छन्।

स्वचालित conversation speech का लागि कम्पोजर कार्यमा **कुराकानी मोड सक्षम गर्नुहोस्** प्रयोग गर्नुहोस्। यसले सक्रिय मुख्य सत्रमा पूरा भएको fenced `spoken` block बाट सुरु हुने assistant पाठ पढ्छ; हरेक reply वा subagent को स्वचालित वाचन होइन। आवश्यक भए त्यस्तो output format माग्नुहोस्। **कुराकानी मोड अक्षम गर्नुहोस्** ले लाम रोक्छ। microphone input सुरु गर्दा पनि सक्रिय conversation speech रोकिन्छ। toggle voice input सँग वा conversation mode पहिले नै enabled हुँदा देखिन्छ र सक्षम गर्न काम गर्ने TTS चाहिन्छ।

## डेटा प्रवाह र गोपनीयता {#privacy}

microphone audio क्लाइन्टबाट CodeNomad backend, त्यसपछि कन्फिगर STT endpoint मा जान्छ। synthesis का लागि छानिएको पाठ backend हुँदै TTS endpoint मा जान्छ; फर्किएको audio क्लाइन्टमा बज्छ। API key server-side रहन्छन् र settings form मा सुरक्षित मानका रूपमा फर्काइँदैनन्।

बोलिएको वा पढिएको सामग्रीका लागि विश्वास गर्ने endpoint प्रयोग गर्नुहोस्। यो offline transcription प्रत्याभूति होइन, र OpenCode credential ले speech स्वतः अधिकृत गर्दैनन्। सकिएपछि recording/playback रोक्नुहोस्; key वा endpoint परिवर्तनले भावी अनुरोध प्रभावित गर्छ, provider लाई पठाइसकेको डेटा होइन। अरू प्रयोगकर्तालाई server दिनुअघि [सुरक्षा](security.md) हेर्नुहोस्।
