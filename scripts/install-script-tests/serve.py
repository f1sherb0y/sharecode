# Serves the Windows install template rendered like the server does, plus a fake installer.
# Usage: python serve.py PORT INSTALLER.exe [bad-sha]
import hashlib, http.server, pathlib, sys

here = pathlib.Path(__file__).parent
port = int(sys.argv[1])
exe = pathlib.Path(sys.argv[2]).read_bytes()
sha = hashlib.sha256(exe).hexdigest() if 'bad-sha' not in sys.argv else '0' * 64
template = (here.parent.parent / 'server-rs/src/routes/client_install/install.ps1').read_text(encoding='utf-8')
values = {'ORIGIN': f'http://127.0.0.1:{port}', 'X64_VERSION': '9.9.9', 'X64_URL': '/api/client/downloads/x/ShareCode%20Client_9.9.9_x64-setup.exe',
          'X64_SHA256': sha, 'ARM64_VERSION': '9.9.9', 'ARM64_URL': '/api/client/downloads/x/ShareCode%20Client_9.9.9_x64-setup.exe', 'ARM64_SHA256': sha}
for k, v in values.items():
    template = template.replace('{{' + k + '}}', v)
script = template.encode('utf-8')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/api/client/install.ps1':
            body, kind = script, 'text/plain; charset=utf-8'
        elif self.path.startswith('/api/client/downloads/'):
            body, kind = exe, 'application/octet-stream'
        else:
            self.send_response(404); self.end_headers(); return
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
