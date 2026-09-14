# Research assistant inputs

This folder answers four different questions: who performs the research, what guidance it follows, what the model is asked, and which limits and sources apply. These are actual files loaded by the application, as required by assignment §8. They are grouped here to keep the repository root focused on the submission documents.

| Folder | Responsibility | Start here |
|---|---|---|
| [agents](agents/README.md) | Researcher definition and turn limits | [researcher.yaml](agents/researcher.yaml) |
| [skills](skills/README.md) | Reusable evidence-comparison guidance | [evidence.md](skills/evidence.md) |
| [prompts](prompts/README.md) | Instructions for generation and review | [answer.md](prompts/answer.md) |
| [config](config/README.md) | Models, prices, sources, and policy | [models.yaml](config/models.yaml) |

The [answer loop](../src/services/answer/answer-question.ts) loads the researcher definition and combines its prompt with its skills. Code validates actions and evidence independently of those instructions. Editing a tools list cannot give the model a new capability; a new tool requires an action schema, implementation, and tests.

YAML supports `#` comments. Comments explain units, limits, and decisions; environment variables hold credentials. Run commands from the repository root so file paths resolve consistently. Development-assistant instructions are separate, in [.github/AGENTS.md](../.github/AGENTS.md).
