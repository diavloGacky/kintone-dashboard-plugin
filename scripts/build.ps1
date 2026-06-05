# パッケージングスクリプト
# 使い方: scripts\build.ps1
# 前提: npm install -g @kintone/plugin-packer

$root      = "$PSScriptRoot\.."
$pluginDir = "$root\plugin"
$outDir    = "$root\dist"

# dist ディレクトリ作成
if (!(Test-Path $outDir)) { New-Item -ItemType Directory $outDir | Out-Null }

Write-Host "kintone プラグインをパッケージングします..."
Write-Host "プラグインディレクトリ: $pluginDir"

# 秘密鍵ファイルがあれば指定（同じプラグインIDを維持するため）
$ppkFile = Get-ChildItem "$root\*.ppk" | Select-Object -First 1
$ppkArg  = if ($ppkFile) { @("--ppk", $ppkFile.FullName) } else { @() }

# kintone plugin packer 実行
& npx @kintone/plugin-packer $pluginDir --out "$outDir\plugin.zip" @ppkArg

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "パッケージング完了: $outDir\plugin.zip"
} else {
  Write-Host "パッケージングに失敗しました"
  exit 1
}
