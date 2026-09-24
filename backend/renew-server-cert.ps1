# Renew ONLY the server certificate (leaf), keeping the existing root CA.
#
# Why: the leaf pins the LAN IP in its SAN at generation time (it said
# 192.168.0.81). When the router hands out a new IP (192.168.0.131) the leaf no
# longer matches the address the phone uses. Chrome-family browsers still offer
# "proceed anyway"; Huawei's built-in browser refuses outright, so the page
# never loads.
#
# Keeping the same root CA means the phone does NOT need to re-install anything.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File backend\renew-server-cert.ps1
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads .ps1
# as ANSI (GBK on a Chinese system) unless it carries a UTF-8 BOM, and non-ASCII
# text then breaks parsing.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $root 'certs'

$rootCert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq 'CN=GuitarFollowLab Root' -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
if (-not $rootCert) { throw 'Root CA with private key not found. Run make-cert.ps1 first.' }

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$dns = @('localhost', $env:COMPUTERNAME)

# Real IP-type SANs. Putting an IP into DNS= does not satisfy browsers that
# require IPAddress= for IP addresses (Huawei's browser refuses outright).
$sanParts = @()
$sanParts += ($dns | ForEach-Object { "DNS=$_" })
$sanParts += ($ips | ForEach-Object { "IPAddress=$_" })
$san = $sanParts -join '&'

Write-Host ''
Write-Host '  Server certificate will be valid for:'
$dns | ForEach-Object { Write-Host ('    DNS  ' + $_) }
$ips | ForEach-Object { Write-Host ('    IP   ' + $_) }
Write-Host ''

$leaf = New-SelfSignedCertificate `
    -Subject 'CN=GuitarFollowLab' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -Signer $rootCert `
    -TextExtension @("2.5.29.17={text}$san") `
    -NotAfter (Get-Date).AddYears(5) `
    -FriendlyName 'GuitarFollowLab Server'

$pw = ConvertTo-SecureString -String 'guitarlab' -Force -AsPlainText
Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $certDir 'local.pfx') -Password $pw | Out-Null

Write-Host '  Renewed:'
Write-Host ('    ' + (Join-Path $certDir 'local.pfx'))
Write-Host ''
Write-Host '  The phone does NOT need to re-install the root certificate.'
Write-Host '  Restart the server, then open  https://<pc-ip>:1210/  on the phone.'
Write-Host ''
