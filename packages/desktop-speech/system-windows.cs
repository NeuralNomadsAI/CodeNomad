using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Speech.Recognition;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Runs only in a disposable child of the desktop host; never attaches to the shared recognizer.
internal static class SystemSpeech {
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private const string RecognizerClass = "{DAC9F469-0C67-4643-9258-87EC128C5941}";
    private const int MaxText = 64 * 1024;

    private static void Emit(object frame) {
        Console.WriteLine(Json.Serialize(frame));
        Console.Out.Flush();
    }

    private static int Error(string error) {
        Emit(new { error });
        return 0;
    }

    private static bool IsDesktop(RecognizerInfo info) {
        if (!info.AdditionalInfo.ContainsKey("Desktop") ||
            !info.AdditionalInfo.ContainsKey("Dictation") ||
            !info.AdditionalInfo.ContainsKey("Vendor") ||
            info.AdditionalInfo["Vendor"] != "Microsoft" ||
            !String.Equals(info.Id, "MS-" + info.Culture.LCID + "-80-DESK", StringComparison.OrdinalIgnoreCase))
            return false;
        using (var token = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Speech\Recognizers\Tokens\" + info.Id)) {
            return token != null &&
                String.Equals(token.GetValue("CLSID") as string, RecognizerClass, StringComparison.OrdinalIgnoreCase) &&
                Object.Equals(token.GetValue("Server Mode"), 0);
        }
    }

    private static SpeechRecognitionEngine Open(RecognizerInfo info) {
        var engine = new SpeechRecognitionEngine(info);
        try {
            engine.LoadGrammar(new DictationGrammar());
            return engine;
        } catch {
            engine.Dispose();
            throw;
        }
    }

    private static string[] Probe(IEnumerable<RecognizerInfo> candidates) {
        var locales = new List<string>();
        foreach (var candidate in candidates) {
            try { using (Open(candidate)) locales.Add(candidate.Culture.Name); }
            catch (InvalidOperationException) {}
            catch (System.Runtime.InteropServices.COMException) {}
        }
        return locales.Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(locale => locale, StringComparer.OrdinalIgnoreCase).ToArray();
    }

    private static int Recognize(SpeechRecognitionEngine engine, string fixture) {
        var text = new StringBuilder();
        var progress = new object();
        var complete = new ManualResetEvent(false);
        var input = new ManualResetEvent(false);
        RecognizeCompletedEventArgs outcome = null;
        bool aborted = false, finish = false, overflow = false;
        bool transcribing = false;
        int bytes = 0;
        engine.SpeechRecognized += (_, args) => {
            lock (progress) {
                var word = args.Result.Text;
                bytes += Encoding.UTF8.GetByteCount(word) + (text.Length == 0 ? 0 : 1);
                if (bytes > MaxText) overflow = true;
                if (overflow) return;
                if (text.Length != 0) text.Append(' ');
                text.Append(word);
                if (!transcribing) Emit(new { progress = new { state = "recording", text = text.ToString() } });
            }
        };
        engine.RecognizeCompleted += (_, args) => { outcome = args; complete.Set(); };
        if (fixture == null) {
            var lease = new Thread(() => {
                try {
                    finish = Console.ReadLine() == "finish";
                    input.Set();
                    if (!finish) return;
                    // The pipe remains open during graceful stop; EOF still cancels inference.
                    Console.ReadLine();
                } catch (IOException) {
                    // A broken owner pipe is equivalent to EOF.
                } finally {
                    aborted = true;
                    input.Set();
                }
            }) { IsBackground = true };
            lease.Start();
            engine.SetInputToDefaultAudioDevice();
        } else {
            engine.SetInputToWaveFile(fixture);
        }
        if (fixture == null) Emit(new { progress = new { state = "recording" } });
        engine.RecognizeAsync(RecognizeMode.Multiple);
        int signal = WaitHandle.WaitAny(new WaitHandle[] { complete, input }, TimeSpan.FromSeconds(120));
        if (signal != 0) {
            if (aborted || !finish) {
                engine.RecognizeAsyncCancel();
                complete.WaitOne(TimeSpan.FromSeconds(2));
                return Error("failed");
            }
            input.Reset();
            lock (progress) {
                transcribing = true;
                Emit(new { progress = new { state = "transcribing" } });
            }
            engine.RecognizeAsyncStop();
            if (aborted || WaitHandle.WaitAny(new WaitHandle[] { complete, input }, TimeSpan.FromSeconds(10)) != 0) {
                engine.RecognizeAsyncCancel();
                complete.WaitOne(TimeSpan.FromSeconds(2));
                return Error("failed");
            }
        }
        engine.SetInputToNull();
        lock (progress) {
            transcribing = true;
            if (aborted || overflow || outcome == null || outcome.Error != null || (outcome.Cancelled && !finish)) return Error("failed");
            Emit(new { value = text.ToString() });
        }
        return 0;
    }

    private static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            var candidates = SpeechRecognitionEngine.InstalledRecognizers().Where(IsDesktop).ToArray();
            if (args.Length == 1 && args[0] == "probe") {
                Emit(new { value = Probe(candidates) });
                return 0;
            }
            if (!((args.Length == 2 && args[0] == "dictate") || (args.Length == 3 && args[0] == "clip")))
                return Error("failed");
            var culture = CultureInfo.GetCultureInfo(args[1]);
            var info = candidates.FirstOrDefault(candidate => candidate.Culture.Name == culture.Name);
            if (info == null) return Error("localeUnavailable");
            using (var engine = Open(info)) return Recognize(engine, args.Length == 3 ? args[2] : null);
        } catch (UnauthorizedAccessException) {
            return Error("permissionDenied");
        } catch {
            return Error("failed");
        }
    }
}
