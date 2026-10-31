# 把证书直接写入当前用户的存储(绕过 CryptUIWizImport 的交互确认框)
#
# 为什么需要:PowerShell 的 X509Store.Add / Import-Certificate 在写入「受信任根」时
# 会走 CryptUIWizImport,弹一个"是否安装此证书"的确认框并等待用户点击。
# 无人值守环境(脚本、CI、远程会话)里没人点,就会失败并报「操作已被用户取消」。
#
# 这里直接调用 CertAddEncodedCertificateToStore —— 它不做 UI 交互,
# 因此在自动化流程里可用。写入的是 CurrentUser 存储,不需要管理员权限。

param(
    [Parameter(Mandatory = $true)][string]$Thumbprint,
    [string[]]$Stores = @('Root', 'TrustedPublisher'),
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Runtime.InteropServices;

public static class CertStoreApi
{
    private const int CERT_STORE_PROV_SYSTEM_W = 10;
    private const int CERT_SYSTEM_STORE_CURRENT_USER = 0x00010000;
    private const int CERT_STORE_OPEN_EXISTING_FLAG = 0x00004000;
    private const int CERT_STORE_READONLY_FLAG = 0x00008000;

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CertOpenStore(
        IntPtr lpszStoreProvider, uint dwEncodingType, IntPtr hCryptProv,
        uint dwFlags, string pvPara);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CertAddEncodedCertificateToStore(
        IntPtr hCertStore, uint dwCertEncodingType, byte[] pbCertEncoded,
        uint cbCertEncoded, uint dwAddDisposition, IntPtr ppCertContext);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CertCloseStore(IntPtr hCertStore, uint dwFlags);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern IntPtr CertFindCertificateInStore(
        IntPtr hCertStore, uint dwCertEncodingType, uint dwFindFlags,
        uint dwFindType, byte[] pvFindPara, IntPtr pPrevCertContext);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CertDeleteCertificateFromStore(IntPtr pCertContext);

    [DllImport("crypt32.dll", SetLastError = true)]
    private static extern bool CertFreeCertificateContext(IntPtr pCertContext);

    private const uint X509_ASN_ENCODING = 0x00000001;
    private const uint PKCS_7_ASN_ENCODING = 0x00010000;
    private const uint CERT_FIND_SHA1_HASH = 0x00010000;
    private const uint CERT_STORE_ADD_REPLACE_EXISTING = 3;

    private static IntPtr OpenStore(string name)
    {
        // pvPara 就是存储名,例如 "Root"、"TrustedPublisher"
        var handle = CertOpenStore(
            (IntPtr)CERT_STORE_PROV_SYSTEM_W, 0, IntPtr.Zero,
            CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_OPEN_EXISTING_FLAG,
            name);
        if (handle == IntPtr.Zero)
            throw new Exception("打开存储 " + name + " 失败,错误码 " + Marshal.GetLastWin32Error());
        return handle;
    }

    public static string Add(string storeName, byte[] der)
    {
        var store = OpenStore(storeName);
        try
        {
            if (!CertAddEncodedCertificateToStore(
                    store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, der,
                    (uint)der.Length, CERT_STORE_ADD_REPLACE_EXISTING, IntPtr.Zero))
            {
                var err = Marshal.GetLastWin32Error();
                // 已存在时不算错误
                return "已有(错误码 " + err + ")";
            }
            return "已写入";
        }
        finally
        {
            CertCloseStore(store, 0);
        }
    }

    public static string Remove(string storeName, byte[] sha1)
    {
        var store = OpenStore(storeName);
        try
        {
            var ctx = CertFindCertificateInStore(
                store, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0,
                CERT_FIND_SHA1_HASH, sha1, IntPtr.Zero);
            if (ctx == IntPtr.Zero) return "未找到";
            var ok = CertDeleteCertificateFromStore(ctx);
            return ok ? "已删除" : "删除失败";
        }
        finally
        {
            CertCloseStore(store, 0);
        }
    }
}
'@

if (-not ('CertStoreApi' -as [type])) {
    Add-Type -TypeDefinition $src -Language CSharp
}

$cert = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Thumbprint -eq $Thumbprint }
if (-not $cert) { throw "在 CurrentUser\My 里找不到指纹为 $Thumbprint 的证书" }

foreach ($store in $Stores) {
    if ($Remove) {
        $r = [CertStoreApi]::Remove($store, $cert.GetCertHash())
        Write-Host "  [$store] $r"
    }
    else {
        $r = [CertStoreApi]::Add($store, $cert.RawData)
        Write-Host "  [$store] $r"
    }
}
