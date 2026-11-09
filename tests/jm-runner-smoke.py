import base64
import io
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from pypdf import PdfReader

fake = '''
import jmcomic
from pathlib import Path
from PIL import Image
from types import SimpleNamespace
def fake_download(album_id, option, check_exception):
    assert check_exception
    root = Path(option.dir_rule.base_dir) / album_id / '1'
    root.mkdir(parents=True, exist_ok=True)
    image = root / '1.jpg'
    Image.new('RGB', (100, 100), 'white').save(image)
    return SimpleNamespace(manifest=SimpleNamespace(image_filepath_list=[str(image)]))
jmcomic.download_album = fake_download
'''
encode = lambda value: base64.b64encode(value.encode('utf-8')).decode('ascii')
script = fake + Path('/fixtures/jm_pdf.py').read_text(encoding='utf-8')
job = json.dumps({'albumId': '123456', 'password': 'sample-password'})
payload = {'script': 'job.py', 'files': [{'path': 'job.py', 'data': encode(script)}, {'path': 'job.json', 'data': encode(job)}], 'outputs': ['result.pdf'], 'timeoutSeconds': 30, 'network': False}
server = subprocess.Popen([sys.executable, '-I', '-u', '/runner/server.py'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
try:
    for attempt in range(50):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8766/healthz', timeout=1):
                break
        except OSError:
            if server.poll() is not None or attempt == 49:
                raise
            time.sleep(0.1)
    request = urllib.request.Request('http://127.0.0.1:8766/run', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=40) as response:
        result = json.load(response)
    assert result['exitCode'] == 0, result
    assert len(result['files']) == 1 and result['files'][0]['path'] == 'result.pdf', result
    pdf = PdfReader(io.BytesIO(base64.b64decode(result['files'][0]['data'])))
    assert pdf.is_encrypted and pdf.decrypt('sample-password') and len(pdf.pages) == 1
    print('执行容器 HTTP 传输、隔离执行与加密 PDF 回传通过')
finally:
    server.terminate()
    server.wait(timeout=5)
