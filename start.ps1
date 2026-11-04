$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
docker info --format '{{.ServerVersion}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop 尚未启动，请先启动 Docker Desktop。' }
if (-not (Test-Path -LiteralPath '.env')) {
  Copy-Item -LiteralPath '.env.example' -Destination '.env'
  Write-Host '已创建 .env，请填写 MODEL_API_KEY；保存后启动检查会自动重试。'
}
docker compose build
if ($LASTEXITCODE -ne 0) { throw '镜像构建失败，旧机器人未停止。' }
$container = (docker compose ps -aq bot | Select-Object -First 1)
if ($container) {
  $details = (docker inspect $container | ConvertFrom-Json)[0]
  $old = @($details.Mounts | Where-Object { $_.Destination -eq '/data' })[0]
  $plan = docker compose config --format json | ConvertFrom-Json
  $newMount = @($plan.services.bot.volumes | Where-Object { $_.target -eq '/data' })[0]
  if ($old.Type -eq 'volume' -and $newMount.type -eq 'bind') { & "$PSScriptRoot/migrate-data.ps1" }
}
docker compose up -d
if ($LASTEXITCODE -ne 0) { throw '启动失败，请检查上方 Docker 输出。' }
$finalPlan = docker compose config --format json | ConvertFrom-Json
$port = @($finalPlan.services.bot.ports)[0].published
Write-Host "请打开 http://127.0.0.1:$port 查看自检、QQ 绑定和人格配置。"
Write-Host '数据及工作区路径见 .env；日志：docker compose logs -f bot'
$deadline = (Get-Date).AddSeconds(60)
$status = $null
do {
  try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$port/status" -TimeoutSec 3 } catch { $status = $null }
  if ($null -ne $status -and $status.phase -in @('ready', 'waiting_qr', 'failed')) { break }
  Start-Sleep -Seconds 2
} while ((Get-Date) -lt $deadline)
if ($null -eq $status) { Write-Warning '管理页面尚未启动，请检查 docker compose logs bot。' }
elseif ($status.phase -eq 'ready') { Write-Host '启动自检和 QQ 连接均已通过。' }
elseif ($status.phase -eq 'waiting_qr') { Write-Host '请打开管理页扫码绑定，随后等待启动自检。' }
else { Write-Warning "当前状态：$($status.phase)。请在管理页查看自检详情；未通过的检查会自动重试。" }
