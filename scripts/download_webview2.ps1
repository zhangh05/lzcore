param([string]$Destination = 'build/webview2')
$ErrorActionPreference = 'Stop'
$metadata = Get-Content packaging/webview2.json -Raw | ConvertFrom-Json
$uri = [uri]$metadata.url
if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'msedge.sf.dl.delivery.mp.microsoft.com') { throw 'Unexpected runtime source' }
New-Item -ItemType Directory -Force $Destination | Out-Null
$cab = Join-Path $env:RUNNER_TEMP 'lzcore-webview2.cab'
Invoke-WebRequest -Uri $uri -OutFile $cab
& expand.exe $cab '-F:*' $Destination | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'WebView2 extraction failed' }
$exe = Get-ChildItem -Path $Destination -Recurse -Filter msedgewebview2.exe | Select-Object -First 1
if (-not $exe -or $exe.VersionInfo.ProductVersion -ne $metadata.version) { throw 'Unexpected runtime version' }
$sig = Get-AuthenticodeSignature -LiteralPath $exe.FullName
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WebView2 Microsoft signature verification failed' }
$env:LZCORE_WEBVIEW2_DIR = $exe.Directory.FullName
"LZCORE_WEBVIEW2_DIR=$($exe.Directory.FullName)" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
