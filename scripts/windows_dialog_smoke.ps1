param([int]$ParentPid, [string]$FileName)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ParentPid)
$deadline=(Get-Date).AddSeconds(25)
do {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  foreach($window in $windows) {
    $editCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1001')
    $edit=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$editCondition)
    if($edit) {
      $value=$edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
      $value.SetValue($FileName)
      $buttonCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1')
      $save=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$buttonCondition)
      if(-not $save) {throw 'Native Save button not found'}
      $save.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
      exit 0
    }
  }
  Start-Sleep -Milliseconds 200
} while((Get-Date)-lt $deadline)
throw 'Native file dialog not found'
