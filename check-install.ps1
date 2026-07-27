$lz4 = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\addonStartup.json.lz4"
$tmpOut = "C:\Users\26655\AppData\Local\Temp\zsearch-addonStartup.json"
if (Test-Path $lz4) {
  python -c "import lz4.block,sys; data=open(r'$lz4','rb').read(); out=lz4.block.decompress(data[8:]); open(r'$tmpOut','wb').write(out)" 2>&1
  if (Test-Path $tmpOut) {
    $c = Get-Content $tmpOut -Raw
    if ($c -match "zsearch") {
      Write-Output "FOUND zsearch in addonStartup"
      $idx = $c.IndexOf("zsearch")
      Write-Output $c.Substring([Math]::Max(0,$idx-100), 500)
    } else {
      Write-Output "NOT in addonStartup"
    }
  }
} else {
  Write-Output "addonStartup file missing"
}
Write-Output "---extensions.json---"
$ext = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions.json"
$c2 = Get-Content $ext -Raw -ErrorAction SilentlyContinue
if ($c2 -match "zsearch") {
  Write-Output "FOUND in extensions.json"
} else {
  Write-Output "NOT in extensions.json"
}
