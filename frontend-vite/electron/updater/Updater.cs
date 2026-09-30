using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

// Standalone portable updater: wait for app processes, replace the portable
// exe, relaunch. Lives next to the app as PaperLabelerUpdater.exe so it is
// never the file being replaced and is not a child of Electron's job object
// once launched via cmd start.
class PaperLabelerUpdater
{
    static string logPath = "update.log";

    static void Log(string msg)
    {
        var line = "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + "] " + msg;
        try { File.AppendAllText(logPath, line + Environment.NewLine, Encoding.UTF8); } catch { }
    }

    static int Main(string[] args)
    {
        string oldExe = null, newExe = null, waitPids = null;
        int healthWaitSec = 8, replaceAttempts = 30;

        for (int i = 0; i < args.Length; i++)
        {
            var a = args[i];
            if (a == "--old" && i + 1 < args.Length) oldExe = args[++i];
            else if (a == "--new" && i + 1 < args.Length) newExe = args[++i];
            else if (a == "--pids" && i + 1 < args.Length) waitPids = args[++i];
            else if (a == "--log" && i + 1 < args.Length) logPath = args[++i];
            else if (a == "--health-wait" && i + 1 < args.Length) int.TryParse(args[++i], out healthWaitSec);
            else if (a == "--attempts" && i + 1 < args.Length) int.TryParse(args[++i], out replaceAttempts);
        }

        if (string.IsNullOrEmpty(logPath)) logPath = "update.log";
        Log("updater start old=" + oldExe + " new=" + newExe + " pids=" + waitPids);

        if (string.IsNullOrEmpty(oldExe) || !File.Exists(oldExe))
        {
            Log("old exe missing");
            return 1;
        }

        // 1) Wait for recorded pids (Electron + portable NSIS stub).
        if (!string.IsNullOrEmpty(waitPids))
        {
            foreach (var part in waitPids.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            {
                int pid;
                if (!int.TryParse(part.Trim(), out pid) || pid <= 0) continue;
                var deadline = DateTime.UtcNow.AddSeconds(120);
                while (DateTime.UtcNow < deadline)
                {
                    try
                    {
                        var p = Process.GetProcessById(pid);
                        if (p.HasExited) break;
                    }
                    catch { break; }
                    Thread.Sleep(200);
                }
            }
        }
        Thread.Sleep(800);

        if (string.IsNullOrEmpty(newExe) || !File.Exists(newExe))
        {
            Log("update file missing; relaunching current exe");
            StartApp(oldExe);
            return 1;
        }

        // 2) Replace with rollback. Prefer Move (same volume).
        string backup = oldExe + ".bak";
        bool replaced = false;
        for (int attempt = 1; attempt <= replaceAttempts; attempt++)
        {
            try
            {
                if (File.Exists(backup)) File.Delete(backup);
                if (File.Exists(oldExe)) File.Move(oldExe, backup);
                try { File.Move(newExe, oldExe); }
                catch
                {
                    File.Copy(newExe, oldExe, true);
                    try { File.Delete(newExe); } catch { }
                }
                if (!File.Exists(oldExe)) throw new Exception("replace produced no exe at target path");
                replaced = true;
                Log("replaced ok (attempt " + attempt + ")");
                break;
            }
            catch (Exception ex)
            {
                Log("replace failed (attempt " + attempt + "): " + ex.Message);
                try
                {
                    if (File.Exists(backup))
                    {
                        if (File.Exists(oldExe)) { try { File.Delete(oldExe); } catch { } }
                        File.Move(backup, oldExe);
                    }
                }
                catch (Exception rex) { Log("rollback failed: " + rex.Message); }
                Thread.Sleep(500);
            }
        }

        if (!replaced)
        {
            Log("replace abandoned; relaunching current exe");
            StartApp(oldExe);
            return 2;
        }

        // 3) Relaunch and health-check.
        var launched = StartApp(oldExe);
        if (launched == null)
        {
            RestoreAndLaunch(oldExe, backup, "Start-Process failed for new exe");
            return 3;
        }
        Log("relaunched pid=" + launched.Id);
        Thread.Sleep(Math.Max(0, healthWaitSec) * 1000);

        bool alive = false;
        try
        {
            var p = Process.GetProcessById(launched.Id);
            alive = !p.HasExited;
        }
        catch { alive = false; }

        if (!alive)
        {
            // Accept a child still under that pid, or another process from target path.
            if (!HasRelatedProcess(launched.Id, oldExe))
            {
                RestoreAndLaunch(oldExe, backup, "relaunched process exited quickly; rolling back");
                return 3;
            }
        }

        Log("startup looks healthy");
        try { if (File.Exists(backup)) File.Delete(backup); } catch { }
        return 0;
    }

    static bool HasRelatedProcess(int parentId, string exePath)
    {
        try
        {
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (p.Id == parentId) return true;
                }
                catch { }
            }
        }
        catch { }
        try
        {
            var q = new Process();
            q.StartInfo.FileName = "powershell.exe";
            q.StartInfo.Arguments = "-NoProfile -Command \"@(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq " + parentId + " -or ($_.ExecutablePath -and $_.ExecutablePath -ieq '" + exePath.Replace("'", "''") + "') }).Count\"";
            q.StartInfo.UseShellExecute = false;
            q.StartInfo.RedirectStandardOutput = true;
            q.StartInfo.CreateNoWindow = true;
            q.Start();
            var outp = q.StandardOutput.ReadToEnd().Trim();
            q.WaitForExit(3000);
            int n;
            if (int.TryParse(outp, out n) && n > 0) return true;
        }
        catch { }
        return false;
    }

    static Process StartApp(string exePath)
    {
        if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return null;
        try
        {
            var psi = new ProcessStartInfo(exePath)
            {
                WorkingDirectory = Path.GetDirectoryName(exePath),
                UseShellExecute = true,
            };
            return Process.Start(psi);
        }
        catch (Exception ex)
        {
            Log("Start-App failed for " + exePath + ": " + ex.Message);
            return null;
        }
    }

    static void RestoreAndLaunch(string target, string backupPath, string reason)
    {
        Log(reason);
        try
        {
            if (File.Exists(backupPath))
            {
                if (File.Exists(target)) { try { File.Delete(target); } catch { } }
                File.Move(backupPath, target);
                Log("restored previous exe from backup");
            }
        }
        catch (Exception ex) { Log("restore failed: " + ex.Message); }
        var p = StartApp(target);
        if (p != null) Log("relaunched pid=" + p.Id);
        else Log("relaunch after restore failed");
    }
}
