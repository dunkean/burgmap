param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$siblingRoot = [IO.Path]::GetDirectoryName($repoRoot)
$artifactRoot = 'E:\CodexArtifacts'
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')

# Explicit inventory: no wildcard deletion of source or unrelated projects.
$siblings = @(
  'cg_base', 'city_generator_compact_publish',
  'city_generator_contours_20261006', 'city_generator_maisons_20261006',
  'city_generator_rendu_20261006', 'city_generator-optimization-baseline',
  'city_generator-optimization-render', 'city_generator-optimization-roofs'
)
$localArtifacts = @(
  'web/out', 'web/scratch',
  'rust/target', 'rust/benches/__pycache__', '.claude/worktrees',
  'node_modules/.vite', 'web/node_modules/.vite',
  'web/node_modules/.vite-temp', 'web/node_modules/.vite-terrain-audit'
)
$externalArtifacts = @(
  'city-generator-2026-10-04', 'city-generator-2026-10-05',
  'city-generator-2026-10-06', 'city-generator-biome-brushes',
  'city-generator-optimization-certification', 'city-generator-polygon-traversal',
  'city-generator-rust-2026-10-06/out'
)
$temporaryArtifacts = @(
  'burgmap-geometry-qa-20261006', 'burgmap-rust-setup', 'burgmap-rustup-init.exe'
)

function Get-SourceFingerprint {
  $paths = @(& git -C $repoRoot ls-files --cached --others --exclude-standard | Sort-Object -Unique)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect repository sources.' }
  $entries = @($paths | ForEach-Object {
    $path = Join-Path $repoRoot $_
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      $_ + ':' + (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    } else { $_ + ':MISSING' }
  })
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($entries -join "`n"))))
  } finally { $sha.Dispose() }
}

function Remove-Artifact([string]$Path) {
  $absolutePath = [IO.Path]::GetFullPath($Path)
  if ($absolutePath -notin $script:approvedPaths -or $absolutePath -eq $repoRoot) {
    throw "Unapproved deletion target: $absolutePath"
  }
  $item = Get-Item -LiteralPath $absolutePath -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    # Unlink junctions without traversing their targets.
    Remove-Item -LiteralPath $absolutePath -Force
  } elseif ($item.PSIsContainer) {
    $links = @(Get-ChildItem -LiteralPath $absolutePath -Force -Recurse -Attributes ReparsePoint |
      Sort-Object { $_.FullName.Length } -Descending)
    foreach ($link in $links) {
      $linkPath = [IO.Path]::GetFullPath($link.FullName)
      if (-not $linkPath.StartsWith($absolutePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Link escaped deletion target: $linkPath"
      }
      Remove-Item -LiteralPath $linkPath -Force
    }
    Remove-Item -LiteralPath $absolutePath -Recurse -Force
  } else { Remove-Item -LiteralPath $absolutePath -Force }
  if ($null -ne (Get-Item -LiteralPath $absolutePath -Force -ErrorAction SilentlyContinue)) {
    throw "Deletion incomplete: $absolutePath"
  }
  Write-Host "Removed: $absolutePath"
}

$script:approvedPaths = @(
  $siblings | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $siblingRoot $_)) }
  $localArtifacts | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $repoRoot $_)) }
  $externalArtifacts | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $artifactRoot $_)) }
  $temporaryArtifacts | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $tempRoot $_)) }
)

# Keep the current standalone bench, WASM package and active Cargo cache.
# Only children of the ignored diagnostic directory are disposable here.
$diagnosticRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'rust/out'))
$diagnosticEntry = Get-Item -LiteralPath $diagnosticRoot -Force -ErrorAction SilentlyContinue
if ($null -ne $diagnosticEntry -and -not ($diagnosticEntry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
  $script:approvedPaths += @(Get-ChildItem -LiteralPath $diagnosticRoot -Force |
    Where-Object { $_.Name -ne 'browser' } |
    ForEach-Object {
      $childPath = [IO.Path]::GetFullPath($_.FullName)
      if ([IO.Path]::GetDirectoryName($childPath) -ne $diagnosticRoot) {
        throw "Diagnostic escaped output directory: $childPath"
      }
      $childPath
    })
}

foreach ($root in @($repoRoot, $siblingRoot, $artifactRoot, $tempRoot)) {
  $entry = Get-Item -LiteralPath $root -Force -ErrorAction SilentlyContinue
  if ($null -ne $entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Unexpected linked parent directory: $root"
  }
}
$registeredPaths = @(& git -C $repoRoot worktree list --porcelain |
  Where-Object { $_.StartsWith('worktree ') } |
  ForEach-Object { [IO.Path]::GetFullPath($_.Substring(9)) })
if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect registered worktrees.' }
if ($registeredPaths.Count -ne 1 -or $registeredPaths[0] -ne $repoRoot) {
  throw 'Worktree inventory changed. Inspect additional registered worktrees before cleanup.'
}
foreach ($name in $siblings) {
  if (Test-Path -LiteralPath (Join-Path (Join-Path $siblingRoot $name) '.git')) {
    throw "Residual directory became a checkout: $name"
  }
}

$existing = @($script:approvedPaths | Where-Object {
  $null -ne (Get-Item -LiteralPath $_ -Force -ErrorAction SilentlyContinue)
})
$bytes = [long]0
foreach ($path in $existing) {
  $item = Get-Item -LiteralPath $path -Force
  if (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    if ($item.PSIsContainer) {
      $bytes += [long]((Get-ChildItem -LiteralPath $path -Force -Recurse -File |
        Measure-Object Length -Sum).Sum)
    } else { $bytes += $item.Length }
  }
  Write-Host "Target: $path"
}
Write-Host ('{0} targets; approximately {1:N2} GiB. Includes old worktree archives.' -f $existing.Count, ($bytes / 1GB))
if (-not $Apply) {
  Write-Host 'Preview only. Run again with -Apply to delete these artifacts.'
  return
}

$before = Get-SourceFingerprint
$dependencies = @('node_modules', 'web/node_modules') | Where-Object {
  Test-Path -LiteralPath (Join-Path $repoRoot $_) -PathType Container
}
foreach ($path in $existing) { Remove-Artifact $path }
& git -C $repoRoot worktree prune --verbose
if ($LASTEXITCODE -ne 0) { throw 'Git worktree pruning failed.' }
if ((Get-SourceFingerprint) -ne $before) { throw 'Source files changed during cleanup.' }
foreach ($dependency in $dependencies) {
  if (-not (Test-Path -LiteralPath (Join-Path $repoRoot $dependency) -PathType Container)) {
    throw "Dependency directory missing: $dependency"
  }
}
Write-Host 'Cleanup complete. Repository sources and installed dependencies preserved.'
