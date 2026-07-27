$userJs = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\user.js"
$content = @"
// Auto-enable sideloaded plugins (set scope to 0 = nowhere auto-disabled)
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
// Allow unsigned plugins (Zotero 7+ default is false but be explicit)
user_pref("xpinstall.signatures.required", false);
// Don't show install confirmation dialog for sideloaded
user_pref("extensions.silentInstallScopes", 15);
"@
if (Test-Path $userJs) {
  Add-Content -Path $userJs -Value "`n$content"
} else {
  Set-Content -Path $userJs -Value $content -Encoding UTF8
}
Write-Output "user.js written:"
Get-Content $userJs | Out-String
