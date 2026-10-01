param([Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
if (-not $env:LZCORE_SIGNING_PFX) { return }
$pfx = Join-Path $env:RUNNER_TEMP ('lzcore-sign-' + [guid]::NewGuid().ToString('N') + '.pfx')
try {
  [IO.File]::WriteAllBytes($pfx, [Convert]::FromBase64String($env:LZCORE_SIGNING_PFX))
  $secret = ConvertTo-SecureString $env:LZCORE_SIGNING_PASSWORD -AsPlainText -Force
  $cert = Import-PfxCertificate -FilePath $pfx -CertStoreLocation Cert:\CurrentUser\My -Password $secret
  try {
    $result = Set-AuthenticodeSignature -LiteralPath $File -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com'
    if ($result.Status -ne 'Valid') { throw 'Windows code signing failed' }
  } finally { Remove-Item -LiteralPath $cert.PSPath -Force }
} finally { Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue }
