' futures-analyzer toggle (port 8300)
' click once: start hidden + open browser; click again: stop
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
tmp = sh.ExpandEnvironmentStrings("%TEMP%") & "\fa_state.txt"
If fso.FileExists(tmp) Then fso.DeleteFile(tmp)

detect = "powershell -NoProfile -Command ""if (Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue) { 'on' | Out-File -Encoding ascii " & tmp & " } else { 'off' | Out-File -Encoding ascii " & tmp & " }"""
sh.Run detect, 0, True
state = ""
If fso.FileExists(tmp) Then state = LCase(Trim(fso.OpenTextFile(tmp).ReadAll))

If state = "on" Then
  stopCmd = "powershell -NoProfile -Command ""Get-NetTCPConnection -LocalPort 8300 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"""
  sh.Run stopCmd, 0, True
  MsgBox "futures-analyzer STOPPED", 64, "FA toggle"
Else
  startCmd = "powershell -NoProfile -Command ""Set-Location 'C:\Users\10166\.agents\skills\futures-analyzer'; Start-Process -FilePath '.venv\Scripts\python.exe' -ArgumentList 'app.py' -WindowStyle Hidden"""
  sh.Run startCmd, 0, True
  ready = False
  For i = 1 To 20
    WScript.Sleep 1000
    If fso.FileExists(tmp) Then fso.DeleteFile(tmp)
    sh.Run detect, 0, True
    If fso.FileExists(tmp) Then
      If LCase(Trim(fso.OpenTextFile(tmp).ReadAll)) = "on" Then
        ready = True
        Exit For
      End If
    End If
  Next
  If ready Then
    sh.Run "http://127.0.0.1:8300"
    MsgBox "futures-analyzer STARTED" & vbCrLf & "http://127.0.0.1:8300", 64, "FA toggle"
  Else
    MsgBox "started, but port 8300 not ready in 20s" & vbCrLf & "check service or run start.bat to see errors", 48, "FA toggle"
  End If
End If
