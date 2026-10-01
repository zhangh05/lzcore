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
        def create():
            self.icon = NotifyIcon()
            source = controller.paths.bundle / 'lzcore.ico'
            self.icon.Icon = Icon(str(source)) if source.is_file() else SystemIcons.Application
            self.icon.Text = '联智中枢'
            menu = ContextMenuStrip()
            for title, action in [('打开联智中枢', self.open), ('桌面设置', lambda: self.open('settings')), ('打开数据目录', lambda: controller.open_directory(controller.paths.data)), ('退出', lambda: self.open('close'))]:
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

    @property
    def title(self):
        return str(self.icon.Text)

    @title.setter
    def title(self, value):
        self.form.BeginInvoke(self.Action(lambda: setattr(self.icon, 'Text', value[:63])))

    def notify(self, message, title, target=None):
        self.target = target
        def display():
            self.icon.BalloonTipTitle = title
            self.icon.BalloonTipText = message
            self.icon.ShowBalloonTip(5000)
        self.form.BeginInvoke(self.Action(display))

    def stop(self):
        # The form may already be disposed after the event loop exits.
        self.icon.Visible = False
        self.icon.Dispose()
