# Snapshots a repo's working tree as a git tree object without touching the real
# index, stash or branch: copies the index to a temp file, stages everything into
# the copy (so unchanged files are not re-hashed), and prints the tree id.
# Usage: snapshot.ps1 <git-dir> <work-tree>
param([string]$GitDir, [string]$WorkTree)
$ErrorActionPreference = "Stop"
$store = Join-Path $GitDir "wingman"
New-Item -ItemType Directory -Force -Path (Join-Path $store "baselines") | Out-Null
# Each run has its own index copy (snap.<pid>.index), removed when the run ends. A run killed
# outright leaves its copy (and git's .lock): the next run removes those of runs that are gone,
# and the single snap.index of older versions.
foreach ($f in [IO.Directory]::GetFiles($store, "snap.*")) {
  $n = [IO.Path]::GetFileName($f)
  if ($n -eq "snap.index" -or $n -eq "snap.index.lock") { Remove-Item -Force -LiteralPath $f -ErrorAction SilentlyContinue; continue }
  if ($n -match '^snap\.(\d+)\.index(\.lock)?$' -and -not (Get-Process -Id ([int]$Matches[1]) -ErrorAction SilentlyContinue)) { Remove-Item -Force -LiteralPath $f -ErrorAction SilentlyContinue }
}
$tmp = Join-Path $store "snap.$PID.index"
$real = Join-Path $GitDir "index"
$code = 1
try {
  Remove-Item -Force -LiteralPath $tmp, "$tmp.lock" -ErrorAction SilentlyContinue
  # Copy-Item keeps the index's last-write time (the racy-index rule, see snapshot.sh).
  if (Test-Path -LiteralPath $real) { Copy-Item -Force -LiteralPath $real -Destination $tmp }
  $env:GIT_INDEX_FILE = $tmp
  Set-Location -LiteralPath $WorkTree
  git --no-optional-locks add -A
  $code = $LASTEXITCODE
  if ($code -eq 0) { git write-tree; $code = $LASTEXITCODE }
} finally {
  Remove-Item -Force -LiteralPath $tmp, "$tmp.lock" -ErrorAction SilentlyContinue
}
exit $code
