import base64
import io
import json
import os
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

from pypdf import PdfReader


album_id = os.environ.get('JM_TEST_ALBUM', '')
if not album_id.isdecimal():
    raise SystemExit('请通过 JM_TEST_ALBUM 指定需要验证的编号')
encode = lambda value: base64.b64encode(value.encode('utf-8')).decode('ascii')
job = json.dumps({'albumId': album_id, 'password': 'temporary-test'})
script = Path('/fixtures/jm_pdf.py').read_text(encoding='utf-8')
payload = {'script': 'job.py', 'files': [{'path': 'job.py', 'data': encode(script)}, {'path': 'job.json', 'data': encode(job)}], 'outputs': ['result.pdf'], 'timeoutSeconds': 180, 'network': True}
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
    with urllib.request.urlopen(request, timeout=200) as response:
        result = json.load(response)
    if result['exitCode'] != 0 or result['timedOut']:
        error = (result['stderr'] or result['stdout']).strip().splitlines()
        raise SystemExit('真实站点下载或转换失败：' + (error[-1] if error else '未知错误'))
    item = result['files'][0]
    data = base64.b64decode(item['data'], validate=True)
    pdf = PdfReader(io.BytesIO(data))
    if not pdf.is_encrypted or not pdf.decrypt('temporary-test'):
        raise SystemExit('生成的文件没有通过加密验证')
    print(json.dumps({'加密': True, '页数': len(pdf.pages), '大小字节': len(data), '容器回传': True}, ensure_ascii=False))
finally:
    server.terminate()
    server.wait(timeout=5)
