# explorer-select.ps1
# One-shot read of the current Explorer selection.
#
# The selection is read through UI Automation, which reports the items that are
# actually selected without touching the selection. The previous implementation
# used AppActivate + Ctrl+A, which replaced the user's own multi-selection with
# "select all" and made the plugin operate on every item in the folder.
#
# Output (one item per line):
#   FOLDER=<folder path>
#   WINDOW_HWND=<hwnd>
#   SELECTED_COUNT=<n>
#   ITEM[i]=<full path>|<isFolder 0|1>|<size bytes>|<last write time>

[Console]::OutputEncoding = [Text.Encoding]::UTF8

try { Add-Type -AssemblyName UIAutomationClient } catch {}
try { Add-Type -AssemblyName UIAutomationTypes } catch {}

$libPath = Join-Path $PSScriptRoot 'explorer-lib.ps1'
if (Test-Path -LiteralPath $libPath) { . $libPath }

$snapshot = Get-SelectionSnapshot
$items = Resolve-SelectedItems $snapshot

Write-Output "FOLDER=$($snapshot.Path)"
Write-Output "WINDOW_HWND=$($snapshot.Hwnd)"
Write-Output "SELECTED_COUNT=$($items.Count)"

$i = 0
foreach ($it in $items) {
  $i++
  $isFolder = if ($it.IsFolder) { '1' } else { '0' }
  Write-Output "ITEM[$i]=$($it.Path)|$isFolder|$($it.Size)|$($it.Modified)"
}
