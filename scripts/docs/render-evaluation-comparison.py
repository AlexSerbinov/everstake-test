"""Render measured evaluation and scope comparison using OpenCV, not generated imagery."""
from pathlib import Path
import json
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs/images'
OUT.mkdir(parents=True, exist_ok=True)
def load(name):
    return json.loads((ROOT / 'artifacts/evaluation' / name).read_text())
import runpy
data=runpy.run_path(str(ROOT/'scripts/docs/submission-data.py'))
base, mcp, current, score, passed = [data[k] for k in ['base','mcp','current','score','passed']]
fonts=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
font_path=next(p for p in fonts if Path(p).exists())
def canvas(h):return np.full((h,1600,3),(247,250,248),dtype=np.uint8)
def text(im,x,y,s,size=28):
    pil=Image.fromarray(cv2.cvtColor(im,cv2.COLOR_BGR2RGB));d=ImageDraw.Draw(pil);f=ImageFont.truetype(font_path,size)
    box=d.textbbox((x,y),s,font=f);assert box[2]<1570 and box[3]<im.shape[0]-20,(s,box)
    d.text((x,y),s,font=f,fill='#203a39');im[:]=cv2.cvtColor(np.array(pil),cv2.COLOR_RGB2BGR)
for lang in ['en','uk']:
    def t(en,uk): return uk if lang=='uk' else en
    im=canvas(820)
    text(im,55,35,t('EVERSTAKE / SELECTED EVALUATION','EVERSTAKE / ПОТОЧНЕ ОЦІНЮВАННЯ'),22)
    text(im,55,90,t(f'{passed}/20 (challenging questions)',f'{passed}/20 (складні питання)'),49)
    text(im,55,160,t(f'Average rubric score: {score:.2f}/100','Середня оцінка: '+f'{score:.2f}'.replace('.',',')+'/100'),42)
    text(im,55,240,t('20 questions, including 5 negative cases. Partial credit contributes to the average.','20 питань, із них 5 негативних. Середня оцінка враховує частково правильні відповіді.'),27)
    for label,answers,y in [(t('Our selected answers','Наші поточні відповіді'),current,335),(t('Model + MCP data only','Модель лише з MCP-даними'),mcp['rows'],450)]:
        text(im,55,y,label,27)
        for i,row in enumerate(answers):
            cv2.rectangle(im,(495+i*39,y),(524+i*39,y+43),(182,237,217) if row['verdict']=='pass' else (210,217,244),-1)
        text(im,1330,y-4,f"{sum(r['verdict']=='pass' for r in answers)}/20",42)
    text(im,55,565,t('18 answers retained + 2 rechecked. Original full run: 14/20. Not a new full run.','18 відповідей збережено + 2 перевірено повторно. Початковий прогін: 14/20.'),27)
    text(im,55,615,t('Our answers: 4 failures, including 1 unsupported-fact case. Green: passed; pink: failed.','Це не новий повний прогін. 4 невдачі, зокрема 1 непідтверджене твердження.'),27)
    text(im,55,665,t('MCP: captured tool data only, one answer turn, no corpus or reference answers.','MCP: лише збережені дані інструментів, одна спроба, без нашого корпусу й еталонів.'),27)
    text(im,55,730,t('Post-hoc rubric review, not a blind benchmark. Source: config/evaluation-submission.json','Оцінка за критеріями, не сліпий тест. Джерело: config/evaluation-submission.json'),25)
    name='06-evaluation'+('-uk' if lang=='uk' else '')+'.png'
    cv2.imwrite(str(OUT/name),im)
im=canvas(830)
text(im,55,45,'Our research assistant and Everstake MCP',44)
text(im,55,116,'Different strengths. The question set above favours document research.',27)
for x,title,lines in [(55,'OUR RESEARCH ASSISTANT',['Useful for:','Dated articles and historical changes','Conflicting sources and exact excerpts','Limitations:','Crawling, refresh and model-review costs','Can miss evidence or serve stale facts']), (820,'EVERSTAKE MCP',['Useful for:','Direct operational tools and calculations','No separate web corpus to maintain','Limitations for this question set:','Captured tools lack many article details','No autonomous tool-selection test here'])]:
    cv2.rectangle(im,(x,205),(x+720,660),(226,239,230),-1)
    text(im,x+22,229,title,30)
    for i,line in enumerate(lines):text(im,x+22,310+i*49,line,27)
text(im,55,711,'Observed answer cost: our full run $1.041169; model + MCP data $0.236955.',27)
text(im,55,756,'Costs exclude subscriptions, hosting and any unmeasured MCP service charges.',24)
cv2.imwrite(str(OUT/'09-mcp-tradeoffs.png'),im)
print('Rendered 06-evaluation.png and 09-mcp-tradeoffs.png from saved measurements.')
