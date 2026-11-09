import json
import re
from pathlib import Path

import img2pdf
import jmcomic
from pypdf import PdfReader, PdfWriter


def natural_key(value):
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r'(\d+)', str(value))]


def main():
    job = json.loads(Path('job.json').read_text(encoding='utf-8'))
    album_id, password = job['albumId'], job['password']
    if not re.fullmatch(r'\d{3,12}', album_id) or not password:
        raise ValueError('编号或 PDF 密码无效')
    base = Path('images').resolve()
    option = jmcomic.JmOption.construct({'dir_rule': {'base_dir': str(base), 'rule': 'Bd/Aid/Pindex'}, 'download': {'threading': {'image': 4, 'photo': 1}}})
    result = jmcomic.download_album(album_id, option, check_exception=True)
    images = [Path(p).resolve() for p in result.manifest.image_filepath_list]
    if not images or any(not p.is_file() or not p.is_relative_to(base) for p in images):
        raise ValueError('下载结果不完整或图片不在任务目录')
    images.sort(key=lambda p: natural_key(p.relative_to(base)))
    with Path('plain.pdf').open('wb') as target:
        img2pdf.convert([str(p) for p in images], outputstream=target)
    reader = PdfReader('plain.pdf')
    writer = PdfWriter()
    writer.append(reader)
    writer.encrypt(password, algorithm='AES-256')
    with Path('result.pdf').open('wb') as target:
        writer.write(target)
    check = PdfReader('result.pdf')
    if not check.is_encrypted or not check.decrypt(password) or len(check.pages) != len(images):
        raise ValueError('PDF 加密或页数校验失败')
    print(json.dumps({'pages': len(images)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
