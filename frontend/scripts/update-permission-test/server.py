"""Local fixture for the real client/updater. Never proxies to production."""
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[3] / 'build/update-permission-test'

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, status, kind='application/json'):
        self.send_response(status)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Type', kind)
        self.end_headers()

    def do_OPTIONS(self):
        self.respond(204)

    def do_GET(self):
        mode = (ROOT / 'mode').read_text().strip()
        if self.path.startswith('/update/'):
            if self.path.rstrip('/').endswith('/0.2.3'):
                self.respond(204)
                return
            payload = {'version': '0.2.3', 'notes': 'Local-only permission continuity experiment',
                       'url': 'http://127.0.0.1:18766/bundle',
                       'signature': (ROOT / mode / 'update.app.tar.gz.sig').read_text().strip()}
            self.respond(200)
            self.wfile.write(json.dumps(payload).encode())
        elif self.path == '/bundle':
            self.respond(200, 'application/octet-stream')
            self.wfile.write((ROOT / mode / 'update.app.tar.gz').read_bytes())
        else:
            self.respond(404)

    def do_POST(self):
        if self.path != '/sample':
            self.respond(404)
            return
        sample = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        sample['signingMode'] = (ROOT / 'mode').read_text().strip()
        with (ROOT / 'samples.jsonl').open('a') as file:
            file.write(json.dumps(sample) + '\n')
        self.respond(204)

print('Local-only update fixture listening at 127.0.0.1:18766', flush=True)
ThreadingHTTPServer(('127.0.0.1', 18766), Handler).serve_forever()
