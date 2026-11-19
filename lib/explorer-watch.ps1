# explorer-watch.ps1
# Watches the Explorer selection and reports changes on stdout.
#
# The plugin starts this as a long-running child process. Every time the
# set of selected items in any Explorer window changes, one block is printed:
#
#   EVENT=selection
#   FOLDER=<folder path>
#   WINDOW_HWND=<hwnd>
#   SELECTED_COUNT=<n>
#   ITEM[i]=<full path>|<isFolder 0|1>|<size bytes>|<last write time>
#   END=selection
#
# The watcher exits by itself after $MaxSeconds so a crashed client can never
# leave an orphan process behind forever.

param(
  [int]$IntervalMs = 900,
  [int]$MaxSeconds = 1800
)

[Console]::OutputEncoding = [Text.Encoding]::UTF8

try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}

$libPath = Join-Path $PSScriptRoot 'explorer-lib.ps1'
if (Test-Path -LiteralPath $libPath) { . $libPath }

$lastKey = ''
$deadline = (Get-Date).AddSeconds($MaxSeconds)

while ((Get-Date) -lt $deadline) {
  try {
    $snapshot = Get-SelectionSnapshot
    $items = Resolve-SelectedItems $snapshot

    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add("FOLDER=$($snapshot.Path)")
    [void]$parts.Add("WINDOW_HWND=$($snapshot.Hwnd)")
    [void]$parts.Add("SELECTED_COUNT=$($items.Count)")
    $i = 0
    foreach ($it in $items) {
      $i++
      $isFolder = if ($it.IsFolder) { '1' } else { '0' }
      [void]$parts.Add("ITEM[$i]=$($it.Path)|$isFolder|$($it.Size)|$($it.Modified)")
    }

    $key = $parts -join "`n"
    if ($key -ne $lastKey) {
      $lastKey = $key
      Write-Output 'EVENT=selection'
      foreach ($p in $parts) { Write-Output $p }
      Write-Output 'END=selection'
      [Console]::Out.Flush()
    }
  } catch {}

  Start-Sleep -Milliseconds $IntervalMs
}
