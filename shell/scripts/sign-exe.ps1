# 给 dist 里的 exe 做本机自签名,消除 SmartScreen 的「发布者: 未知」拦截。
#
# 为什么需要:
#   程序是本地构建的,没有任何代码签名证书。Windows Defender SmartScreen 对
#   「未签名 + 无信誉」的可执行文件一律弹「Windows 已保护你的电脑 / 发布者: 未知」,
#   这不是病毒告警,点「仍要运行」也能用,但每次构建都要点一次很烦。
#
# 做法:
#   1. 生成一张自签名的代码签名证书(CurrentUser\My),不需要管理员。
#   2. 把它的公钥导入当前用户的「受信任根」和「受信任发布者」两个存储,
#      这样 Windows 在**本机**就能验证签名链,发布的名称不再是"未知"。
#   3. 用 Set-AuthenticodeSignature 给 exe 签 SHA256 签名(附时间戳,可选)。
#
# 局限(必须知道):
#   - 只对**信任了这张证书的机器**有效。换台机器运行,又会显示未知发布者。
#   - 想在所有机器上都免打扰,只能买公开 CA 的代码签名证书(EV 证书才立刻有信誉)。
#
# 用法: pwsh -File sign-exe.ps1 -DistDir <目录> [-RemoveCert]

param(
    [Parameter(Mandatory = $true)][string]$DistDir,
    [switch]$RemoveCert,
    [string]$Subject = 'CN=VirtualDesk Local Build, O=VirtualDesk, C=CN'
)

$ErrorActionPreference = 'Stop'
$certStorePath = 'Cert:\CurrentUser\My'

function Get-OrCreateSigningCert {
    # 复用已有证书,避免每次打包都生成一张新的(否则信任列表会越堆越多)
    $existing = Get-ChildItem $certStorePath |
        Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
        Sort-Object NotAfter -Descending |
        Select-Object -First 1

    if ($existing -and $existing.NotAfter -gt (Get-Date).AddDays(30)) {
        Write-Host "  [签名] 复用已有证书 $($existing.Thumbprint)"
        return $existing
    }

    Write-Host "  [签名] 生成自签名代码签名证书…"
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject $Subject `
        -CertStoreLocation $certStorePath `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable `
        -NotAfter (Get-Date).AddYears(5) `
        -HashAlgorithm SHA256
    Write-Host "  [签名] 已生成 $($cert.Thumbprint)"
    return $cert
}

function Trust-Cert([System.Security.Cryptography.X509Certificates.X509Certificate2]$cert) {
    # 只需当前用户存储,不需要管理员权限
    foreach ($storeName in 'Root', 'TrustedPublisher') {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
        $store.Open('ReadWrite')
        try {
            $already = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
            if ($already) {
                Write-Host "  [签名] 已在 $storeName 存储中"
            }
            else {
                $store.Add($cert)
                Write-Host "  [签名] 已加入 $storeName 存储"
            }
        }
        finally {
            $store.Close()
        }
    }
}

function Remove-TrustedCert {
    $certs = Get-ChildItem $certStorePath | Where-Object { $_.Subject -eq $Subject }
    foreach ($cert in $certs) {
        foreach ($storeName in 'Root', 'TrustedPublisher') {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
            $store.Open('ReadWrite')
            try {
                $found = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
                if ($found) { $store.Remove($found) }
            }
            finally { $store.Close() }
        }
        Remove-Item -Path "$certStorePath\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
        Write-Host "  [签名] 已移除证书 $($cert.Thumbprint)"
    }
}

if ($RemoveCert) {
    Remove-TrustedCert
    return
}

if (-not (Test-Path $DistDir)) {
    throw "目录不存在: $DistDir"
}

$cert = Get-OrCreateSigningCert
Trust-Cert $cert

$targets = Get-ChildItem $DistDir -Filter '*.exe' -File
if ($targets.Count -eq 0) {
    throw "$DistDir 里没有 exe"
}

foreach ($file in $targets) {
    # 时间戳服务器失败不影响签名本身(离线也能签),所以不设成致命错误
    try {
        $result = Set-AuthenticodeSignature `
            -FilePath $file.FullName `
            -Certificate $cert `
            -HashAlgorithm SHA256 `
            -TimestampServer 'http://timestamp.digicert.com' `
            -ErrorAction Stop
    }
    catch {
        $result = Set-AuthenticodeSignature `
            -FilePath $file.FullName `
            -Certificate $cert `
            -HashAlgorithm SHA256
    }

    $status = $result.Status
    Write-Host "  [签名] $($file.Name):$status"
    if ($status -ne 'Valid') {
        Write-Host "         $($result.StatusMessage)" -ForegroundColor Yellow
    }
}
