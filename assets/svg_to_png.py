"""Convert an SVG to a bounded-size PNG in the isolated Python worker."""
import re
from defusedxml import ElementTree
import cairosvg

data = open('image.svg', 'rb').read()
root = ElementTree.fromstring(data)
if root.tag.rsplit('}', 1)[-1] != 'svg':
    raise ValueError('输入不是 SVG')

def pixels(value):
    match = re.fullmatch(r'\s*([0-9]+(?:\.[0-9]+)?)\s*(?:px)?\s*', value or '')
    return float(match.group(1)) if match else None

width, height = pixels(root.get('width')), pixels(root.get('height'))
if not width or not height:
    viewbox = re.split(r'[\s,]+', (root.get('viewBox') or '').strip())
    if len(viewbox) != 4:
        raise ValueError('SVG 必须提供尺寸或 viewBox')
    width, height = float(viewbox[2]), float(viewbox[3])
if not 0 < width < 1e7 or not 0 < height < 1e7:
    raise ValueError('SVG 尺寸无效')
scale = min(1.0, 4096 / max(width, height), (16000000 / (width * height)) ** 0.5)
cairosvg.svg2png(bytestring=data, write_to='image.png', output_width=max(1, round(width * scale)), output_height=max(1, round(height * scale)), unsafe=False)
