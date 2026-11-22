# प्रत्यक्ष रिमोट पहुँच

प्रत्यक्ष पहुँचले server password प्रयोग गरी CodeNomad को HTTP/HTTPS listener मा जोड्छ। यो [Remote Control](remote-control.md) भन्दा अलग हो: pairing लाई LAN binding वा inbound port चाहिँदैन, र कुनै मार्ग चुपचाप अर्कोमा फर्कँदैन।

## पहुँच मार्ग रोज्नुहोस् {#access-paths}

| मार्ग | व्यवस्थापन गर्नुपर्ने कुरा |
| --- | --- |
| उही मेसिनको browser | loopback binding राख्नुहोस्; छापिएको local URL प्रयोग गर्नुहोस्। |
| LAN वा VPN | पहुँचयोग्य interface मा bind, अभिप्रेत client मा firewall सीमित र trusted HTTPS प्रयोग गर्नुहोस्। VPN ले CodeNomad listener कन्फिगर गर्दैन। |
| SSH forwarding | backend loopback-bound राखी वास्तविक छापिएको port forward गर्नुहोस्। tunnel ले transport जोगाउँछ तर CodeNomad authentication प्रतिस्थापन गर्दैन। |
| Reverse proxy | backend private/loopback interface मा राख्नुहोस्; proxy मा trusted TLS terminate, upstream hop सुरक्षित र direct-access tool लाई चाहिने दीर्घकालीन SSE तथा WebSocket समर्थन गर्नुहोस्। |
| Remote Control | host बाट device pair गर्नुहोस्; सीमित सतह र आयुका लागि [Remote Control](remote-control.md) हेर्नुहोस्। |

binding ले firewall नियम, port forwarding, DNS वा VPN बनाउँदैन। प्रमाणीकरणविहीन HTTP listener Internet मा सार्वजनिक नगर्नुहोस्। workspace root security sandbox होइन; server सार्वजनिक गर्नुअघि [सुरक्षा](security.md) पढ्नुहोस्।

## प्रत्यक्ष पहुँच सक्षम {#enable-direct-access}

1. host मा **सेटिङहरू → रिमोट पहुँच** खोली **प्रत्यक्ष पहुँच (स्थानीय नेटवर्क, उन्नत)** विस्तार गर्नुहोस्।
2. **सर्भर पासवर्ड** मा **पासवर्ड सेट गर्नुहोस्** वा **पासवर्ड परिवर्तन गर्नुहोस्** रोजी **नयाँ पासवर्ड** र **पासवर्ड पुष्टि गर्नुहोस्** भरेर **पासवर्ड बचत गर्नुहोस्**। runtime-supplied password यहाँ बदल्न मिल्दैन; [सुरक्षा](security.md) हेर्नुहोस्।
3. **अन्य IP हरूबाट जडान अनुमति दिनुहोस्** लाई **लिस्निङ मोड (Listening mode)** अन्तर्गत चालू गर्नुहोस्। restart चेतावनी पढेर अस्थायी अवरोधका लागि तयार हुँदा मात्र **अहिले रिस्टार्ट गर्नुहोस्** रोज्नुहोस्।
4. restart पछि **रिफ्रेस** गरी **पहुँचयोग्य ठेगानाहरू** जाँच्नुहोस्। अर्को device मा पहुँचयोग्य HTTPS ठेगाना खोल्नुहोस्, वा host मा **QR देखाउनुहोस्** रोजेर अर्को device बाट scan गरी sign in गर्नुहोस्।

यसले host को direct listening mode बदल्छ, एउटै project वा Remote Control होइन। localhost बाहिर server सुन्दा disclosure स्वतः खुल्छ। automatic restart उपलब्ध नभए CodeNomad हातैले restart गर्नुहोस्; standalone deployment ले launch-time `--host` मिलाउनुपर्छ। exposure हटाउन switch बन्द गरी restart, वा loopback binding मा CLI पुनःसुरु गर्नुहोस्। यसले paired Remote Control device revoke गर्दैन।

### Listener binding तालिका {#binding-matrix}

