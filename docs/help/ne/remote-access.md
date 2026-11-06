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
| Standalone, HTTPS मात्र (default) | निजी loopback listener मात्र (तल हेर्नुहोस्) | `--host` |
| Standalone, HTTP मात्र | LAN/wildcard ठेगानासमेत **`--host`** | सक्षम छैन |
| Standalone, दुवै listener | `127.0.0.1`, `--host` जे भए पनि | `--host` |
| नेटिभ desktop backend | host-internal listener समेत HTTP `127.0.0.1` मै रहन्छ | HTTPS enabled हुँदा `--host` |

हरेक backend ले Missions जस्ता CodeNomad कै bundled OpenCode plugin का लागि `127.0.0.1` मा HTTP listener पनि राख्छ। HTTP माग नगरिएको भए, वा मागिएको HTTP listener `127.0.0.1` वा `0.0.0.0` बाहेक अर्को ठेगानामा bind भएको भए, backend ले अनियमित `127.0.0.1` port मा निजी HTTP listener थप्छ। यो कहिल्यै छापिँदैन वा जडान ठेगानाका रूपमा दिइँदैन, अरू मेसिनबाट पहुँचयोग्य हुँदैन, र उही प्रमाणीकृत application सेवा दिन्छ।

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

generated server certificate 30 दिन चल्छ। expiry को तीन दिनभित्र, आवश्यक SAN छुट्दा, certificate जाँच असफल हुँदा वा private-key फाइल हराउँदा startup ले renew गर्छ। generated CA 365 दिन चल्छ र expiry, certificate जाँच असफल वा private-key फाइल हराउँदा बदलिन्छ; बदल्दा server certificate पनि फेरि जारी हुन्छ। विद्यमान भ्रष्ट, अपठनीय वा नमिलेका private key स्वतः मर्मत हुँदैनन्। client ले replacement CA trust गर्नुपर्छ। निरन्तर in-process renewal छैन: दीर्घकालीन deployment मा expiry अघि सचेत restart मिलाउनुहोस्।

certificate चेतावनी आए रोकिएर hostname, SAN, trust store र expiry जाँच्नुहोस्। verification अक्षम वा चेतावनी क्लिक गरेर जानुलाई deployment प्रक्रिया नबनाउनुहोस्। [PWA स्थापना र microphone पहुँच](mobile.md) जस्ता remote browser सुविधालाई पनि trusted HTTPS चाहिन्छ।

## remote server बचत {#saved-servers}

1. गृह पृष्ठ, खाली ट्याब वा **ट्याब खोल्नुहोस्** लन्चरमा **ब्राउज गर्नुहोस्** खोली ठेगाना वा pairing link **सर्भरको ठेगाना वा लिङ्क** मा राख्नुहोस्। टाँस्दा तुरुन्त थपिन्छ; टाइप गरेको पाठ Enter ले थप्छ। सर्भर host name मा बचत हुन्छ र यसको पङ्क्तिमा focus जान्छ; pairing link ले browsing का लागि local backend पनि pair गर्छ। लन्चर खुलै रहन्छ। त्यही सूचीमा परियोजना हेर्न पङ्क्ति क्लिक गर्नुहोस्। **सेटिङहरू → सर्भरहरू** मा पनि यही फिल्ड छ।
2. विश्वसनीय HTTPS origin प्रयोग गर्नुहोस्। प्रमाणपत्र जाँच असफल भए फिल्डमुनि **TLS प्रमाणीकरण छोड्नुहोस्** देखिन्छ: विश्वसनीय सर्भरका लागि मात्र चिन्ह लगाई बचत गर्न फेरि Enter थिच्नुहोस्। यो profile को folder वा परियोजना छान्दा आफ्नै विन्डोमा खुल्छ।
3. **ब्राउज गर्नुहोस्** मा सर्भरको पङ्क्ति छानेर त्यही सूचीमा परियोजना हेर्नुहोस्। मागिएमा inline form मा username र password दिनुहोस्। नाम वा ठेगाना **सेटिङहरू → सर्भरहरू** को **सर्भर सम्पादन गर्नुहोस्** बाट बदल्नुहोस्।

**सेटिङहरू → सर्भरहरू** मा profile व्यवस्थापन हुन्छ (**सर्भर सम्पादन गर्नुहोस्**, **बचत गरिएको सर्भर हटाउनुहोस्**)। हटाउँदा पहिले backend मा भएका browsing credential र session बिर्सिन्छ, अनि bookmark हट्छ र सम्बन्धित ट्याब बन्द हुन्छन्। Remote परियोजना र कुराकानी सर्भरमै रहन्छन्। स्थानीय backend ले browsing secret आफ्नो configuration सँगै `remote-server-credentials.json` मा राख्छ; यो फाइललाई password जस्तै सुरक्षित राख्नुहोस्। Embedded view को authentication छुट्टै हुन्छ।

