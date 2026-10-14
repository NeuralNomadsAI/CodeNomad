# किबोर्ड सर्टकट

## command खोज र मद्दत {#discover-commands}

1. Windows/Linux मा `Ctrl+Shift+P` वा macOS मा `Cmd+Shift+P` बाट **कमाण्ड प्यालेट** खोल्नुहोस्, वा देखिने button/menu item प्रयोग गर्नुहोस्।
2. कार्य नाम लेख्नुहोस्। प्यालेटमा application कार्य र हालको Location का custom command छन्; उपलब्धता सक्रिय दृश्यमा निर्भर हुन्छ।
3. हालको UI भाषामा बाह्य browser सन्दर्भमा यो गाइड खोल्न **मद्दत खोल्नुहोस्** चलाउनुहोस्। नेटिभ **Help → CodeNomad Help** ले उही गाइड खोल्छ।

मद्दतले एप दृश्य र मस्यौदा छुँदैन। खोल्न असफल भए सोझै [CodeNomad Help](https://neuralnomadsai.github.io/CodeNomad/) जानुहोस्। command खोजिनुमा shortcut अनुकूलन गर्न मिल्छ भन्ने होइन: shortcut manager ले निश्चित 49-command renderer catalogue समेट्छ, सबै palette वा native-menu कार्य होइन।

## record, अक्षम र reset {#customize}

1. **सेटिङहरू → किबोर्ड सर्टकटहरू** खोली कार्य भेट्न **सर्टकटहरू छान्नुहोस्** प्रयोग गर्नुहोस्।
2. **सम्पादन** रोजेर **कुञ्जीहरूको संयोजन थिच्नुहोस्** मा चाहेको संयोजन थिच्नुहोस्। recording ले binding बचत गर्छ।
3. renderer binding हटाउन **निष्क्रिय पार्नुहोस्**, default फर्काउन **रिसेट**, वा सबै renderer binding का लागि **सबै रिसेट गर्नुहोस्** प्रयोग गर्नुहोस्।
4. conflict भएका हरेक row को चेतावनी समाधान गर्नुहोस्; conflict बताइन्छन्, चुपचाप अक्षम हुँदैनन्।

binding CodeNomad UI configuration मा बचत हुन्छन् र साझा गर्ने क्लाइन्टलाई असर गर्छन्। OpenCode CLI/TUI binding वा native menu accelerator सम्पादन गर्दैनन्। recording ले app renderer shortcut रोक्छ, तर OS वा native menu रोक्न सक्दैन। **रद्द गर्नुहोस्**, focus गुम्दा, खण्ड बन्द गर्दा वा विन्डो छोड्दा recording सकिन्छ। एक्ला modifier र IME composition बेवास्ता हुन्छन्; साधारण Tab/Shift+Tab ले focus सार्छ।

save असफल भए पुरानो shortcut उपलब्ध राख्नुहोस् र देखाइएको binding जाँचेर पुनःप्रयास गर्नुहोस्। आकस्मिक assignment का लागि Reset सुरक्षित पुनःप्राप्ति हो।

## Renderer default {#renderer-defaults}

`Mod` को अर्थ Windows/Linux मा `Ctrl` र macOS मा `Cmd` हो। यी default हुन्, OS/native host ले key पठाउँछ भन्ने प्रत्याभूति होइनन्। दायरा महत्त्वपूर्ण छ: एउटै key गृह पृष्ठ, कम्पोजर वा खोजमा फरक कार्य हुन सक्छ।

| कार्य | Default |
| --- | --- |
| command palette खोल्ने | `Mod+Shift+P` |
| नयाँ instance / गृह पृष्ठमा फोल्डर browse | `Mod+N` |
| app ट्याब बन्द | `Mod+W` |
| अघिल्लो / अर्को app ट्याब | `Mod+[` / `Mod+]` |
| app ट्याब 1–9 | `Mod+1` देखि `Mod+9` |
| instance नाम बदल्ने (tab context) | `F2` |
| नयाँ सत्र | `Mod+Shift+N` |
| सत्र बन्द | `Mod+Shift+W` |
| अघिल्लो / अर्को सत्र | `Mod+Shift+[` / `Mod+Shift+]` |
| सत्र ट्याब 1–9 | `Mod+Shift+1` देखि `Mod+Shift+9` |
| instance जानकारी | `Mod+Shift+L` |
| सत्र इतिहास खोज | `Mod+F` |
| अर्को / अघिल्लो खोज नतिजा (खोज focus मा) | `Enter` / `Shift+Enter` |
| prompt focus / prompt खाली | `Mod+P` / `Mod+K` |
| model / agent selector खोल्ने | `Mod+Shift+M` / `Mod+Shift+A` |
| model variant चयन | `Mod+Shift+T` |
| blocking tool background मा सार्ने (कम्पोजर) | `Mod+B` |
| prompt पठाउने | `Enter` |
| वैकल्पिक follow-up व्यवहारमा पठाउने | `Mod+Shift+Enter` |
| नयाँ line राख्ने | `Shift+Enter` वा `Mod+Enter` |
| अघिल्लो / अर्को prompt (कम्पोजर) | `ArrowUp` / `ArrowDown` |
| prompt focus हटाउने / shell mode छोड्ने | कम्पोजर सन्दर्भअनुसार `Escape` |
| सत्र रोक्ने | `Escape` दुईपटक; पहिलो थिचाइले पुष्टि देखाउँछ |
| छेउको प्रश्न पठाउने (`/btw` विन्डो) | `Mod+Enter` |
| फाइल बचत (workspace editor) | `Mod+S` |

Enter-to-submit अक्षम कन्फिगरेसनमा **इनपुट पठाउनुहोस्** को default `Mod+Enter` र **नयाँ पङ्क्ति थप्नुहोस्** को `Enter` वा `Shift+Enter` हुन्छ। स्पष्ट shortcut override ले default बदल्छ। प्रभावकारी binding manager मा हेर्नुहोस्। अघिल्लो/अर्को सत्रले session सूची घुमाउँछ; यो sidebar को browser-जस्तो **पछाडि**/**अगाडि** इतिहास होइन, जसको shortcut छैन।

## नेटिभ key र प्लेटफर्म interception {#native-keys}

नेटिभ key स्थिर छन् र सम्बन्धित renderer binding बदले वा अक्षम गरे पनि सक्रिय रहन्छन्। विशेष गरी native **New Window** ले `Mod+Shift+N` प्रयोग गर्छ, जुन renderer को New session default हो। native menu ले रोक्दा देखिने New Session नियन्त्रण प्रयोग गर्नुहोस् वा renderer action rebind गर्नुहोस्। त्यस्तै native `Mod+W` ले app ट्याब मात्र नभई विन्डो बन्द गर्न सक्छ।

| नेटिभ कार्य | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | View-menu नियन्त्रण र platform webview zoom input |
| Full Screen | Windows/Linux मा `F11`; macOS मा `Ctrl+Cmd+F` | macOS मा `Ctrl+Cmd+F` menu accelerator; अरू प्लेटफर्ममा menu प्रयोग गर्नुहोस् |
| Developer Tools | Windows/Linux मा `Ctrl+Shift+I`; macOS मा `Alt+Cmd+I` | `Alt+Mod+I` |

सामान्य browser विन्डोले आफ्ना shortcut पनि राख्छन्। binding CodeNomad सम्म नपुगे सुरक्षा अक्षम वा OS-भरका key बदल्नुको सट्टा अर्को संयोजन रोज्नुहोस्।

## किबोर्ड layout र पाठ प्रवेश {#layouts-ime}

अङ्क पङ्क्ति र square-bracket shortcut ले AZERTY/QWERTZ समेत recording, execution र conflict जाँचमा भौतिक key स्थान प्रयोग गर्छन्। अन्य key ले logical मान प्रयोग गर्छन्। प्रयोग गर्ने किबोर्डमै record गरेर देखिएको नतिजा जाँच्नुहोस्।

IME composition मा पाठ प्रवेश प्राथमिक हुन्छ। prompt history र Escape कार्य पनि focus, picker/shell अवस्था र हालको कार्यमा निर्भर छन्; हरेक ArrowUp वा Escape सर्तरहित global कार्य हो नमान्नुहोस्। hover tooltip र shortcut manager ले स्थायी keyboard-help strip नथपी हालको assignment देखाउँछन्।
