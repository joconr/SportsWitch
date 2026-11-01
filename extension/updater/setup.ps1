<#
Turns on automatic updates for the SportsWitch in the folder above this one; "Set up automatic updates.cmd" runs it.
It registers SportsWitch Updater with Chrome for this Windows account only: one entry in Chrome's list of helpers
(HKCU\Software\Google\Chrome\NativeMessagingHosts) and one file in %LOCALAPPDATA%\SportsWitch. No administrator
rights. Only the SportsWitch loaded from this folder may start the helper, and the helper installs only releases
signed by SportsWitch's developer.
  -Remove   turns automatic updates off again (SportsWitch still says when a new version is out)
  -Name     another helper name, for tests
#>
param([switch]$Remove, [string]$Name = 'com.sportswitch.updater')
$ErrorActionPreference = 'Stop'
$folder = Split-Path -Parent $PSScriptRoot
$key = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$Name"
$hostFile = Join-Path $env:LOCALAPPDATA "SportsWitch\$Name.json"

if ($Remove) {
  if (Test-Path $key) { Remove-Item $key -Recurse -Force }
  if (Test-Path $hostFile) { Remove-Item $hostFile -Force }
  Write-Host 'Automatic updates are off. SportsWitch still tells you when a new version is out.'
  exit 0
}
if (Test-Path -LiteralPath (Join-Path $folder 'tools\publish_release.ps1')) {
  Write-Host "This copy of SportsWitch doesn't update itself, so automatic updates can't be set up for it. Nothing was changed."
  exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $folder 'manifest.json'))) {
  Write-Host "SportsWitch isn't in $folder. Run this from the SportsWitch folder you loaded in Chrome."
  exit 1
}

# Chrome names a SportsWitch loaded from a folder after the folder's path: the first 128 bits of the SHA-256 of
# the path (UTF-16, drive letter in capitals), written with the letters a to p.
function Get-ExtensionId([string]$path) {
  if ($path -match '^[a-z]:') { $path = $path.Substring(0, 1).ToUpper() + $path.Substring(1) }
  $hash = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::Unicode.GetBytes($path))
  return -join ($hash[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}
# The same path with every name spelled as it is on disk, in case Chrome was given it that way.
function Get-DiskPath([string]$path) {
  $dir = New-Object IO.DirectoryInfo $path
  $names = @()
  while ($dir.Parent) {
    $names = @($dir.Parent.GetDirectories($dir.Name)[0].Name) + $names
    $dir = $dir.Parent
  }
  return $dir.Name.ToUpper() + ($names -join '\')
}
$origins = @(@($folder, (Get-DiskPath $folder)) | Select-Object -Unique | ForEach-Object { "chrome-extension://$(Get-ExtensionId $_)/" })

$manifest = [ordered]@{
  name = $Name
  description = 'SportsWitch Updater: installs signed SportsWitch releases from GitHub into its folder.'
  path = Join-Path $PSScriptRoot 'sportswitch_updater.cmd'
  type = 'stdio'
  allowed_origins = $origins
}
New-Item -ItemType Directory -Force (Split-Path -Parent $hostFile) | Out-Null
[IO.File]::WriteAllText($hostFile, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name '(Default)' -Value $hostFile
Write-Host "Automatic updates are on for SportsWitch in $folder."
Write-Host 'New versions now install by themselves, between games. Keep this folder where it is.'
Write-Host 'In SportsWitch, Settings > Updates > Check now shows it.'
