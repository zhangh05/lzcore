param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
# A PowerShell 7 parent can pass its module path to Windows PowerShell 5.
# Resolve built-in commands (including Get-FileHash) from this host's modules.
$env:PSModulePath = Join-Path $PSHOME 'Modules'
$planPath = [IO.Path]::GetFullPath($Plan)
$state = Get-Content -LiteralPath $planPath -Raw -Encoding UTF8 | ConvertFrom-Json
$statusPath = Join-Path (Split-Path $planPath) 'result.json'
$backup = $null
$installed = @()
$instanceLock = $null
$exitCode = 0
try {
  if ($state.data_schema -ne 1 -or $state.mode -notin @('portable','installed')) { throw 'Unsupported update plan' }
  $app = [IO.Path]::GetFullPath($state.app).TrimEnd('\')
  $data = [IO.Path]::GetFullPath($state.data).TrimEnd('\')
  $package = [IO.Path]::GetFullPath($state.package)
  if ($data -eq $app -or -not $package.StartsWith($data + '\.runtime\updates\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected update paths' }
  if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.sha256) { throw 'Package checksum mismatch' }
  # Wait for the application to close itself. Never stop or kill an active app.
  $parent = Get-Process -Id $state.parent_pid -ErrorAction SilentlyContinue
  if ($parent) { $parent.WaitForExit() }
  $instanceLock = [IO.File]::Open((Join-Path $data '.runtime\desktop-instance.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
  if ($instanceLock.Length -eq 0) { $instanceLock.WriteByte(48); $instanceLock.Flush() }
  $instanceLock.Lock(0,1)
  if ($state.mode -eq 'installed') {
    $backup = Join-Path $data ('.runtime\program-backups\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($name in @('_internal','lzcore.exe','build-info.json')) {
      $source = Join-Path $app $name
      if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $backup -Recurse; $installed += $name }
    }
    if ($state.signed -and (Get-AuthenticodeSignature -LiteralPath $package).Status -ne 'Valid') { throw 'Invalid installer signature' }
    $process = Start-Process -FilePath $package -ArgumentList @('/CURRENTUSER','/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/DIR="' + $app + '"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  } else {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $stage = Join-Path (Split-Path $planPath) 'unpacked'
    [IO.Directory]::CreateDirectory($stage) | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($package)
    try {
      $seen = @{}
      $total = 0L
      foreach ($entry in $archive.Entries) {
        $name = $entry.FullName.Replace('\','/')
        $segments = $name.Split('/')
        if ($segments[0] -ne 'lzcore' -or $segments -contains '..' -or $segments -contains '.' -or $name.Contains(':') -or $seen.ContainsKey($name.ToLowerInvariant())) { throw 'Invalid update archive path' }
        $seen[$name.ToLowerInvariant()] = $true
        if ($segments.Length -gt 1 -and $segments[1] -notin @('_internal','lzcore.exe','build-info.json','portable.json')) { throw 'Unexpected program file in update' }
        $total += $entry.Length
        if ($total -gt 3GB -or $archive.Entries.Count -gt 100000) { throw 'Update archive exceeds limit' }
      }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($package, $stage)
    $new = Join-Path $stage 'lzcore'
    $build = Get-Content -LiteralPath (Join-Path $new 'build-info.json') -Raw | ConvertFrom-Json
    if ($build.version -ne $state.version -or $build.data_schema -ne 1 -or -not (Test-Path (Join-Path $new 'lzcore.exe'))) { throw 'Invalid program metadata' }
    if ($state.signed -and (Get-AuthenticodeSignature -LiteralPath (Join-Path $new 'lzcore.exe')).Status -ne 'Valid') { throw 'Invalid program signature' }
    $backup = Join-Path $data ('.runtime\program-backups\' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $new) {
      $destination = Join-Path $app $item.Name
      if (Test-Path -LiteralPath $destination) { Move-Item -LiteralPath $destination -Destination $backup }
      $installed += $item.Name
      Move-Item -LiteralPath $item.FullName -Destination $destination
    }
  }
  $preferences = Join-Path $data '.runtime\desktop.json'
  $prefs = if (Test-Path -LiteralPath $preferences) { Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
  $prefs | Add-Member -NotePropertyName previous_version -NotePropertyValue $state.previous_version -Force
  $prefsJson = $prefs | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($preferences + '.tmp', $prefsJson, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath ($preferences + '.tmp') -Destination $preferences -Force
  @{ok=$true; version=$state.version} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
} catch {
  if ($backup) {
    foreach ($name in $installed) {
      $destination = Join-Path $app $name
      if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
      $original = Join-Path $backup $name
      if (Test-Path -LiteralPath $original) { Move-Item -LiteralPath $original -Destination $destination }
    }
  }
  @{ok=$false; error='更新未完成。原数据保留，请重新启动并核对程序版本。'; reason=$_.FullyQualifiedErrorId; line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  $exitCode = 1
} finally {
  if ($instanceLock) { $instanceLock.Dispose() }
}
if (Test-Path (Join-Path $state.app 'lzcore.exe')) { Start-Process -FilePath (Join-Path $state.app 'lzcore.exe') -ArgumentList @('--data-dir',('"' + $state.data + '"')) }
exit $exitCode
