param([int]$ParentPid, [string]$FileName)
$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LZDialog {
  public delegate bool EnumWindow(IntPtr handle, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr handle, EnumWindow callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint process);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr handle);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder value, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr handle, uint message, IntPtr parameter, string value);
}
'@
$deadline=(Get-Date).AddSeconds(25)
do {
  $script:dialog=[IntPtr]::Zero
  $callback=[LZDialog+EnumWindow]{param($hwnd,$parameter)
    [uint32]$processId=0
    [void][LZDialog]::GetWindowThreadProcessId($hwnd,[ref]$processId)
    $class=New-Object Text.StringBuilder 128
    [void][LZDialog]::GetClassName($hwnd,$class,128)
    if($processId -eq $ParentPid -and $class.ToString() -eq '#32770') {$script:dialog=$hwnd}
    return $true
  }
  [void][LZDialog]::EnumWindows($callback,[IntPtr]::Zero)
  if($script:dialog -ne [IntPtr]::Zero) {
    $script:edit=[IntPtr]::Zero; $script:save=[IntPtr]::Zero
    $child=[LZDialog+EnumWindow]{param($hwnd,$parameter)
      $id=[LZDialog]::GetDlgCtrlID($hwnd)
      $class=New-Object Text.StringBuilder 128
      [void][LZDialog]::GetClassName($hwnd,$class,128)
      if($id -in @(1001,1148) -and $class.ToString() -eq 'Edit') {$script:edit=$hwnd}
      if($id -eq 1 -and $class.ToString() -eq 'Button') {$script:save=$hwnd}
      return $true
    }
    [void][LZDialog]::EnumChildWindows($script:dialog,$child,[IntPtr]::Zero)
    if($script:edit -ne [IntPtr]::Zero -and $script:save -ne [IntPtr]::Zero) {
      # Windows runner's legacy .NET UIA exposes these as panes without
      # patterns. The native Edit and Button still implement standard messages.
      $set=[LZDialog]::SendMessage($script:edit,0x000C,[IntPtr]::Zero,$FileName)
      if($set -eq [IntPtr]::Zero) {throw 'Native filename field rejected text'}
      [void][LZDialog]::SendMessage($script:save,0x00F5,[IntPtr]::Zero,$null)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
} while((Get-Date)-lt $deadline)
throw 'Native filename Edit or Save Button not found'
