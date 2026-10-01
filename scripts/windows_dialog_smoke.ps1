param([int]$ParentPid, [string]$FileName)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root=[System.Windows.Automation.AutomationElement]::RootElement
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ParentPid)
$editCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)
$deadline=(Get-Date).AddSeconds(25)
do {
  $windows=$root.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
  foreach($window in $windows) {
    # Modern Common Item Dialog exposes 1001 as a ComboBox; its Edit child
    # owns ValuePattern. Classic SaveFileDialog uses 1148 for the edit itself.
    foreach($id in @('1001','1148')) {
      $fieldCondition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id)
      $field=$window.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$fieldCondition)
      if(-not $field) {continue}
      $edit=if($field.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit){$field}else{$field.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$editCondition)}
      if(-not $edit) {continue}
      $value=$null
      if(-not $edit.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value) -or $value.Current.IsReadOnly) {continue}
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
# Isolated fixture UI only: report control shape for environment diagnosis.
foreach($window in $windows) {
  $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object {
    Write-Host "$($_.Current.ControlType.ProgrammaticName) / $($_.Current.AutomationId) / $($_.Current.Name)"
  }
}
throw 'Native editable filename control not found'
