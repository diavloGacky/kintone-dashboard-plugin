# ダッシュボードビルダー ローカルサーバー起動スクリプト
# 使い方: .\dashboard-builder\serve.ps1

$port = 8080
$path = $PSScriptRoot

Write-Host "================================================"
Write-Host " ダッシュボードビルダー"
Write-Host "================================================"
Write-Host " URL: http://localhost:$port"
Write-Host " 停止: Ctrl+C"
Write-Host ""
Write-Host "事前準備（初回のみ）："
Write-Host " kintone管理画面 > システム管理 > セキュリティ > CORS設定"
Write-Host " 許可オリジン: http://localhost:$port を追加"
Write-Host "================================================"
Write-Host ""

if (Get-Command python3 -ErrorAction SilentlyContinue) {
    python3 -m http.server $port --directory $path
} elseif (Get-Command python -ErrorAction SilentlyContinue) {
    python -m http.server $port --directory $path
} else {
    # Python未インストール時は .NET HttpListener で代替
    $listener = [System.Net.HttpListener]::new()
    $listener.Prefixes.Add("http://localhost:$port/")
    $listener.Start()
    Write-Host "サーバー起動完了 (PowerShell内蔵サーバー使用)"

    while ($listener.IsListening) {
        $ctx  = $listener.GetContext()
        $req  = $ctx.Request
        $res  = $ctx.Response

        $local = $req.Url.LocalPath.TrimStart('/')
        if ($local -eq '' -or $local -eq '/') { $local = 'index.html' }
        $full = Join-Path $path $local

        if (Test-Path $full -PathType Leaf) {
            $bytes = [System.IO.File]::ReadAllBytes($full)
            $ext   = [System.IO.Path]::GetExtension($full).ToLower()
            $res.ContentType = switch ($ext) {
                '.html' { 'text/html; charset=utf-8' }
                '.js'   { 'application/javascript; charset=utf-8' }
                '.css'  { 'text/css; charset=utf-8' }
                default { 'application/octet-stream' }
            }
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
            Write-Host "200 $($req.Url.LocalPath)"
        } else {
            $res.StatusCode = 404
            $body = [System.Text.Encoding]::UTF8.GetBytes('Not Found')
            $res.ContentLength64 = $body.Length
            $res.OutputStream.Write($body, 0, $body.Length)
            Write-Host "404 $($req.Url.LocalPath)"
        }
        $res.OutputStream.Close()
    }
}
