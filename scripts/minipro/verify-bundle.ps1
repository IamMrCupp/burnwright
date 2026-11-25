# Check that the Windows installer carries a working minipro sidecar, run from
# where an installed copy of burnwright finds it, not from the build tree.
#
#   pwsh scripts/minipro/verify-bundle.ps1 <burnwright_*-setup.exe>
#
# Runs the NSIS installer silently (per-user, no admin), lists what it
# installed, then runs burnwright-minipro.exe and burnwright-minipro-t76.exe
# from the install folder with
# PATH cut down to System32: no MSYS2 or other DLLs may be needed. Same checks
# as verify-bundle.sh: version and database counts, a full -l listing, and
# "No programmer found" (CI has no hardware). Then burnwright.exe itself,
# started the way it starts itself to scan a dump (--inspect-worker, #153):
# it has to read a dump from stdin and write its report to stdout, with the
# same cut-down PATH. Uninstalls afterwards.
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

if (-not (Test-Path (Join-Path $dir 'burnwright.exe'))) { Fail "burnwright.exe isn't next to the sidecar" }

# Only Windows' own DLLs, and an unrelated working directory so minipro can't
# pick up databases from the current folder.
$env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
$work = Join-Path ([IO.Path]::GetTempPath()) "bw-verify-$PID"
New-Item -ItemType Directory -Force $work | Out-Null

# Both builds: the stable one, and the T76-only one with its own databases.
foreach ($variant in @(
    @{ Name = $sidecarName; Res = 'minipro'; T76 = $false },
    @{ Name = 'burnwright-minipro-t76.exe'; Res = 'minipro-t76'; T76 = $true })) {
  $bin = Join-Path $dir $variant.Name
  $res = Join-Path $dir $variant.Res
  if (-not (Test-Path $bin)) { Fail "installed $($variant.Name) not found" }
  foreach ($f in 'infoic.xml', 'logicic.xml', 'LICENSE.minipro.txt', 'COPYING.libusb.txt', 'LICENSE.zlib.txt', 'NOTICE.txt') {
    $path = Join-Path $res $f
    if (-not (Test-Path $path) -or (Get-Item $path).Length -eq 0) { Fail "missing $path" }
  }
  if (-not (Select-String -Path (Join-Path $res 'NOTICE.txt') -Pattern 'Commit:' -Quiet)) { Fail "$($variant.Res)\NOTICE.txt doesn't record the minipro commit" }

  Section "run $bin"
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
    if ($variant.T76 -and $version -notmatch 'T76:\s+\d{4,} devices') { Fail "--version didn't count the T76 database" }
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
}

# The app as its own scan worker. burnwright.exe is a GUI program with no
# console, so this is also the check that it reads and writes plain pipes,
# which is how the app talks to it. The dump is made here: 4 KiB of erased
# flash, then a 74-byte gzip file holding one line of text (the bytes
# crates/inspect's tests use).
$app = Join-Path $dir 'burnwright.exe'
Section "run $app --inspect-worker"
$image = [IO.MemoryStream]::new()
$erased = [byte[]]::new(4096)
[Array]::Fill($erased, [byte]0xFF)
$image.Write($erased, 0, $erased.Length)
$gzip = [Convert]::FromHexString('1f8b0800000000600003013300ccff6275726e77726967687420746573743a206e6f7468696e67206865726520697320616e796f6e652773206669726d776172650a68f5184b33000000')
$image.Write($gzip, 0, $gzip.Length)
$dump = $image.ToArray()
$len = $dump.Length

# .NET's own process class, not Start-Process: the bytes go down a pipe
# untouched, where PowerShell's redirection may treat them as text.
$start = [Diagnostics.ProcessStartInfo]::new($app, '--inspect-worker')
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$start.WorkingDirectory = $work
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$w = [Diagnostics.Process]::Start($start)
$stdout = $w.StandardOutput.ReadToEndAsync()
$stderr = $w.StandardError.ReadToEndAsync()
$w.StandardInput.BaseStream.Write($dump, 0, $dump.Length)
$w.StandardInput.Close()
# A binary that missed the argument would open a window and stay: give it
# two minutes, not the rest of the job.
if (-not $w.WaitForExit(120000)) {
  $w.Kill()
  Fail "the scan worker was still running after two minutes"
}
if ($w.ExitCode -ne 0) {
  Write-Host $stderr.Result
  Fail "the scan worker exited $($w.ExitCode)"
}
$json = $stdout.Result
Write-Host $json
if (-not $json) { Fail "the scan worker wrote nothing" }
if (-not $json.Contains("`"len`":$len,")) { Fail "the report isn't of all $len bytes" }
if (-not $json.Contains('"offset":4096,"size":74,"kind":"gzip"')) { Fail "the scan worker didn't find the gzip file at offset 4096" }
Write-Host "scan worker: OK"

Section "uninstall"
$uninstaller = Join-Path $dir 'uninstall.exe'
if (Test-Path $uninstaller) {
  $u = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
  Write-Host "uninstaller exited $($u.ExitCode)"
}

Write-Host "`nNSIS install: OK`nAll bundle checks passed."
