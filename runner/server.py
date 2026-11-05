"""Private, bounded Python worker. No host mounts, credentials or database."""
import base64
import hashlib
import json
import os
import signal
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import __version__ as pillow_version

MAX_REQUEST = 140 * 1024 * 1024
MAX_FILES = 128
MAX_FILE = 50 * 1024 * 1024
MAX_OUTPUT = 100 * 1024 * 1024
gate = threading.BoundedSemaphore(1)


def relative_path(value):
    if not isinstance(value, str) or not value or '\\' in value or '\x00' in value:
        raise ValueError('文件路径无效')
    parsed = PurePosixPath(value)
    if parsed.is_absolute() or any(part in ('..', '.') for part in parsed.parts):
        raise ValueError('文件路径必须位于任务工作区')
    return parsed


def digest(data):
    return hashlib.sha256(data).hexdigest()


def execute(request):
    script = relative_path(request.get('script'))
    if script.suffix.lower() not in ('.py', '.sh'):
        raise ValueError('只允许执行 .py 或 .sh 文件')
    inputs = request.get('files', [])
    if not isinstance(inputs, list) or len(inputs) > MAX_FILES:
        raise ValueError('输入文件数量超限')
    timeout = request.get('timeoutSeconds', 30)
    if not isinstance(timeout, int) or not 1 <= timeout <= 900:
        raise ValueError('超时时间必须为 1 至 900 秒')
    network = request.get('network', False)
    if not isinstance(network, bool):
        raise ValueError('网络权限格式无效')
    selected_outputs = request.get('outputs')
    if selected_outputs is not None and (not isinstance(selected_outputs, list) or len(selected_outputs) > MAX_FILES):
        raise ValueError('输出路径数量超限')
    with tempfile.TemporaryDirectory(prefix='python-job-', dir='/tmp') as temp:
        root = Path(temp)
        before = {}
        total = 0
        for item in inputs:
            name = relative_path(item.get('path'))
            data = base64.b64decode(item.get('data', ''), validate=True)
            total += len(data)
            if len(data) > MAX_FILE or total > MAX_OUTPUT:
                raise ValueError('输入文件大小超限')
            target = root.joinpath(*name.parts)
            if target.exists():
                raise ValueError('输入文件路径重复')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            before[name.as_posix()] = digest(data)
        script_path = root.joinpath(*script.parts)
        if not script_path.is_file():
            raise ValueError('脚本未包含在输入文件中')
        env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': temp, 'TMPDIR': temp, 'PYTHONDONTWRITEBYTECODE': '1', 'LANG': 'C.UTF-8'}
        with tempfile.TemporaryFile() as stdout, tempfile.TemporaryFile() as stderr:
            process = subprocess.Popen([sys.executable, '-I', '/runner/sandbox.py', str(script_path), '1' if network else '0'], cwd=temp, env=env, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                exit_code, timed_out = process.wait(timeout=timeout), False
            except subprocess.TimeoutExpired:
                exit_code, timed_out = None, True
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            stdout.seek(0); stderr.seek(0)
            out = stdout.read(65536).decode('utf-8', 'replace')
            err = stderr.read(65536).decode('utf-8', 'replace')
        if exit_code != 0 or timed_out:
            return {'exitCode': exit_code, 'timedOut': timed_out, 'stdout': out, 'stderr': err, 'files': [], 'network': network}
        outputs, total = [], 0
        targets = []
        if selected_outputs is not None:
            for name in selected_outputs:
                target = root.joinpath(*relative_path(name).parts)
                if not target.exists() or target.is_symlink() or not target.resolve().is_relative_to(root):
                    raise ValueError('指定的输出不存在或不在任务目录')
                targets.append(target)
        candidates = root.rglob('*') if selected_outputs is None else (item for target in targets for item in ([target] if target.is_file() else target.rglob('*') if target.is_dir() else []))
        seen = set()
        for item in candidates:
            if item.is_symlink() or not item.is_file() or not item.resolve().is_relative_to(root):
                continue
            name = item.relative_to(root).as_posix()
            if name in seen:
                continue
            seen.add(name)
            size = item.stat().st_size
            if size > MAX_FILE:
                raise ValueError('输出文件大小超限')
            data = item.read_bytes()
            if before.get(name) == digest(data):
                continue
            total += size
            if len(outputs) >= MAX_FILES or total > MAX_OUTPUT:
                raise ValueError('输出文件数量或总大小超限')
            outputs.append({'path': name, 'data': base64.b64encode(data).decode(), 'size': size})
        return {'exitCode': exit_code, 'timedOut': timed_out, 'stdout': out, 'stderr': err, 'files': outputs, 'network': network}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != '/healthz':
            self.reply(404, {'error': 'not found'}); return
        font = Path('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc').is_file()
        self.reply(200 if font else 503, {'ok': font, 'pillow': pillow_version, 'cjkFont': font})

    def do_POST(self):
        if self.path != '/run':
            self.reply(404, {'error': 'not found'}); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length <= 0 or length > MAX_REQUEST:
                raise ValueError('请求大小超限')
            request = json.loads(self.rfile.read(length))
            with gate:
                result = execute(request)
            self.reply(200, result)
        except (ValueError, KeyError, TypeError, OSError) as error:
            self.reply(400, {'error': str(error)})


ThreadingHTTPServer(('0.0.0.0', 8766), Handler).serve_forever()
