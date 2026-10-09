<#
    install-host.ps1 — registers the WebSDR-Sync TCP relay as a Chrome native
    messaging host on Windows.

        .\install-host.ps1              install
        .\install-host.ps1 -Test        check the relay runs, without Chrome
        .\install-host.ps1 -Uninstall   remove

    Windows registers native messaging hosts in the REGISTRY, not by dropping a
    file in a known directory the way macOS and Linux do. A key under
    HKCU:\Software\<browser>\NativeMessagingHosts\<host name> holds, as its
    default value, the absolute path of a manifest JSON file — which this script
    writes next to itself.

    Chrome cannot exec a .py directly, so the registered path is a small .bat
    that calls the interpreter this script verified. The relay itself already
    puts stdio into binary mode (msvcrt.setmode), which Windows needs: in text
    mode \n becomes \r\n and the length-prefixed message framing desyncs.

    If PowerShell refuses to run this, it is the execution policy, not the
    script:  powershell -ExecutionPolicy Bypass -File .\install-host.ps1
#>

[CmdletBinding()]
param(
    [switch] $Test,
    [switch] $Uninstall,
    [switch] $ShowConsole,          # use python.exe instead of pythonw.exe
    [string] $Python,               # force a specific interpreter
    [string] $TargetOverride        # testing only: ping this path directly
)

$ErrorActionPreference = 'Stop'

$HostName    = 'nl.websdrsync.rigctld_bridge'
$LegacyHost  = 'nl.catsdr.rigctld_bridge'      # pre-rename; cleaned up on install
$ExtId       = 'oemieknppkbaemfioegnockcekglefbn'

$Dir          = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$PyScript     = Join-Path $Dir 'websdrsync_host.py'
$BatFile      = Join-Path $Dir 'websdrsync_host.bat'
$HostManifest = Join-Path $Dir 'websdrsync_host.win.json'
$LogFile      = Join-Path $Dir 'websdrsync_host.log'

$RegRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'HKCU:\Software\Google\Chrome Beta\NativeMessagingHosts'
    'HKCU:\Software\Google\Chrome SxS\NativeMessagingHosts'      # Canary
    'HKCU:\Software\Chromium\NativeMessagingHosts'
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

# ---------------------------------------------------------------- interpreter
function Find-Python {
    param([string] $Preferred)

    # Native commands that exit non-zero must not become terminating errors here:
    # probing candidates means expecting some of them to fail.
    $ErrorActionPreference = 'Continue'
    if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -Scope Global -ErrorAction SilentlyContinue) {
        $script:savedNative = $global:PSNativeCommandUseErrorActionPreference
        $global:PSNativeCommandUseErrorActionPreference = $false
    }

    # NO DOUBLE QUOTES IN THIS STRING. Windows PowerShell wraps an argument
    # containing spaces in double quotes when it builds the command line, and any
    # embedded " then closes that quoting early -- python would receive mangled
    # source and fail, making a perfectly good interpreter look broken.
    $probeCode = 'import sys, socket, json, struct, threading, ipaddress; sys.stdout.write(sys.version.split()[0])'

    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Preferred) { $candidates.Add($Preferred) }

    # The py launcher is the most reliable way to find a real python.org install.
    try {
        $viaLauncher = & py -3 -c 'import sys; sys.stdout.write(sys.executable)' 2>$null
        if ($viaLauncher) { $candidates.Add(($viaLauncher | Out-String).Trim()) }
    } catch { }

    foreach ($name in 'python.exe', 'python3.exe', 'python') {
        try {
            Get-Command $name -All -ErrorAction Stop |
                Where-Object { $_.CommandType -eq 'Application' } |
                ForEach-Object { $candidates.Add($_.Source) }
        } catch { }
    }

    $seen = @{}
    foreach ($c in $candidates) {
        if (-not $c) { continue }
        if ($seen.ContainsKey($c)) { continue }
        $seen[$c] = $true
        if (-not (Test-Path -LiteralPath $c)) { continue }

        # %LOCALAPPDATA%\Microsoft\WindowsApps\python.exe is an App Execution
        # Alias: a stub that opens the Microsoft Store when Python is absent.
        if ($c -like '*\Microsoft\WindowsApps\*') {
            Write-Host "  skipping $c"
            Write-Host "           (Microsoft Store alias, not a real interpreter)"
            continue
        }

        $out = ''
        $rc  = $null
        try {
            $out = (& $c -c $probeCode 2>&1 | Out-String).Trim()
            $rc  = $LASTEXITCODE
        } catch {
            $out = $_.Exception.Message
        }

        if ($rc -eq 0 -and $out -match '^\d+\.\d+') {
            Write-Host "  using    $c  (Python $out)"
            return $c
        }

        # Say WHY, so a rejected interpreter is diagnosable instead of mysterious.
        Write-Host "  skipping $c"
        Write-Host "           exit code: $rc"
        if ($out) { Write-Host "           output   : $out" }
    }
    return $null
}

