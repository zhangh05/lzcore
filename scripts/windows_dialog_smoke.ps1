param([int]$ParentPid, [string]$FileName)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
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
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint own, uint target, bool attach);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)] public struct Keyboard {
    public ushort key, scan; public uint flags, time; public UIntPtr extra;
  }
  [StructLayout(LayoutKind.Explicit, Size=32)] public struct InputUnion {
    [FieldOffset(0)] public Keyboard keyboard;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Input {
    public uint type; public InputUnion value;
  }
  [DllImport("user32.dll")] public static extern uint SendInput(uint count, Input[] inputs, int size);
  public static void TypeText(string text) {
    foreach(char c in text) {
      Input down=new Input {type=1, value=new InputUnion {keyboard=new Keyboard {scan=c, flags=4}}};
      Input up=down; up.value.keyboard.flags=6;
      if(SendInput(2,new[]{down,up},Marshal.SizeOf(typeof(Input)))!=2) throw new Exception("Keyboard input rejected");
    }
  }
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
      # WM_SETTEXT changes the Edit display but does not update the modern
      # dialog's filename binding. Use actual Unicode keyboard input instead.
      [uint32]$processId=0
      $targetThread=[LZDialog]::GetWindowThreadProcessId($script:edit,[ref]$processId)
      $ownThread=[LZDialog]::GetCurrentThreadId()
      [void][LZDialog]::AttachThreadInput($ownThread,$targetThread,$true)
      try {
        [void][LZDialog]::SetForegroundWindow($script:dialog)
        [void][LZDialog]::SetFocus($script:edit)
      } finally { [void][LZDialog]::AttachThreadInput($ownThread,$targetThread,$false) }
      [System.Windows.Forms.SendKeys]::SendWait('^a')
      [LZDialog]::TypeText($FileName)
      Start-Sleep -Milliseconds 200
      [void][LZDialog]::SendMessage($script:save,0x00F5,[IntPtr]::Zero,$null)
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
} while((Get-Date)-lt $deadline)
throw 'Native filename Edit or Save Button not found'
