[Укр](submission_ukr/PROCESS.md) | [Eng Version](PROCESS.md)

# Part B: how I would automate reporting

## How it works for me

I have already built this kind of system at my company for our developer team. At the end of the working day, I run a skill that puts the report together. Since developers do most tasks through Claude Code or Codex, and our team mostly dictates them through a voice-to-text app, that was the best source for us.

The app converts speech to text and saves timestamped records on the computer. Those records show which tasks I asked for during the day. After a task, Claude Code and Codex also write a changelog entry explaining what they did and when, in terms of the business task. The skill matches these records and builds a report from them. I have not connected a notetaker to this skill yet, but it could be connected to pull in information from calls as well. Or at least Google Calendar could be connected to see how much time was scheduled for each call. I have not got around to that part yet.

Once the report is ready, it goes to a Telegram bot, where I confirm it. Time is also logged automatically in Jira. In the morning, I have a list of tasks for the day, and time is logged against them. If I did something outside that list, the system either creates a new task or logs the time against a suitable broader task, with a description in the worklog. So by the end of the day, my time is logged automatically, and I spend about five minutes on the process.

That makes it easier for developers. Other departments will have their own sources and probably need more manual additions. But there is still plenty we can automate.

## Where to get information for other departments

I see two approaches. The first is to connect to work systems. I would start there. If someone uses Slack and Google Meet, collect the agreed Slack channels and check the call schedule in Google Calendar. If a meeting is scheduled from 13:00 to 13:45, those 45 minutes can be the basis for a worklog. That is the scheduled time, so the person confirms that the call actually lasted that long before it is logged.

A more advanced option is to connect to the notetaker through its API. I saw that you have one. It could provide what was discussed and how long the call lasted, based on the recording timestamps. We need to check which data it exposes.

Take the accounting department. An accountant might use their own CRM or accounting system, which could be difficult to connect to for reporting. I would still try with Claude Code: with an existing API and access, it might well take about 20 minutes to set up. But it depends on the particular system. Each department will have its own set of reporting sources.

The second approach is a local tracker. Even though it is local, I still do not like this option. The tracker takes screenshots every minute or five minutes. The employee’s local agent processes them on their computer and tries to work out what they were doing. The company receives only the report, not the screenshots themselves. Since screenshots can contain personal information, this collection needs to be agreed with the person.

This still does not give the full picture: work happens between screenshots and away from the computer too. But it helps when someone works in Excel or another system that is difficult to connect to. Screenshots can help reconstruct the activity roughly; the time still needs to be checked with the person.

I think combining the two methods would give the best coverage. But employees may have privacy concerns, and we need to discuss those in advance.

But we need to understand this: if the accountant works in a system we have not connected to, no records does not mean no work. That brings us to the next question.

## Fully autonomous or partly manual?

We can run a system that collects data on its own, but mistakes and awkward situations are possible. We do not always want those passed on. Someone might chat at work about digging their garden, and that ends up in the report.

I would not run this fully autonomously without review. I would still leave the decision to a person. But we can encourage people to submit their reports on time.

## How to encourage people to submit reports

If the department submits reports once a week, we keep that schedule. The system can collect data in the background during the week and send the person one draft before the submission deadline. The department head reviews the final department report before publication.

We can set up a loop: a task that runs automatically at a set time. For example, on Friday at 18:30, the system collects the week’s data and sends the person a private draft in Slack or Telegram. They read it, make a few edits and send it. The important thing is that it starts by itself: there is already a draft to check, instead of having to recall the whole week from scratch. That takes a lot of the effort away.

If people still do not submit reports, we could agree in advance to use something like a Slack bot: on the reporting day, the draft arrives at 18:30, and at 19:30 the system sends the report to the manager as it is. First, it checks whether the person has already submitted that week's report in the agreed channel. If they have, nothing is sent again. If the check fails, notify someone about the failure rather than sending blindly.

The system should separate business tasks from personal conversations and remove the bits about digging potatoes. But the model can make mistakes too, so sensitive or disputed items still need a person's confirmation.

## How to tell whether it helps

I would try this in one department for a month and measure three things: total human time spent on the weekly report, including review and edits; the share of supported claims; and the share of important work included. Initial targets would be under 20 minutes instead of an hour, 70–80% supported claims in a sample, and 95% of outcomes and blockers from a list checked by the department head. These are targets to test, not results we already have.

## Downsides

AI systems often produce “soulless” reports. For example, someone finally solves a difficult task, or a salesperson closes a challenging client after lengthy negotiations. The report just says: “Held talks with client X and agreed to work together.” Technically correct, but it loses why the result matters and how much effort went into it. If we want more than time logs and need a meaningful account of the work done, I would still let a person control the content. I have revised this process many times at my company. The system now generates reports automatically, but I still check them because there are sometimes inconsistencies.

## What could break, and where an agent is not needed

For example, Slack access fails, but the report looks complete. Before generation, code checks access, the reporting dates and expected records. If a source is unavailable or there is unusually little data, the system notifies the owner before the deadline, retries collection and blocks automatic sending until the issue is checked. Scheduling, permissions, counts, checking for an already submitted report and delivery are handled by ordinary code: these need clear rules. The agent matches records and writes clearly. A person fills in what the system cannot see and decides what can be sent.
