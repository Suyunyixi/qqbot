$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$plan = docker compose config --format json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw '无法读取 Docker Compose 配置。' }
$mount = @($plan.services.bot.volumes | Where-Object { $_.target -eq '/data' })[0]
if ($null -eq $mount -or $mount.type -ne 'bind') { throw '数据库目标必须是宿主机目录映射。' }
if ($plan.services.bot.environment.BOT_SQLITE_PATH -ne '/data/bot.sqlite' -or $plan.services.bot.environment.BOT_CHECKPOINT_PATH -ne '/data/checkpoints.sqlite') { throw '旧卷自动迁移要求先使用默认数据库文件名；迁移完成后再调整文件名。' }
$target = [System.IO.Path]::GetFullPath([string]$mount.source)
$container = (docker compose ps -aq bot | Select-Object -First 1)
if (-not $container) { throw '找不到旧机器人容器；请保留原 Docker 数据卷并手动检查。' }
$details = (docker inspect $container | ConvertFrom-Json)[0]
$old = @($details.Mounts | Where-Object { $_.Destination -eq '/data' })[0]
if ($null -eq $old -or $old.Type -ne 'volume') { throw '当前机器人没有可迁移的旧数据卷。' }
if (Test-Path -LiteralPath $target) {
  if (@(Get-ChildItem -LiteralPath $target -Force).Count -gt 0) { throw "目标目录非空，已停止迁移以防覆盖：$target" }
} else { New-Item -ItemType Directory -Path $target | Out-Null }
Write-Host '正在暂停旧机器人并复制数据库；原始 Docker 卷会保留。'
docker compose stop bot
if ($LASTEXITCODE -ne 0) { throw '无法停止旧机器人。' }
try {
  docker cp "${container}:/data/." $target
  if ($LASTEXITCODE -ne 0) { throw '复制数据失败。' }
  $sourceMount = "type=volume,source=$($old.Name),target=/data"
  $targetMount = "type=bind,source=$target,target=/data"
  $before = docker run --rm --network none --mount $sourceMount --entrypoint node bot-bot dist/cli/verify-data.js
  if ($LASTEXITCODE -ne 0) { throw '旧数据库检查失败。' }
  $after = docker run --rm --network none --mount $targetMount --entrypoint node bot-bot dist/cli/verify-data.js
  if ($LASTEXITCODE -ne 0) { throw '迁移后的数据库检查失败。' }
  if ($before -ne $after) { throw '迁移前后表结构或数据数量不一致。' }
  Write-Host "数据库完整性和表记录数量校验通过；已复制到 $target。原数据卷 $($old.Name) 保留。"
} catch {
  Write-Warning '迁移未完成，正在恢复旧机器人。目标目录不会自动删除，请检查后再重试。'
  docker start $container | Out-Null
  throw
}
