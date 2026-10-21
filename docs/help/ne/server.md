# स्वतन्त्र सर्भर

project र tool भएको ठाउँमा CodeNomad चलाएर स्थानीय वा remote browser UI प्रयोग गर्नुहोस्। backend ले filesystem पहुँच, Git कार्य, authentication र event delivery दिन्छ। साझा OpenCode सेवाले कुराकानी र execution स्वामित्व राख्छ; browser disconnect हुँदा रोक्ने child server होइन।

उही UI ले [धेरै project tab र worktree](projects.md), [conversation परिवार र background activity](conversations.md), [bounded history loading, search र timeline navigation](history.md), र [command palette र shortcut](shortcuts.md) समर्थन गर्छ। browser र tablet पहुँचले execution host बाहिर सार्दैन।

## host तयार गर्नुहोस् {#prerequisites}

1. Node.js 24 LTS र npm स्थापना गर्नुहोस्; repository को pinned build runtime 24.20.0 हो। desktop package मा Node/npm हुन्छ।
2. Git लाई **backend प्रक्रियाको PATH** मा राख्नुहोस्। WSL भित्रको Git मात्र Windows backend का लागि पुग्दैन।
3. OpenCode स्थापना वा चयन गर्नुहोस्: आवश्यक न्यूनतम **2.1.2**, सिफारिस qualification लक्ष्य **2.1.2**। नयाँ/custom build मा compatibility जाँच हुन्छ, tested-version allowlist होइन। [OpenCode सेटअप](opencode.md) हेर्नुहोस्।
4. server सुरु गर्ने फोल्डर रोज्नुहोस्, वा `--workspace-root` स्पष्ट दिनुहोस्।

Git बिना स्पष्ट खोलिएको physical folder मा मात्र कुराकानी उपलब्ध हुन्छन्; Git र worktree कार्य असफल हुन्छन्। Git स्थापना र PATH परिवर्तनपछि backend restart गर्नुहोस्। workspace root ले opening/browsing सीमित गर्छ, agent execution होइन: [सुरक्षा](security.md) हेर्नुहोस्।

## चलाउनुहोस् वा स्थापना {#run}

एउटा स्थापना विधि रोज्नुहोस्। यी first-run उदाहरणले shell history मा password राख्नुको सट्टा local bootstrap प्रयोग गर्छन्:

### npx बाट चलाउने {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Global स्थापना {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### project मा स्थापना {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

उपलब्ध भए `npx codenomad` ले project को installed binary प्रयोग गर्छ। यसले package project मा स्थापना गर्छ; configuration वा OpenCode storage project-local **बनाउँदैन**।

1. host मा छापिएको **Local Connection URL** खोल्नुहोस्। [local bootstrap](security.md) पूरा गरी persistent server password बचत गर्नुहोस्। HTTPS trust तयार नभए उक्त प्रक्रियामा loopback-only HTTP setup विकल्प छ।
2. पछिका start मा `--generate-token` नदिनुहोस्; वा हरेक start मा `CODENOMAD_SERVER_PASSWORD` दिनुहोस्।
3. installed CLI विकल्प हेर्न `codenomad --help` प्रयोग गर्नुहोस्।

आदेश foreground मा चल्छन्। terminal बन्द वा Ctrl+C गर्दा backend र Remote Control जडान रोकिन्छ। `--launch` ले browser मात्र खोल्छ; server daemonize गर्दैन। unattended उपलब्धतामा स्पष्ट configuration, working directory, environment र restart policy सहित OS process/service manager अन्तर्गत उही आदेश चलाउनुहोस्। service log वा सार्वजनिक unit file मा secret नराख्नुहोस्।

browser बन्द गर्दा छुट्टै चलिरहेको standalone backend रोकिँदैन। project tab बन्द गर्दा त्यो परियोजना CodeNomad मा बन्द हुन्छ र CodeNomad ले त्यो जडान पछ्याउन छोड्छ। OpenCode Location हट्दैन र सत्र चलिरहन्छन्; परियोजना फेरि खोल्दा ती भेटिन्छन्। backend shutdown ले पनि OpenCode चलिरहन्छ। CodeNomad नफर्केसम्म backend-dependent सुविधा अनुपलब्ध हुन्छन्; छुट्टै native scheduling आयुका लागि [मिसन](missions.md) हेर्नुहोस्।

## ठेगाना र port {#addresses}

startup ले **Local Connection URL**, उपलब्ध भए **Remote Connection URL**, र लागू भए **Other Accessible URLs** छाप्छ। अनुमान होइन छापिएको scheme र port प्रयोग गर्नुहोस्। loopback URL त्यही machine बाट मात्र पुगिन्छ; छापिएको LAN ठेगानालाई अझै routing र firewall पहुँच चाहिन्छ।

