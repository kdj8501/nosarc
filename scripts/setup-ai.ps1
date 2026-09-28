$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$venvPython = Join-Path $repoRoot 'ai-worker/.venv/Scripts/python.exe'
$requirements = Join-Path $repoRoot 'ai-worker/requirements-cpu.txt'
$modelPath = Join-Path $repoRoot 'data/models/comictextdetector.pt.onnx'
$modelDirectory = Split-Path -Parent $modelPath
$downloadPath = "$modelPath.download"
$huggingFaceCache = Join-Path $repoRoot 'data/models/huggingface/hub'
$modelUrl = 'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt.onnx'

if (-not (Test-Path -LiteralPath $venvPython)) {
    $pythonCommand = Get-Command python -ErrorAction Stop
    & $pythonCommand.Source -m venv (Join-Path $repoRoot 'ai-worker/.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Could not create ai-worker/.venv.' }
}

& $venvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw 'Could not upgrade pip in ai-worker/.venv.' }
& $venvPython -m pip install -r $requirements
if ($LASTEXITCODE -ne 0) { throw 'Could not install the CPU AI dependencies.' }

New-Item -ItemType Directory -Force -Path $modelDirectory | Out-Null
if ((Test-Path -LiteralPath $modelPath) -and (Get-Item -LiteralPath $modelPath).Length -gt 10MB) {
    Write-Host 'Comic Text Detector model is already installed.'
} else {
    try {
        Invoke-WebRequest -Uri $modelUrl -OutFile $downloadPath
        if ((Get-Item -LiteralPath $downloadPath).Length -le 10MB) {
            throw 'Downloaded detector model is unexpectedly small.'
        }
        Move-Item -LiteralPath $downloadPath -Destination $modelPath -Force
        Write-Host "Installed Comic Text Detector model at $modelPath"
    }
    finally {
        if (Test-Path -LiteralPath $downloadPath) {
            Remove-Item -LiteralPath $downloadPath -Force
        }
    }
}

& (Join-Path $repoRoot 'ai-worker/.venv/Scripts/hf.exe') download kha-white/manga-ocr-base --cache-dir $huggingFaceCache
if ($LASTEXITCODE -ne 0) { throw 'Could not download the Manga OCR model.' }