function Get-Pythonw {
    param([string] $PyExe)
    if ($ShowConsole) { return $PyExe }
    # pythonw.exe runs without opening a console window. Chrome redirects stdio
    # either way, so the protocol is unaffected.
    $w = Join-Path (Split-Path -Parent $PyExe) 'pythonw.exe'
    if (Test-Path -LiteralPath $w) { return $w }
    return $PyExe
}

# ------------------------------------------------------------------- location
function Test-Location {
    $cloud = @('\OneDrive', '\Dropbox', '\Google Drive', '\GoogleDrive', '\iCloudDrive')
    foreach ($c in $cloud) {
        if ($Dir -like "*$c*") {
            Write-Warning "This folder is inside $($c.TrimStart('\'))."
            Write-Warning "  On Windows Chrome can usually still run the relay from there, but"
            Write-Warning "  Files On-Demand can turn the scripts into online-only placeholders"
            Write-Warning "  while Chrome is reading them. A local folder such as C:\WebSDR-Sync"
            Write-Warning "  is safer."
            break
        }
    }
    # cmd.exe reads a .bat in the console codepage, so an accented or non-Latin
    # character anywhere in this path can break the launcher in ways that only
    # show up as "Native host has exited".
    $nonAscii = ($Dir.ToCharArray() | Where-Object { [int]$_ -gt 127 })
    if ($nonAscii) {
        Write-Warning "This path contains non-ASCII characters: $Dir"
        Write-Warning "  cmd.exe may mangle them in the launcher. If the relay fails to start,"
        Write-Warning "  move the folder somewhere with a plain ASCII path such as C:\WebSDR-Sync."
    }
}

# ------------------------------------------------------------- native ping
function Invoke-HostPing {
    param([Parameter(Mandatory)] [string] $Target)

    # Everything here is on the failure path by design: a relay that dies on
    # startup makes the stdin write throw a broken pipe. Report that as a clean
    # FAIL with whatever stderr we caught, never as an unhandled exception.
    $proc = $null
    try {
        $psi = [System.Diagnostics.ProcessStartInfo]::new()
        $psi.FileName               = $Target
        $psi.UseShellExecute        = $false
        $psi.CreateNoWindow         = $true
        $psi.RedirectStandardInput  = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError  = $true

        $proc = [System.Diagnostics.Process]::Start($psi)

        $json  = '{"op":"ping"}'
        $body  = [System.Text.Encoding]::UTF8.GetBytes($json)
        $len   = [System.BitConverter]::GetBytes([int] $body.Length)   # 4-byte LE
        $stdin = $proc.StandardInput.BaseStream
        $stdin.Write($len, 0, 4)
        $stdin.Write($body, 0, $body.Length)
        $stdin.Flush()
        $stdin.Close()         # EOF makes the relay exit cleanly after replying

        $ms = [System.IO.MemoryStream]::new()
        $proc.StandardOutput.BaseStream.CopyTo($ms)
        $err = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit(10000) | Out-Null

        $bytes = $ms.ToArray()
        if ($bytes.Length -ge 4) {
            $n = [System.BitConverter]::ToInt32($bytes, 0)
            if ($n -gt 0 -and $bytes.Length -ge (4 + $n)) {
                $reply = [System.Text.Encoding]::UTF8.GetString($bytes, 4, $n)
                return [pscustomobject]@{ Ok = $true; Reply = $reply; Err = $err; Code = $proc.ExitCode }
            }
        }
        $why = if ($bytes.Length -eq 0) { 'the relay wrote nothing at all' }
               else { "the relay wrote $($bytes.Length) bytes that are not a native-messaging frame" }
        return [pscustomobject]@{ Ok = $false; Reply = $null; Err = $err; Code = $proc.ExitCode; Why = $why }
    }
    catch {
        $err = ''
        $code = $null
        try { if ($proc) { $err = $proc.StandardError.ReadToEnd() } } catch { }
        try { if ($proc -and $proc.HasExited) { $code = $proc.ExitCode } } catch { }
        return [pscustomobject]@{ Ok = $false; Reply = $null; Err = $err; Code = $code
                                  Why = "the relay exited before it could be spoken to ($($_.Exception.Message))" }
    }
    finally {
        try { if ($proc -and -not $proc.HasExited) { $proc.Kill() } } catch { }
    }
}

function Get-RegisteredTarget {
    foreach ($root in $RegRoots) {
        $key = $root + '\' + $HostName
        try {
            if (Test-Path -LiteralPath $key) {
                $manifestPath = (Get-ItemProperty -LiteralPath $key).'(default)'
                if ($manifestPath -and (Test-Path -LiteralPath $manifestPath)) {
                    $m = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
                    return [pscustomobject]@{ Manifest = $manifestPath; Path = $m.path }
                }
            }
        } catch { }
    }
    return $null
}

