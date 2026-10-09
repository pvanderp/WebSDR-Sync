<#
    uninstall-host.ps1 — removes the WebSDR-Sync relay from this machine.

        .\uninstall-host.ps1            remove the registration and generated files
        .\uninstall-host.ps1 -DryRun    list what would be removed, change nothing

    On Windows the registration lives in the registry, so this deletes the
    HKCU keys for every Chromium-family browser under BOTH the current host name
    and the pre-rename one, then removes the files the installer generated. It
    re-checks afterwards and reports anything that survived rather than assuming
    success.

    It does not delete this folder and does not touch the extension itself --
    both are yours to remove, and the script says how.

    If PowerShell refuses to run this, it is the execution policy, not the
    script:  powershell -ExecutionPolicy Bypass -File .\uninstall-host.ps1
#>

[CmdletBinding()]
param(
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

# Both names: a folder set up before the rename still has the old one
# registered, pointing at a script that no longer exists.
$HostNames = @('nl.websdrsync.rigctld_bridge', 'nl.catsdr.rigctld_bridge')

$Dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

$RegRoots = @(
    'HKCU:\Software\Google\Chrome\NativeMessagingHosts'
    'HKCU:\Software\Google\Chrome Beta\NativeMessagingHosts'
    'HKCU:\Software\Google\Chrome SxS\NativeMessagingHosts'      # Canary
    'HKCU:\Software\Chromium\NativeMessagingHosts'
    'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
    'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)

# Files the installer generated. Shipped sources are never touched.
$Generated = @(
    (Join-Path $Dir 'websdrsync_host.bat')
    (Join-Path $Dir 'websdrsync_host.win.json')
    (Join-Path $Dir 'websdrsync_host.log')
    (Join-Path $Dir 'websdrsync_host.sh')
    (Join-Path $Dir 'catsdr_host.bat')
    (Join-Path $Dir 'catsdr_host.log')
)

function Test-RegKey {
    param([string] $Key)
    # The HKCU: drive does not exist off Windows; treat that as "nothing there"
    # rather than letting it abort the run.
    try { return (Test-Path -LiteralPath $Key) } catch { return $false }
}

if ($DryRun) { Write-Host "DRY RUN — nothing will be changed."; Write-Host "" }

# ------------------------------------------------------------ registrations
foreach ($root in $RegRoots) {
    foreach ($n in $HostNames) {
        $key = $root + '\' + $n
        if (Test-RegKey $key) {
            if ($DryRun) {
                Write-Host "would remove  $key"
            } else {
                try {
                    Remove-Item -LiteralPath $key -Recurse -Force
                    Write-Host "removed  $key"
                } catch {
                    Write-Host "FAILED to remove $key : $($_.Exception.Message)" -ForegroundColor Red
                }
            }
        }
    }
}

# --------------------------------------------------------- generated files
foreach ($f in $Generated) {
    if (Test-Path -LiteralPath $f) {
        if ($DryRun) {
            Write-Host "would remove  $f"
        } else {
            try {
                Remove-Item -LiteralPath $f -Force
                Write-Host "removed  $f"
            } catch {
                Write-Host "FAILED to remove $f : $($_.Exception.Message)" -ForegroundColor Red
            }
        }
    }
}

$pycache = Join-Path $Dir '__pycache__'
if (Test-Path -LiteralPath $pycache) {
    if ($DryRun) { Write-Host "would remove  $pycache" }
    else {
        try { Remove-Item -LiteralPath $pycache -Recurse -Force; Write-Host "removed  $pycache" }
        catch { Write-Host "FAILED to remove $pycache" -ForegroundColor Red }
    }
}

# ------------------------------------------------------------------- verify
if (-not $DryRun) {
    $left = @()
    foreach ($root in $RegRoots) {
        foreach ($n in $HostNames) {
            $key = $root + '\' + $n
            if (Test-RegKey $key) { $left += $key }
        }
    }
    foreach ($f in $Generated) { if (Test-Path -LiteralPath $f) { $left += $f } }

    if ($left.Count) {
        Write-Host ""
        foreach ($l in $left) { Write-Host "STILL PRESENT  $l" -ForegroundColor Red }
        Write-Host "Some items could not be removed — check permissions and re-run." -ForegroundColor Red
        exit 1
    }
    Write-Host ""
    Write-Host "Relay removed. Nothing of it is left registered on this machine." -ForegroundColor Green
}

Write-Host @"

Two things this script deliberately does not do:

  1. Remove the extension. Go to chrome://extensions and click Remove on
     WebSDR-Sync. Your saved settings (rigctld host, receiver choice) live with
     the extension and go with it.

  2. Delete this folder. Once the extension is removed you can delete it
     yourself; nothing outside it will still point here.
"@