`--host` को default `127.0.0.1` हो; `localhost` त्यही ठेगानामा normalize हुन्छ। सक्षम listener मा यी नियम लागू हुन्छन्:

| Launch/mode | HTTP bind | HTTPS bind |
| --- | --- | --- |
| Standalone, HTTPS मात्र (default) | निजी loopback listener मात्र | `--host` |
| Standalone, HTTP मात्र | LAN/wildcard ठेगानासमेत **`--host`** | सक्षम छैन |
| Standalone, दुवै listener | `127.0.0.1`, `--host` जे भए पनि | `--host` |
| नेटिभ desktop backend | host-internal listener समेत HTTP `127.0.0.1` मै रहन्छ | HTTPS enabled हुँदा `--host` |

ठोस LAN ठेगानाले loopback connection स्वीकार नगर्न सक्छ। `0.0.0.0` सबै IPv4 interface हुन्; `::` dual-stack wildcard listener हो। browser मा wildcard होइन वास्तविक पहुँचयोग्य ठेगाना प्रयोग गर्नुहोस्। `--host` मा IPv6 zone identifier समर्थित छैनन्।

standalone HTTPS deployment मा [bootstrap प्रक्रिया](security.md) बाट password सेट गरी चलाउनुहोस्:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

loopback-मात्र HTTP का लागि, जस्तै local trusted proxy पछाडि:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

9898 वा 9899 port नमान्नुहोस्: नदिएका port व्यस्त भए अर्कोमा जान सक्छन्। स्पष्ट nonzero `--https-port`, वा HTTP सक्षम हुँदा `--http-port`, ले port स्थिर गरी bind नसके असफल हुन्छ; `0` ले OS लाई चयन गर्न दिन्छ। छापिएका **Local Connection URL**, **Remote Connection URL** र ताजा **पहुँचयोग्य ठेगानाहरू** त्यस run का आधिकारिक हुन्। पूर्ण [server CLI सन्दर्भ](server.md) हेर्नुहोस्।

## प्रशासक नीति {#administrator-policy}

