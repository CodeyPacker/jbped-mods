# Installs Wingman into a Herdr home: the wingman and tabs-plus mods, the layout blocks and
# the Claude Code hook (through the mod's own install.ps1, which sets the Windows environment
# and installs the hook in WSL). Run it from a clone of this repo. It downloads nothing.
#
#   powershell -ExecutionPolicy Bypass -File wingman\install.ps1 [install|uninstall|status] [-NoLayout] [-NoHook] [-DryRun] [-Purge]
#
#   install     (default) copy the mods, patch or clone a layout, install the hook
#   uninstall   remove the hook, the layout blocks and both mods (data\wingman stays unless -Purge)
#   status      show what is installed
#   -NoLayout   leave layouts alone
#   -NoHook     leave the Windows environment and WSL's Claude settings alone
#   -DryRun     print every action, write nothing
#   -Purge      with uninstall: also delete data\wingman
#
# Herdr home: $env:HERDR_APP_HOME, else %USERPROFILE%\.config\herdr-app.
# Windows PowerShell 5.1 or later.
param(
  [Parameter(Position = 0)][ValidateSet("install", "uninstall", "status")][string]$Action = "install",
  [switch]$NoLayout,
  [switch]$NoHook,
  [switch]$DryRun,
  [switch]$Purge
)
$ErrorActionPreference = "Stop"

$share = $PSScriptRoot
$repo = Split-Path -Parent $share
$wingSrc = Join-Path $share "mods\wingman"
$tabsSrc = Join-Path $repo "tabs-plus\mods\tabs-plus"
$ts = Get-Date -Format "yyyyMMdd-HHmmss"
$script:changed = @()
$script:nexts = @()
$script:res = ""

function Die($m) { Write-Host "Error: $m"; exit 1 }
function Say($m) { Write-Host $m }
function Act($m) { if ($DryRun) { Say "  [dry-run] would $m" } else { Say "  $m" } }
function NoteChange($m) { $script:changed += "  - $m" }
function NoteNext($m) { $script:nexts += "  - $m" }

# ---- Herdr home ----
if ($env:HERDR_APP_HOME) { $home_ = $env:HERDR_APP_HOME } else { $home_ = Join-Path $env:USERPROFILE ".config\herdr-app" }
if (-not ((Test-Path -LiteralPath (Join-Path $home_ "mods") -PathType Container) -and (Test-Path -LiteralPath (Join-Path $home_ "layouts") -PathType Container))) {
  Die "$home_ does not look like a Herdr home (mods\ and layouts\ missing). Start Herdr once, or set HERDR_APP_HOME."
}
$home_ = (Resolve-Path -LiteralPath $home_).ProviderPath
if ($Action -eq "install" -and -not ((Test-Path -LiteralPath $wingSrc) -and (Test-Path -LiteralPath $tabsSrc))) {
  Die "Run this from a full clone of the repo: $wingSrc and $tabsSrc must exist."
}

# ---- JSON: parse into ordered dictionaries and lists, write back in the file's own style ----
$WING = @(@("wingman-review", "review"), @("wingman-edit", "edit"), @("wingman-changes", "changes"))
$MAXPX = 2400

function ConvertTo-Plain($o) {
  if ($null -eq $o) { return $null }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    $d = [ordered]@{}
    foreach ($p in $o.PSObject.Properties) { $d[$p.Name] = ConvertTo-Plain $p.Value }
    return $d
  }
  if ($o -is [System.Array]) {
    $l = New-Object System.Collections.ArrayList
    foreach ($i in $o) { [void]$l.Add((ConvertTo-Plain $i)) }
    return , $l
  }
  return $o
}

