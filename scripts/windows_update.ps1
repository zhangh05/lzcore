param([Parameter(Mandatory=$true)][string]$Plan, [switch]$Recover)
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
$journalPath = Join-Path (Split-Path $planPath) 'transaction.json'
$transaction = $null
$canRestore = $false
$runOncePath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$runOnceName = '!LZCoreRecovery-' + (Split-Path (Split-Path $planPath) -Leaf)
function Save-Transaction {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($transaction | ConvertTo-Json -Depth 20))
  $stream = New-Object IO.FileStream(($journalPath + '.tmp'), [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  if (Test-Path -LiteralPath $journalPath) { [IO.File]::Replace(($journalPath + '.tmp'), $journalPath, $null) }
  else { [IO.File]::Move(($journalPath + '.tmp'), $journalPath) }
}
function Register-Recovery {
  New-Item -Path $runOncePath -Force | Out-Null
  $hostExe = Join-Path $PSHOME 'powershell.exe'
  $command = '"' + $hostExe + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Plan "' + $planPath + '" -Recover'
  New-ItemProperty -Path $runOncePath -Name $runOnceName -Value $command -PropertyType String -Force | Out-Null
}
function Restore-Program {
  foreach ($name in $transaction.names) {
    $destination = Join-Path $app $name
    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
    if ($transaction.originals -contains $name) {
      Copy-Item -LiteralPath (Join-Path $transaction.backup $name) -Destination $app -Recurse
    }
  }
  $transaction.phase = 'rolled_back'
  Save-Transaction
}
function Snapshot-Program([string[]]$names) {
  $script:backup = Join-Path $data ('.runtime\program-backups\' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $originals = @()
  foreach ($name in $names) {
    $source = Join-Path $app $name
    if (Test-Path -LiteralPath $source) {
      Copy-Item -LiteralPath $source -Destination $backup -Recurse
      $originals += $name
    }
  }
  foreach ($file in Get-ChildItem -LiteralPath $backup -Recurse -File) {
    $stream = [IO.File]::Open($file.FullName, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Read)
    try { $stream.Flush($true) } finally { $stream.Dispose() }
  }
  $script:transaction = [pscustomobject]@{phase='prepared'; app=$app; backup=$backup; names=@($names); originals=@($originals); version=$state.version}
  Save-Transaction
  $script:canRestore = $true
  # The copied helper and plan live outside the program being replaced.
  # Register recovery before the first destructive operation.
  Register-Recovery
}
try {
  if ($state.data_schema -ne 1 -or $state.mode -notin @('portable','installed')) { throw 'Unsupported update plan' }
  $app = [IO.Path]::GetFullPath($state.app).TrimEnd('\')
  $data = [IO.Path]::GetFullPath($state.data).TrimEnd('\')
  $package = [IO.Path]::GetFullPath($state.package)
  if ($data -eq $app -or -not $package.StartsWith($data + '\.runtime\updates\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected update paths' }
  if (-not $Recover -and (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $state.sha256) { throw 'Package checksum mismatch' }
  # Wait for the application to close itself. Never stop or kill an active app.
  $parent = Get-Process -Id $state.parent_pid -ErrorAction SilentlyContinue
  if ($parent) { $parent.WaitForExit() }
  $instanceLock = [IO.File]::Open((Join-Path $data '.runtime\desktop-instance.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
  if ($instanceLock.Length -eq 0) { $instanceLock.WriteByte(48); $instanceLock.Flush() }
  $instanceLock.Lock(0,1)
  if (Test-Path -LiteralPath $journalPath) {
    $transaction = Get-Content -LiteralPath $journalPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $snapshotPath = [IO.Path]::GetFullPath($transaction.backup)
    if ($transaction.app -ne $app -or (Split-Path $snapshotPath) -ne (Join-Path $data '.runtime\program-backups') -or (Split-Path $snapshotPath -Leaf) -notmatch '^[0-9a-f]{32}$' -or @($transaction.names).Count -lt 3 -or @($transaction.names | Where-Object { $_ -notin @('_internal','lzcore.exe','build-info.json','portable.json') }).Count) { throw 'Invalid program transaction' }
    if (@($transaction.originals | Where-Object { $_ -notin $transaction.names -or -not (Test-Path -LiteralPath (Join-Path $transaction.backup $_)) }).Count) { throw 'Incomplete recovery snapshot' }
    $canRestore = $true
    if ($transaction.phase -eq 'prepared') { Register-Recovery; Restore-Program }
    elseif ($transaction.phase -notin @('completed','rolled_back')) { throw 'Unknown program transaction phase' }
    Remove-ItemProperty -Path $runOncePath -Name $runOnceName -ErrorAction SilentlyContinue
    if (-not $Recover) { throw 'Previous update transaction exists; check the program before retrying' }
  } elseif ($Recover) { throw 'Missing program transaction' }
  if ($Recover) {
    @{ok=($transaction.phase -eq 'completed'); recovered=$true; version=$(if ($transaction.phase -eq 'completed') { $state.version } else { $state.previous_version }); backup=$transaction.backup} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  } elseif ($state.mode -eq 'installed') {
    Snapshot-Program @('_internal','lzcore.exe','build-info.json')
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
    Snapshot-Program @('_internal','lzcore.exe','build-info.json','portable.json')
    foreach ($item in Get-ChildItem -LiteralPath $new) {
      $destination = Join-Path $app $item.Name
      if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
      $installed += $item.Name
      Move-Item -LiteralPath $item.FullName -Destination $destination
    }
  }
  if (-not $Recover) {
  $preferences = Join-Path $data '.runtime\desktop.json'
  $prefs = if (Test-Path -LiteralPath $preferences) { Get-Content -LiteralPath $preferences -Raw -Encoding UTF8 | ConvertFrom-Json } else { [pscustomobject]@{} }
  $prefs | Add-Member -NotePropertyName previous_version -NotePropertyValue $state.previous_version -Force
  $prefsJson = $prefs | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($preferences + '.tmp', $prefsJson, (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath ($preferences + '.tmp') -Destination $preferences -Force
  $transaction.phase = 'completed'
  Save-Transaction
  Remove-ItemProperty -Path $runOncePath -Name $runOnceName -ErrorAction SilentlyContinue
  @{ok=$true; version=$state.version; backup=$backup} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
}
} catch {
  if ($canRestore -and $transaction -and $transaction.phase -eq 'prepared') {
    # Keep the snapshot and journal on rollback failure; login recovery can
    # retry using the independent helper even if lzcore.exe is missing.
    try { Restore-Program; Remove-ItemProperty -Path $runOncePath -Name $runOnceName -ErrorAction SilentlyContinue }
    catch { $exitCode = 1 }
  }
  @{ok=$false; error='更新未完成。原数据保留，请重新启动并核对程序版本。'; reason=$_.FullyQualifiedErrorId; line=$_.InvocationInfo.ScriptLineNumber} | ConvertTo-Json | Set-Content -LiteralPath $statusPath -Encoding UTF8
  $exitCode = 1
} finally {
  if ($instanceLock) { $instanceLock.Dispose() }
}
if ((-not $transaction -or $transaction.phase -ne 'prepared') -and (Test-Path (Join-Path $state.app 'lzcore.exe'))) { Start-Process -FilePath (Join-Path $state.app 'lzcore.exe') -ArgumentList @('--data-dir',('"' + $state.data + '"')) }
exit $exitCode
