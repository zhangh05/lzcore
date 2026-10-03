"""Windows-owned tray and notification click handling; no registry integration."""
import threading


class NativeTray:
    def __init__(self, controller):
        from System import Action
        from System.Drawing import Icon, SystemIcons
        from System.Windows.Forms import ContextMenuStrip, NotifyIcon, ToolStripMenuItem
        self.form = controller.window.native
        self.Action = Action
        self.controller = controller
        self.target = None
        self._callbacks = []
        self._stopped = False
        def create():
            self.icon = NotifyIcon()
            source = controller.paths.bundle / 'lzcore.ico'
            self.icon.Icon = Icon(str(source)) if source.is_file() else SystemIcons.Application
            self.icon.Text = '联智中枢'
            menu = ContextMenuStrip()
            for title, action in [('打开联智中枢', self.open), ('桌面设置', lambda: self.open('settings')), ('打开数据目录', self.open_data), ('退出', lambda: self.open('close'))]:
                item = ToolStripMenuItem(title)
                def callback(_sender, _event, handler=action):
                    threading.Thread(target=handler, daemon=True).start()
                item.Click += callback
                self._callbacks.append(callback)
                menu.Items.Add(item)
            self.icon.ContextMenuStrip = menu
            def clicked(_sender, _event):
                threading.Thread(target=self.open, daemon=True).start()
            def notification(_sender, _event):
                threading.Thread(target=lambda: self.open('task', target=self.target), daemon=True).start()
            self.icon.DoubleClick += clicked
            self.icon.BalloonTipClicked += notification
            self._callbacks.extend([clicked, notification])
            self.icon.Visible = True
        self.form.Invoke(Action(create))

    def open(self, action=None, **detail):
        self.controller.show()
        if action:
            self.controller.emit(action, **detail)

    def open_data(self):
        from desktop_app.controller import DesktopApi
        # Tray actions share the bridge's current-session authorization.
        if not DesktopApi(self.controller).open_folder('data')['ok']:
            self.open('settings')

    @property
    def title(self):
        return str(self.icon.Text)

    @title.setter
    def title(self, value):
        if self._stopped:
            return
        def update():
            if not self._stopped:
                self.icon.Text = value[:63]
        self.form.BeginInvoke(self.Action(update))

    def notify(self, message, title, target=None):
        if self._stopped:
            return
        self.target = target
        def display():
            if self._stopped:
                return
            self.icon.BalloonTipTitle = title
            self.icon.BalloonTipText = message
            self.icon.ShowBalloonTip(5000)
        self.form.BeginInvoke(self.Action(display))

    def stop(self):
        if self._stopped:
            return
        def dispose():
            self._stopped = True
            self.icon.Visible = False
            self.icon.Dispose()
        # Dispose on the owning UI thread before the form is destroyed.
        if self.form.InvokeRequired:
            self.form.Invoke(self.Action(dispose))
        else:
            dispose()
