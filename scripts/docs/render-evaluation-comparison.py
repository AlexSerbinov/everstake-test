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
base, repair, mcp = [load(n) for n in ['agent-cdf52dda.json','agent-82df0052.json','mcp-core-v2.json']]
assert [(r['question']['id'],r['question']['question']) for r in base['rows']] == [(r['question']['id'],r['question']['question']) for r in mcp['rows']]
latest={r['question']['id']:r for r in base['rows']}
latest.update({r['question']['id']:r for r in repair['rows']})
current=[latest[r['question']['id']] for r in base['rows']]
fonts=['/System/Library/Fonts/Supplemental/Arial.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']
font_path=next(p for p in fonts if Path(p).exists())
def canvas(h):return np.full((h,1600,3),(247,250,248),dtype=np.uint8)
def text(im,x,y,s,size=28):
    pil=Image.fromarray(cv2.cvtColor(im,cv2.COLOR_BGR2RGB));d=ImageDraw.Draw(pil);f=ImageFont.truetype(font_path,size)
    box=d.textbbox((x,y),s,font=f);assert box[2]<1570 and box[3]<im.shape[0]-20,(s,box)
    d.text((x,y),s,font=f,fill='#203a39');im[:]=cv2.cvtColor(np.array(pil),cv2.COLOR_RGB2BGR)
im=canvas(900)
text(im,55,35,'EVERSTAKE / MEASURED COMPARISON',22)
text(im,55,86,'Same questions. Different evidence and workflows.',43)
text(im,55,151,'20 questions, including 5 negative cases. Same answer model: Gemini 3.8 Flash.',27)
rows=[('Our agent - full run',base['rows'],250),('Model + MCP data only',mcp['rows'],395),('Our agent - after rechecks',current,540)]
for label,answers,y in rows:
    text(im,55,y,label,29)
    for i,row in enumerate(answers):
        rgb=(182,237,217) if row['verdict']=='pass' else (210,217,244)
        cv2.rectangle(im,(495+i*39,y),(524+i*39,y+43),rgb,-1)
    text(im,1330,y-4,f"{sum(r['verdict']=='pass' for r in answers)}/20",42)
text(im,495,310,'Full run: 6 failures; 1 unsupported-fact case.',25)
text(im,495,455,'6 passes: 1 factual answer and 5 correct refusals.',25)
text(im,495,600,'2 questions rerun; 18 retained. Not a new full run.',25)
text(im,55,702,'MCP supplies data; it does not generate the answers in this test.',30)
text(im,55,752,'Captured MCP responses only. One answer turn; no web corpus or reference answers.',25)
text(im,55,802,'Sources: EVAL.md and saved runs. Post-hoc review, not a blind benchmark.',25)
cv2.imwrite(str(OUT/'06-evaluation.png'),im)
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
