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
  # A copy racing a commit or add running in the repo can fail (git replaces its index): a few tries, then fail.
  if (Test-Path -LiteralPath $real) {
    for ($i = 1; ; $i++) {
      try { Copy-Item -Force -LiteralPath $real -Destination $tmp -ErrorAction Stop; break }
      catch { if ($i -ge 5) { throw }; Start-Sleep -Milliseconds 50 }
    }
  }
  $env:GIT_INDEX_FILE = $tmp
  Set-Location -LiteralPath $WorkTree
  # git's stderr (a CRLF warning, say) must not fail the run: when the caller redirects stderr, Windows
  # PowerShell turns each line into an error record that "Stop" would make fatal. The exit code decides.
  $ErrorActionPreference = "Continue"
  # core.safecrlf=false only silences the line-ending warning, it does not change what is hashed.
  # No hook or fsmonitor may run for a snapshot. --ignore-errors: a file git can't read (locked, a filter that
  # fails) is left out, or keeps its indexed content, instead of losing the snapshot: git then exits 1 after
  # indexing everything else, which is fine. Any other code (128: a corrupt index) is a real failure.
  # A filter marked required (git-lfs, say) that can't run is fatal for the whole tree: drop the flag for this run.
  $extra = @(git config --name-only --get-regexp '^filter\..*\.required$' 2>$null | ForEach-Object { "-c"; "$_=false" })
  $nohooks = Join-Path $store "nohooks"
  git --no-optional-locks -c core.safecrlf=false -c core.fsmonitor=false -c "core.hooksPath=$nohooks" @extra add -A --ignore-errors
  $code = $LASTEXITCODE
  if ($code -eq 1) { $code = 0 }
  if ($code -eq 0) { git -c core.fsmonitor=false -c "core.hooksPath=$nohooks" @extra write-tree; $code = $LASTEXITCODE }
} finally {
  Remove-Item -Force -LiteralPath $tmp, "$tmp.lock" -ErrorAction SilentlyContinue
}
exit $code
