param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$ClaudeArgs
)

$models = @(
  @{ Key = '1'; Id = 'gemini-2.5-flash-lite'; Name = 'Gemini 2.5 Flash-Lite'; Note = 'Lightest and cheapest' }
  @{ Key = '2'; Id = 'gemini-2.5-flash'; Name = 'Gemini 2.5 Flash'; Note = 'Fast and balanced' }
  @{ Key = '3'; Id = 'gemini-2.5-pro'; Name = 'Gemini 2.5 Pro'; Note = 'Most capable' }
  @{ Key = '4'; Id = 'gemini-3-flash-preview'; Name = 'Gemini 3 Flash Preview'; Note = 'Newer preview model' }
  @{ Key = '5'; Id = 'gemini-3-pro-preview'; Name = 'Gemini 3 Pro Preview'; Note = 'Newest high-end preview model' }
  @{ Key = '6'; Id = '__custom__'; Name = 'Custom model ID'; Note = 'Type any Gemini model manually' }
)

Write-Host ''
Write-Host 'GemCode Model Picker'
Write-Host '--------------------'

foreach ($model in $models) {
  Write-Host "$($model.Key). $($model.Name) [$($model.Id)] - $($model.Note)"
}

Write-Host ''
$choice = Read-Host 'Pick a model number (default: 2)'

if ([string]::IsNullOrWhiteSpace($choice)) {
  $choice = '2'
}

$selected = $models | Where-Object { $_.Key -eq $choice } | Select-Object -First 1

if (-not $selected) {
  Write-Host "Invalid choice: $choice"
  exit 1
}

if ($selected.Id -eq '__custom__') {
  $customModel = Read-Host 'Enter the Gemini model ID'
  if ([string]::IsNullOrWhiteSpace($customModel)) {
    Write-Host 'No model ID entered.'
    exit 1
  }

  $env:CLAUDE_GEMINI_MODEL = $customModel.Trim()

  if (-not $env:CLAUDE_GEMINI_SESSION_NAME) {
    $env:CLAUDE_GEMINI_SESSION_NAME = "GemCode · Custom"
  }
} else {
  $env:CLAUDE_GEMINI_MODEL = $selected.Id

  if (-not $env:CLAUDE_GEMINI_SESSION_NAME) {
    $env:CLAUDE_GEMINI_SESSION_NAME = "GemCode · $($selected.Name)"
  }
}

& "$PSScriptRoot\claude-gemini.ps1" @ClaudeArgs
exit $LASTEXITCODE
