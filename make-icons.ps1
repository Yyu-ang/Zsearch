Add-Type -AssemblyName System.Drawing
function New-ZsearchIcon($path, $size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.Clear([System.Drawing.Color]::White)
  $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 66, 133, 244))
  $g.FillEllipse($brush, 2, 2, $size - 4, $size - 4)
  $font = New-Object System.Drawing.Font("Segoe UI", [int]($size * 0.6), [System.Drawing.FontStyle]::Bold)
  $sf = New-Object System.Drawing.StringFormat
  $sf.Alignment = [System.Drawing.StringAlignment]::Center
  $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
  $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $rect = New-Object System.Drawing.RectangleF(0, -[int]($size*0.05), $size, $size)
  $g.DrawString("Z", $font, $whiteBrush, $rect, $sf)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
$dir = "d:\library\code\Zsearch\addon\content\icons"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
New-ZsearchIcon "$dir\favicon.png" 96
New-ZsearchIcon "$dir\favicon@0.5x.png" 48
Get-ChildItem $dir | Select-Object Name, Length
