# प्रमाणीकरण र सुरक्षा

CodeNomad पहुँचले OpenCode मार्फत backend host मा काम चलाउन सक्छ। server password, browser session र paired device लाई शक्तिशाली credential मान्नुहोस्। CodeNomad multi-tenant execution sandbox होइन।

## server प्रमाणीकरण रोज्नुहोस् {#authentication}

| विधि | आयु र दायरा |
| --- | --- |
| `--password` वा `CODENOMAD_SERVER_PASSWORD` | त्यस backend process को runtime override। हरेक start मा फेरि चाहिन्छ; सुरक्षित हुँदैन। managed password file override गर्छ। |
| Settings बाट password | सक्रिय configuration YAML छेउ `auth.json` मा salted scrypt hash बचत गर्छ। runtime override नभएका पछिल्ला start मा प्रयोग हुन्छ। |
| `--generate-token` | local, one-time bootstrap सक्षम; छापिएको token 60 सेकेन्ड चल्छ। reusable API token वा Remote Control link होइन। |
| Remote Control pairing | host बाट व्यवस्थित छुट्टै device-cookie authentication; [Remote Control](remote-control.md) हेर्नुहोस्। |

default username `codenomad` हो। सुरक्षित auth file ले username राख्छ; `--username` मात्र बदल्दा त्यस identity को नाम बदलिँदैन। configured password, bootstrap mode वा स्पष्ट skipped authentication नभए server startup अस्वीकार हुन्छ।

command argument वा shell history मा password राख्नुभन्दा सुरक्षित environment/service secret प्रयोग गर्नुहोस्। process environment वा configuration directory हेर्न सक्ने व्यक्तिले deployment compromise गर्न सक्छ।

## स्थायी password bootstrap {#bootstrap}

1. runtime password override बिना स्थानीय start गर्नुहोस्। पहिले certificate setup नगरी loopback bootstrap का लागि `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch` प्रयोग गर्नुहोस्।
2. backend machine मा छापिएको **Local Connection URL** को `/auth/token` खोलेर `CODENOMAD_BOOTSTRAP_TOKEN:` पछि छापिएको मान बुझाउनुहोस्। त्यो output नबाँड्नुहोस्।
3. **सेटिङहरू → रिमोट पहुँच → प्रत्यक्ष पहुँच (स्थानीय नेटवर्क, उन्नत) → सर्भर पासवर्ड** खोल्नुहोस्।
4. **पासवर्ड सेट गर्नुहोस्** रोजी **नयाँ पासवर्ड** र **पासवर्ड पुष्टि गर्नुहोस्** मा कम्तीमा आठ character भरेर **पासवर्ड बचत गर्नुहोस्**।
5. अर्को launch मा `--generate-token` नदिई direct connection का लागि सुरक्षित password प्रयोग गर्नुहोस्। remote access अघि [trusted HTTPS](remote-access.md) कन्फिगर गर्नुहोस्; loopback HTTP setup आदेश remote deployment आदेश होइन।

bootstrap host कै loopback listener बाट मात्र स्वीकार हुन्छ, LAN client वा Remote Control ingress बाट होइन। setup मा default loopback binding राख्नुहोस्। म्याद सकिएको वा प्रयोग भएको token लाई नयाँ bootstrap start चाहिन्छ। persistent password पहिल्यै भए bootstrap session ले **पासवर्ड परिवर्तन गर्नुहोस्** रोज्न दिन्छ।

`auth.json` app-managed हो; hash हातैले नलेख्नुहोस् वा फाइल सार्वजनिक नगर्नुहोस्। password CLI/environment बाट आए Settings ले बदल्न अस्वीकार गर्छ: विद्यमान managed password प्रयोग गर्न override बिना restart, वा सेट गर्न local bootstrap प्रयोग गर्नुहोस्। अपठनीय वा लेख्न नसकिने auth file लाई OS permission/path मर्मत चाहिन्छ, authentication बन्द होइन।

## browser session र revocation {#sessions}

direct sign-in ले opaque in-memory backend session र `codenomad_session` cookie (वा configured नाम) बनाउँछ। cookie `HttpOnly`, `SameSite=Lax`, `/` दायराका र HTTPS बाट जारी हुँदा `Secure` हुन्छन्। browser-session cookie हुन्; backend restart ले in-memory session अमान्य गर्छ। माग्दा असफल परिवर्तन फेरि पठाउनुको सट्टा त्यहीं reauthenticate गर्नुहोस्।

password बदल्दा पछिका credential जाँच बदलिन्छन्; जारी भइसकेका direct session वा Remote Control device अमान्य **हुँदैनन्**। compromise शङ्का भए:

1. network exposure सीमित गरी host मा नयाँ password सेट, वा runtime secret बदलेर restart गर्नुहोस्।
2. विद्यमान direct session अमान्य गर्न backend restart गर्नुहोस्।
3. **रिमोट कन्ट्रोल → जोडिएका उपकरणहरू** मा अज्ञात device छुट्टै **हटाउनुहोस्**। सम्पूर्ण मार्ग तुरुन्त काट्न Remote Control रोक्नुहोस्।
4. प्रभावित file, provider account र native OpenCode गतिविधि समीक्षा गर्नुहोस्। पहुँच रोक्नु admitted काम rollback होइन।

