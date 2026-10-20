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
| Standalone, HTTPS मात्र (default) | सक्षम छैन | `--host` |
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

9898 वा 9899 port नमान्नुहोस्: नदिएका port व्यस्त भए अर्कोमा जान सक्छन्। स्पष्ट nonzero `--https-port` वा `--http-port` ले port स्थिर गरी bind नसके असफल हुन्छ; `0` ले OS लाई चयन गर्न दिन्छ। छापिएका **Local Connection URL**, **Remote Connection URL** र ताजा **पहुँचयोग्य ठेगानाहरू** त्यस run का आधिकारिक हुन्। पूर्ण [server CLI सन्दर्भ](server.md) हेर्नुहोस्।

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

1. desktop गृह पृष्ठमा **सर्भरहरू**, त्यसपछि **सर्भरमा जडान गर्नुहोस्** चयन गर्नुहोस्।
2. trusted HTTPS origin सहित **सर्भरको नाम** र **सर्भर URL** भर्नुहोस्। **स्व-हस्ताक्षरित प्रमाणपत्रहरूको लागि TLS प्रमाणीकरण छोड्नुहोस्।** नछान्नुहोस्; बरु trust स्थापित गर्नुहोस्।
3. bookmark गर्न **बचत गर्नुहोस्**, वा बचत र खोल्न **जडान गर्नुहोस्** रोज्नुहोस्। त्यो server मा sign in गर्नुहोस्।

bookmark यो CodeNomad कन्फिगरेसनका हुन्, remote server का project होइनन्। URL बचतले server सुरु वा access प्रदान गर्दैन। **बचत गरिएको सर्भर हटाउनुहोस्** ले bookmark हटाउँछ, remote कुराकानी, backend वा credential होइन।

Remote Control मा **सर्भर URL** मा नयाँ pairing link paste गर्नुहोस्। bookmark ले tunnel origin मात्र राख्छ, one-use code कहिल्यै होइन; device-cookie हराएपछि पुनःpair गर्न [Remote Control](remote-control.md) हेर्नुहोस्।
