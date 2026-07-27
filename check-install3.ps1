$ext = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions.json"
$c = Get-Content $ext -Raw
$idx = $c.IndexOf('"zsearch@zotero-plugin.dev"')
if ($idx -ge 0) {
  Write-Output "=== zsearch in extensions.json ==="
  $end = [Math]::Min($idx + 2000, $c.Length)
  Write-Output $c.Substring($idx, $end - $idx)
}
Write-Output ""
Write-Output "=== zotseek in extensions.json (for comparison) ==="
$idx2 = $c.IndexOf('"zotseek@zotero.org"')
if ($idx2 -ge 0) {
  $end2 = [Math]::Min($idx2 + 2000, $c.Length)
  Write-Output $c.Substring($idx2, $end2 - $idx2)
}
