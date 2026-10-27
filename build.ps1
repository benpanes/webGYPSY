# Build the GYPSY WebAssembly module (web/gypsy.js)
#
# Needs Emscripten loaded in this PowerShell session, e.g.
#   . C:\Users\Ben\Documents\git_repos\emsdk\emsdk_env.ps1
# and the rGYPSY submodule checked out (git submodule update --init).
#
# -sSINGLE_FILE embeds the WebAssembly in gypsy.js, so web/index.html also
# works when opened straight from disk.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Get-Command em++ -ErrorAction SilentlyContinue)) {
  throw "em++ not found. Load Emscripten first: . <emsdk folder>\emsdk_env.ps1"
}
if (-not (Test-Path "rGYPSY/src/core/gypsy_sim.h")) {
  throw "rGYPSY/src/core not found. Run: git submodule update --init"
}

em++ src/gypsy_wasm.cpp `
  -std=c++17 -O2 -fexceptions `
  -I rGYPSY/src/core `
  -lembind `
  -sMODULARIZE=1 -sEXPORT_NAME=createGypsy `
  -sSINGLE_FILE=1 `
  -sALLOW_MEMORY_GROWTH=1 `
  "-sENVIRONMENT=web,node" `
  -o web/gypsy.js
if ($LASTEXITCODE -ne 0) { throw "em++ failed" }

Write-Host "Built web/gypsy.js ($([math]::Round((Get-Item web/gypsy.js).Length / 1KB)) KB)"

# ---- Single-file app: index.html with its local scripts and stylesheets
# inlined -> dist/gypsy.html
function Read-WebFile($name) {
  $path = Join-Path $PSScriptRoot "web/$name"
  if (-not (Test-Path $path)) { throw "web/index.html refers to web/$name, which doesn't exist" }
  [IO.File]::ReadAllText($path)
}
$html = Read-WebFile "index.html"
# Local files only (web/ and its subfolders, e.g. vendor/). "</script" or
# "</style" inside the inlined text would end the tag early, and "<!--" can
# change how the HTML parser finds the end of a script; in JavaScript strings
# "<\/" and "<\!" mean the same as "</" and "<!".
$html = [regex]::Replace($html, '<script src="(?!https?:|//)([^":]+\.js)"></script>', {
  param($m) "<script>`n" + (Read-WebFile $m.Groups[1].Value).Replace("</script", "<\/script").Replace("<!--", "<\!--") + "`n</script>"
})
$html = [regex]::Replace($html, '<link rel="stylesheet" href="(?!https?:|//)([^":]+\.css)">', {
  param($m) "<style>`n" + (Read-WebFile $m.Groups[1].Value).Replace("</style", "<\/style") + "`n</style>"
})
if ($html -match '<script src=|<link rel="stylesheet"') { throw "dist/gypsy.html still refers to an external file" }

# Build information shown in the app's footer: version from the git tag
# ("v1.0.0", or "v1.0.0-2-gabc1234" / "-dirty" between releases), the rGYPSY
# commit the model was built from, and the build date
$version = (git describe --tags --always --dirty 2>$null)
if (-not $version) { $version = "unknown" }
$model = (git -C rGYPSY rev-parse --short HEAD 2>$null)
$date = Get-Date -Format "yyyy-MM-dd"
$dot = [char]0x00B7   # middle dot (non-ASCII text in this script would be misread by Windows PowerShell)
$info = "Version $version $dot model rGYPSY $model $dot built $date"
if (-not $html.Contains(">Development build<")) { throw "web/index.html has no build information placeholder" }
$html = $html.Replace(">Development build<", ">$([Net.WebUtility]::HtmlEncode($info))<")

New-Item -ItemType Directory -Force dist | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "dist/gypsy.html"), $html, (New-Object Text.UTF8Encoding $false))
Write-Host "Built dist/gypsy.html ($([math]::Round((Get-Item dist/gypsy.html).Length / 1KB)) KB, single file): $info"
