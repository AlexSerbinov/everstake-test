# Research agent configuration

This folder describes the researcher that answers questions from collected sources. `researcher.yaml` selects its prompt, evidence guidance, and limits on research and repair steps.

The YAML is configuration, not an autonomous service. The [answer module](../src/services/answer/README.md) runs the loop and implements the allowed actions and output checks in code. The listed tools describe that interface; editing the list does not add a tool.

![How the agent configuration reaches the runtime](../docs/images/folder-agent.png)
