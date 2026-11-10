# Check that the Windows installer carries a working minipro sidecar, run from
# where an installed copy of burnwright finds it, not from the build tree.
#
#   pwsh scripts/minipro/verify-bundle.ps1 <burnwright_*-setup.exe>
#
# Runs the NSIS installer silently (per-user, no admin), lists what it
# installed, then runs burnwright-minipro.exe from the install folder with
# PATH cut down to System32: no MSYS2 or other DLLs may be needed. Same checks
# as verify-bundle.sh: version and database counts, a full -l listing, and
# "No programmer found" (CI has no hardware). Uninstalls afterwards.
param([Parameter(Mandatory)][string]$Installer)

$ErrorActionPreference = 'Stop'
function Fail($msg) { Write-Host "FAIL: $msg"; exit 1 }
function Section($msg) { Write-Host "`n=== $msg ===" }

$sidecarName = 'burnwright-minipro.exe'
$Installer = (Resolve-Path $Installer).Path

Section "install $(Split-Path -Leaf $Installer)"
$p = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if ($p.ExitCode -ne 0) { Fail "installer exited $($p.ExitCode)" }

$candidates = @("$env:LOCALAPPDATA\burnwright", "$env:LOCALAPPDATA\Programs\burnwright", "$env:ProgramFiles\burnwright")
$dir = $candidates | Where-Object { Test-Path (Join-Path $_ $sidecarName) } | Select-Object -First 1
if (-not $dir) {
  $found = Get-ChildItem -Path $env:LOCALAPPDATA, $env:ProgramFiles -Filter $sidecarName -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $found) { Fail "installed $sidecarName not found" }
  $dir = $found.DirectoryName
}
Write-Host "installed to $dir"
Get-ChildItem -Path $dir -Recurse -File | ForEach-Object { $_.FullName.Substring($dir.Length + 1) + "  ($($_.Length) bytes)" }

$bin = Join-Path $dir $sidecarName
$res = Join-Path $dir 'minipro'
if (-not (Test-Path (Join-Path $dir 'burnwright.exe'))) { Fail "burnwright.exe isn't next to the sidecar" }
foreach ($f in 'infoic.xml', 'logicic.xml', 'LICENSE.minipro.txt', 'COPYING.libusb.txt', 'LICENSE.zlib.txt', 'NOTICE.txt') {
  $path = Join-Path $res $f
  if (-not (Test-Path $path) -or (Get-Item $path).Length -eq 0) { Fail "missing $path" }
}
if (-not (Select-String -Path (Join-Path $res 'NOTICE.txt') -Pattern 'Commit:' -Quiet)) { Fail "NOTICE.txt doesn't record the minipro commit" }

Section "run $bin"
# Only Windows' own DLLs, and an unrelated working directory so minipro can't
# pick up databases from the current folder.
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
$work = Join-Path ([IO.Path]::GetTempPath()) "bw-verify-$PID"
New-Item -ItemType Directory -Force $work | Out-Null
Push-Location $work
try {
  $db = @('--infoic', (Join-Path $res 'infoic.xml'), '--logicic', (Join-Path $res 'logicic.xml'))

  # minipro writes --version and -k to stderr; cmd /c merges it for us.
  $version = (cmd /c "`"$bin`" $($db[0]) `"$($db[1])`" $($db[2]) `"$($db[3])`" --version 2>&1") -join "`n"
  $code = $LASTEXITCODE
  Write-Host $version
  if ($code -ne 0) { Fail "--version exited $code" }
  if ($version -notmatch 'minipro version') { Fail "--version didn't print a version" }
  if ($version -notmatch 'T48:\s+\d{4,} devices') { Fail "--version didn't count the T48 database" }
  if (-not $version.Contains("Using overridden database file $($db[1])")) { Fail "didn't use the bundled infoic.xml" }

  $devices = & $bin @db -q tl866ii -l
  if ($LASTEXITCODE -ne 0) { Fail "-l exited $LASTEXITCODE" }
  Write-Host "-q tl866ii -l: $($devices.Count) devices"
  if ($devices.Count -lt 1000) { Fail "-l listed only $($devices.Count) devices" }

  # minipro pipes every -l through a pager on Windows. The app names its own
  # in PAGER (WINDOWS_LIST_PAGER in crates/engine/src/cli.rs): a filter that
  # copies every line. It has to list the same names as the default pager.
  $env:PAGER = 'findstr "^"'
  try { $paged = & $bin @db -q tl866ii -l } finally { Remove-Item Env:PAGER }
  if ($LASTEXITCODE -ne 0) { Fail "-l with PAGER set exited $LASTEXITCODE" }
  $names = @($devices | Where-Object { $_ })
  $pagedNames = @($paged | Where-Object { $_ })
  Write-Host "-q tl866ii -l through findstr: $($pagedNames.Count) names (default pager: $($names.Count))"
  $diff = @(Compare-Object $names $pagedNames -SyncWindow 0)
  if ($diff.Count -ne 0) {
    $diff | Select-Object -First 10 | Format-Table | Out-String | Write-Host
    Fail "-l through findstr differs from the default pager in $($diff.Count) lines"
  }

  & $bin @db -q t48 -d AT27C256@DIP28 | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "-d AT27C256@DIP28 exited $LASTEXITCODE" }

  $presence = (cmd /c "`"$bin`" -k 2>&1") -join "`n"
  Write-Host "-k: $presence"
  if ($presence -notmatch 'No programmer found') { Fail "-k gave unexpected output" }
} finally {
  Pop-Location
}

Section "uninstall"
$uninstaller = Join-Path $dir 'uninstall.exe'
if (Test-Path $uninstaller) {
  $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  Write-Host "uninstaller exited $($u.ExitCode)"
}

Write-Host "`nNSIS install: OK`nAll sidecar checks passed."
