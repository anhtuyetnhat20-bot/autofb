# Tao (hoac go) loi tat "AUTOFB" trong thu muc Startup cua tai khoan Windows hien tai,
# de server va agent research tu bat moi khi dang nhap may. Khong can quyen quan tri.
# File nay de chu khong dau vi Windows PowerShell 5.1 doc file theo bang ma cu.
#   Cai:  powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
#   Go:   powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 -Remove
param([switch]$Remove)

$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'AUTOFB.lnk'

if ($Remove) {
  if (Test-Path $link) { Remove-Item $link -Confirm:$false; "Da go tu chay AUTOFB." } else { "Chua co loi tat AUTOFB trong Startup." }
  return
}

$target = Join-Path $PSScriptRoot 'start-autofb.cmd'
$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = $target
$s.WorkingDirectory = Split-Path $PSScriptRoot -Parent
$s.WindowStyle = 7   # thu nho
$s.Description = 'Bat server AUTOFB va agent research'
$s.Save()
"Da tao $link"
"Tro toi $target"
