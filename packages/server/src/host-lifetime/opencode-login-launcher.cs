using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text.RegularExpressions;

// GUI subsystem entry point: Task Scheduler never creates a console for this
// process. CreateNoWindow keeps the console program it starts hidden as well,
// including from default-terminal delegation. It starts and exits: no waiting,
// no watching, no restart.
// Usage: opencode-login-launcher.exe [--env NAME=VALUE]... -- <program> [arguments]...
internal static class OpenCodeLoginLauncher {
    private static string Quote(string value) {
        if (value.Length > 0 && !Regex.IsMatch(value, "[\\s\"]")) return value;
        return "\"" + Regex.Replace(Regex.Replace(value, "(\\\\*)\"", "$1$1\\\""), "(\\\\+)$", "$1$1") + "\"";
    }

    private static int Main(string[] args) {
        var environment = new List<KeyValuePair<string, string>>();
        int index = 0;
        while (index + 1 < args.Length && args[index] == "--env") {
            var pair = args[index + 1];
            int separator = pair.IndexOf('=');
            if (separator <= 0) return 1;
            environment.Add(new KeyValuePair<string, string>(pair.Substring(0, separator), pair.Substring(separator + 1)));
            index += 2;
        }
        if (index + 1 >= args.Length || args[index] != "--") return 1;
        try {
            var arguments = new string[args.Length - index - 2];
            for (int i = index + 2; i < args.Length; i++) arguments[i - index - 2] = Quote(args[i]);
            var info = new ProcessStartInfo(args[index + 1], string.Join(" ", arguments));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.WindowStyle = ProcessWindowStyle.Hidden;
            foreach (var entry in environment) info.EnvironmentVariables[entry.Key] = entry.Value;
            using (Process.Start(info)) { }
            return 0;
        } catch { return 1; }
    }
}
