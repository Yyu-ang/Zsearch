$lz4 = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\addonStartup.json.lz4"
$tmpOut = "C:\Users\26655\AppData\Local\Temp\zsearch-addonStartup.json"
python -c "import lz4.block,sys; data=open(r'$lz4','rb').read(); out=lz4.block.decompress(data[8:]); open(r'$tmpOut','wb').write(out)"
$c = Get-Content $tmpOut -Raw
# Find zsearch section
$idx = $c.IndexOf('"zsearch@zotero-plugin.dev"')
if ($idx -ge 0) {
  Write-Output "=== zsearch section ==="
  # Find the closing brace of this object - search forward for next major section
  $end = [Math]::Min($idx + 1500, $c.Length)
  Write-Output $c.Substring($idx, $end - $idx)
}
Write-Output ""
Write-Output "=== zotseek section (comparison) ==="
$idx2 = $c.IndexOf('"zotseek@zotero.org"')
if ($idx2 -ge 0) {
  $end2 = [Math]::Min($idx2 + 1500, $c.Length)
  Write-Output $c.Substring($idx2, $end2 - $idx2)
}
