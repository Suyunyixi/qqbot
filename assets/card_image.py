"""Render a structured text card using Pillow and the bundled CJK font."""
import json
from PIL import Image, ImageDraw, ImageFont

with open('card.json', encoding='utf-8') as source:
    data = json.load(source)
items = data['items'][:10]
width = 1080
height = min(2400, 290 + 150 * len(items))
image = Image.new('RGB', (width, height), '#eef2f8')
draw = ImageDraw.Draw(image)
font_path = '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'
title_font = ImageFont.truetype(font_path, 54)
subtitle_font = ImageFont.truetype(font_path, 27)
item_font = ImageFont.truetype(font_path, 32)
description_font = ImageFont.truetype(font_path, 24)
number_font = ImageFont.truetype(font_path, 30)

def fit(value, font, max_width):
    text = str(value).replace('\n', ' ').strip()
    while text and draw.textlength(text, font=font) > max_width:
        text = text[:-1]
    return text + ('…' if len(text) < len(str(value).strip()) else '')

draw.rounded_rectangle((30, 30, width - 30, height - 30), radius=32, fill='white')
draw.rectangle((70, 74, 79, 138), fill='#596ef2')
draw.text((103, 65), fit(data['title'], title_font, 850), font=title_font, fill='#17223d')
draw.text((104, 150), fit(data.get('subtitle', ''), subtitle_font, 850), font=subtitle_font, fill='#68768e')
for index, item in enumerate(items):
    y = 225 + index * 150
    draw.rounded_rectangle((72, y, 1008, y + 126), radius=18, fill='#f5f7fc')
    draw.text((100, y + 36), str(index + 1).zfill(2), font=number_font, fill='#6679e8')
    draw.text((175, y + 22), fit(item['title'], item_font, 790), font=item_font, fill='#23304a')
    draw.text((175, y + 73), fit(item.get('description', ''), description_font, 790), font=description_font, fill='#718098')
image.save('card.png', 'PNG', optimize=True)
