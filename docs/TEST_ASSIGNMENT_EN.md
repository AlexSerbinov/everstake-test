# **TEST ASSIGNMENT**

## **AI Automation & Agentic Systems Lead**

**Everstake\
Version:** 1.0\
**September 2026**

## **1. Context**

Everstake has years of accumulated company knowledge: the blog, documentation, repositories, AMA recordings, press releases, and social media posts.

Some of this information contradicts itself, some is outdated, and some exists in multiple copies across different domains.

The same challenge — only on a larger scale — exists within our internal knowledge: meeting recordings, Slack channels, and department-specific spreadsheets.

This assignment is **not designed to test whether you can simply build a RAG pipeline**.

We want to understand:

- how you handle dirty and inconsistent data;

- how you measure the quality of your own system;

- how you make architectural and product decisions;

- how you react when requirements change during delivery.

This assignment uses **public data only**. You will not receive any confidential information, and you should not attempt to find or use any.

## **2. Scope and Time**

**Expected effort:** 6–8 hours\
**Completion window:** 5 calendar days

If you realise that you cannot complete everything within the expected timeframe, **do not extend the scope or working time unnecessarily**.

Instead, deliberately reduce the scope and explain in your report:

- what you decided not to complete;

- why you made that decision;

- what you would prioritise next.

**“Incomplete but honestly measured” is better than “everything completed, but nobody knows how well it works.”**

# **PART A. KNOWLEDGE ASSISTANT OVER A PUBLIC CORPUS**

## **3. What We’re Building**

Build a system that answers questions about Everstake using **a corpus of public sources that you assemble**, rather than relying on the model’s own knowledge.

The system should support two modes.

### **3.1. Factual Lookup**

Examples:

- “How many networks does Everstake support?”

- “Who is the CEO?”

- “What certifications does the company hold?”

Each answer must include:

- the requested value or fact;

- the date as of which the information is current;

- a link to the specific source.

### **3.2. Synthesis**

Examples:

- “How has the company’s positioning shifted over the last two years?”

- “Which products appeared after 2025?”

The answer must use **multiple sources** and demonstrate the development or trajectory over time rather than presenting a single data point.

## **4. The Corpus**

Attached is **corpus_sources.csv**, containing a seed list of approximately **60 verified URLs**, including:

- company website;

- blog content across two domains;

- documentation;

- GitHub;

- Medium;

- press releases;

- third-party mentions;

- video content.

This list is **a starting point only**.

You are expected to:

- expand the corpus through crawling while respecting robots.txt;

- decide which sources should be included or excluded;

- explain and justify those decisions;

- grow the corpus to **at least 200 documents**.

### **Video Content**

YouTube/video content should be treated as a separate category.

Including it is your decision, but you should explain your reasoning, particularly considering the trade-off between:

**transcription cost vs. value of the information contained in the video.**

## **5. Core Requirements**

### **5.1. Recency and Source Authority**

The corpus contains facts that have changed over time, as well as facts repeated across multiple near-identical sources.

Your system must return the **current answer**.

It should not simply return:

- whichever document ranks highest by similarity;

- whichever answer appears in the largest number of documents.

Explain in your report how your system determines **recency and source authority**.

### **5.2. Deduplication**

The same material may appear at **2–4 different URLs**.

Identify duplicate or near-duplicate content and report:

- how many duplicates you found;

- how you identified them;

- how your system handles them.

### **5.3. An Honest “I Don’t Know”**

If the corpus does not contain enough information to answer a question, the system must clearly state that **no reliable answer was found**.

It must **not use the model’s own knowledge to fill the gap**.

### **5.4. Instructions Embedded Inside Documents**

Some pages in the corpus contain text addressed directly to AI assistants, including explicit instructions about what an AI should or should not say.

Your system must handle this appropriately.

Explain:

- how your architecture identifies or handles such instructions;

- why you selected this approach.

This is an **architectural requirement**, not merely a prompt-formatting issue.

### **5.5. Evaluation Set**

Create an evaluation set containing **20 questions with reference answers**.

At least **5 questions must be negative cases**, meaning that the answer does not exist in the corpus.

Run your system against all 20 questions and submit the following information for each:

**Question \| Reference Answer \| System Answer \| Verdict**

Report:

- overall accuracy;

- number of successful answers;

- number of failed answers;

- separately, the **number of cases where the system invented a fact**.

### **5.6. Actual Cost**

Provide **measured costs, not estimates**, for the implemented system.

Report:

- number of tokens used to build the index;

- actual cost of building the index;

- cost of one query.

