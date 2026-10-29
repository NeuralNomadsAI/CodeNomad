# CodeNomad डाउनलोड गर्नुहोस्

Windows, macOS र Linux का लागि निःशुल्क र खुला-स्रोत (MIT) डेस्कटप एप। यो तपाईंको OpenCode सेवासँग जोडिन्छ; पहिले [आवश्यकता](install.md#requirements) जाँच्नुहोस्।

## डेस्कटप एप {#desktop}

{{release}}

{{download-button}}

| प्लेटफर्म | Tauri (सिफारिस गरिएको) | Electron |
| --- | --- | --- |
| Windows 10 वा पछिको | [Installer, x64](release:tauri-windows-x64) | [ZIP, x64](release:electron-windows-x64) |
| macOS 13.5 वा पछिको | [ZIP, Apple Silicon](release:tauri-macos-arm64) · [ZIP, Intel](release:tauri-macos-x64) | [ZIP, Apple Silicon](release:electron-macos-arm64) · [ZIP, Intel](release:electron-macos-x64) |
| Linux x64 (Ubuntu 24.04 मा परीक्षण गरिएको) | [AppImage, x64](release:tauri-linux-x64) | [Debian प्याकेज, x64](release:electron-linux-x64) |

दुवै build ले उही कार्यस्थान दिन्छन्। Tauri ले एपभित्रैबाट अपडेट स्थापना गर्न सक्छ; Electron नयाँ रिलिज डाउनलोड गरेर अपडेट हुन्छ र हरेक प्लेटफर्ममा नेटिभ ब्राउजर स्वचालन समर्थन गर्छ (Tauri ले Windows मा मात्र)। [build हरू तुलना गर्नुहोस्](install.md#desktop-downloads)।

## प्याकेज म्यानेजर {#package-managers}

Windows मा winget ले Tauri build स्थापना गर्छ:

```sh
winget install NeuralNomadsAI.CodeNomad
```

CodeNomad लाई स्वतन्त्र सर्भरका रूपमा चलाएर ब्राउजरमा प्रयोग गर्न, Node.js 24 भएको होस्टमा npm बाट सुरु गर्नुहोस्:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

[स्वतन्त्र सर्भर](server.md#run) पृष्ठले पहिलो साइन-इन, global स्थापना, ठेगाना र प्रमाणीकरण समेट्छ; [आवश्यकता](install.md#requirements) मा Node.js, Git र OpenCode सूचीबद्ध छन्।

## स्थापना र पहिलो सुरुवात {#verify-and-install}

यो पृष्ठ वा [आधिकारिक रिलिज](https://github.com/NeuralNomadsAI/CodeNomad/releases) बाट मात्र डाउनलोड गर्नुहोस्, र चेतावनी छल्नकै लागि अविश्वसनीय archive कहिल्यै नचलाउनुहोस्।

- **Linux**: AppImage लाई executable बनाउनुहोस् वा Debian प्याकेज स्थापना गर्नुहोस्; [Linux मा स्थापना](install.md#linux-install) हेर्नुहोस्।
- **macOS**: macOS ले पहिलो सुरुवात रोकेमा [macOS quarantine](troubleshooting.md#macos-quarantine) हेर्नुहोस्।
- **हरेक प्लेटफर्म**: [आवश्यकता](install.md#requirements) मा सूचीबद्ध Git र अनुकूल OpenCode CLI स्थापना गर्नुहोस्, त्यसपछि [पहिलो सुरुवातमा OpenCode चयन गर्नुहोस्](install.md#first-launch)। सुरुवातका अन्य समस्या [समस्या समाधान](troubleshooting.md#desktop-launch) मा समेटिएका छन्।

## विकासलाई आर्थिक सहयोग गर्नुहोस् {#support-development}

CodeNomad निःशुल्क छ र स्वयंसेवकहरूले आफ्नै समयमा यसलाई maintain गर्छन्। यो तपाईं वा तपाईंको टोलीका लागि उपयोगी छ भने, प्रायोजनले यसलाई maintain गर्न र नयाँ OpenCode रिलिजसँग अनुकूल राख्न मद्दत गर्छ। प्रायोजनले के खर्च बेहोर्छ भन्ने कुरा [CodeNomad लाई आर्थिक सहयोग गर्नुहोस्](sponsor.md) पृष्ठले बताउँछ।

{{funding}}
