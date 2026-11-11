; 联智中枢每用户安装器。只通过 packaging/windows/build.py 调用（传入 AppVersion 与 Root）。
#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef Root
  #error Root is required
#endif

[Setup]
AppId={{7E8A6D0A-6E11-4C97-99F2-214CB76A2B93}
AppName=联智中枢
AppVersion={#AppVersion}
AppVerName=联智中枢 {#AppVersion}
VersionInfoVersion={#AppVersion}.0
AppPublisher=LZCore
AppPublisherURL=https://github.com/zhangh05/lzcore
DefaultDirName={localappdata}\Programs\LZCore
DefaultGroupName=联智中枢
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#Root}\release
OutputBaseFilename=lzcore-v{#AppVersion}-windows-setup
SetupIconFile={#Root}\lzcore.ico
UninstallDisplayIcon={app}\lzcore.exe
UninstallDisplayName=联智中枢
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
#ifdef SignCommand
SignTool=lzcore {#SignCommand}
SignedUninstaller=yes
#endif

[Languages]
Name: "chinesesimp"; MessagesFile: "{#Root}\packaging\inno\ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: unchecked

[InstallDelete]
; 升级前清掉旧版本的运行时目录：旧的 Python 模块、DLL 或前端资源残留会和新版本混用。
; 用户数据不在安装目录（默认 %LOCALAPPDATA%\LZCore），不受影响。
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#Root}\dist\lzcore\lzcore.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\dist\lzcore\build-info.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Root}\dist\lzcore\_internal\*"; DestDir: "{app}\_internal"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\联智中枢"; Filename: "{app}\lzcore.exe"
Name: "{autodesktop}\联智中枢"; Filename: "{app}\lzcore.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\lzcore.exe"; Description: "启动联智中枢"; Flags: nowait postinstall skipifsilent

[Registry]
; 程序自己写开机自启动；卸载时只删除这一项。
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "LZCore"; Flags: uninsdeletevalue dontcreatekey

[UninstallDelete]
Type: filesandordirs; Name: "{app}\_internal"

[Code]
function LZCoreRunning(): Boolean;
var Code: Integer;
begin
  { 不自动结束进程：正在运行的程序可能持有网络写操作。 }
  Result := not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "if (Get-Process lzcore -ErrorAction SilentlyContinue) {exit 1}"',
    '', SW_HIDE, ewWaitUntilTerminated, Code) or (Code <> 0);
end;

function InitializeSetup(): Boolean;
var Version: Cardinal;
begin
  Result := RegQueryDWordValue(HKLM, 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full', 'Release', Version) and (Version >= 528040);
  if not Result then MsgBox('需要 .NET Framework 4.8。请先完成 Windows 更新后重试。', mbError, MB_OK);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\portable.json')) then begin
    Result := '此目录是便携版。请选择独立的安装目录，安装后可在桌面设置中迁移原数据。';
    Exit;
  end;
  if LZCoreRunning() then
    Result := '联智中枢正在运行。请先在程序中结束任务并退出，再继续安装。';
end;

function InitializeUninstall(): Boolean;
begin
  Result := not LZCoreRunning();
  if not Result then MsgBox('请先从联智中枢中结束任务并退出程序，再卸载。用户数据会保留。', mbError, MB_OK);
end;
