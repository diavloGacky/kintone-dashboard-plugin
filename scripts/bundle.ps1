# バンドルスクリプト: 全ファイルを dashboard.bundle.js 1本に結合
# 使い方: scripts\bundle.ps1

$root    = "$PSScriptRoot\.."
$libDir  = "$root\plugin\lib"
$jsDir   = "$root\customization\js"
$cssDir  = "$root\customization\css"
$outDir  = "$root\dist"

if (!(Test-Path $outDir)) { New-Item -ItemType Directory $outDir | Out-Null }

$outFile = "$outDir\dashboard.bundle.js"
$enc     = [System.Text.Encoding]::UTF8

function ReadFile($path) {
  return [System.IO.File]::ReadAllText($path, $enc)
}

function ToCssBase64($path) {
  # CSS を UTF-8 バイト列に変換して Base64 エンコード（エスケープ不要）
  $bytes = [System.Text.Encoding]::UTF8.GetBytes((ReadFile $path))
  return [Convert]::ToBase64String($bytes)
}

Write-Host "バンドルを生成中..."

# --- CSS を Base64 で安全に埋め込む ---
$gridstackCssB64 = ToCssBase64 "$libDir\gridstack.css"
$dashboardCssB64 = ToCssBase64 "$cssDir\dashboard.css"

$cssInjection = @"
/* CSS injection (base64) */
(function() {
  var style = document.createElement('style');
  style.textContent =
    atob('$gridstackCssB64') +
    atob('$dashboardCssB64');
  document.head.appendChild(style);
})();

"@

# --- 各パーツを読み込む ---
$chartJs     = ReadFile "$libDir\chart.min.js"
$gridstackJs = ReadFile "$libDir\gridstack.js"
$dashboardJs = ReadFile "$jsDir\dashboard.js"

# --- 結合 ---
$banner = @"
/*! kintone Dashboard Plugin - dashboard.bundle.js
 *  kintone JavaScriptカスタマイズ用 ワンファイルバンドル
 *  使い方: kintoneアプリ設定 > JavaScript/CSSでカスタマイズ > このファイルをアップロード
 */

"@

$bundle = $banner + $chartJs + "`n`n" + $gridstackJs + "`n`n" + $cssInjection + $dashboardJs

[System.IO.File]::WriteAllText($outFile, $bundle, $enc)

$sizeKB = [math]::Round((Get-Item $outFile).Length / 1KB, 1)
Write-Host "バンドル完了: $outFile ($sizeKB KB)"
Write-Host "アップロードするファイルは このファイル1つだけです。"