HTTPS ले **9898** र HTTP ले **9899** प्राथमिकता दिन्छ। port override नहुँदा व्यस्त preferred port OS-assigned port मा फर्कन्छ। स्पष्ट nonzero port fallback हुँदैन; `0` ले OS-assigned माग्छ। port 0 देखि 65535 सम्म integer हुन्छन्।

listener exposure, certificate, VPN/SSH र reverse proxy का लागि [प्रत्यक्ष रिमोट पहुँच](remote-access.md) हेर्नुहोस्। inbound port बिनाको पहुँचका लागि [Remote Control](remote-control.md) प्रयोग गर्नुहोस्।

## सार्वजनिक CLI सन्दर्भ {#cli-reference}

flag ले environment counterpart override गर्छन्। value-taking flag ले देखाइएको argument लिन्छन्; switch ले लिँदैनन्। HTTPS/HTTP मानले case-insensitive `1`, `true`, `yes`, `y` र `on` लाई enabled मान्छन्; स्पष्टताका लागि `true`/`false` प्रयोग गर्नुहोस्। UI auto-update ले `1`, `true` र `yes` चिन्छ।

**कडा boolean environment variable** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` र `CODENOMAD_SKIP_AUTH`) ले `1`, `true`, `yes` वा `on` हुँदा switch सक्षम गर्छन्; ठूला/साना अक्षर र सुरु तथा अन्त्यका whitespace बेवास्ता गरिन्छन्। `0`, `false`, `no`, `off`, खाली वा whitespace मात्र भएका मान र unset variable ले switch बन्द नै राख्छन्। अन्य कुनै मानले सम्बन्धित CLI flag भए पनि server सुरु हुन दिँदैन। CLI flag ले मान्य बन्द मानलाई उछिनेर switch सक्षम गर्छ; अन्यथा तलका `false` default लागू हुन्छन्।

| Flag | Environment | Default र असर |
| --- | --- | --- |
| `-h, --help` | — | मद्दत छापेर बाहिरिने। |
| `-v, --version` | — | installed package version छापेर बाहिरिने। |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`; `localhost` IPv4 loopback मा normalize हुन्छ। IPv6 zone identifier अस्वीकार हुन्छन्। [binding matrix](remote-access.md) हेर्नुहोस्। |
| `--https <enabled>` | `CLI_HTTPS` | `true`; HTTPS listener। |
| `--http <enabled>` | `CLI_HTTP` | `false`; HTTP listener। कम्तीमा एउटा listener enabled हुनुपर्छ। |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` preferred; `0` automatic। |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` preferred; `0` automatic। |
| `--tls-key <path>` | `CLI_TLS_KEY` | unset; PEM private key, `--tls-cert` चाहिन्छ। |
| `--tls-cert <path>` | `CLI_TLS_CERT` | unset; PEM certificate, `--tls-key` चाहिन्छ। |
| `--tls-ca <path>` | `CLI_TLS_CA` | unset; supplied certificate को ऐच्छिक PEM CA chain। |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | unset; generated certificate का थप comma-separated DNS नाम/IP। |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | process working directory; workspace खोल्ने root। |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`; full-filesystem browsing अनुमति। agent sandbox सेटिङ होइन। |
| `--config <path>` | `CLI_CONFIG` | resolved active default: `~/.config/codenomad/config.yaml`। स्पष्ट स्थानका लागि directory वा YAML file स्वीकार्छ। |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`; documented level: `trace`, `debug`, `info`, `warn`, `error`। |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`; अन्यथा चयनित file मा लेख्छ। |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`; runtime auth username। runtime password override नभए stored auth file ले आफ्नै username राख्छ। |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | unset; runtime-only password, managed auth file भन्दा अघि पर्छ। |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`; अक्षर, अङ्क, `_` र `-` बाहेक character `_` बन्छन्। |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`; one-use, 60-second local bootstrap token छाप्छ। |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`; direct-listener authentication अक्षम। खतरनाक: [सुरक्षा](security.md) हेर्नुहोस्। Remote Control लाई अझै device pairing चाहिन्छ। |
| `--ui-dir <path>` | `CLI_UI_DIR` | package को `public` directory; explicit override ले remote UI resolution को सट्टा त्यो UI serve गर्छ। |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | unset; HTTP listener हुँदै UI proxy। development मा `--https=false --http=true`; HTTPS listener ले dev UI proxy गर्दैन। |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`; auto-update override गरी उपलब्ध cached/bundled UI प्रयोग गर्छ। |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`; startup मा compatible remote UI जाँच्छ। |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`; remote UI manifest। |
| `--launch` | `CLI_LAUNCH` | `false`; startup पछि browser मा local UI खोल्छ। |
| `--upgrade [version]` | — | default मा upgrade हुँदैन। माग्दा global `@neuralnomads/codenomad@latest` वा दिइएको version स्थापना गरी बाहिरिन्छ। |

सार्वजनिक सन्दर्भमा user-facing विकल्प छन्; desktop host ले निजी launch coordination आफैं व्यवस्थापन गर्छन्।