प्रशासकले सुन्ने ठेगाना तोक्न सक्छ: सर्भरले प्रयोग गर्नुपर्ने ठेगानामा `CODENOMAD_LOCKED_HOST` सम्पूर्ण प्रणालीमा सेट गर्नुहोस्, त्यसपछि CodeNomad पुनः सुरु गर्नुहोस्। यसले `--host`, `CLI_HOST` र **अन्य IP हरूबाट जडान अनुमति दिनुहोस्** लाई उछिन्छ; स्विचले नतिजा देखाउँछ तर परिवर्तन गर्न सक्दैन। सहकर्मीहरूले कम्पनीको नेटवर्कबाट सर्भरमा पुग्न इन्ट्रानेट ठेगाना, वा यो कम्प्युटरमै राख्न `127.0.0.1` प्रयोग गर्नुहोस्। सबै पहुँच कम्पनीको नेटवर्कभित्रै राख्न `CODENOMAD_REMOTE_CONTROL=disabled` पनि सेट गर्नुहोस् ([रिमोट कन्ट्रोल](remote-control.md#administrator-policy))।

## अनुमति प्राप्त ओरिजिनहरू {#upgrading}

होस्टनामको उपनाम, रिभर्स प्रोक्सी वा छुट्टै होस्टमा रहेको UI का लागि ब्याकएन्डमा `CODENOMAD_ALLOWED_ORIGINS` मा विश्वास गरिएका UI ओरिजिनहरू (स्किम, होस्टनाम र पोर्ट) राख्नुहोस्। नेटिभ LAN क्लाइन्टले परिवर्तन गर्ने अनुरोधमा अनुमति प्राप्त `Origin` हेडर पठाउनुपर्छ। यी HTTPS ओरिजिनबाट टनेलबिना उपकरण जोडी बनाउन पनि सकिन्छ; [प्रत्यक्ष HTTPS बाट जोडी बनाउनुहोस्](remote-control.md#direct-https)।

UI छुट्टै होस्टमा भए सर्भर अद्यावधिक गर्नुअघि UI तैनाथ गर्नुहोस् र खुला ट्याब तथा विन्डो पुनः लोड गर्नुहोस्। सर्भरले UI उपलब्ध गराउँछ भने अद्यावधिकपछि पुनः लोड गर्नुहोस्।

होस्टमा सीमित कार्यका लागि loopback जडान प्रयोग गर्नुहोस्: SideCar सामग्री (`/sidecars/`) र WebSocket, Remote Control व्यवस्थापन (`/api/remote-control/`), प्लगइन ब्रिज (`/api/opencode-plugin/`), रिमोट प्रोक्सी (`/api/remote-proxy/`), पासवर्ड परिवर्तन र टोकनबाट प्रारम्भिक सेटअप। प्रत्यक्ष LAN पहुँचबाट साइन इन गरे पनि यी कार्यलाई loopback चाहिन्छ। SideCars मा मात्र अपवाद छ: होस्टको **HTTPS मार्फत SideCars खोल्नुहोस्** सेटिङले विश्वसनीय HTTPS origin बाट साइन इन गरिएका ब्राउजरका लागि तिनको सामग्री र WebSocket खोल्छ ([SideCars](browser-sidecars.md#register-sidecar))। सक्रिय पूर्वावलोकन सामग्री (`/previews/`) वैध क्षमता टोकनसहित प्रत्यक्ष LAN पहुँचमा उपलब्ध छ।

`/api/sidecars` दर्ता API प्रमाणीकृत प्रत्यक्ष LAN क्लाइन्ट र जोडी बनाइएका उपकरणलाई उपलब्ध रहन्छन्। होस्टमा सक्षम रहँदा Remote Control का वेब पूर्वावलोकन आफ्नो क्षमता टोकनसहित उपलब्ध रहन्छन्। सर्भर व्यवस्थापन र लगइन विवरण सुरक्षित रूपमा हाल्ने तरिकाका लागि हेर्नुहोस् [remote server बचत](remote-access.md#saved-servers).

## Trusted TLS कन्फिगर {#tls}

### आफ्नै certificate दिनुहोस् {#custom-certificates}

1. client ले प्रयोग गर्ने hostname वा IP समेट्ने Subject Alternative Names (SANs) भएको certificate ल्याउनुहोस्।
2. PEM फाइलका रूपमा दुवै `--tls-key <path>` र `--tls-cert <path>` दिनुहोस्। CA chain/bundle चाहिए `--tls-ca <path>` थप्नुहोस्।
3. CodeNomad restart गरी client device बाट certificate र छापिएको HTTPS ठेगाना जाँच्नुहोस्।

custom certificate फाइल startup मा पढिन्छन् र CodeNomad ले पुनःलेख्दैन। renewal र नयाँ फाइल लोड गर्ने restart तपाईंको जिम्मा हो। `--tlsSANs` ले generated certificate कन्फिगर गर्छ; दिइएको certificate मा नाम थप्न सक्दैन। private key सुरक्षित गर्नुहोस् र host identity जाँचेको certificate मात्र trust गर्नुहोस्।

### generated local CA प्रयोग गर्नुहोस् {#generated-certificates}

HTTPS enabled र key/certificate pair नदिँदा CodeNomad ले configuration base मुनि local CA र server certificate बनाउँछ:

| फाइल | उद्देश्य |
| --- | --- |
| `tls/ca-cert.pem` | आफूले व्यवस्थापन गर्ने client लाई सुरक्षित वितरण गर्ने public CA certificate। |
| `tls/ca-key.pem` | CA private key; कहिल्यै नबाँड्नुहोस्। |
| `tls/server-cert.pem` | Server certificate। |
| `tls/server-key.pem` | Server private key; कहिल्यै नबाँड्नुहोस्। |

1. `--tlsSANs "host.example.test,192.0.2.10"` बाट client-facing सबै DNS नाम/IP थप्नुहोस्। wildcard binding ले SAN का लागि सबै LAN ठेगाना पत्ता लगाउँदैन।
2. certificate generate/recheck गर्न backend restart गर्नुहोस्।
3. trusted माध्यमबाट host/CA प्रमाणित गरी हरेक अभिप्रेत client/browser trust store मा **CA certificate मात्र** import गर्नुहोस्। वैकल्पिक रूपमा public trusted certificate वा TLS reverse proxy प्रयोग गर्नुहोस्।

generated server certificate 30 दिन चल्छ। expiry को तीन दिनभित्र, आवश्यक SAN छुट्दा, certificate जाँच असफल हुँदा वा private-key फाइल हराउँदा startup ले renew गर्छ। generated CA 365 दिन चल्छ र expiry, certificate जाँच असफल वा private-key फाइल हराउँदा बदलिन्छ; बदल्दा server certificate पनि फेरि जारी हुन्छ। client ले replacement CA trust गर्नुपर्छ। निरन्तर in-process renewal छैन: दीर्घकालीन deployment मा expiry अघि सचेत restart मिलाउनुहोस्।

certificate चेतावनी आए रोकिएर hostname, SAN, trust store र expiry जाँच्नुहोस्। verification अक्षम वा चेतावनी क्लिक गरेर जानुलाई deployment प्रक्रिया नबनाउनुहोस्। [PWA स्थापना र microphone पहुँच](mobile.md) जस्ता remote browser सुविधालाई पनि trusted HTTPS चाहिन्छ।

## remote server बचत {#saved-servers}

प्रमाणीकृत रिमोट क्लाइन्टहरूले स्थानीय क्लाइन्टले जस्तै उही बचत गरिएका सर्भर प्रयोग र व्यवस्थापन गर्न सक्छन्। नयाँ सर्भर पासवर्ड वा जोडी बनाउने लिङ्क प्रविष्ट गर्न HTTPS वा रिमोट कन्ट्रोल चाहिन्छ।

**सेटिङहरू → सर्भरहरू** मा **सर्भरको ठेगाना वा लिङ्क** भित्र ठेगाना वा जोडी बनाउने लिङ्क टाँस्नुहोस्, वा टाइप गरेर Enter थिच्नुहोस्। यसले परियोजना नखोली सर्भर बचत गर्छ। **सर्भर सम्पादन गर्नुहोस्** ले **URL** वा वैकल्पिक **नाम** बदल्छ; उही URL र TLS नीतिमा नाम बदल्न अफलाइन पनि सकिन्छ। पुष्टि गरेपछि **हटाउनुहोस्** ले यस सञ्झ्यालमा सर्भरका ट्याब बन्द गर्छ र हालका सर्टकट हटाउँछ। अस्थायी परियोजनाका लागि **राख्नुहोस्** वा **हटाउनुहोस्** छान्नुहोस्; हटाउँदा तिनका फाइल र कुराकानी मेटिन्छन्। अरू परियोजना र कुराकानी सर्भरमै रहन्छन्।

CodeNomad होस्टमा OpenSSH चाहिन्छ र गन्तव्यमा CodeNomad पहिले नै चलिरहेको हुनुपर्छ। **सेटिङहरू → सर्भरहरू** मा **SSH सर्भर थप्नुहोस्** छान्नुहोस्। SSH होस्टबाट देखिने CodeNomad को **URL** र **SSH होस्ट (वैकल्पिक)** वा उपनाम हालेर **बचत गर्नुहोस्** छान्नुहोस्। प्रोफाइल अफलाइन पनि बचत हुन्छ। OpenSSH लाई कुञ्जी प्रमाणीकरण र `known_hosts` मा प्रमाणित होस्ट कुञ्जी चाहिन्छ। त्यस सर्भरमा CodeNomad मा साइन इन गर्नुहोस्; HTTPS प्रमाणपत्र पनि जाँचिन्छ।

सर्भर सम्पादकमा **TLS प्रमाणीकरण छोड्नुहोस्** चेकबक्स छ। **सर्भरको ठेगाना वा लिङ्क** फिल्डले त्यही ठेगानाको प्रमाणपत्र जाँच असफल भएपछि मात्र यो विकल्प देखाउँछ; ठेगाना बदल्दा छनोट हट्छ। जोडी बनाउँदा TLS सधैँ जाँचिन्छ।

`multiBackend` लाई `false` मा राखिएको भए मात्र छुट्टै डेस्कटप विन्डोका लागि तलका चरण अपनाउनुहोस्:

1. **सेटिङहरू → रिमोट पहुँच → सर्भरहरू** → **CodeNomad सर्भर जडान गर्नुहोस्**.
2. **सर्भरमा जडान गर्नुहोस्** मा trusted HTTPS origin सहित **सर्भरको नाम** र **सर्भर URL** भर्नुहोस्। **स्व-हस्ताक्षरित प्रमाणपत्रहरूको लागि TLS प्रमाणीकरण छोड्नुहोस्।** नछान्नुहोस्; बरु trust स्थापित गर्नुहोस्।
3. bookmark गर्न **बचत गर्नुहोस्**, वा बचत र खोल्न **जडान गर्नुहोस्** रोज्नुहोस्। त्यो server मा sign in गर्नुहोस्।

रिमोट विन्डोहरू खुला रहँदा अन्तिम स्थानीय विन्डो बन्द गर्दा त्यसका ट्याबहरू रहन्छन्: रिमोट विन्डोमा **सञ्झ्याल → नयाँ विन्डो**, वा CodeNomad फेरि सुरु गर्दा त्यो फेरि खुल्छ।

Remote Control मा **सर्भर URL** मा नयाँ pairing link paste गर्नुहोस्। bookmark ले tunnel origin मात्र राख्छ, one-use code कहिल्यै होइन; device-cookie हराएपछि पुनःpair गर्न [Remote Control](remote-control.md) हेर्नुहोस्।

## ट्याबमा रिमोट परियोजना खोल्नुहोस् {#remote-project-tabs}

गृहपृष्ठ वा नयाँ ट्याबमा **ब्राउज गर्नुहोस्** र सर्भर रोज्नुहोस्। सर्भर बचत गर्न ठेगाना वा जोडा बनाउने लिङ्क टाँस्नुहोस्। आवश्यक परे साइन इन गर्नुहोस्। फोल्डर हेर्न त्यसमा क्लिक गर्नुहोस्; खोल्न पथको फिल्डमा Enter थिच्नुहोस् वा **खोल्नुहोस्**। पछाडि गएर सर्भर सूचीमा फर्कनुहोस्।

स्थानीय र रिमोट परियोजना एउटै सञ्झ्यालमा खुल्छन्। ब्राउज गर्दा चयन गरिएको सर्भरका सर्टकटहरू **हालका ट्याबहरू**मा देखिन्छन्। मिश्रित सूचीमा यहाँ खोलिएका परियोजनाका सर्भर आइकन र नाम देखिन्छन्। [रिमोट ट्याबहरू पुनर्स्थापना गर्नुहोस्](projects.md#restore-remote-tabs).

**सेटिङहरू → सर्भरहरू** मा **खोल्नुहोस्** ले **ब्राउज गर्नुहोस्** मा सर्भर छान्छ र कुनै खाली ट्याब खुला भए त्यही प्रयोग गर्छ।

### `--connect-server` {#connect-server}

`--connect-server <name-or-url>` ले `multiBackend` को मान जेसुकै भए पनि छुट्टै रिमोट सञ्झ्याल खोल्छ। बचत गरिएको नाम वा ID, वा HTTP(S) URL प्रयोग गर्नुहोस्। नयाँ URL त्यसको होस्टनाममा बचत हुन्छ। सुरु गर्दा दिइने URL मा प्रयोगकर्ता नाम, पासवर्ड वा जोडी बनाउने कोड राख्न मिल्दैन। सिन्ट्याक्स र रिमोट सञ्झ्याल मात्र खोल्ने तरिकाका लागि [डेस्कटप सुरु गर्ने आर्गुमेन्टको तालिका](desktop.md#desktop-cli) हेर्नुहोस्।
