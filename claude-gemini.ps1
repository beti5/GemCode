param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$ErrorActionPreference = 'Stop'

if (-not $env:GEMINI_PROXY_PORT) {
  $env:GEMINI_PROXY_PORT = '11435'
}

if (-not $env:CLAUDE_GEMINI_MODEL) {
  if ($env:GEMINI_PROXY_DEFAULT_MODEL) {
    $env:CLAUDE_GEMINI_MODEL = $env:GEMINI_PROXY_DEFAULT_MODEL
  } else {
    $env:CLAUDE_GEMINI_MODEL = 'gemini-2.5-flash'
  }
}

if (-not $env:CLAUDE_GEMINI_DEBUG_FILE) {
  $env:CLAUDE_GEMINI_DEBUG_FILE = Join-Path $PSScriptRoot 'claude-debug.log'
}

if (-not $env:CLAUDE_GEMINI_SESSION_NAME) {
  $env:CLAUDE_GEMINI_SESSION_NAME = 'GemCode'
}

if (-not $env:CLAUDE_GEMINI_APPEND_SYSTEM_PROMPT) {
  $env:CLAUDE_GEMINI_APPEND_SYSTEM_PROMPT = 'If the WebSearch tool is available in this session, treat it as real web access. For current or recent information, use WebSearch instead of saying you cannot browse the web.'
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js is not installed on PATH.'
  exit 1
}

if (-not (Get-Command claude.cmd -ErrorAction SilentlyContinue)) {
  Write-Host 'Claude Code is not installed on PATH.'
  Write-Host 'Install it with: npm.cmd install -g @anthropic-ai/claude-code'
  exit 1
}

if (-not $env:GEMINI_API_KEY -and -not $env:GOOGLE_API_KEY) {
  Write-Host 'Gemini API key not found.'
  Write-Host ''
  Write-Host 'Set one of these first in PowerShell:'
  Write-Host '  setx GEMINI_API_KEY "your_key_here"'
  Write-Host 'or'
  Write-Host '  setx GOOGLE_API_KEY "your_key_here"'
  Write-Host ''
  Write-Host 'Then open a new terminal and run this launcher again.'
  exit 1
}

$port = [int]$env:GEMINI_PROXY_PORT
Write-Host "Restarting local Gemini proxy on port $port..."

try {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($listener) {
    Stop-Process -Id $listener.OwningProcess -Force
    Start-Sleep -Milliseconds 300
  }
} catch {
}

$env:GEMINI_PROXY_DEFAULT_MODEL = $env:CLAUDE_GEMINI_MODEL

$proxyStart = @{
  FilePath = 'node'
  ArgumentList = 'gemini-anthropic-proxy.mjs'
  WorkingDirectory = $PSScriptRoot
  PassThru = $true
}

if ($env:CLAUDE_GEMINI_SHOW_PROXY -eq '1') {
  $proxyStart.WindowStyle = 'Minimized'
} else {
  $proxyStart.WindowStyle = 'Hidden'
}

$proxyProcess = Start-Process @proxyStart

$ready = $false
for ($i = 0; $i -lt 15; $i++) {
  try {
    Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/health" | Out-Null
    $ready = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $ready) {
  Write-Host 'Failed to start the Gemini proxy.'
  Write-Host 'Check gemini-proxy.log in this folder.'
  exit 1
}

$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$port"
$env:ANTHROPIC_API_KEY = 'sk-gemini-proxy'

Write-Host "Launching GemCode with Gemini model $($env:CLAUDE_GEMINI_MODEL) through the local proxy..."

$claudeLaunchArgs = @(
  '--no-chrome',
  '--model', $env:CLAUDE_GEMINI_MODEL,
  '--name', $env:CLAUDE_GEMINI_SESSION_NAME,
  '--append-system-prompt', $env:CLAUDE_GEMINI_APPEND_SYSTEM_PROMPT
)

if ($env:CLAUDE_GEMINI_DEBUG -eq '1') {
  $claudeLaunchArgs += @('--debug-file', $env:CLAUDE_GEMINI_DEBUG_FILE)
}

$claudeLaunchArgs += $ClaudeArgs

& claude.cmd @claudeLaunchArgs

exit $LASTEXITCODE
