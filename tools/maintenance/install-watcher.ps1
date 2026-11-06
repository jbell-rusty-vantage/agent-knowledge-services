param([switch]$Remove, [switch]$Start)
$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$identity = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($repository))).Substring(0, 12)
$taskName = "KS-Git-Maintenance-$identity"
$marker = "Knowledge Services Git reconciliation for $repository"
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and $existing.Description -ne $marker) { throw 'Existing unrelated scheduled task preserved.' }
if ($Remove) {
    if ($existing) {
        Stop-ScheduledTask -TaskName $taskName
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    }
    Write-Output "Removed managed watcher: $taskName"
    exit
}
$shellPath = (Get-Process -Id $PID).Path
$gitDirectory = & git -C $repository rev-parse --git-common-dir
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Git common directory.' }
$stateDirectory = [IO.Path]::GetFullPath((Join-Path $repository (Join-Path $gitDirectory 'maintenance')))
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$runtimeDirectories = @('node', 'git', 'gh', 'agent') | ForEach-Object {
    $installedCommand = Get-Command $_ -ErrorAction SilentlyContinue
    if ($installedCommand -and $installedCommand.Source) { Split-Path -Parent $installedCommand.Source }
} | Select-Object -Unique
@{ node = (Get-Command node -ErrorAction Stop).Source; directories = @($runtimeDirectories) } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stateDirectory 'watcher-runtime.json') -Encoding utf8
$runner = Join-Path $PSScriptRoot 'run-watcher.ps1'
$launcher = Join-Path $PSScriptRoot 'run-watcher-hidden.vbs'
$scriptHost = Join-Path $env:SystemRoot 'System32/wscript.exe'
if (-not (Test-Path -LiteralPath $scriptHost)) { throw 'Windows Script Host is required for windowless watcher startup.' }
$action = New-ScheduledTaskAction -Execute $scriptHost -Argument "//B //NoLogo `"$launcher`" `"$shellPath`" `"$runner`"" -WorkingDirectory $repository
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $marker
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
if ($Start) { Start-ScheduledTask -TaskName $taskName }
Write-Output "Installed managed watcher: $taskName (current user must be signed in)"
