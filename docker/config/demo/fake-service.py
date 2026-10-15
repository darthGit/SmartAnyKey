# Fake network service for demo targets: opens the listed TCP ports so a network
# scan sees a printer, a recorder or a router web UI. No real protocol behind them.
#   FAKE_PORTS="80=http 9100=raw"   FAKE_SERVER="..." (HTTP Server header + page title)
#   FAKE_BANNER="..." (first line on raw ports)
import os
import socketserver
import threading

SERVER = os.environ.get('FAKE_SERVER', 'embedded-httpd')
BANNER = os.environ.get('FAKE_BANNER', '')


class Http(socketserver.BaseRequestHandler):
    def handle(self):
        self.request.settimeout(3)
        try:
            self.request.recv(4096)
        except OSError:
            pass
        body = f'<html><head><title>{SERVER}</title></head><body>{SERVER}</body></html>'.encode()
        head = f'HTTP/1.0 200 OK\r\nServer: {SERVER}\r\nContent-Type: text/html\r\nContent-Length: {len(body)}\r\n\r\n'
        self.request.sendall(head.encode() + body)


class Raw(socketserver.BaseRequestHandler):
    def handle(self):
        if BANNER:
            self.request.sendall((BANNER + '\r\n').encode())


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


for spec in os.environ['FAKE_PORTS'].split():
    port, kind = spec.split('=')
    srv = Server(('0.0.0.0', int(port)), Http if kind == 'http' else Raw)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    print(f'listening {port}/{kind}', flush=True)

threading.Event().wait()
