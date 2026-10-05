using System;
using System.Collections.Generic;
using System.IO;

namespace Guardian
{
    public class FileEntry
    {
        public string Path;
        public long Size;
        public long MTimeTicks;
        public long ATimeTicks;
    }

    public class WalkResult
    {
        public List<FileEntry> Entries = new List<FileEntry>();
        public long TotalFiles;
        public long TotalBytes;
        public long MatchedBytes;
        public int Errors;
        public bool Truncated;
    }

    // Fast, defensive file-system walker. Never follows reparse points (junctions/symlinks),
    // skips cloud-only placeholders (OneDrive "Files On-Demand"), tolerates access-denied and vanished files,
    // and honours a hard deadline so a scan can never run past its time budget.
    public static class FsWalker
    {
        const int FILE_ATTRIBUTE_OFFLINE = 0x1000;
        const int FILE_ATTRIBUTE_RECALL_ON_OPEN = 0x40000;
        const int FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS = 0x400000;

        public static WalkResult Walk(string root, string[] excluded, long minSize, DateTime olderThanUtc, int maxEntries, DateTime deadlineUtc)
        {
            WalkResult res = new WalkResult();
            Stack<string> stack = new Stack<string>();
            stack.Push(root);
            List<string> ex = new List<string>();
            if (excluded != null)
            {
                foreach (string e in excluded) { if (!string.IsNullOrEmpty(e)) ex.Add(e.TrimEnd('\\')); }
            }
            bool filterAge = olderThanUtc != DateTime.MinValue;
            while (stack.Count > 0)
            {
                if (DateTime.UtcNow > deadlineUtc) { res.Truncated = true; break; }
                string dir = stack.Pop();
                bool skip = false;
                foreach (string e in ex)
                {
                    if (dir.Equals(e, StringComparison.OrdinalIgnoreCase) || dir.StartsWith(e + "\\", StringComparison.OrdinalIgnoreCase)) { skip = true; break; }
                }
                if (skip) continue;
                FileSystemInfo[] items;
                try { items = new DirectoryInfo(dir).GetFileSystemInfos(); }
                catch (Exception) { res.Errors++; continue; }
                foreach (FileSystemInfo fsi in items)
                {
                    try
                    {
                        FileAttributes a = fsi.Attributes;
                        if ((a & FileAttributes.ReparsePoint) != 0) continue;
                        if ((a & FileAttributes.Directory) != 0) { stack.Push(fsi.FullName); continue; }
                        int ai = (int)a;
                        if ((ai & (FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS)) != 0) continue;
                        FileInfo fi = (FileInfo)fsi;
                        long len = fi.Length;
                        res.TotalFiles++;
                        res.TotalBytes += len;
                        if (len < minSize) continue;
                        if (filterAge && fi.LastWriteTimeUtc > olderThanUtc) continue;
                        res.MatchedBytes += len;
                        if (res.Entries.Count >= maxEntries) { res.Truncated = true; continue; }
                        FileEntry fe = new FileEntry();
                        fe.Path = fi.FullName;
                        fe.Size = len;
                        fe.MTimeTicks = fi.LastWriteTimeUtc.Ticks;
                        fe.ATimeTicks = fi.LastAccessTimeUtc.Ticks;
                        res.Entries.Add(fe);
                    }
                    catch (Exception) { res.Errors++; }
                }
            }
            return res;
        }
    }
}
