# 开关 Windows 的「检查应用和文件」(SmartScreen 应用信誉检查)
#
# 背景:
#   Windows 安全中心 → 应用和浏览器控制 → 基于信誉的保护设置 → 「检查应用和文件」
#   这个开关在注册表里就是:
#     HKCU\Software\Microsoft\Windows\CurrentVersion\AppHost\EnableWebContentEvaluation
#     1 = 开启(默认),0 = 关闭
#
# 关掉之后,双击本程序不会再弹「Windows 已保护你的电脑」。代价是这层防护全局失效,
# Defender 的病毒扫描仍然正常工作。随时可以用 -Enable 改回来。
#
# 只影响当前用户,不需要管理员权限。
#
# 用法:
#   powershell -NoProfile -ExecutionPolicy Bypass -File toggle-smartscreen.ps1 -Disable
#   powershell -NoProfile -ExecutionPolicy Bypass -File toggle-smartscreen.ps1 -Enable
#   powershell -NoProfile -ExecutionPolicy Bypass -File toggle-smartscreen.ps1 -Status

param(
    [switch]$Disable,
    [switch]$Enable,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\AppHost'
$name = 'EnableWebContentEvaluation'

if ($Status -or (-not $Disable -and -not $Enable)) {
    $current = (Get-ItemProperty -Path $key -Name $name -ErrorAction SilentlyContinue).$name
    if ($null -eq $current) {
        Write-Host '  当前状态: 未设置(等同开启,会检查应用和文件)'
    }
    elseif ($current -eq 0) {
        Write-Host '  当前状态: 已关闭(不会检查应用和文件)'
    }
    else {
        Write-Host '  当前状态: 已开启'
    }
    return
}

if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
}

if ($Disable) {
    Set-ItemProperty -Path $key -Name $name -Value 0 -Type DWord
    Write-Host '  已关闭「检查应用和文件」。双击 exe 不会再弹 SmartScreen。'
    Write-Host '  恢复: 用 -Enable 参数,或在 Windows 安全中心里重新打开该开关。'
}
else {
    Set-ItemProperty -Path $key -Name $name -Value 1 -Type DWord
    Write-Host '  已开启「检查应用和文件」。'
}

# 设置改动可能需要重开资源管理器才完全生效
Write-Host '  (如果暂时没生效,注销重新登录一次即可)'
