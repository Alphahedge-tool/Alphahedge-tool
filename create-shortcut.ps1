$WshShell = New-Object -comObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut("$env:USERPROFILE\Desktop\AlphaHedge.lnk")
$Shortcut.TargetPath = "C:\Users\SSEI\Alphahedge-tool\start-alphahedge.bat"
$Shortcut.WorkingDirectory = "C:\Users\SSEI\Alphahedge-tool"
$Shortcut.IconLocation = "C:\Users\SSEI\Alphahedge-tool\public\alphahede.ico"
$Shortcut.Description = "Launch AlphaHedge"
$Shortcut.Save()
Write-Host "Shortcut created on Desktop!" -ForegroundColor Green