छुट्टै 30-दिन inactivity expiry र पाँच-मिनेट pairing link का लागि [Remote Control](remote-control.md) हेर्नुहोस्। password change device revocation होइन, tunnel stop device deletion होइन।

## transport र listener exposure सुरक्षित {#transport}

direct remote access मा trusted HTTPS प्रयोग गर्नुहोस्। plain HTTP ले network hop हेर्न सक्नेलाई password, session cookie र काम सामग्री खोलिदिन्छ। TLS reverse proxy मा terminate भए backend hop loopback वा सुरक्षित network मा राख्नुहोस्; proxy TLS ले खुला upstream HTTP connection encrypt गर्दैन।

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH` ले direct-listener login अक्षम गरी अनुरोध authenticated मान्छ। server सार्वजनिक गर्न सुरक्षित **बनाउँदैन**। सुरक्षा घेरा नलागेको reachable listener ले पुग्ने सबैलाई पहुँच दिन्छ; VPN मात्रले trusted र untrusted VPN user छुट्याउँदैन। हरेक access path स्वतन्त्र डिजाइन र प्रमाणित नगरेसम्म authentication enabled राख्नुहोस्। यो flag भए पनि Remote Control लाई paired device चाहिन्छ।

[binding matrix र TLS प्रक्रिया](remote-access.md) जाँच्नुहोस्, विशेष गरी standalone HTTP-only मोड: यसले `--host` मान्छ र loopback बाहिर cleartext खोल्न सक्छ। certificate त्रुटि ठीक गर्न verification कहिल्यै अक्षम नगर्नुहोस्।

**`--dangerously-skip-auth` नदिएसम्म `CODENOMAD_SKIP_AUTH=false` ले authentication सक्षम नै राख्छ।** `1`, `true`, `yes` वा `on` ले authentication bypass सक्षम गर्छन्; ठूला/साना अक्षर र सुरु तथा अन्त्यका whitespace बेवास्ता गरिन्छन्। `0`, `false`, `no`, `off`, खाली वा whitespace मात्र भएको मान र unset variable ले bypass बन्द नै राख्छन्। अन्य कुनै मानले CLI flag भए पनि server सुरु हुन दिँदैन। flag ले मान्य बन्द मानलाई उछिन्छ; [CLI सन्दर्भ](server.md#cli-reference) हेर्नुहोस्।

## host सीमा बुझ्नुहोस् {#host-boundary}

`--workspace-root` ले खोल्न मिल्ने workspace सीमित गर्छ, र `--unrestricted-root` ले browsing खुकुलो बनाउँछ। कुनै पनि OS jail, container, filesystem sandbox वा authorized native tool ले गर्न सक्ने कामको सीमा होइन। agent, shell command, plugin र MCP tool execution host permission र आफ्नै configured credential मा काम गर्छन्।

वास्तविक अलगाव चाहिए OS account, container/VM र upstream permission configuration प्रयोग गर्नुहोस्। एउटा ट्याब मात्र देख्ला भन्ने अपेक्षाले device लाई access नदिनुहोस्। server configuration र shared OpenCode service ले अन्य कुराकानी/project प्रभावित गर्न सक्छन्; छुट्टै सीमाका लागि [OpenCode सेटअप](opencode.md), [अनुमति](permissions.md) र [विस्तार](extensions.md) हेर्नुहोस्।

## credential र निदान निजी राख्नुहोस् {#privacy}

provider connection र global conversation storage OpenCode का हुन्। समर्थित usage integration का लागि CodeNomad ले connection metadata र selected credential server-side पढ्छ; browser API ले provider secret मान फर्काउँदैनन्। बाह्य OAuth login refresh त्यसको स्वामीको हो; CodeNomad ले ती refresh token साट्दैन। [प्रदायक](providers.md) हेर्नुहोस्।

| सामग्री | व्यवस्थापन |
| --- | --- |
| password, bootstrap token, pairing link, cookie | issue, screenshot, shell transcript वा साझा log मा कहिल्यै paste नगर्नुहोस्। |
| `auth.json`, TLS private key, tunnel identity, configuration secret | OS permission र encrypted backup बाट जोगाउनुहोस्; सहयोगका लागि पूरा directory upload नगर्नुहोस्। |
| कुराकानी पाठ, attachment, workspace path र remote address | साझा गर्नुअघि review/redact; व्यक्ति, project वा infrastructure चिनाउन सक्छन्। |
| provider key र speech credential | अभिप्रेत settings/credential owner मा मात्र भर्नुहोस्; कुन provider ले data पाउँछ जाँच्नुहोस्। [आवाज](voice.md) हेर्नुहोस्। |
| debug/trace log र network capture | आवश्यक मात्र सङ्कलन, स्थानीय निरीक्षण र report अघि redact गर्नुहोस्। downstream tool output secret-free छ नमान्नुहोस्। |

**सेटिङहरू → जानकारी → बग रिपोर्ट गर्नुहोस्** ले listener, address, path, credential वा conversation content पूर्वभरण नगरी सीमित निदान तयार गर्छ। आफूले थपेको सामग्री बुझाउनुअघि समीक्षा गर्नुहोस्। [सहयोग](support.md) हेर्नुहोस्।
