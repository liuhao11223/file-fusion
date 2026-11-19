# explorer-lib.ps1
# Shared helpers for reading the current Explorer selection.
# Dot-sourced by explorer-select.ps1 (one-shot read) and explorer-watch.ps1
# (continuous watcher).
#
# The selection is read through UI Automation, which reports the items that
# are actually selected without touching the selection. The previous
# implementation used AppActivate + Ctrl+A, which replaced the user's own
# multi-selection with "select all".

$ErrorActionPreference = 'SilentlyContinue'

# UI Automation assemblies are required by Get-UiaSelectedNames. Load them here so
# every consumer of this library works, not only the scripts that load them.
try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}

if (-not ("FFX" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class FFX {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

  // Visible Explorer folder windows, front to back in the real Z-order.
  public static List<long> ExplorerZOrder() {
    var list = new List<long>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetClassName(h, sb, sb.Capacity);
      if (sb.ToString() == "CabinetWClass") list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@
}

function Get-ShellApp {
  # The Shell COM object is expensive to create; reuse one instance per script
  # run instead of creating a new one for every lookup.
  if ($null -ne $script:FFXShellApp) { return $script:FFXShellApp }
  try {
    $script:FFXShellApp = New-Object -ComObject Shell.Application
  } catch {
    $script:FFXShellApp = $null
  }
  return $script:FFXShellApp
}

function Get-FolderPathMap {
  # hwnd -> folder path, taken from the Shell COM object.
  $map = @{}
  try {
    $shell = Get-ShellApp
    foreach ($w in $shell.Windows()) {
      try {
        $hwnd = [int64]$w.HWND
        $p = [string]$w.Document.Folder.Self.Path
        if ($hwnd -and $p) { $map[$hwnd] = $p }
      } catch {}
    }
  } catch {}
  return $map
}

function Get-ExplorerCandidates {
  # Explorer folder windows that have a known path, front to back.
  $pathMap = Get-FolderPathMap
  $result = New-Object System.Collections.ArrayList
  foreach ($h in [FFX]::ExplorerZOrder()) {
    if ($pathMap.ContainsKey($h)) {
      [void]$result.Add(@{ Hwnd = [int64]$h; Path = $pathMap[$h] })
    }
  }
  # The comma keeps PowerShell from collapsing a single-element list into a
  # scalar (which would break .Count and the foreach below).
  return ,$result
}

function Get-UiaSelectedNames([int64]$hwnd) {
  # Names of the items currently selected in the file list of one Explorer
  # window. Returns an empty array when nothing is selected.
  $names = New-Object System.Collections.ArrayList
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if (-not $root) { return ,$names }

    # The file list of a modern Explorer window is a List named "UIItemsView".
    $cond = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::List)),
      (New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ClassNameProperty,
        'UIItemsView')))

    $lists = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    for ($i = 0; $i -lt $lists.Count; $i++) {
      try {
        $sp = $lists.Item($i).GetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern)
        $sel = $sp.Current.GetSelection()
        foreach ($s in $sel) {
          $n = [string]$s.Current.Name
          if ($n) { [void]$names.Add($n) }
        }
      } catch {}
    }

    # Fallback for shells that do not expose a SelectionPattern on the list:
    # walk the list items and ask each one whether it is selected.
    if ($names.Count -eq 0) {
      $itemCond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::ListItem)
      $items = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCond)
      for ($i = 0; $i -lt $items.Count; $i++) {
        try {
          $it = $items.Item($i)
          $pat = $it.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
          if ($pat.Current.IsSelected) {
            $n = [string]$it.Current.Name
            if ($n) { [void]$names.Add($n) }
          }
        } catch {}
      }
    }
  } catch {}
  return ,$names
}

function Get-ComSelectedNames([int64]$hwnd) {
  # Legacy path: Shell COM SelectedItems. Kept as a fallback for shells where
  # UI Automation is unavailable.
  $names = New-Object System.Collections.ArrayList
  try {
    $shell = Get-ShellApp
    foreach ($w in $shell.Windows()) {
      try {
        if ([int64]$w.HWND -ne $hwnd) { continue }
        $sel = $w.Document.SelectedItems()
        for ($i = 1; $i -le $sel.Count; $i++) {
          $it = $sel.Item($i)
          $n = [string]$it.Name
          if (-not $n) { $n = [System.IO.Path]::GetFileName([string]$it.Path) }
          if ($n) { [void]$names.Add($n) }
        }
        break
      } catch {}
    }
  } catch {}
  return ,$names
}

function Get-SelectionSnapshot {
  # Returns a hashtable describing the current selection:
  #   Hwnd  - Explorer window handle
  #   Path  - folder path of that window
  #   Names - array of selected item names
  $snapshot = @{ Hwnd = 0; Path = ''; Names = @() }

  $fg = [int64][FFX]::GetForegroundWindow()
  # Get-ExplorerCandidates returns an ArrayList (via the comma trick); bind it
  # directly. Wrapping it in @() here would nest the whole list as ONE element
  # and break multi-window handling.
  $candidates = Get-ExplorerCandidates
  if ($candidates.Count -eq 0) { return $snapshot }

  $target = $null

  # 1) foreground Explorer window that has a selection
  foreach ($c in $candidates) {
    if ($c.Hwnd -eq $fg) {
      $n = Get-UiaSelectedNames $c.Hwnd
      if ($n.Count -gt 0) { $target = $c; $snapshot.Names = $n; break }
    }
  }

  # 2) front-most Explorer window that has a selection
  if (-not $target) {
    foreach ($c in $candidates) {
      $n = Get-UiaSelectedNames $c.Hwnd
      if ($n.Count -gt 0) { $target = $c; $snapshot.Names = $n; break }
    }
  }

  # 3) foreground Explorer window, even without a selection
  if (-not $target) {
    foreach ($c in $candidates) {
      if ($c.Hwnd -eq $fg) { $target = $c; break }
    }
  }

  # 4) front-most Explorer window
  if (-not $target) { $target = $candidates[0] }

  $snapshot.Hwnd = $target.Hwnd
  $snapshot.Path = $target.Path
  if ($snapshot.Names.Count -eq 0) {
    $snapshot.Names = Get-ComSelectedNames $target.Hwnd
  }
  return $snapshot
}

function Resolve-SelectedItems($snapshot) {
  # Turns the selected names into full paths plus metadata.
  # Returns an array of hashtables: Path / IsFolder / Size / Modified.
  $result = New-Object System.Collections.ArrayList
  $folderPath = $snapshot.Path
  if (-not $folderPath) { return ,$result }

  $fsMap = @{}
  if (Test-Path -LiteralPath $folderPath) {
    foreach ($e in (Get-ChildItem -LiteralPath $folderPath -Force)) {
      $fsMap[$e.Name] = $e
    }
  }

  foreach ($name in $snapshot.Names) {
    $full = ''
    $isFolder = $false
    $size = 0
    $mtime = ''

    $entry = $null
    if ($fsMap.ContainsKey($name)) {
      $entry = $fsMap[$name]
    } else {
      $candidate = Join-Path $folderPath $name
      if (Test-Path -LiteralPath $candidate) {
        $entry = Get-Item -LiteralPath $candidate -Force
      }
    }

    if ($entry) {
      $full = $entry.FullName
      if ($entry.PSIsContainer) {
        $isFolder = $true
      } else {
        $size = [int64]$entry.Length
      }
      $mtime = $entry.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    } else {
      $full = $name
    }

    [void]$result.Add(@{
      Path = $full
      IsFolder = $isFolder
      Size = $size
      Modified = $mtime
    })
  }
  return ,$result
}
