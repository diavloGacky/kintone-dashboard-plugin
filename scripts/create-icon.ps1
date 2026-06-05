# 48x48 アイコン（PNG）を生成するスクリプト
# System.Drawing を使用

Add-Type -AssemblyName System.Drawing

$size   = 48
$bmp    = New-Object System.Drawing.Bitmap $size, $size
$g      = [System.Drawing.Graphics]::FromImage($bmp)

# 背景
$g.FillRectangle([System.Drawing.Brushes]::RoyalBlue, 0, 0, $size, $size)

# 棒グラフアイコン風の描画
$whiteBrush = [System.Drawing.Brushes]::White
$g.FillRectangle($whiteBrush,  8, 28,  8, 12)
$g.FillRectangle($whiteBrush, 20, 18,  8, 22)
$g.FillRectangle($whiteBrush, 32,  8,  8, 32)

$g.Dispose()

$outPath = "$PSScriptRoot\..\plugin\image\icon.png"
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Host "アイコン作成完了: $outPath"
