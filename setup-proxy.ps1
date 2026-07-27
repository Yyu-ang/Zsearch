# Setup proxy plugin loading (like zotero-plugin-scaffold's asProxy mode)
$profile = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default"
$addonID = "zsearch@zotero-plugin.dev"
$sourceDir = "D:\library\code\Zsearch\.scaffold\build\addon"

# 1. Remove XPI file
$xpiPath = Join-Path $profile "extensions\$addonID.xpi"
if (Test-Path $xpiPath) {
  Remove-Item $xpiPath -Force
  Write-Output "Removed XPI: $xpiPath"
}

# 2. Create proxy file (text file with path to source dir)
$proxyPath = Join-Path $profile "extensions\$addonID"
Set-Content -Path $proxyPath -Value $sourceDir -NoNewline -Encoding UTF8
Write-Output "Created proxy file: $proxyPath"
Write-Output "  Content: $sourceDir"

# 3. Update extensions.json to enable the plugin
$extJson = Join-Path $profile "extensions.json"
Copy-Item $extJson "$extJson.bak" -Force
$c = Get-Content $extJson -Raw
$idx = $c.IndexOf('"zsearch@zotero-plugin.dev"')
if ($idx -ge 0) {
  $startSearch = [Math]::Max(0, $idx - 50)
  $braceStart = $c.LastIndexOf('{', $idx, $idx - $startSearch)
  $depth = 1
  $i = $braceStart + 1
  while ($depth -gt 0 -and $i -lt $c.Length) {
    if ($c[$i] -eq '{') { $depth++ }
    elseif ($c[$i] -eq '}') { $depth-- }
    $i++
  }
  $entry = $c.Substring($braceStart, $i - $braceStart)
  $newEntry = $entry -replace '"seen":false', '"seen":true'
  $newEntry = $newEntry -replace '"userDisabled":true', '"userDisabled":false'
  $newEntry = $newEntry -replace '"active":false', '"active":true'
  $newEntry = $newEntry -replace '"foreignInstall":true', '"foreignInstall":false'
  # Also update the path to point to the source directory
  $newEntry = $newEntry -replace '"path":"[^"]*"', "`"path`":`"$($sourceDir -replace '\\','\\')`""
  $c = $c.Substring(0, $braceStart) + $newEntry + $c.Substring($i)
  Set-Content -Path $extJson -Value $c -NoNewline -Encoding UTF8
  Write-Output "Updated extensions.json - plugin enabled with proxy path"
}

# 4. Clear lock files
Get-ChildItem $profile -Force -Filter "*lock*" | Remove-Item -Force -ErrorAction SilentlyContinue
Write-Output "Lock files cleared"
Write-Output "Done! Ready to start Zotero."
