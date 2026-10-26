"""Loopback-only receiver. No captured pixels leave this computer."""
import json
import os
import pathlib
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(os.environ.get('SHARE_VISIBILITY_DIR', '/tmp/sharecode-visibility-test'))
ROOT.mkdir(parents=True, exist_ok=True)
PAGE = pathlib.Path(__file__).with_name('index.html')
lock = threading.Lock()
running = False


def sequence():
    global running
    try:
        for phase in ['visible', 'covered', 'visible', 'offscreen', 'visible', 'orderOut', 'visible', 'appHide', 'visible', 'minimized', 'visible']:
            (ROOT / 'command').write_text(phase)
            time.sleep(8)
    finally:
        (ROOT / 'command').write_text('visible')
        running = False


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        if self.path == '/status':
            try:
                source = json.loads((ROOT / 'source.json').read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                source = {}
            body = json.dumps(dict(source=source, running=running)).encode()
            content_type = 'application/json'
        else:
            body, content_type = PAGE.read_bytes(), 'text/html'
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        global running
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.path == '/run':
            if not running:
                running = True
                threading.Thread(target=sequence, daemon=True).start()
        elif self.path == '/sample':
            with lock, (ROOT / 'samples.jsonl').open('a') as file:
                file.write(json.dumps(json.loads(data)) + '\n')
        self.send_response(204)
        self.end_headers()


print('Visibility test: http://127.0.0.1:18765', flush=True)
ThreadingHTTPServer(('127.0.0.1', 18765), Handler).serve_forever()
