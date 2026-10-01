#ifndef AppVersion
  #error AppVersion is required
#endif
[Setup]
AppId={{7E8A6D0A-6E11-4C97-99F2-214CB76A2B93}
AppName=联智中枢
AppVersion={#AppVersion}
AppPublisher=LZCore
AppPublisherURL=https://github.com/zhangh05/lzcore
DefaultDirName={localappdata}\Programs\LZCore
DefaultGroupName=联智中枢
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir=..\release
OutputBaseFilename=lzcore-v{#AppVersion}-windows-setup
SetupIconFile=..\lzcore.ico
UninstallDisplayIcon={app}\lzcore.exe
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
DisableProgramGroupPage=yes
#ifdef SignCommand
SignTool=lzcore {#SignCommand}
SignedUninstaller=yes
#endif
[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked
[Files]
Source: "..\dist\lzcore\*"; DestDir: "{app}"; Excludes: "portable.json,data,workspaces,config"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{autoprograms}\联智中枢"; Filename: "{app}\lzcore.exe"
Name: "{autodesktop}\联智中枢"; Filename: "{app}\lzcore.exe"; Tasks: desktopicon
[Run]
Filename: "{app}\lzcore.exe"; Description: "启动联智中枢"; Flags: nowait postinstall skipifsilent
[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "LZCore"; Flags: uninsdeletevalue
[Code]
function InitializeSetup(): Boolean;
var Version: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Version) and (Version >= 528040);
  if not Result then MsgBox('需要 .NET Framework 4.8。请先完成 Windows 更新后重试。', mbError, MB_OK);
end;
function PrepareToInstall(var NeedsRestart: Boolean): String;
var Code: Integer;
begin
  { No automatic termination: a running process may own a network write. }
  Result := '';
  if FileExists(ExpandConstant('{app}\lzcore.exe')) then begin
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -NonInteractive -Command "if (Get-Process lzcore -ErrorAction SilentlyContinue) {exit 1}"', '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0) then
      Result := '请先从联智中枢中结束任务并退出程序，再继续安装。';
  end;
end;
function InitializeUninstall(): Boolean;
var Code: Integer;
begin
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "if (Get-Process lzcore -ErrorAction SilentlyContinue) {exit 1}"', '', SW_HIDE, ewWaitUntilTerminated, Code) and (Code = 0);
  if not Result then MsgBox('请先从联智中枢中结束任务并退出程序，再卸载。用户数据会保留。', mbError, MB_OK);
end;
