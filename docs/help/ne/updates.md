# अपडेट

## release feed रोज्नुहोस् {#feed}

1. **सेटिङहरू → जानकारी → अपडेटहरू** खोल्नुहोस्।
2. **अपडेट फिड** लाई **स्थिर रिलिजहरू** वा **पूर्वावलोकन र स्थिर रिलिजहरू** मा सेट गर्नुहोस्।
3. refresh/check गरी installation स्वीकार्नुअघि offered release समीक्षा गर्नुहोस्।

feed CodeNomad server configuration मा सुरक्षित हुन्छ र offered release मात्र बदल्छ। desktop data profile, draft, window, OpenCode session वा service configuration बदल्दैन। स्पष्ट चयन नभए preview-labelled build को default preview र अन्यको stable हुन्छ।

Stable ले नवीनतम final release चयन गर्छ। Preview ले publication order पछ्याउँछ किनकि development build ले एउटै base version number साझा गर्न सक्छन्; numeric version मात्र तुलना नगर्नुहोस्। preview release यसका सबै build प्रकाशित भएपछि मात्र प्रस्ताव गरिन्छ। preview package prerelease व्यवहार परीक्षण गर्न इच्छुकका लागि हुन्; restart अघि release note जाँचेर महत्त्वपूर्ण draft जोगाउनुहोस्।

## desktop स्थापना update {#desktop-update}

1. **मद्दत → अपडेटहरू जाँच गर्नुहोस्…**, update notification वा **सेटिङहरू → जानकारी → अपडेटहरू** को बटन प्रयोग गर्नुहोस्।
2. Electron मा release page बाट आफ्नो host/platform को archive/package लिनुहोस्।
3. योग्य local Tauri installation मा native offer समीक्षा गरी **स्थापना गरी पुनः सुरु गर्नुहोस्** स्पष्ट रोज्नुहोस्।
4. installation/restart अघि हरेक window को महत्त्वपूर्ण काम बचत गरी relaunch पछि **जानकारी** जाँच्नुहोस्।

| Tauri स्थापना | in-app install योग्यता |
| --- | --- |
| Windows x64 NSIS installation | embedded updater key र signed release payload सहित समर्थित। |
| macOS x64 / arm64 application | embedded updater key र signed `.app.tar.gz` payload सहित समर्थित। |
| Linux x64 AppImage | AppImage bundle marker र nonempty `APPIMAGE` path, साथै signed update समर्थन चाहिन्छ। `APPRUN` मात्र पुग्दैन। |
| Debian/RPM, loose Windows executable, unsigned/keyless build | in-app install को सट्टा release page खोल्छ। |

Tauri application र native **प्राथमिकताहरू** window मा release प्रस्ताव हुँदा अपडेटहरू section ले **अपडेट स्थापना गर्नुहोस्** देखाउँछ। यसले चयनित feed जाँच्छ र in-app update उपलब्ध हुँदा **स्थापना गरी पुनः सुरु गर्नुहोस्** प्रस्ताव गर्छ; अन्यथा section मा देखाइएको release page खोल्छ। Electron, web र remote window ले यसको सट्टा **अपडेट डाउनलोड गर्नुहोस्** link देखाउँछन्, native updater check गर्दैनन्।

Tauri को **मद्दत → अपडेटहरू जाँच गर्नुहोस्…** menu ले focus भएको application window मा update flow चलाउँछ। प्राथमिकताहरू वा remote window बाट प्रयोग गर्दा, यसले सबैभन्दा हाल प्रयोग गरिएको application window अगाडि ल्याएर check चलाउँछ; remote window मार्फत install गर्दैन। लक्षित loading, login वा pairing screen लगायत कुनै application window ले कार्य ग्रहण गर्न नसके menu ले यसको सट्टा release page खोल्छ।

Tauri ले chosen feed/target को published update manifest भएका release मात्र स्थापना गर्छ। घोषित release अझै install गर्न नमिले notification ले यसको सट्टा release page खोल्छ। installation अघि native signature verification आवश्यक छ। updater signature OS notarization/code-signing आश्वासनभन्दा फरक हुन्।

installation ले app बदल्नु/restart अघि सबै app window flush र owned CodeNomad backend stop गर्छ। स्वतन्त्र OpenCode daemon यो shutdown को भाग होइन। CodeNomad बन्द हुँदा नफर्केसम्म backend-dependent सुविधा हराउँछन्; continuing OpenCode session बाट UI सेवा निर्बाध छ नठान्नुहोस्।

check busy भए अर्को window को कार्य पर्खनुहोस्। download, validation वा shutdown failure मा error पढी नयाँ check गर्नुहोस्; पुरानो notification पुराना byte reinstall गर्ने अनुमति होइन। असफल installation ले backend फर्काएर window reload गर्न सक्छ र installation स्वतः replay गर्दैन। native installation नभए उपयुक्त package का लागि release page प्रयोग गर्नुहोस्; [स्थापना](install.md) हेर्नुहोस्।

## standalone server update {#standalone-update}

1. CodeNomad कसरी launch भयो पहिचान गरी backend मा निर्भर काम बचत गर्नुहोस्।
2. सामान्य process/service नियन्त्रणबाट त्यो CodeNomad server process रोक्नुहोस्।
3. उही package installation update गरी अभिप्रेत configuration र flag सहित restart गर्नुहोस्।

| Launch/install विधि | Update command |
| --- | --- |
| one-off stable npm launch | सामान्य flag सहित `npx @neuralnomads/codenomad@latest` |
| global stable स्थापना | `npm install -g @neuralnomads/codenomad@latest` |
| local stable स्थापना | त्यही package directory मा `npm install @neuralnomads/codenomad@latest` |
| one-off preview launch | सामान्य flag सहित `npx @neuralnomads/codenomad-dev@latest` |
| global/local preview स्थापना | उही global/local npm ढाँचामा `@neuralnomads/codenomad-dev@latest` स्थापना |

npm ले स्थापना गर्‍यो भन्दै चलिरहेको process ले नयाँ code पाउँदैन। जानाजानी उही configuration path राख्नुहोस्; Settings मा feed चयनले npm package प्रतिस्थापन वा stable/preview package नाम स्वतः switch गर्दैन। relaunch गर्दा authentication/TLS flag जोगाउनुहोस्; [सर्भर](server.md) हेर्नुहोस्।

## OpenCode maintenance अलग राख्नुहोस् {#opencode-separate}

CodeNomad update चयनित OpenCode CLI update होइन। CLI update चलिरहेको shared daemon restart होइन। native configuration reload आफ्नै loaded Location/request असर भएको अर्को स्पष्ट कार्य हो।

desktop Node/npm resource app सँगै आउँछन्; application release ले तिनको update दिन्छ। system Node/npm, Electron internal runtime, platform webview वा स्वतन्त्र व्यवस्थापित OpenCode सेवा बदल्दैन।

runtime चयन, installation/update र explicit service नियन्त्रणका लागि **सेटिङहरू → OpenCode** प्रयोग गर्नुहोस्। restart/reload अघि, विशेष गरी अन्य window/user वा Mission ले daemon साझा गर्दा, [OpenCode सेटअप](opencode.md) जाँच्नुहोस्। update/reconnect सकियो भन्दै अनिश्चित prompt वा mutation नदोहोर्‍याउनुहोस्।
