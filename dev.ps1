# .\dev: the codebase CLI for agents working on Knowledge Services (scripts/dev/dev_cli.py).
# Standard-library Python, so it runs before `pnpm install`. POSIX shells: ./dev
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command python3 -ErrorAction SilentlyContinue }
if (-not $py) {
    Write-Error "dev: no python on PATH; install Python 3.12+ (uv python install 3.12)"
    exit 3
}
& $py.Source -X utf8 (Join-Path $PSScriptRoot 'scripts/dev/dev_cli.py') @args
exit $LASTEXITCODE