सुरक्षित सर्भर command line बाट सिधै खोल्न, सर्भरको सुरक्षित नाम वा यसको `https://` URL सहित desktop app लाई `--connect-server <name>` (वा `--connect-server=<name>`) सँग सुरु गर्नुहोस्। CodeNomad ले remote window मात्र खोल्छ, profile को TLS जाँच र native remote window को आफ्नै sign-in सहित; CodeNomad पहिले नै चलिरहेको छ भने, नयाँ window को सट्टा यसको हालको window ले त्यसलाई खोल्छ। कुनै सुरक्षित सर्भरसँग नमिल्ने URL यसको host नाममा बचत हुन्छ। सुरु गर्दा दिइने मानमा credential कहिल्यै हुँदैन: user नाम, password वा pairing code भएको URL अस्वीकार हुन्छ। नाम अज्ञात भए, URL अमान्य भए वा जडान असफल भए, CodeNomad सामान्य रूपमा सुरु हुन्छ र त्रुटि देखाउँछ। स्व-हस्ताक्षरित सर्भरका लागि स्थानीय प्रमाणपत्र स्थापना जस्ता पुष्टि जडानलाई चाहिँदा पनि, CodeNomad सामान्य रूपमा सुरु हुन्छ र त्यहीँ सोध्छ। Windows मा, सुरु गर्ने argument मा `|` भए Tauri build सुरु हुँदैन; बरु सर्भरको URL प्रयोग गर्नुहोस्, वा सर्भरको नाम बदल्नुहोस्।

रिमोट विन्डोले यो कम्प्युटरमा फर्कने बाटो सधैँ छोड्छ। रिमोट विन्डोहरू खुला रहँदा अन्तिम स्थानीय विन्डो बन्द गर्दा त्यसका ट्याबहरू रहन्छन्: रिमोट विन्डोमा **सञ्झ्याल → नयाँ विन्डो**, वा CodeNomad फेरि सुरु गर्दा त्यो फेरि खुल्छ। सर्भर लोड गर्न नसकिँदा त्यसको विन्डोले त्यो देखाउँछ र **फेरि प्रयास गर्नुहोस्**, **स्थानीय विन्डो खोल्नुहोस्** र **विन्डो बन्द गर्नुहोस्** दिन्छ; Tauri संस्करणमा पृष्ठको रिलोड बटन र **सञ्झ्याल → नयाँ विन्डो** प्रयोग गर्नुहोस्।

नयाँ Remote Control link टाँस्दा tunnel origin बचत हुन्छ र browsing का लागि local backend pair हुन्छ। यसको device credential निजी रूपमा अर्को launch सम्म पनि रहन्छ; प्रयासपछि code हटाइन्छ। Revocation पछि **ब्राउजमा फर्कनुहोस्** छानी नयाँ link **सर्भरको ठेगाना वा लिङ्क** मा टाँस्नुहोस्। Embedded view छुट्टै pair हुन्छ। Server-side pairing उपलब्ध नभए remote server update गर्नुहोस् वा password login का लागि यसको direct-listener URL प्रयोग गर्नुहोस्; tunnel address लाई pairing चाहिन्छ। [Remote Control](remote-control.md) हेर्नुहोस्।

## रिमोट परियोजना ट्याबमा खोल्नुहोस् {#remote-project-tabs}

डेस्कटप एपमा (Electron, वा Windows मा Tauri), बचत गरिएको सर्भरले आफ्नो कुनै परियोजना यो सञ्झ्यालको ट्याबमा, तपाईंका स्थानीय परियोजनाहरूसँगै, खोल्न पनि सक्छ:

1. गृह पृष्ठ, खाली ट्याब वा **ट्याब खोल्नुहोस्** लन्चरमा **ब्राउज गर्नुहोस्** खोली बचत गरिएको सर्भर छान्नुहोस्। पहिले थप्न **सर्भरको ठेगाना वा लिङ्क** प्रयोग गरी नयाँ पङ्क्ति क्लिक गर्नुहोस्।
2. त्यही सूचीमा सर्भरका हालका परियोजना र folder देखिन्छन्। आवश्यक भए inline form बाट sign in गर्नुहोस्। हालको परियोजना छान्नुहोस् वा folder मा गई **हालको चयन गर्नुहोस्** थिच्नुहोस्। **ब्राउजमा फर्कनुहोस्** ले सर्भर सूची देखाउँछ।
3. Folder छान्दा remote project ट्याब खुल्छ र सुरुको खाली ट्याबलाई बदल्छ। `+` लन्चर यो छनोटसम्म खुलै रहन्छ। परियोजना सिधै फेरि खोल्न **हालका** मा थपिन्छ।

ट्याबका कुराकानी, फाइल, Git, सेटिङ र Missions remote server मा चल्छन्। Embedded view ले सर्भरको remote-window storage साझा गर्छ र Browse भन्दा छुट्टै sign-in माग्न सक्छ। Remote ट्याब startup restoration मा फर्कन्छन्। Embedded mode नभएका सर्भरले पूर्ण UI देखाउँछन्; TLS verification छोड्ने profile र macOS/Linux को Tauri ले छुट्टै window खोल्छन्। Embedded page सर्भरमै रहन्छ र host मा notification मात्र दिन सक्छ। Web client र Remote Control device मा remote ट्याब हुँदैनन्।

Backend browsing ले प्रत्येक बचत गरिएको profile को destination address स्वीकार गर्छ, जसमा loopback, RFC1918 LAN, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS र `*.ts.net`, IPv6 ULA/link-local र यी address मा resolve हुने नामहरू पर्छन्। तपाईंको network route र TLS setup ले connection सम्भव बनाउनुपर्छ। Certificate verification बचत गरिएको profile र स्पष्ट TLS confirmation अनुसार हुन्छ।
