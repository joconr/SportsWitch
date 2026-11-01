<#
SportsWitch Updater. Chrome starts it, through sportswitch_updater.cmd, when SportsWitch asks; "Set up automatic
updates" registered it for the SportsWitch folder it sits in. It answers one message and exits:
  {"cmd":"hello"}                      -> {"ok":true,"version":"<this folder's version>"}
  {"cmd":"install","version":"4.5.0"} -> downloads SportsWitch-v4.5.0.zip and its signature from the GitHub
                                          releases named in this folder's manifest.json, checks the signature
                                          against release-key.xml, and copies the new files over this folder.
SportsWitch reloads itself afterwards. Its settings live in Chrome, not in this folder, so they stay.
Failures answer {"ok":false,"error":"..."} and leave the folder as it was.
SPORTSWITCH_UPDATE_SOURCE, for tests, downloads from another address; the signature check still applies.
#>
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$folder = Split-Path -Parent $PSScriptRoot

# Chrome's native messaging: a 4-byte length, then that much UTF-8 JSON, each way.
function Read-Exactly($stream, [int]$count) {
  $buffer = New-Object byte[] $count
  $read = 0
  while ($read -lt $count) {
    $n = $stream.Read($buffer, $read, $count - $read)
    if ($n -le 0) { throw 'Chrome closed the connection.' }
    $read += $n
  }
  return ,$buffer
}
function Read-Message {
  $stdin = [Console]::OpenStandardInput()
  $length = [BitConverter]::ToInt32((Read-Exactly $stdin 4), 0)
  if ($length -le 0 -or $length -gt 65536) { throw 'That message is too long.' }
  return [Text.Encoding]::UTF8.GetString((Read-Exactly $stdin $length)) | ConvertFrom-Json
}
function Send-Message($answer) {
  $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes(($answer | ConvertTo-Json -Compress))
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

function Read-Manifest($path) {
  return [IO.File]::ReadAllText((Join-Path $path 'manifest.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Install-Release([string]$version) {
  if ($version -notmatch '^\d{1,4}(\.\d{1,4}){1,3}$') { throw "That isn't a version number." }
  if (Test-Path -LiteralPath (Join-Path $folder 'tools\publish_release.ps1')) { throw "This is the workshop folder; it doesn't update itself." }
  $manifest = Read-Manifest $folder
  if ($manifest.version -eq $version) { return @{ok = $true; version = $version} } # already copied, only the reload is left
  if ([string]$manifest.homepage_url -notmatch '^https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+$') { throw "manifest.json doesn't name SportsWitch's GitHub page." }
  $source = if ($env:SPORTSWITCH_UPDATE_SOURCE) { $env:SPORTSWITCH_UPDATE_SOURCE.TrimEnd('/') } else { "$($manifest.homepage_url)/releases/download" }

  $mutex = New-Object System.Threading.Mutex($false, 'Local\SportsWitchUpdater')
  try { $mine = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $mine = $true }
  if (-not $mine) { throw 'Another update is already installing.' }
  $work = Join-Path ([IO.Path]::GetTempPath()) ('SportsWitch-update-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  try {
    New-Item -ItemType Directory $work | Out-Null
    $zip = Join-Path $work 'release.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$source/v$version/SportsWitch-v$version.zip" -OutFile $zip
      Invoke-WebRequest -UseBasicParsing -Uri "$source/v$version/SportsWitch-v$version.zip.sig" -OutFile "$zip.sig"
    } catch { throw "Couldn't download SportsWitch $version from GitHub ($($_.Exception.Message))." }

    # Only what the developer signed installs, wherever it was downloaded from.
    $key = New-Object System.Security.Cryptography.RSACryptoServiceProvider
    $key.PersistKeyInCsp = $false
    $key.FromXmlString([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'release-key.xml')))
    try { $signature = [Convert]::FromBase64String([IO.File]::ReadAllText("$zip.sig").Trim()) } catch { $signature = New-Object byte[] 0 }
    $signed = $key.VerifyData([IO.File]::ReadAllBytes($zip), $signature,
      [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    if (-not $signed) { throw "The download isn't signed by SportsWitch's developer, so it wasn't installed." }

    # The release ZIP holds one SportsWitch folder.
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $new = Join-Path $work 'new'
    $files = New-Object System.Collections.Generic.List[string]
    $archive = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
      foreach ($entry in $archive.Entries) {
        if (-not $entry.Name) { continue }
        $name = $entry.FullName.Replace('\', '/')
        if (-not $name.StartsWith('SportsWitch/') -or $name.Contains(':') -or ('/' + $name + '/').Contains('/../')) {
          throw "The download has a file it shouldn't ($name)."
        }
        $relative = $name.Substring(12).Replace('/', '\')
        $target = Join-Path $new $relative
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $true)
        $files.Add($relative)
      }
    } finally { $archive.Dispose() }
    $found = (Read-Manifest $new).version
    if ($found -ne $version) { throw "The download is version $found, not $version." }

    # Copy over this folder, keeping the old files until every new one is in place.
    $old = Join-Path $work 'old'
    foreach ($relative in $files) {
      $target = Join-Path $folder $relative
      if (Test-Path -LiteralPath $target) {
        $saved = Join-Path $old $relative
        New-Item -ItemType Directory -Force (Split-Path -Parent $saved) | Out-Null
        Copy-Item -LiteralPath $target -Destination $saved
      }
    }
    try {
      foreach ($relative in $files) {
        $target = Join-Path $folder $relative
        New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $new $relative) -Destination $target -Force
      }
    } catch {
      $problem = $_.Exception.Message
      foreach ($relative in $files) {
        $target = Join-Path $folder $relative
        $saved = Join-Path $old $relative
        try {
          if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $target -Force }
          elseif (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
        } catch {}
      }
      throw "Couldn't copy the new files ($problem). The folder is as it was."
    }
    return @{ok = $true; version = $version}
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    if ($mine) { $mutex.ReleaseMutex() }
  }
}

# Answer last: Chrome may end this process as soon as the answer arrives.
try {
  $message = Read-Message
  switch ([string]$message.cmd) {
    'hello' { $answer = @{ok = $true; version = [string](Read-Manifest $folder).version} }
    'install' { $answer = Install-Release ([string]$message.version) }
    default { $answer = @{ok = $false; error = 'SportsWitch Updater does not know that request.'} }
  }
} catch {
  $answer = @{ok = $false; error = $_.Exception.Message}
}
try { Send-Message $answer } catch {}
