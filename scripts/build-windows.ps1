$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
if ((node -p "process.platform") -ne 'win32') { throw 'Build this package on Windows.' }
if ((node -p "process.versions.node.split('.')[0]") -ne '24') { throw 'Use Node.js 24 LTS (24.11.1 or newer).' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
npm test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
npm run build:bundle
if ($LASTEXITCODE -ne 0) { throw 'Bundle failed' }
New-Item -ItemType Directory -Force dist | Out-Null
'{"main":"build/bridge.cjs","output":"build/sea.blob","disableExperimentalSEAWarning":true,"useSnapshot":false,"useCodeCache":false}' | Set-Content -Encoding ascii build/sea-config.json
node --experimental-sea-config build/sea-config.json
if ($LASTEXITCODE -ne 0) { throw 'SEA preparation failed' }
$NodeExe = node -p 'process.execPath'
Copy-Item $NodeExe dist/SkiStreamBridge.exe -Force
npx --no-install postject dist/SkiStreamBridge.exe NODE_SEA_BLOB build/sea.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw 'SEA injection failed' }
Copy-Item config.example.json dist/config.json -Force
Copy-Item README.md dist/README.md -Force
Copy-Item start-windows.cmd dist/start-windows.cmd -Force
$NodeVersion = node -p 'process.version'
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$NodeVersion/LICENSE" -OutFile dist/Node-LICENSE
Copy-Item LICENSE dist/LICENSE -Force
Copy-Item node_modules/ws/LICENSE dist/ws-LICENSE -Force
& .\dist\SkiStreamBridge.exe --help
if ($LASTEXITCODE -ne 0) { throw 'EXE smoke test failed' }
Write-Host 'Start dist/SkiStreamBridge.exe and configure it at http://127.0.0.1:8789/. Test with VOLA before race use.'
