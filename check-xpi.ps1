$xpiPath = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions\zsearch@zotero-plugin.dev.xpi"
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($xpiPath)
Write-Output "XPI contents:"
foreach ($entry in $zip.Entries) {
  Write-Output "  $($entry.FullName) ($($entry.Length) bytes)"
}
$zip.Dispose()
