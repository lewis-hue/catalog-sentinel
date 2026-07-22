[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-zA-Z][-a-zA-Z0-9]{0,127}$')]
  [string]$StackName,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[a-z]{2}(-gov)?-[a-z]+-[0-9]$')]
  [string]$Region,

  [string]$Profile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
  throw 'AWS CLI v2 is required.'
}

$awsContext = @('--region', $Region, '--no-cli-pager')
if ($Profile.Trim()) {
  $awsContext += @('--profile', $Profile.Trim())
}

function Get-StackOutput([string]$OutputKey) {
  $value = & aws cloudformation describe-stacks @awsContext `
    --stack-name $StackName `
    --query "Stacks[0].Outputs[?OutputKey=='$OutputKey'].OutputValue | [0]" `
    --output text
  if ($LASTEXITCODE -ne 0 -or -not $value -or $value -eq 'None') {
    throw "Missing required stack output '$OutputKey' from '$StackName'."
  }
  return $value.Trim()
}

$clusterArn = Get-StackOutput 'ClusterArn'
$taskDefinition = Get-StackOutput 'MigrationTaskDefinitionArn'
$subnetIds = Get-StackOutput 'AppSubnetIds'
$securityGroupId = Get-StackOutput 'TaskSecurityGroupId'

$networkConfiguration = "awsvpcConfiguration={subnets=[$subnetIds],securityGroups=[$securityGroupId],assignPublicIp=DISABLED}"
$runResult = & aws ecs run-task @awsContext `
  --cluster $clusterArn `
  --task-definition $taskDefinition `
  --launch-type FARGATE `
  --count 1 `
  --network-configuration $networkConfiguration `
  --output json | ConvertFrom-Json

if ($LASTEXITCODE -ne 0) {
  throw 'ECS rejected the migration task request.'
}
if ($runResult.failures.Count -gt 0 -or $runResult.tasks.Count -ne 1) {
  $failureReason = ($runResult.failures | ForEach-Object { $_.reason }) -join '; '
  throw "Migration task did not start. $failureReason"
}

$taskArn = [string]$runResult.tasks[0].taskArn
Write-Output "Migration task started: $taskArn"

& aws ecs wait tasks-stopped @awsContext --cluster $clusterArn --tasks $taskArn
if ($LASTEXITCODE -ne 0) {
  throw "Timed out waiting for migration task: $taskArn"
}

$task = & aws ecs describe-tasks @awsContext `
  --cluster $clusterArn `
  --tasks $taskArn `
  --query 'tasks[0]' `
  --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $task) {
  throw "Unable to inspect completed migration task: $taskArn"
}

$container = $task.containers | Select-Object -First 1
if ($null -eq $container.exitCode -or [int]$container.exitCode -ne 0) {
  throw "Migration failed (exit=$($container.exitCode), reason=$($container.reason), task=$taskArn)."
}

Write-Output "Migration completed successfully: $taskArn"
