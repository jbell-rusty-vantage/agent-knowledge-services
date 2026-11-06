Option Explicit

' Start hidden before PowerShell allocates a console, and retain its exit status.
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
Dim shell, command, result
Set shell = CreateObject("WScript.Shell")
command = Quote(WScript.Arguments(0)) & " -NoProfile -NonInteractive -WindowStyle Hidden -File " & Quote(WScript.Arguments(1))
result = shell.Run(command, 0, True)
WScript.Quit result

Function Quote(value)
    Quote = Chr(34) & value & Chr(34)
End Function