Then extrapolate the expected cost for a corpus **50× larger** and show the arithmetic behind your calculation.

### **5.7. Baseline Comparison**

Everstake operates its own MCP server:

github.com/everstake/mcp

It provides company information from static text.

In one paragraph, explain:

- where your system performs better than the existing MCP server;

- where it performs worse.

An honest conclusion such as:

**“For this class of questions, the MCP server performs better.”**

will be considered a positive signal rather than a weakness.

## **6. Technology Stack**

You may use any technology stack.

For example:

- Python;

- TypeScript;

- cloud infrastructure;

- local infrastructure;

- any appropriate AI/LLM tooling.

The only requirement is that **we must either be able to run the system ourselves or see it running on your screen during the defence session**.

# **PART B. PROCESS REDESIGN**

## **7. Task**

**Expected effort:** approximately 1 hour\
**Format:** one page of prose\
**No code is required or expected.**

### **The Process**

Consider the current **weekly department reporting process**.

Today, a department head manually collects information from:

- the task tracker;

- Slack;

- their own meetings;

and then manually prepares a weekly report.

This process takes approximately **one hour per person per week**.

Describe how you would redesign this process.

Your response should cover the following areas.

### **As-Is → To-Be**

Explain:

- where exactly manual work disappears;

- which parts become automated;

- where a human deliberately remains involved and why.

### **Success Metrics**

Define **2–3 measurable metrics** that would demonstrate whether the redesigned process is successful.

Avoid subjective measures such as:

> “It feels smoother.”

### **Failure Mode**

Describe:

- what could break;

- how the system would detect the problem **before a user reports it**;

- what should happen after the failure is detected.

### **What Should NOT Be an Agent**

Identify elements of this process that **should not be implemented as an AI agent** and explain why.

# **8. What to Submit**

Please submit the following:

**1. Repository**

The repository should contain:

- source code;

- README with clear instructions for running the system;

- agents;

- skills;

- prompts.

Agents, skills, and prompts should be provided as **actual files**, rather than only described in prose.

**2. EVAL.md**

Include:

- the 20-question evaluation table;

- evaluation metrics;

- an honest breakdown of failures.

**3. REPORT.md**

Approximately **2–3 pages** covering:

- architecture;

- key technical/product decisions;

- why those decisions were made;

- actual costs;

- what you deliberately cut because of the time constraint;

- what you would do differently if you had one month.

**4. PROCESS.md**

Your response to **Part B — Process Redesign**.

**5. Working History**

Provide a **Git log with real timestamps**.

We are interested not only in the final result, but also in **how you got there**.

# **9. Defence Session**

The defence session will take place via **video call with screen sharing**.

**Participation is mandatory. Without the defence session, the assignment will not be graded.**

| **Block** | **What Happens** |
|----|----|
| **Walkthrough** | Demonstrate the system and explain your architectural decisions. |
| **Requirement Change** | We provide a new constraint, and you modify the system **live during the session**. |
| **Blind Questions** | We ask questions to your system that you have not seen in advance. |
| **Process Discovery** | A department head describes their working week. Through questions, you identify the underlying process and propose what should be automated first and why. |

The **Process Discovery** block is not a formality.

A significant part of this role involves entering different departments, understanding how people actually work, and identifying automation opportunities **that nobody explicitly asked you to find**.

# **10. Use of AI**

You may use **any AI tools you consider appropriate**.

This is a role focused on AI, so using AI during the assignment is expected.

There is one important condition:

> **You must be able to explain and modify any line of what you submit.**

We will verify this during the live defence session.

Code that you cannot understand, explain, or modify in response to a new requirement will be considered a **failed section**.

# **11. Evaluation Criteria**

| **Criterion** | **Weight** |
|----|----|
| Answer quality on the difficult parts of the corpus | **25%** |
| Measurement discipline: evaluation, honest metrics, acknowledged failures | **20%** |
| Behaviour under a live requirement change | **20%** |
| Judgement: agent vs. code vs. human | **15%** |
| Handling of in-document instructions and data access | **10%** |
| Part B and Process Discovery | **10%** |
| **Total** | **100%** |

## **Automatic Fail Criteria**

Regardless of the total score, the assignment will not pass if:

- there is **no evaluation with measurable results**;

- the candidate is **unable to modify/rework the system live** when presented with a new requirement.

## **What Would Impress Us Most**

> **You identify a meaningful problem in the corpus that this assignment never explicitly mentioned — and explain it to us.**

# **12. Questions**

You are welcome to ask questions **at any point during the assignment**.

Clarifying questions are normal and **carry no penalty**.
