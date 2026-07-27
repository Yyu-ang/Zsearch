$ext = "C:\Users\26655\AppData\Roaming\Zotero\Zotero\Profiles\yg6b7bq9.default\extensions.json"
# Backup
Copy-Item $ext "$ext.bak" -Force
$c = Get-Content $ext -Raw
# Pattern: "zsearch@zotero-plugin.dev",..."seen":false,...,"userDisabled":true,...
# We'll set seen:true, userDisabled:false, active:true for zsearch entry only
$pattern = '"id":"zsearch@zotero-plugin.dev","syncGUID":"([^"]+)"'
if ($c -match $pattern) {
    Write-Output "Found zsearch id, replacing state..."
    # Replace specific fields within the zsearch entry
    # Use a more targeted approach - find the entry block
    $idx = $c.IndexOf('"id":"zsearch@zotero-plugin.dev"')
    if ($idx -lt 0) {
        # Try the older format where id is the key
        $idx = $c.IndexOf('"zsearch@zotero-plugin.dev"')
    }
    if ($idx -ge 0) {
        # Find the start of this addon object (back to "{" preceding "id")
        $startSearch = [Math]::Max(0, $idx - 50)
        $braceStart = $c.LastIndexOf('{', $idx, $idx - $startSearch)
        # Find the matching close brace
        $depth = 1
        $i = $braceStart + 1
        while ($depth -gt 0 -and $i -lt $c.Length) {
            $ch = $c[$i]
            if ($ch -eq '{') { $depth++ }
            elseif ($ch -eq '}') { $depth-- }
            $i++
        }
        $braceEnd = $i  # one past the closing }
        $entry = $c.Substring($braceStart, $braceEnd - $braceStart)
        Write-Output "Entry length: $($entry.Length)"
        # Modify the entry
        $newEntry = $entry -replace '"seen":false', '"seen":true'
        $newEntry = $newEntry -replace '"userDisabled":true', '"userDisabled":false'
        $newEntry = $newEntry -replace '"active":false', '"active":true'
        $newEntry = $newEntry -replace '"foreignInstall":true', '"foreignInstall":false'
        $c = $c.Substring(0, $braceStart) + $newEntry + $c.Substring($braceEnd)
        Set-Content -Path $ext -Value $c -NoNewline -Encoding UTF8
        Write-Output "Modified extensions.json - zsearch enabled"
        # Verify
        $c2 = Get-Content $ext -Raw
        $idx2 = $c2.IndexOf('"zsearch@zotero-plugin.dev"')
        if ($idx2 -ge 0) {
            $snippet = $c2.Substring($idx2, [Math]::Min(800, $c2.Length - $idx2))
            Write-Output "=== Verify ==="
            Write-Output $snippet
        }
    } else {
        Write-Output "Could not locate zsearch entry by id"
    }
} else {
    Write-Output "Pattern not found. Showing context..."
    $idx = $c.IndexOf("zsearch@zotero-plugin.dev")
    if ($idx -ge 0) {
        Write-Output $c.Substring([Math]::Max(0,$idx-200), 500)
    }
}