### थप deployment environment {#deployment-environment}

| Variable | Default र दायरा |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`; release offer का लागि query गरिने repository। |
| `CODENOMAD_REMOTE_CONTROL_API` | unset: hosted OpenTunnel API। self-hosted relay deployment का लागि API origin सेट गर्नुहोस्। |
| `NODE_EXTRA_CA_CERTS` | Node को ऐच्छिक additional CA file; missing OpenCode daemon सुरु गर्दा allowed startup environment सँग पठाइन्छ। चलिरहेको daemon बदल्दैन। |

provider-specific usage credential [प्रदायक](providers.md) मा छन्। desktop data-profile चयन [डेस्कटप](desktop.md) मा छ, release feed ले नियन्त्रण गर्दैन।

## configuration र storage स्वामित्व {#storage}

तलका default path backend user को home मा छन्। स्पष्ट `--config` directory ले configuration base बदल्छ; YAML filename ले त्यो file र छेउको state/storage चयन गर्छ। deployment का लागि एउटा अभिप्रेत configuration identity प्रयोग गरी पूरा directory OS permission बाट जोगाउनुहोस्।

| स्वामी/data | Default स्थान वा नियम |
| --- | --- |
| स्थिर CodeNomad preference | `~/.config/codenomad/config.yaml` |
| परिवर्तनशील CodeNomad state | `~/.config/codenomad/state.yaml` |
| CodeNomad instance metadata | `~/.config/codenomad/instances/` |
| password hash | सक्रिय YAML configuration छेउ `auth.json`; app-managed। |
| generated TLS certificate र private key | configuration base मुनि `tls/`। |
| Remote Control route, enabled चयन र device hash | configuration base मुनि `remote-control-devices.json`। |
| temporary workspace registry र folder | त्यही base मुनि `temporary-workspaces.json` र `temporary-workspaces/`। |
| स्थापित panel extension र permission receipt | त्यही base मुनि `panel-extensions/` र `permission-receipts/`। |
| downloaded UI cache | `~/.config/codenomad/ui/`; custom `--config` भए पनि CLI UI resolver ले home-based cache प्रयोग गर्छ। |
| OpenCode कुराकानी, message, service registration र provider connection | execution host को OpenCode global storage, CodeNomad instance directory होइन। |
| desktop restore state | default `~/.codenomad/client-state/v2/`; profile/window दायराका लागि [डेस्कटप](desktop.md) हेर्नुहोस्। |

CodeNomad विद्यमान साझा daemon मा जोडिन्छ वा नभए सुरु गर्छ। startup environment ले नयाँ सुरु daemon मात्र प्रभावित गर्छ। छुट्टै, configured complete session environment प्रत्येक prompt, custom command वा session shell अनुरोधअघि लागू हुन्छ, preference हेर्दा/सम्पादन गर्दा होइन। [OpenCode सेटअप](opencode.md) हेर्नुहोस्।

## event र reconnect {#events}

backend ले साझा native OpenCode event stream ग्रहण गरी Server-Sent Events बाट workspace र CodeNomad event browser client लाई multiplex गर्छ। delivery live र अस्थायी हो: **event replay सुनिश्चित छैन**।

reconnect पछि UI ले authoritative session र pending-request state फेरि ल्याउँछ; file/configuration invalidation ले पनि नयाँ read चलाउँछ। reconnect जवाफ हराएको send, delete, answer वा अन्य mutation दोहोर्‍याउने अनुमति होइन। पहिले परिणाम अवस्था जाँच्नुहोस्। recovery अपूर्ण हुँदा ज्ञात pending request र draft राखिन्छन्; [अनुमति](permissions.md) र [समस्या समाधान](troubleshooting.md) हेर्नुहोस्।

## preview package र maintenance {#maintenance}

preview CLI package स्पष्ट प्रयास गर्न:

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

अलग CodeNomad सेटिङ चाहिए जानाजानी छुट्टै configuration प्रयोग गर्नुहोस्; package चयनले shared OpenCode storage अलग गर्दैन। **सेटिङहरू → जानकारी → अपडेटहरू → अपडेट फिड** ले offered release नियन्त्रण गर्छ, backend data identity वा installed package होइन।

`codenomad --upgrade` ले पत्ता लागेको npm/pnpm/bun manager (नभेटिए npm) बाट global stable CLI package update गर्छ। चलिरहेको server restart वा OpenCode update गर्दैन। project-local वा preview installation मा ठ्याक्कै त्यो npm package explicit update गर्नुहोस्। update पछि managed CodeNomad process सचेत restart गरी छापिएका address फेरि जाँच्नुहोस्।

desktop maintenance का लागि [अपडेट](updates.md), source-build command का लागि [सहयोग](support.md), provider plan usage का लागि [प्रदायक](providers.md) हेर्नुहोस्।
