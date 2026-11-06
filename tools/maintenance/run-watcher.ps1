$ErrorActionPreference = 'Stop'
$repository = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Set-Location -LiteralPath $repository
$gitDirectory = & git rev-parse --git-common-dir
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve Git common directory.' }
$stateDirectory = [IO.Path]::GetFullPath((Join-Path $repository (Join-Path $gitDirectory 'maintenance')))
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$runtime = Get-Content -LiteralPath (Join-Path $stateDirectory 'watcher-runtime.json') -Raw | ConvertFrom-Json
$env:Path = (@($runtime.directories) + @($env:Path)) -join [IO.Path]::PathSeparator
& $runtime.node (Join-Path $PSScriptRoot 'cli.mjs') watch --once *> (Join-Path $stateDirectory 'watcher-last-run.log')
exit $LASTEXITCODE
