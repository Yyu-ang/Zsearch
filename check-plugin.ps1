$ext = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions.json"
$c = Get-Content $ext -Raw
$idx = $c.IndexOf('"zsearch@zotero-plugin.dev"')
if ($idx -ge 0) {
  $start = $c.LastIndexOf('{', $idx, $idx)
  $depth = 1
  $i = $start + 1
  while ($depth -gt 0 -and $i -lt $c.Length) {
    if ($c[$i] -eq '{') { $depth++ }
    elseif ($c[$i] -eq '}') { $depth-- }
    $i++
  }
  $entry = $c.Substring($start, $i - $start)
  $obj = $entry | ConvertFrom-Json
  Write-Output "ID: $($obj.id)"
  Write-Output "Active: $($obj.active)"
  Write-Output "UserDisabled: $($obj.userDisabled)"
  Write-Output "Seen: $($obj.seen)"
  Write-Output "Version: $($obj.version)"
  Write-Output "Path: $($obj.path)"
} else {
  Write-Output "Plugin not found in extensions.json"
}
