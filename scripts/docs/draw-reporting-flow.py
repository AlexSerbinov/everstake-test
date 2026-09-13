"""Draw reporting diagrams with OpenCV; Pillow provides Unicode text rendering.

Dependencies: opencv-python-headless, numpy, Pillow.
Run from any directory. Output is written to docs/images/.
"""
from pathlib import Path
import os
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
FONT = os.environ.get('DIAGRAM_FONT', '/System/Library/Fonts/Supplemental/Arial.ttf')
BOLD = os.environ.get('DIAGRAM_FONT_BOLD', '/System/Library/Fonts/Supplemental/Arial Bold.ttf')
COPY = {
 'uk': {
  'title': 'Як я б збирав звіт', 'sub': 'Звіт раз на тиждень. У п’ятницю збираємо дані й готуємо чернетку.',
  'sources': [('Jira', 'Час, задачі, зміни'), ('Дзвінки', 'Нотатки, рішення'), ('Slack / Telegram', 'Робочі канали'), ('CRM / пошта', 'Для свого відділу'), ('VoiceInk', 'За згодою людини')],
  'collect': ('18:30 · Збираємо', 'Код перевіряє доступи,', 'дати й повноту даних'),
  'draft': ('Агент пише', 'Зводить повтори, додає', 'результати й посилання'),
  'review': ('Людина читає', 'Править чернетку', 'й відправляє'),
  'fail': ('Даних бракує?', 'Сповіщення + повтор збору.', 'Автовідправлення зупинено.'),
  'auto': ('19:30 · Можна автоматично', 'Лише за попередньою згодою.', 'Чутливе й спірне чекає людини.'),
  'week': ('У п’ятницю · Звіт відділу', 'Керівник звіряє головне й затверджує публікацію.'),
  'foot': 'Код збирає та перевіряє. Агент допомагає написати. Людина вирішує, що надсилати.'
 },
 'en': {
  'title': 'How I would put the report together', 'sub': 'One report per week. On Friday, collect the records and prepare a draft.',
  'sources': [('Jira', 'Time, tasks, changes'), ('Meetings', 'Notes, agreements'), ('Slack / Telegram', 'Work channels'), ('CRM / email', 'Department sources'), ('VoiceInk', 'With consent')],
  'collect': ('18:30 · Collect', 'Code checks access,', 'dates and missing inputs'),
  'draft': ('Agent drafts', 'Groups repeated work,', 'adds outcomes and links'),
  'review': ('Person reviews', 'Edits the draft', 'and sends it'),
  'fail': ('Missing inputs?', 'Notify the owner and retry.', 'Automatic delivery is blocked.'),
  'auto': ('19:30 · Optional auto-send', 'Only with prior agreement.', 'Sensitive or disputed items wait.'),
  'week': ('Friday · Department report', 'The head checks the main points and approves publication.'),
  'foot': 'Code collects and checks. The agent helps write. A person decides what to share.'
 }
}

def draw(lang):
 c=COPY[lang]
 canvas=np.full((1050,1500,3), (250,248,245),dtype=np.uint8)
 labels=[]
 def text(x,y,value,size=24,bold=False,color='#253447'):
  labels.append((x,y,value,size,bold,color))
 def line(a,b,color=(177,157,135),arrow=False):
  if arrow: cv2.arrowedLine(canvas,a,b,color,3,cv2.LINE_AA,tipLength=.13)
  else: cv2.line(canvas,a,b,color,3,cv2.LINE_AA)
 def box(x,y,w,h,lines,fill=(255,255,255),border=(217,208,197)):
  cv2.rectangle(canvas,(x,y),(x+w,y+h),fill,-1)
  cv2.rectangle(canvas,(x,y),(x+w,y+h),border,2,cv2.LINE_AA)
  for i,value in enumerate(lines): text(x+22,y+21+i*35,value,25 if i==0 else 22,i==0)
 text(50,35,c['title'],39,True)
 text(50,93,c['sub'],24)
 for i,source in enumerate(c['sources']):
  x=50+i*286
  box(x,165,256,108,source)
  line((x+128,273),(x+128,315))
 line((178,315),(1322,315))
 line((260,315),(260,378),arrow=True)
 box(50,380,420,155,c['collect'])
 box(540,380,420,155,c['draft'])
 box(1030,380,420,155,c['review'])
 line((470,455),(536,455),arrow=True)
 line((960,455),(1026,455),arrow=True)
 line((260,535),(260,599),color=(106,148,197),arrow=True)
 box(50,602,420,150,c['fail'],fill=(232,242,255),border=(154,184,215))
 line((1240,535),(1240,599),arrow=True)
 text(1258,554,'Якщо не надіслано' if lang=='uk' else 'If not sent',17)
 line((1120,535),(1120,569))
 line((1120,569),(745,569))
 line((745,569),(745,809),arrow=True)
 text(555,586,'Надіслано людиною' if lang=='uk' else 'Sent by the person',19)
 box(1030,602,420,150,c['auto'],fill=(241,248,234))
 line((1240,752),(1240,875))
 line((1240,875),(1107,875),arrow=True)
 box(385,813,720,124,c['week'],fill=(243,239,229),border=(179,164,134))
 text(50,989,c['foot'],23)
 # OpenCV draws every box and connector. Pillow adds Cyrillic glyphs.
 image=Image.fromarray(cv2.cvtColor(canvas,cv2.COLOR_BGR2RGB))
 pen=ImageDraw.Draw(image)
 for x,y,value,size,bold,color in labels:
  font=ImageFont.truetype(BOLD if bold else FONT,size)
  pen.text((x,y),value,font=font,fill=color)
 path=ROOT/'docs/images'/f'reporting-flow-{lang}.png'
 assert cv2.imwrite(str(path), cv2.cvtColor(np.array(image),cv2.COLOR_RGB2BGR))
 print(path)

for language in COPY:
 draw(language)
