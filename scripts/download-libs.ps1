# ライブラリダウンロードスクリプト
# 使い方: scripts\download-libs.ps1

$libDir = "$PSScriptRoot\..\plugin\lib"

Write-Host "ライブラリをダウンロードします..."

# Chart.js
$chartUrl = "https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"
$chartOut  = "$libDir\chart.min.js"
Invoke-WebRequest -Uri $chartUrl -OutFile $chartOut
Write-Host "Chart.js: ダウンロード完了 -> $chartOut"

# gridstack.js
$gsUrl = "https://cdn.jsdelivr.net/npm/gridstack@10.3.1/dist/gridstack-all.js"
$gsOut = "$libDir\gridstack.js"
Invoke-WebRequest -Uri $gsUrl -OutFile $gsOut
Write-Host "gridstack.js: ダウンロード完了 -> $gsOut"

# gridstack.css
$gsCssUrl = "https://cdn.jsdelivr.net/npm/gridstack@10.3.1/dist/gridstack.min.css"
$gsCssOut = "$libDir\gridstack.css"
Invoke-WebRequest -Uri $gsCssUrl -OutFile $gsCssOut
Write-Host "gridstack.css: ダウンロード完了 -> $gsCssOut"

Write-Host ""
Write-Host "ライブラリのダウンロードが完了しました。"
