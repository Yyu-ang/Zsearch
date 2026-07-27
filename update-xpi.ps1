# Package the build directory into an XPI and install it
$buildAddon = "D:\library\code\Zsearch\.scaffold\build\addon"
$xpiPath = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions\zsearch@zotero-plugin.dev.xpi"

if (-not (Test-Path $buildAddon)) {
  Write-Error "Build addon directory not found: $buildAddon"
  exit 1
}

# Remove old XPI
if (Test-Path $xpiPath) {
  Remove-Item $xpiPath -Force
}

# Create XPI (ZIP) from build directory
# Use .NET ZipFile for proper ZIP format
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($buildAddon, $xpiPath)

Write-Output "XPI created: $xpiPath"
Write-Output "Size: $((Get-Item $xpiPath).Length) bytes"