# ===================================================================== actions
if ($Uninstall) {
    # One implementation, in one place.
    $un = Join-Path $Dir 'uninstall-host.ps1'
    if (Test-Path -LiteralPath $un) { & $un; exit $LASTEXITCODE }
    Write-Host "ERROR: uninstall-host.ps1 is missing from $Dir" -ForegroundColor Red
    exit 1
}

if ($Test) {
    $target = $TargetOverride
    $manifestPath = $null
    if (-not $target) {
        $reg = Get-RegisteredTarget
        if (-not $reg) {
            Write-Host "FAIL: no registry entry for $HostName - run .\install-host.ps1 first" -ForegroundColor Red
            exit 1
        }
        $manifestPath = $reg.Manifest
        $target = $reg.Path
        Write-Host "manifest : $manifestPath"
    }
    Write-Host "host path: $target"
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host "FAIL: $target does not exist - re-run .\install-host.ps1" -ForegroundColor Red
        exit 1
    }
    Write-Host 'sending  : {"op":"ping"}'
    $r = Invoke-HostPing -Target $target
    if ($r.Ok) {
        Write-Host "PASS: relay replied $($r.Reply)" -ForegroundColor Green
        Write-Host ""
        Write-Host "The relay is fine. If Chrome still says `"Native host has exited`","
        Write-Host "close Chrome completely and reopen it, and confirm the extension id on"
        Write-Host "chrome://extensions is $ExtId."
    } else {
        Write-Host "FAIL: $($r.Why)" -ForegroundColor Red
        if ($null -ne $r.Code) { Write-Host "      exit code $($r.Code)" }
        if ($r.Err) { Write-Host "stderr:"; Write-Host $r.Err }
        Write-Host "See $LogFile for the interpreter's own error output."
        exit 1
    }
    return
}

# -------------------------------------------------------------------- install
Write-Host "folder   : $Dir"
Test-Location

if (-not (Test-Path -LiteralPath $PyScript)) {
    throw "websdrsync_host.py not found next to this script ($PyScript)"
}

# Files extracted from a downloaded zip carry the Mark of the Web, which blocks
# script execution. Clear it across the whole extension folder.
try {
    Get-ChildItem -LiteralPath (Split-Path -Parent $Dir) -Recurse -File -ErrorAction SilentlyContinue |
        Unblock-File -ErrorAction SilentlyContinue
    Write-Host "mark-of-web: cleared"
} catch { }

$py = Find-Python -Preferred $Python
if (-not $py) {
    Write-Host ""
    Write-Host "ERROR: no working python3 found." -ForegroundColor Red
    Write-Host "       Install it from https://www.python.org/downloads/ (tick 'Add python.exe"
    Write-Host "       to PATH'), then re-run this script. Avoid the Microsoft Store stub."
    Write-Host ""
    Write-Host "       If Python IS installed and was rejected above, the reason is printed"
    Write-Host "       with each candidate. You can also force one:"
    Write-Host "         .\install-host.ps1 -Python 'C:\Path\To\python.exe'"
    exit 1
}
$runner = Get-Pythonw -PyExe $py
Write-Host "python   : $py"
if ($runner -ne $py) { Write-Host "runner   : $runner  (no console window; -ShowConsole to override)" }

# Chrome will not CreateProcess a .py, so register a .bat that calls the
# interpreter. Nothing here may write to stdout: that pipe carries the protocol.
$bat = @"
@echo off
"$runner" "$PyScript" %* 2>>"$LogFile"
"@
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($BatFile, $bat, $utf8NoBom)

$manifest = [ordered]@{
    name            = $HostName
    description     = 'WebSDR-Sync: TCP relay to rigctld'
    path            = $BatFile
    type            = 'stdio'
    allowed_origins = @("chrome-extension://$ExtId/")
}
[System.IO.File]::WriteAllText($HostManifest, ($manifest | ConvertTo-Json -Depth 4), $utf8NoBom)

foreach ($root in $RegRoots) {
    $key = $root + '\' + $HostName
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -LiteralPath $key -Name '(default)' -Value $HostManifest
    Write-Host "registered $key"

    $old = $root + '\' + $LegacyHost          # tidy up the pre-rename entry
    if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Recurse -Force }
}

Write-Host ""
Write-Host "Host name    : $HostName"
Write-Host "Host manifest: $HostManifest"
Write-Host "Launcher     : $BatFile"
Write-Host "Extension id : $ExtId  (pinned by the 'key' field in manifest.json)"
Write-Host "Relay log    : $LogFile"
Write-Host ""
Write-Host "Verify it runs:   .\install-host.ps1 -Test"
Write-Host "Then load the extension unpacked, start rigctld, and click Connect."
Write-Host "Close Chrome completely and reopen it if it was already running."
