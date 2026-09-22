# Generate a self-signed certificate so a phone can open this page over https.
# Browsers only hand out microphone access on https or localhost, so LAN access
# has to go through https.
#
# Outputs:
#   certs\local.pfx   server certificate, read by server.js
#   certs\local.cer   root certificate, the one the phone has to trust
#
# NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
# .ps1 files as ANSI (GBK on a Chinese system) unless they carry a UTF-8 BOM,
# and non-ASCII text then breaks string quoting.

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$certDir = Join-Path $root 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$ips = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    Select-Object -ExpandProperty IPAddress)
$names = @('localhost', '127.0.0.1', $env:COMPUTERNAME) + $ips

Write-Host ''
Write-Host '  Certificate will cover these addresses:'
$names | ForEach-Object { Write-Host ('    ' + $_) }
Write-Host ''

# Root CA. Android only accepts an installed certificate as a trusted root
# when it carries the CA basic-constraint flag, so set it explicitly.
$rootCert = New-SelfSignedCertificate `
    -Subject 'CN=GuitarFollowLab Root' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyUsage CertSign, CRLSign `
    -TextExtension '2.5.29.19={critical}{text}ca=1' `
    -NotAfter (Get-Date).AddYears(10) `
    -FriendlyName 'GuitarFollowLab Root'

# Server certificate, signed by the root above.
$leaf = New-SelfSignedCertificate `
    -Subject 'CN=GuitarFollowLab' `
    -DnsName $names `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -Signer $rootCert `
    -NotAfter (Get-Date).AddYears(5) `
    -FriendlyName 'GuitarFollowLab Server'

$pw = ConvertTo-SecureString -String 'guitarlab' -Force -AsPlainText
Export-PfxCertificate -Cert $leaf -FilePath (Join-Path $certDir 'local.pfx') -Password $pw | Out-Null
Export-Certificate -Cert $rootCert -FilePath (Join-Path $certDir 'local.cer') | Out-Null

Write-Host '  Done:'
Write-Host ('    ' + (Join-Path $certDir 'local.pfx'))
Write-Host ('    ' + (Join-Path $certDir 'local.cer'))
Write-Host ''
Write-Host '  On the phone:'
Write-Host '    1. open  http://<pc-ip>:1209  in the phone browser'
Write-Host '    2. click the "download certificate" link on that page'
Write-Host '    3. install it (Android: choose "CA certificate";'
Write-Host '       iPhone: also enable it under Settings - General -'
Write-Host '       About - Certificate Trust Settings)'
Write-Host '    4. then open  https://<pc-ip>:1210'
Write-Host ''