function Esc([string]$s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach ($c in $s.ToCharArray()) {
    switch ($c) {
      '"' { [void]$sb.Append('\"') }
      '\' { [void]$sb.Append('\\') }
      "`n" { [void]$sb.Append('\n') }
      "`r" { [void]$sb.Append('\r') }
      "`t" { [void]$sb.Append('\t') }
      "`b" { [void]$sb.Append('\b') }
      "`f" { [void]$sb.Append('\f') }
      default {
        if ([int]$c -lt 32) { [void]$sb.Append(('\u{0:x4}' -f [int]$c)) } else { [void]$sb.Append($c) }
      }
    }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

function ToJson($v, [string]$ind, [int]$depth) {
  if ($null -eq $v) { return "null" }
  if ($v -is [bool]) { if ($v) { return "true" } else { return "false" } }
  if ($v -is [string]) { return (Esc $v) }
  $inv = [System.Globalization.CultureInfo]::InvariantCulture
  if ($v -is [System.Collections.IDictionary]) {
    if ($v.Count -eq 0) { return "{}" }
    $pad = $ind * ($depth + 1)
    $items = @()
    foreach ($k in $v.Keys) { $items += ($pad + (Esc ([string]$k)) + ": " + (ToJson $v[$k] $ind ($depth + 1))) }
    return "{`n" + ($items -join ",`n") + "`n" + ($ind * $depth) + "}"
  }
  if ($v -is [System.Collections.IList]) {
    if ($v.Count -eq 0) { return "[]" }
    $pad = $ind * ($depth + 1)
    $items = @()
    foreach ($i in $v) { $items += ($pad + (ToJson $i $ind ($depth + 1))) }
    return "[`n" + ($items -join ",`n") + "`n" + ($ind * $depth) + "]"
  }
  if ($v -is [double] -or $v -is [single]) {
    $s = $v.ToString("R", $inv)
    if ($s -notmatch "[.eEN]") { $s += ".0" }
    return $s
  }
  return [string]::Format($inv, "{0}", $v)
}

function Read-Layout([string]$path) {
  $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
  if ($text.Length -gt 0 -and $text[0] -eq [char]0xFEFF) { $text = $text.Substring(1) }
  $nl = "`n"; if ($text.Contains("`r`n")) { $nl = "`r`n" }
  $ind = "  "
  foreach ($line in ($text -split $nl)) {
    $s = $line.TrimStart(" ", "`t")
    if ($s.Length -gt 0 -and $s.Length -ne $line.Length) {
      $ws = $line.Substring(0, $line.Length - $s.Length)
      if ($ws[0] -eq "`t") { $ind = "`t" } else { $ind = $ws }
      break
    }
  }
  $root = ConvertTo-Plain ($text | ConvertFrom-Json)
  return @{ Root = $root; Nl = $nl; Ind = $ind; Eof = $text.EndsWith("`n") }
}

function Write-Layout([string]$path, $L, $root) {
  $out = ToJson $root $L.Ind 0
  if ($L.Eof) { $out += "`n" }
  if ($L.Nl -ne "`n") { $out = $out.Replace("`n", $L.Nl) }
  $tmp = "$path.tmp-$PID"
  [System.IO.File]::WriteAllText($tmp, $out, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Backup-File([string]$src, [string]$dest) {
  $d = $dest; $n = 0
  while (Test-Path -LiteralPath $d) { $n++; $d = "$dest-$n" }
  Copy-Item -LiteralPath $src -Destination $d
  return (Split-Path -Leaf $d)
}

function Get-Nodes($root) {
  $list = New-Object System.Collections.ArrayList
  $stackp = New-Object System.Collections.Stack
  $stackp.Push(@($root, $null))
  while ($stackp.Count -gt 0) {
    $e = $stackp.Pop()
    [void]$list.Add($e)
    $n = $e[0]
    if ($n.Contains("children") -and ($n["children"] -is [System.Collections.IList])) {
      for ($i = $n["children"].Count - 1; $i -ge 0; $i--) {
        $c = $n["children"][$i]
        if ($c -is [System.Collections.IDictionary]) { $stackp.Push(@($c, $n)) }
      }
    }
  }
  return , $list
}

function Is-Wing($n, [string]$view) {
  if ($n["type"] -ne "block") { return $false }
  $c = $n["content"]
  if (-not ($c -is [System.Collections.IDictionary]) -or $c["mod"] -ne "wingman") { return $false }
  $v = $null
  if ($c["props"] -is [System.Collections.IDictionary]) { $v = $c["props"]["view"] }
  if ($view) { return ($v -eq $view) }
  return ($v -eq "review" -or $v -eq "edit" -or $v -eq "changes")
}

function Find-Stack($root) {
  foreach ($e in (Get-Nodes $root)) {
    $n = $e[0]
    if ($n["id"] -eq "panel-body" -and $n["type"] -eq "stack" -and ($n["children"] -is [System.Collections.IList])) { return $e }
  }
  return $null
}

function Is-Number($v) { return ($v -is [int] -or $v -is [long] -or $v -is [decimal] -or $v -is [double]) }

# The capture controller: an empty block in the root's floating list, always rendered.
$CTL_ID = "wingman-capture"

function Is-Ctl($f) {
  if (-not ($f -is [System.Collections.IDictionary])) { return $false }
  $c = $f["content"]
  if (-not ($c -is [System.Collections.IDictionary]) -or $c["mod"] -ne "wingman") { return $false }
  return (($c["props"] -is [System.Collections.IDictionary]) -and $c["props"]["role"] -eq "capture")
}

# Returns the action text, or $null when nothing was added.
function Add-Ctl($root) {
  $fl = $null
  if ($root.Contains("floating")) {
    $fl = $root["floating"]
    if (-not ($fl -is [System.Collections.IList])) { Say "  note: the layout's floating is not a list; capture controller not added"; return $null }
  } else {
    $fl = New-Object System.Collections.ArrayList
  }
  foreach ($f in $fl) { if (Is-Ctl $f) { return $null } }
  foreach ($f in $fl) {
    if ($f -is [System.Collections.IDictionary] -and $f["id"] -eq $CTL_ID) { Say "  note: a floating block with id $CTL_ID exists but is not Wingman's; skipped"; return $null }
  }
  [void]$fl.Add([ordered]@{ id = $CTL_ID; content = ([ordered]@{ mod = "wingman"; props = ([ordered]@{ role = "capture" }) }) })
  $root["floating"] = $fl
  return "add floating block $CTL_ID (capture controller)"
}

function Remove-Ctl($root) {
  if (-not ($root["floating"] -is [System.Collections.IList])) { return $null }
  $keep = New-Object System.Collections.ArrayList
  foreach ($f in $root["floating"]) { if (-not (Is-Ctl $f)) { [void]$keep.Add($f) } }
  if ($keep.Count -eq $root["floating"].Count) { return $null }
  if ($keep.Count -gt 0) { $root["floating"] = $keep } else { $root.Remove("floating") }
  return "remove floating block $CTL_ID"
}

# Adds the blocks. src may differ from dst (a clone). Sets $script:res to changed|unchanged|nostack.
function Patch-Layout([string]$src, [string]$dst, [string]$bak, [string]$cloned) {
  $L = Read-Layout $src
  $root = $L.Root
  $e = Find-Stack $root
  if ($null -eq $e) {
    Say "  note: no stack with id `"panel-body`" in $(Split-Path -Leaf $src)"
    $script:res = "nostack"; return
  }
  $stack = $e[0]; $parent = $e[1]
  $acts = @()
  foreach ($w in $WING) {
    $bid = $w[0]; $view = $w[1]
    $has = $false; $idTaken = $false
    foreach ($c in $stack["children"]) {
      if ($c -is [System.Collections.IDictionary]) {
        if (Is-Wing $c $view) { $has = $true }
        if ($c["id"] -eq $bid) { $idTaken = $true }
      }
    }
    if ($has) { continue }
    if ($idTaken) { Say "  note: a block with id $bid exists but is not Wingman's; skipped"; continue }
    $blk = [ordered]@{ id = $bid; type = "block"; content = ([ordered]@{ mod = "wingman"; props = ([ordered]@{ view = $view }) }) }
    [void]$stack["children"].Add($blk)
    $acts += "add block $bid to panel-body"
  }
  $tabs = $null
  foreach ($x in (Get-Nodes $root)) {
    $n = $x[0]; $c = $n["content"]
    if ($n["type"] -eq "block" -and ($c -is [System.Collections.IDictionary]) -and ($c["mod"] -eq "tabs" -or $c["mod"] -eq "tabs-plus")) {
      if ($null -eq $tabs -or $n["id"] -eq "tabs") { $tabs = $n }
    }
  }
  if ($null -eq $tabs) {
    Say "  note: no tabs block found; Wingman's panel buttons need a tabs block using mod tabs-plus"
  } elseif ($tabs["content"]["mod"] -eq "tabs") {
    $tabs["content"]["mod"] = "tabs-plus"
    $acts += "point block $($tabs['id']) at tabs-plus"
  }
  if ($null -ne $parent -and $parent.Contains("max") -and (Is-Number $parent["max"]) -and $parent["max"] -lt $MAXPX) {
    $acts += "raise max of $($parent['id']) from $($parent['max']) to $MAXPX"
    $parent["max"] = $MAXPX
  }
  $a = Add-Ctl $root
  if ($a) { $acts += $a }
  $clone = ($src -ne $dst)
  if ($clone -and -not $root.Contains("cloned_from")) {
    $cf = [ordered]@{ name = $cloned }
    foreach ($f in (Get-ChildItem -LiteralPath (Split-Path -Parent $src) -Filter "*.json" -File)) {
      try { $o = [System.IO.File]::ReadAllText($f.FullName) | ConvertFrom-Json } catch { continue }
      if ($o.cloned_from -and $o.cloned_from.name -eq $cloned -and $o.cloned_from.version) { $cf["version"] = $o.cloned_from.version; break }
    }
    $new = [ordered]@{}
    foreach ($k in $root.Keys) {
      $new[$k] = $root[$k]
      if ($k -eq "id") { $new["cloned_from"] = $cf }
    }
    if (-not $new.Contains("cloned_from")) {
      $new = [ordered]@{ cloned_from = $cf }
      foreach ($k in $root.Keys) { $new[$k] = $root[$k] }
    }
    $root = $new
    $acts = @("create $(Split-Path -Leaf $dst) as a copy of $(Split-Path -Leaf $src)") + $acts
  }
  foreach ($a in $acts) { Act $a }
  if ($acts.Count -eq 0) { $script:res = "unchanged"; return }
  if (-not $DryRun) {
    if (-not $clone -and $bak -ne "-") { Say "  back up to $(Backup-File $src $bak)" }
    Write-Layout $dst $L $root
  }
  $script:res = "changed"
}

function Unpatch-Layout([string]$path, [string]$bak) {
  $L = Read-Layout $path
  $root = $L.Root
  $ids = $WING | ForEach-Object { $_[0] }
  $acts = @()
  $a = Remove-Ctl $root
  if ($a) { $acts += $a }
  foreach ($x in (Get-Nodes $root)) {
    $n = $x[0]
    if ($n["children"] -is [System.Collections.IList]) {
      $keep = New-Object System.Collections.ArrayList
      foreach ($c in $n["children"]) {
        if ($c -is [System.Collections.IDictionary] -and ($ids -contains $c["id"]) -and (Is-Wing $c "")) {
          $acts += "remove block $($c['id'])"
        } else { [void]$keep.Add($c) }
      }
      if ($keep.Count -ne $n["children"].Count) {
        $n["children"] = $keep
        if ($ids -contains $n["active"]) {
          if ($keep.Count -gt 0 -and $keep[0] -is [System.Collections.IDictionary] -and $keep[0].Contains("id")) { $n["active"] = $keep[0]["id"] }
          else { $n.Remove("active") }
        }
      }
    }
    $c = $n["content"]
    if ($n["type"] -eq "block" -and ($c -is [System.Collections.IDictionary]) -and $c["mod"] -eq "tabs-plus") {
      $c["mod"] = "tabs"
      $acts += "point block $($n['id']) back at tabs"
    }
  }
  foreach ($a in $acts) { Act $a }
  if ($acts.Count -eq 0) { $script:res = "unchanged"; return }
  if (-not $DryRun) {
    Say "  back up to $(Backup-File $path $bak)"
    Write-Layout $path $L $root
  }
  $script:res = "changed"
}

function Get-LayoutStatus([string]$path) {
  $L = Read-Layout $path
  $e = Find-Stack $L.Root
  $n = 0
  if ($e) {
    foreach ($w in $WING) {
      foreach ($c in $e[0]["children"]) { if ($c -is [System.Collections.IDictionary] -and (Is-Wing $c $w[1])) { $n++; break } }
    }
  }
  $tabs = "none"
  foreach ($x in (Get-Nodes $L.Root)) {
    $c = $x[0]["content"]
    if ($x[0]["type"] -eq "block" -and ($c -is [System.Collections.IDictionary]) -and ($c["mod"] -eq "tabs" -or $c["mod"] -eq "tabs-plus")) { $tabs = $c["mod"] }
  }
  $st = "no"; if ($e) { $st = "yes" }
  return @{ Stack = $st; Blocks = $n; Tabs = $tabs; Text = "stack=$st blocks=$n tabs=$tabs" }
}

# Returns @(name, shipped|own|missing).
function Get-ActiveLayout {
  $name = "main"
  try {
    $s = [System.IO.File]::ReadAllText((Join-Path $home_ "shared.json")) | ConvertFrom-Json
    if ($s.layout -is [string] -and $s.layout) { $name = $s.layout }
  } catch { }
  $path = Join-Path $home_ "layouts\$name.json"
  if ($name -match '[/\\]' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return @($name, "missing") }
  $shipped = @("main", "terminals", "win98") -contains $name
  try {
    $inst = [System.IO.File]::ReadAllText((Join-Path $home_ "installed.json")) | ConvertFrom-Json
    $shipped = [bool]($inst.PSObject.Properties.Name -contains "layout:$name")
  } catch { }
  try {
    $o = [System.IO.File]::ReadAllText($path) | ConvertFrom-Json
    if ($o.cloned_from) { $shipped = $false }
  } catch { }
  if ($shipped) { return @($name, "shipped") } else { return @($name, "own") }
}

# ---- mods ----
function Test-Link([string]$p) {
  $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  return ($null -ne $i -and ($i.Attributes -band [System.IO.FileAttributes]::ReparsePoint))
}

function Get-TreeMap([string]$dir) {
  $map = @{}
  $base = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd("\")
  foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -File -Force)) {
    $rel = $f.FullName.Substring($base.Length + 1)
    if ($rel -eq "gpui-kit.d.ts" -or $rel -eq "jsconfig.json") { continue }
    $map[$rel] = (Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
  }
  return $map
}

function Same-Tree([string]$a, [string]$b) {
  $x = Get-TreeMap $a; $y = Get-TreeMap $b
  if ($x.Count -ne $y.Count) { return $false }
  foreach ($k in $x.Keys) { if (-not $y.ContainsKey($k) -or $x[$k] -ne $y[$k]) { return $false } }
  return $true
}

function Copy-Mod([string]$src, [string]$name) {
  $dest = Join-Path $home_ "mods\$name"
  if ((Test-Path -LiteralPath $dest) -and (Test-Link $dest)) {
    Say "  mods\$name is a link; left alone (Herdr does not hot-reload linked folders)"; return
  }
  $exists = Test-Path -LiteralPath $dest -PathType Container
  if ($exists -and (Same-Tree $src $dest)) { Say "  mods\$name is up to date"; return }
  if ($exists) { Act "replace mods\$name" } else { Act "copy mods\$name" }
  if ($DryRun) { return }
  $tmp = Join-Path $home_ ".wingman-install.$PID"
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  Copy-Item -Path (Join-Path $src "*") -Destination $tmp -Recurse -Force
  # Herdr writes these into each mod folder; keep its copies.
  foreach ($f in @("gpui-kit.d.ts", "jsconfig.json")) {
    $t = Join-Path $tmp $f
    if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force }
    $o = Join-Path $dest $f
    if ($exists -and (Test-Path -LiteralPath $o)) { Copy-Item -LiteralPath $o -Destination $t }
  }
  if ($exists) { Move-Item -LiteralPath $dest -Destination "$tmp.old" }
  Move-Item -LiteralPath $tmp -Destination $dest
  if (Test-Path -LiteralPath "$tmp.old") { Remove-Item -LiteralPath "$tmp.old" -Recurse -Force }
  NoteChange "mods\$name installed"
}

# ---- layout ----
function Show-NoStackHelp {
  Say "  no side panel stack found, so no layout was changed. Add these by hand:"
  Say "    - to a stack with id `"panel-body`", three blocks:"
  foreach ($v in @("review", "edit", "changes")) {
    Say "        {`"id`":`"wingman-$v`",`"type`":`"block`",`"content`":{`"mod`":`"wingman`",`"props`":{`"view`":`"$v`"}}}"
  }
  Say "    - to the root's `"floating`" list, the capture controller:"
  Say "        {`"id`":`"wingman-capture`",`"content`":{`"mod`":`"wingman`",`"props`":{`"role`":`"capture`"}}}"
  Say "    - set the tabs block's `"content`":{`"mod`":`"tabs-plus`"}"
  Say "    - raise `"max`" of the column holding the stack to 2400"
  NoteNext "Add the Wingman blocks to your layout by hand (see above)."
}

function Switch-To([string]$name) {
  if ($DryRun) { Act "switch to layout $name"; return }
  $ok = $false
  if (Get-Command herdr-app -ErrorAction SilentlyContinue) {
    try {
      & herdr-app do layout.switch ('{\"name\":\"' + $name + '\"}') *> $null
      $ok = ($LASTEXITCODE -eq 0)
    } catch { $ok = $false }
  }
  if ($ok) { Say "  switched to layout $name"; NoteChange "active layout is now $name" }
  else { NoteNext "Switch to the layout `"$name`": ctrl-shift-l, or Settings." }
}

function Install-Layout {
  Say "Layout"
  $a = Get-ActiveLayout; $name = $a[0]; $kind = $a[1]
  if ($kind -eq "missing") {
    Say "  the active layout `"$name`" has no file in layouts\; layout not changed"
    NoteNext "Make a layout of your own (Duplicate layout in the palette), switch to it, and run this again."
    return
  }
  $lay = Join-Path $home_ "layouts"
  if ($kind -eq "shipped") {
    $target = "$name-wingman"
    Say "  active layout `"$name`" is shipped (read-only); using the copy `"$target`""
    $tp = Join-Path $lay "$target.json"
    if (Test-Path -LiteralPath $tp) { Patch-Layout $tp $tp "$tp.bak-$ts" $name }
    else { Patch-Layout (Join-Path $lay "$name.json") $tp "-" $name }
    if ($script:res -eq "nostack") { Show-NoStackHelp; return }
    if ($script:res -eq "changed") { NoteChange "layout $target.json created or updated" }
    Switch-To $target
  } else {
    Say "  active layout `"$name`" is your own"
    $p = Join-Path $lay "$name.json"
    Patch-Layout $p $p "$p.bak-$ts" $name
    if ($script:res -eq "nostack") { Show-NoStackHelp; return }
    if ($script:res -eq "changed") { NoteChange "layout $name.json patched (backup: $name.json.bak-$ts)" }
    if ($script:res -eq "unchanged") { Say "  already patched" }
  }
}

function Uninstall-Layout {
  Say "Layout"
  $found = $false
  foreach ($f in (Get-ChildItem -LiteralPath (Join-Path $home_ "layouts") -Filter "*.json" -File)) {
    Unpatch-Layout $f.FullName "$($f.FullName).bak-$ts"
    if ($script:res -eq "changed") { $found = $true; NoteChange "layout $($f.Name) restored (backup: $($f.Name).bak-$ts)" }
  }
  if (-not $found) { Say "  no layout had Wingman's blocks" }
}

# ---- hook ----
function Test-HookInstalled {
  # With CLAUDE_CONFIG_DIR set, look at that file. Otherwise ask WSL, where the hook lives.
  if ($env:CLAUDE_CONFIG_DIR) {
    $f = Join-Path $env:CLAUDE_CONFIG_DIR "settings.json"
    if (Test-Path -LiteralPath $f) { return (Select-String -LiteralPath $f -Pattern "herdr-wingman-hook" -Quiet) }
    return $false
  }
  if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
    & wsl.exe -e sh -c 'grep -q herdr-wingman-hook "$HOME/.claude/settings.json" 2>/dev/null' *> $null
    return ($LASTEXITCODE -eq 0)
  }
  return $false
}

function Install-Hook {
  Say "Claude Code hook"
  $inst = Join-Path $home_ "mods\wingman\install\install.ps1"
  if ($DryRun) { Act "run $inst install (sets HERDR_WINGMAN_DIR and WSLENV, installs the hook in WSL)"; return }
  if (-not (Test-Path -LiteralPath $inst)) { Say "  mod not installed; hook skipped"; return }
  $before = "$([Environment]::GetEnvironmentVariable('HERDR_WINGMAN_DIR','User'))|$([Environment]::GetEnvironmentVariable('WSLENV','User'))"
  $had = Test-HookInstalled
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inst install
  if ($LASTEXITCODE -ne 0) { Die "the hook installer failed (exit $LASTEXITCODE)" }
  $after = "$([Environment]::GetEnvironmentVariable('HERDR_WINGMAN_DIR','User'))|$([Environment]::GetEnvironmentVariable('WSLENV','User'))"
  if ($before -ne $after) {
    NoteChange "Windows user variables HERDR_WINGMAN_DIR and WSLENV set"
    NoteNext "Restart Herdr, so new terminals get the variables."
  }
  if (-not $had) {
    NoteChange "hook added in WSL's Claude settings"
    NoteNext "Restart running Claude Code sessions so they load the hook."
  }
}

function Uninstall-Hook {
  Say "Claude Code hook"
  $inst = Join-Path $wingSrc "install\install.ps1"
  if (-not (Test-Path -LiteralPath $inst)) { $inst = Join-Path $home_ "mods\wingman\install\install.ps1" }
  if ($DryRun) { Act "run $inst uninstall"; return }
  if (-not (Test-Path -LiteralPath $inst)) { Say "  hook installer not found; hook left alone"; return }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $inst uninstall
  if ($LASTEXITCODE -ne 0) { Die "the hook installer failed (exit $LASTEXITCODE)" }
  NoteChange "hook and Windows user variables removed"
  NoteNext "Restart Herdr and running Claude Code sessions."
}

# ---- status ----
function Show-ModStatus([string]$src, [string]$name) {
  $dest = Join-Path $home_ "mods\$name"
  if (-not (Test-Path -LiteralPath $dest)) { Say "  mods\${name}: not installed" }
  elseif (Test-Link $dest) { Say "  mods\${name}: linked folder" }
  elseif (-not (Test-Path -LiteralPath $src)) { Say "  mods\${name}: installed (no repo copy to compare)" }
  elseif (Same-Tree $src $dest) { Say "  mods\${name}: installed, matches the repo copy" }
  else { Say "  mods\${name}: installed, differs from the repo copy" }
}

function Show-Status {
  Say "Mods"
  Show-ModStatus $wingSrc "wingman"
  Show-ModStatus $tabsSrc "tabs-plus"
  Say "Layout"
  $a = Get-ActiveLayout
  Say "  active: $($a[0]) ($($a[1]))"
  $any = $false
  foreach ($f in (Get-ChildItem -LiteralPath (Join-Path $home_ "layouts") -Filter "*.json" -File)) {
    try { $s = Get-LayoutStatus $f.FullName } catch { continue }
    if ($s.Stack -eq "no" -or $s.Blocks -eq 0) { continue }
    $any = $true
    Say "  $($f.Name): $($s.Text)"
  }
  if (-not $any) { Say "  no layout has Wingman's blocks" }
  Say "Hook"
  if (Test-HookInstalled) { Say "  installed" } else { Say "  not installed" }
  Say "  HERDR_WINGMAN_DIR (user): $([Environment]::GetEnvironmentVariable('HERDR_WINGMAN_DIR','User'))"
}

# ---- run ----
if ($DryRun) { Say "Dry run: nothing will be written." }
Say "Herdr home: $home_"
switch ($Action) {
  "status" { Show-Status; exit 0 }
  "install" {
    Say "Mods"
    Copy-Mod $wingSrc "wingman"
    Copy-Mod $tabsSrc "tabs-plus"
    if ($NoLayout) { Say "Layout skipped (-NoLayout)" } else { Install-Layout }
    if ($NoHook) { Say "Hook skipped (-NoHook)" } else { Install-Hook }
  }
  "uninstall" {
    if ($NoHook) { Say "Hook skipped (-NoHook)" } else { Uninstall-Hook }
    if ($NoLayout) { Say "Layout skipped (-NoLayout)" } else { Uninstall-Layout }
    Say "Mods"
    foreach ($name in @("wingman", "tabs-plus")) {
      $d = Join-Path $home_ "mods\$name"
      if (-not (Test-Path -LiteralPath $d)) { Say "  mods\$name not installed" }
      elseif (Test-Link $d) { Say "  mods\$name is a link; left alone" }
      else {
        Act "remove mods\$name"
        if (-not $DryRun) { Remove-Item -LiteralPath $d -Recurse -Force; NoteChange "mods\$name removed" }
      }
    }
    $data = Join-Path $home_ "data\wingman"
    if (Test-Path -LiteralPath $data) {
      if ($Purge) {
        Act "delete data\wingman"
        if (-not $DryRun) { Remove-Item -LiteralPath $data -Recurse -Force; NoteChange "data\wingman deleted" }
      } else { Say "  data\wingman kept (use -Purge to delete it)" }
    }
  }
}

Say ""
if ($DryRun) { Say "Dry run done. Nothing was written."; exit 0 }
if ($script:changed.Count -gt 0) { Say "Changed:"; $script:changed | ForEach-Object { Say $_ } } else { Say "Nothing changed." }
if ($Action -eq "install" -and $script:changed.Count -gt 0) { NoteNext "Herdr reloads mods and layouts itself; no restart needed for those." }
if ($script:nexts.Count -gt 0) { Say "Next:"; $script:nexts | ForEach-Object { Say $_ } }
exit 0
