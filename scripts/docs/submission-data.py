"""Load the explicitly selected submission evidence; never select the best run."""
import json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
selection = json.loads((ROOT/'assistant/config/evaluation-submission.json').read_text())
def load(name): return json.loads((ROOT/'artifacts/evaluation'/name).read_text())
base=load(selection['baseArtifact']); rechecks=[load(n) for n in selection['recheckArtifacts']]; mcp=load(selection['comparatorArtifact'])
assert base['id']==selection['baseRun'] and base['corpusVersion']==selection['corpusVersion']
latest={r['question']['id']:r for r in base['rows']}
for run in rechecks:
    assert run['id'] in selection['rechecks'] and run['recheckOf']==base['id']
    assert run['corpusVersion']==base['corpusVersion'] and run['questionSetVersion']==selection['questionSetVersion']
    for row in run['rows']:
        assert row['question']==latest[row['question']['id']]['question']
        latest[row['question']['id']]=row
current=list(latest.values())
assert len(current)==20 and [r['question'] for r in current]==[r['question'] for r in mcp['rows']]
passed=sum(r['verdict']=='pass' for r in current)
score=sum(sum(r['qualityScore'][k] for k in ['correctness','completeness','grounding','uncertainty']) for r in current)/len(current)
assert (passed,score)==(16,92.75)
headlines={'en':f'**{passed}/20 (challenging questions), average rubric score {score:.2f}/100.**', 'uk':f'**{passed}/20 (складні питання), середня оцінка {score:.2f}/100.**'.replace('92.75','92,75')}
notes={'en':'18 answers retained and 2 rechecked; not a new full run. Partial credit contributes to the average; 16/20 is the full-pass count. Post-hoc coding-assistant review, not a blind benchmark or probability of correctness.', 'uk':'18 відповідей збережено, 2 перевірено повторно; це не новий повний прогін. Середня оцінка враховує часткові бали, а 16/20 — кількість повністю пройдених питань. Оцінювання виконав coding assistant; це не сліпий тест і не ймовірність правильності.'}
