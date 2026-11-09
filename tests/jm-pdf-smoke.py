import json
import os
import runpy
import tempfile
from pathlib import Path
from types import SimpleNamespace

import jmcomic
from PIL import Image
from pypdf import PdfReader


with tempfile.TemporaryDirectory() as directory:
    os.chdir(directory)
    Path('job.json').write_text(json.dumps({'albumId': '123456', 'password': 'sample-password'}), encoding='utf-8')

    def fake_download(album_id, option, check_exception):
        assert album_id == '123456' and check_exception
        root = Path(option.dir_rule.base_dir) / album_id
        for number, size in [('10', (100, 200)), ('2', (200, 100))]:
            target = root / number / '1.jpg'
            target.parent.mkdir(parents=True, exist_ok=True)
            Image.new('RGB', size, 'white').save(target)
        return SimpleNamespace(manifest=SimpleNamespace(image_filepath_list=[str(root / '10' / '1.jpg'), str(root / '2' / '1.jpg')]))

    jmcomic.download_album = fake_download
    runpy.run_path('/fixtures/jm_pdf.py', run_name='__main__')
    result = PdfReader('result.pdf')
    assert result.is_encrypted and not result.decrypt('incorrect')
    assert result.decrypt('sample-password') and len(result.pages) == 2
    assert result.pages[0].mediabox.width > result.pages[0].mediabox.height
    print('加密、密码校验和页序验证通过')
