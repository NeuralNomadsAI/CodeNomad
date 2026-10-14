# सहयोग र source build

bug report, current release र contribution का लागि repository प्रयोग गर्नुहोस्। issue report अघिको सुरक्षित recovery [समस्या समाधान गाइड](troubleshooting.md) मा छ।

## bug report गर्नुहोस् {#report-a-bug}

1. **सेटिङहरू → जानकारी → निदान (Diagnostics)** खोल्नुहोस्।
2. GitHub issue form खोल्न **बग रिपोर्ट गर्नुहोस्** चयन गर्नुहोस्।
3. prefilled version/client जानकारी समीक्षा गर्नुहोस्। न्यूनतम reproduction, अपेक्षित व्यवहार र वास्तविक नतिजा थपेर GitHub बाट बुझाउनुहोस्।

कार्यले CodeNomad/OpenCode version, OS र bounded client/runtime context पूर्वभर्छ। listener address, workspace path, credential वा conversation text भर्दैन। form खोल्नु issue बुझाउनु होइन।

थप निदान चाहिए **क्लिपबोर्डमा प्रतिलिपि गर्नुहोस्** वा **.txt डाउनलोड गर्नुहोस्** ले छुट्टै report बनाउँछ। त्यस विस्तृत report मा local path र network address हुन सक्छन्: attach अघि review/redact गर्नुहोस्। automatic diagnostic report ले authentication secret हटाए पनि screenshot वा log अंशमा secret हुन सक्छन्।

GitHub form मा incompatible field भए CodeNomad ले उही report जानकारीसहित plain issue खोल्छ। form पढ्दाको अस्थायी failure ले खोल्न रोक्दैन। सधैं [issue सूची](https://github.com/NeuralNomadsAI/CodeNomad/issues) हातैले प्रयोग गर्न सकिन्छ।

## समुदाय र release {#community}

| स्रोत | प्रयोग |
| --- | --- |
| [CodeNomad repository](https://github.com/NeuralNomadsAI/CodeNomad) | source, project गतिविधि र documentation। |
| [Issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) | reproducible bug वा feature request खोल्नुअघि विद्यमान report खोज्नुहोस्। |
| [Pull requests](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | प्रस्तावित परिवर्तन समीक्षा वा contribution समन्वय। |
| [नवीनतम release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | stable download artifact। |
| [सबै release](https://github.com/NeuralNomadsAI/CodeNomad/releases) | published preview र release note। |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | project संगठन। |
| [MIT license](../../../LICENSE) | license सर्त। |

CodeNomad नियन्त्रणभन्दा native OpenCode configuration का समस्यामा [OpenCode दस्तावेज](https://opencode.ai/v2/docs/) र [upstream release](https://github.com/anomalyco/opencode/releases) हेर्नुहोस्।

## source बाट build {#build-from-source}

`.node-version` मा pinned Node.js **24.20.0**, npm, Git र compatible OpenCode CLI प्रयोग गर्नुहोस्। development checkout बाट आदेश चलाउनुहोस्:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` ले Electron development host सुरु गर्छ। Tauri मा पहिले Rust toolchain समेत [platform build prerequisites](https://v2.tauri.app/start/prerequisites/) स्थापना गरी चलाउनुहोस्:

```sh
npm run dev:tauri
```

development परिवर्तनले development host प्रभावित गर्छन्, स्वतन्त्र चलिरहेको OpenCode daemon को installed version होइन। native packaging लाई उचित target tool चाहिन्छ; target OS मै build प्राथमिकता दिनुहोस्।

### build र validation {#build-and-validate}

| repository root बाट command | उद्देश्य |
| --- | --- |
| `npm run build` | Electron application resource build। |
| `npm run build:tauri` | native prerequisite सहित Tauri application build। |
| `npm run build:ui` | browser UI build। |
| `npm run build --workspace @neuralnomads/codenomad` | standalone server र bundled asset build। |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Electron Debian release package। |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Linux Tauri AppImage package। |
| `npm run typecheck` | root का configured TypeScript workspace जाँच। |
| `npm run test:help` | सबै public-help locale र link validation। |
| `npm run build:help` | standalone public help `dist/help` मा build। |

help build लाई running CodeNomad वा OpenCode service चाहिँदैन। packaging विवरणका लागि [BUILD.md](../../../BUILD.md), scoped validation र PR convention का लागि [CONTRIBUTING.md](../../../CONTRIBUTING.md) हेर्नुहोस्; target package मा वास्तवमै भएका script प्रयोग गर्नुहोस्।

## package नक्सा र योगदान {#contribute}

| Package | जिम्मेवारी |
| --- | --- |
| `packages/server` | workspace/API/Git नियन्त्रण, OpenCode जडान, auth, event र speech। |
| `packages/ui` | SolidJS workspace, नियन्त्रण, localization र browser help entry point। |
| `packages/electron-app` | Electron window, native integration र packaging। |
| `packages/tauri-app` | Tauri window, platform integration र packaging। |
| `packages/remote-tunnel` | backend-side OpenTunnel transport runtime। |

1. overlap हुने काम लागू गर्नुअघि सम्बन्धित issue मा scope छलफल गर्नुहोस्।
2. `dev` बाट branch बनाई परिवर्तन केन्द्रित राख्नुहोस्।
3. प्रभावित क्षेत्रका check चलाउनुहोस्, व्यवहारसँग user help update गर्नुहोस् र PR `dev` मा लक्षित गर्नुहोस्।

public help स्रोत `docs/help/<locale>/` मा छन्। अनुवादमा हरेक English heading को explicit ID, level र order जोगाउनुहोस्; translated heading ले deep link बिगार्नु हुँदैन। [help maintenance contract](../../../dev-docs/USER_HELP.md) ले कडा completeness check र static publishing pipeline बताउँछ।
