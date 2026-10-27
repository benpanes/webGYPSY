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

# ---- Single-file app: index.html with both scripts inlined -> dist/gypsy.html
function Get-InlineScript($file) {
  # "</script" inside a script would end the tag early
  $js = [IO.File]::ReadAllText((Join-Path $PSScriptRoot $file)).Replace("</script", "<\/script")
  "<script>`n$js`n</script>"
}
$html = [IO.File]::ReadAllText((Join-Path $PSScriptRoot "web/index.html"))
foreach ($f in "gypsy.js", "gypsy-api.js") {
  $tag = "<script src=""$f""></script>"
  if (-not $html.Contains($tag)) { throw "web/index.html has no $tag to inline" }
  $html = $html.Replace($tag, (Get-InlineScript "web/$f"))
}
New-Item -ItemType Directory -Force dist | Out-Null
[IO.File]::WriteAllText((Join-Path $PSScriptRoot "dist/gypsy.html"), $html, (New-Object Text.UTF8Encoding $false))
Write-Host "Built dist/gypsy.html ($([math]::Round((Get-Item dist/gypsy.html).Length / 1KB)) KB, single file)"
