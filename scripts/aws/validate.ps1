[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$templates = @(
  (Join-Path $repositoryRoot 'infra\aws\bootstrap.yaml'),
  (Join-Path $repositoryRoot 'infra\aws\dr-region.yaml'),
  (Join-Path $repositoryRoot 'infra\aws\production.yaml')
)

foreach ($template in $templates) {
  if (-not (Test-Path -LiteralPath $template -PathType Leaf)) {
    throw "Missing CloudFormation template: $template"
  }
}

if (-not (Get-Command cfn-lint -ErrorAction SilentlyContinue)) {
  throw 'cfn-lint is required. Install the pinned 1.41.0 release before validating.'
}

Push-Location $repositoryRoot
try {
  & cfn-lint @templates
  if ($LASTEXITCODE -ne 0) {
    throw "cfn-lint failed with exit code $LASTEXITCODE"
  }

  & node --check scripts/production-soak.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "production soak script syntax validation failed with exit code $LASTEXITCODE"
  }

  & node --check scripts/authorized-distrokid-acceptance.mjs
  if ($LASTEXITCODE -ne 0) {
    throw "DistroKid acceptance script syntax validation failed with exit code $LASTEXITCODE"
  }
} finally {
  Pop-Location
}

Write-Output 'AWS templates and production acceptance scripts validated locally.'
