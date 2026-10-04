"""Dependency-only TLS tunnels for isolated engineering containers.

The broker is a separate container without a project mount. TLS remains end to
end; neither arbitrary destinations nor private address resolutions are valid.
"""

PACKAGE_HOSTS = ("registry.npmjs.org", "pypi.org", "files.pythonhosted.org")

PROXY_PROGRAM = r"""
import ipaddress, os, select, socket, socketserver, threading

ALLOWED = {"registry.npmjs.org", "pypi.org", "files.pythonhosted.org"}

def forward(left, right):
    while True:
        ready, _, _ = select.select([left, right], [], [], 60)
        if not ready:
            return
        for source in ready:
            data = source.recv(65536)
            if not data:
                return
            (right if source is left else left).sendall(data)

class Tunnel(socketserver.StreamRequestHandler):
    def handle(self):
        self.connection.settimeout(15)
        line = self.rfile.readline(4097)
        fields = line.decode("ascii", "replace").strip().split()
        if len(fields) != 3 or fields[0] != "CONNECT":
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        authority = fields[1]
        host, sep, port = authority.rpartition(":")
        if not sep or host not in ALLOWED or port != "443":
            self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
            return
        total = 0
        while True:
            header = self.rfile.readline(4097)
            total += len(header)
            if total > 16384 or not header:
                return
            if header in (b"\r\n", b"\n"):
                break
        try:
            addresses = list(dict.fromkeys(item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)))
            if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
                self.wfile.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
                return
            upstream = socket.create_connection((addresses[0], 443), timeout=15)
            with upstream:
                self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                self.wfile.flush()
                forward(self.connection, upstream)
        except OSError:
            return

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

class Preview(socketserver.BaseRequestHandler):
    # The destination is fixed by the server-created environment, not supplied
    # in an HTTP URL. Publishing an internal Docker network directly does not
    # create an ingress port; this transport owns that explicit boundary.
    def handle(self):
        try:
            with socket.create_connection((os.environ["PROJECT_HOST"], int(os.environ["PROJECT_PORT"])), timeout=5) as upstream:
                forward(self.request, upstream)
        except OSError:
            return

proxy = Server((os.environ.get("PROXY_BIND", "0.0.0.0"), int(os.environ.get("PROXY_PORT", "3128"))), Tunnel)
if os.environ.get("PROJECT_PORT"):
    threading.Thread(target=proxy.serve_forever, daemon=True).start()
    Server(("0.0.0.0", int(os.environ["PROJECT_PORT"])), Preview).serve_forever()
else:
    proxy.serve_forever()
"""
