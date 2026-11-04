"""Runs inside the worker container against its HTTP API; no QQ connection."""
import base64
import json
import urllib.request

script = '''import socket
from pathlib import Path
from PIL import Image, ImageFont, ImageDraw
try:
    socket.socket()
    raise RuntimeError('network sandbox unavailable')
except PermissionError:
    pass
assert Path('input.txt').read_text(encoding='utf-8') == '中文输入'
font = ImageFont.truetype('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc', 24)
image = Image.new('RGB', (320, 80), 'white')
ImageDraw.Draw(image).text((5, 5), '中文绘图', font=font, fill='black')
image.save('out.png')
print('sandbox-ok')
'''
encode = lambda value: base64.b64encode(value.encode('utf-8')).decode('ascii')
payload = {'script': 'test.py', 'files': [{'path': 'test.py', 'data': encode(script)}, {'path': 'input.txt', 'data': encode('中文输入')}], 'timeoutSeconds': 20}
request = urllib.request.Request('http://127.0.0.1:8766/run', json.dumps(payload).encode(), {'Content-Type': 'application/json'})
with urllib.request.urlopen(request, timeout=30) as response:
    result = json.load(response)
assert result['exitCode'] == 0, result
assert 'sandbox-ok' in result['stdout'], result
assert result['network'] is False
image = next(item for item in result['files'] if item['path'] == 'out.png')
assert base64.b64decode(image['data']).startswith(b'\x89PNG\r\n\x1a\n')
print('Python 文件输入、网络隔离、中文字体、PNG 输出均已通过')
