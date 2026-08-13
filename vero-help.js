/* Club Vero — in-app help content.
 *
 * GENERATED FILE. Do not edit by hand: run
 *   node docs/help-centre/tools/build-app-help.js
 * after editing docs/help-centre/tools/content.js, which is also what the
 * printed user guide is built from.
 *
 * Edition: August 2026
 */
window.VERO_HELP = {
  "edition": "August 2026",
  "sections": [
    {
      "number": "1",
      "title": "Getting started",
      "intro": "Signing in, finding your way around the five menu groups, and the short management rhythm the product is designed for.",
      "articles": [
        {
          "n": "01",
          "title": "Sign in and understand your access",
          "purpose": "Get into Club Vero and understand why two people at the same club see different screens.",
          "where": "Your club’s Club Vero address",
          "tab": null,
          "images": [
            "01-signin.png"
          ],
          "steps": [
            "Enter your email address and password, then select Sign in.",
            "If this is your first sign-in, or an administrator has reset your password, you are asked to set a new one before the dashboard opens.",
            "Check the role badge in the top right of the dashboard — it names your role and what it gives you, for example General Manager · Full Access.",
            "The role also decides which menu items exist for you. Club Vero has six roles: Super Admin, General Manager, F&B Director, Department Head (read-only), Shift Manager and Golf Shift Manager.",
            "A Shift Manager signs straight into Upload and a Golf Shift Manager straight into Golf, because those are the only screens their role needs.",
            "If something described in this guide is not on your menu, it is almost always the role rather than a fault. Ask whoever administers your club to check it in Setup → Settings → Team members.",
            "Select Sign out at the bottom of the left-hand menu when you have finished on a shared computer."
          ],
          "practice": "Give each person the lowest role that still lets them do their job. Members’ names and contact details are only visible to General Manager and above."
        },
        {
          "n": "02",
          "title": "Find your way around",
          "purpose": "Learn the five menu groups so you can find any screen in one step.",
          "where": "The left-hand menu, on every screen",
          "tab": "overview",
          "images": [
            "02-overview.png"
          ],
          "steps": [
            "Overview holds the screens you read: Overview, Outlets, Trends, Server Performance and Golf.",
            "Intelligence holds what Club Vero has worked out for you: AI Insights, Training Actions and Case Alerts.",
            "People holds your records: Members and Visits.",
            "Communications holds everything about sending and what was sent: Survey Queue, Events, Survey Log and Message Log.",
            "Setup holds configuration and money: Upload, Survey Builder, Reports, SMS Credit and Settings.",
            "Two menu items carry a count when there is something waiting — Case Alerts shows open cases in red, Survey Queue shows how many surveys are queued.",
            "Help & FAQ sits on its own at the bottom of the menu, and every role can open it — including the screens that role cannot otherwise reach.",
            "The ? button beside any screen title explains what that screen is built from, and links to the step-by-step article for it."
          ],
          "practice": "The screen title is not always the menu name. Overview is titled Member Experience, and Survey Queue is titled Survey Queue but its panel is headed Queued surveys — the menu name is the reliable one."
        },
        {
          "n": "03",
          "title": "A daily and weekly rhythm",
          "purpose": "Use Club Vero without adding another reporting burden to the week.",
          "where": "Across Setup, Communications and Intelligence",
          "tab": null,
          "images": [],
          "steps": [
            "Daily: upload the end-of-shift report in Setup → Upload, unless your POS already sends it automatically.",
            "Daily: open Intelligence → Case Alerts, assign each new case to a person, and call the members whose cases are close to their call-back window.",
            "Daily: record the call with Log call, and select Resolve only once the matter is actually finished.",
            "Weekly: read Overview for NPS, response rate and the three indices, then Outlets and Trends for the direction of travel.",
            "Weekly: read Intelligence → AI Insights and work through Intelligence → Training Actions.",
            "Weekly: look at Overview → Server Performance for who to coach and who to recognise, and at People → Members for the Member Health call list.",
            "Monthly or per committee cycle: build the report in Setup → Reports and export it.",
            "Close the weekly review by agreeing what will be recognised, corrected, investigated or simply watched."
          ],
          "practice": "A short consistent routine beats constant checking. Everything on the daily list should take a manager under ten minutes on an ordinary day."
        }
      ]
    },
    {
      "number": "2",
      "title": "Members, visits and surveys",
      "intro": "The records that decide who is eligible for a survey, and the screens that show what was sent and what came back.",
      "articles": [
        {
          "n": "04",
          "title": "Add, import and edit members",
          "purpose": "Keep the membership list that survey eligibility and delivery both depend on.",
          "where": "People → Members",
          "tab": "members",
          "images": [
            "03-members.png"
          ],
          "steps": [
            "To add one person, complete Add a member: member number, first name, last name, phone in E.164 format, email, communication preference and type.",
            "Type is the same vocabulary Visits uses — Member, Visitor / Guest, Commercial or Other. Golf is a valid stored type but is never offered here, because golf records are created by the tee sheet importer.",
            "Tick Opted out of surveys if the person has asked not to be contacted, then select + Add member.",
            "For a whole roster, use Bulk import and drop in the club’s CSV export. The columns are member_id, first_name, last_name, phone_number, email_address, communication_preference and opt_out_flag.",
            "Select Download CSV template → if you need the exact header row to hand to whoever produces the export.",
            "To change a record, search by name or member number, select Edit, make the change and save.",
            "Select the status pill to switch a member between Active and Opted out without opening the record."
          ],
          "practice": "Write phone numbers in international format, for example +16105551234. A number stored any other way may look fine on screen and still fail at the carrier."
        },
        {
          "n": "05",
          "title": "Upload the end-of-shift report",
          "purpose": "Turn the day’s takings into survey opportunities without anyone reviewing a list.",
          "where": "Setup → Upload, or Upload end-of-shift report on the Overview screen",
          "tab": "upload",
          "images": [
            "05-upload.png"
          ],
          "steps": [
            "Open Setup → Upload, or use the Upload end-of-shift report button in the banner at the top of Overview.",
            "Leave POS system on Detect automatically unless the export has had its branding stripped; Club Vero reads NorthStar, Jonas, Lightspeed and Club V1 exports as they come out of the POS.",
            "Leave Outlet on Read from the file when the report covers several outlets, or choose one outlet if the file is for a single room.",
            "Drop the export into the dashed area, or select it to browse. PDF, CSV and Excel are all read by the server.",
            "Read the result. Club Vero applies each outlet’s minimum spend and re-survey window itself, so qualifying visits go into the Survey Queue and everything else is simply filed.",
            "If the parse looks wrong, the diagnostics under the upload area name the outlet, the row count and anything it could not read."
          ],
          "practice": "One file, once a day. Nobody should be reviewing individual visits — that is what the thresholds in Setup → Settings are for."
        },
        {
          "n": "06",
          "title": "Log a visit by hand and read the Visit log",
          "purpose": "Record visits that never reach the POS export, and answer the question “why did this member not get a survey?”",
          "where": "People → Visits",
          "tab": "visits",
          "images": [
            "06-visits.png"
          ],
          "steps": [
            "In Add a visit, choose the visitor type: Member, Visitor / Guest, Commercial or Other.",
            "For a member, start typing the member number or name and pick them from the lookup — this attaches the visit to the right record rather than creating a loose one.",
            "For anyone else, enter the name and either a phone number or an email address.",
            "Choose the outlet, the visit date and the spend amount, and the server if you know who it was.",
            "Select + Add visit.",
            "Use Visit log underneath to check any visit. Qualifies says whether it met the outlet threshold and the re-survey rule; Survey says whether a survey has gone out.",
            "Use the filter tabs — All, Members, Visitors, Commercial, Golf, Other — to narrow the log.",
            "Where a visit qualifies and nothing has been sent, Send survey appears on the row."
          ],
          "practice": "Start here when someone asks why a survey did or did not go out. The Visit log answers it in one line, before you open the Survey Queue or the Message Log."
        },
        {
          "n": "07",
          "title": "Work the Survey Queue",
          "purpose": "See who is due to receive a survey, when it will send, and why anything is stuck.",
          "where": "Communications → Survey Queue",
          "tab": "queue",
          "images": [
            "07-queue.png"
          ],
          "steps": [
            "Read the banner first. It says how many surveys will send, at what time, and how the batch splits between SMS and email.",
            "Check the by-outlet line underneath for where today’s volume is coming from.",
            "Work down the table: date, name, outlet, spend, channel and the number or address the survey will go to.",
            "Blocked rows are shaded and carry the reason in place of the recipient — opted out, no phone or email, or a member number not on your list.",
            "Send now on a row sends that one survey immediately. Remove takes the row out of the queue but keeps the visit for reporting.",
            "Send all now sends the whole ready batch immediately rather than waiting for the scheduled time. Use it deliberately.",
            "Why hasn’t anything sent? runs a check across eligibility, contact details, provider configuration, send time and SMS credit, and tells you which one is the problem.",
            "Clear unsendable removes every blocked row at once — useful after a membership import has fixed the underlying records."
          ],
          "practice": "Manual sending should be the exception. The queue exists so you can see the automation working, not so you can drive it by hand."
        },
        {
          "n": "08",
          "title": "Check the Survey Log",
          "purpose": "Confirm what was asked, what came back, and chase what did not.",
          "where": "Communications → Survey Log",
          "tab": "surveylog",
          "images": [
            "08-surveylog.png"
          ],
          "steps": [
            "Use the filter tabs to move between All, Awaiting reply and Answered.",
            "Each row shows the date, member, outlet, channel, status, NPS and overall score.",
            "Status has three states: Not sent yet, Sent — awaiting reply, and Answered. They mean different things and are worth reading carefully.",
            "Select the arrow on an answered row to expand it. The answers are labelled with the questions that member actually received, so a golf response reads as pace of play rather than food quality.",
            "Resend appears on anything sent but unanswered.",
            "Open shows the survey exactly as the member sees it.",
            "+ Send survey manually, at the top of the screen, sends a one-off survey to a member or a guest — choose the recipient, the outlet, the channel and which survey they should receive."
          ],
          "practice": "The Survey Log tells you about the survey. If a survey looks like it never arrived, the Message Log tells you about the delivery attempt."
        },
        {
          "n": "09",
          "title": "Check the Message Log",
          "purpose": "See every message Club Vero has actually sent, and what happened to it.",
          "where": "Communications → Message Log",
          "tab": "messagelog",
          "images": [
            "09-messagelog.png"
          ],
          "steps": [
            "Filter by All, SMS, Email or Failed.",
            "Each row shows the date and time, the member, the channel, the exact number or address used, the status, and the message body.",
            "Failed rows are the ones to act on — usually a wrong number format, a dead mailbox, or SMS credit having run out.",
            "Hover a body to read the full message text.",
            "Use the Message Log and the Survey Log together: one says whether the message went, the other whether the survey was answered."
          ],
          "practice": "A failure here is a data problem far more often than a system problem. Fix the member record, and the next send picks them up."
        }
      ]
    },
    {
      "number": "3",
      "title": "Intelligence and action",
      "intro": "What Club Vero does with the feedback once it arrives: service recovery, coaching, and early warning on members.",
      "articles": [
        {
          "n": "10",
          "title": "Respond to Case Alerts",
          "purpose": "Recover a member who has had a poor visit, and record what was done about it.",
          "where": "Intelligence → Case Alerts",
          "tab": "alerts",
          "images": [
            "10-alerts.png"
          ],
          "steps": [
            "Read the four figures at the top: how often members are called back inside the window, the median time to that call, how many rated the club higher afterwards, and how many are still waiting.",
            "The bars underneath show the last 30 days of alerts by severity, and how many of each are still open.",
            "Filter the list with All, Awaiting call-back, Open, Assigned or Resolved.",
            "Each case shows the member, the outlet, the severity, the scores, the member’s own words, and a countdown chip such as 3h left to call.",
            "Use the Assign to… dropdown to give the case an owner. Where an outlet has an owner set in Settings, new cases are assigned and emailed to that person automatically.",
            "Call the member. Then select Log call and record the channel, how the member sounded and any notes.",
            "AI Suggest drafts a response you can use as a starting point for the conversation.",
            "When the matter is genuinely finished, select Resolve and record the root cause, the action taken, any goodwill given and a note. That summary then sits on the case for anyone reading it later."
          ],
          "practice": "Logging a call records what happened inside Club Vero. It does not send anything to the member — the call is still yours to make."
        },
        {
          "n": "11",
          "title": "Read AI Insights",
          "purpose": "See the themes running through the week’s comments instead of reading every one.",
          "where": "Intelligence → AI Insights",
          "tab": "insights",
          "images": [
            "11-insights.png"
          ],
          "steps": [
            "Read the Weekly AI narrative at the top — one line per outlet, summarising what the week’s comments actually said.",
            "Work down the theme clusters. Each outlet panel is marked Critical, Watch or Maintain, and says how many responses it is based on.",
            "Each theme carries its sentiment, whether it is rising, stable or falling, how many members mentioned it, and one representative quote.",
            "A rising negative theme with a handful of mentions is the thing to act on; a stable positive one is what to protect.",
            "The analysis runs weekly on the day and time set in Setup → Settings. Generate now runs it immediately when you need it before that."
          ],
          "practice": "Always read the quote under a theme before acting on it. The cluster tells you what is being said; only the quote tells you what it means."
        },
        {
          "n": "12",
          "title": "Work Training Actions",
          "purpose": "Turn the week’s feedback into a short list of things the team will actually do.",
          "where": "Intelligence → Training Actions",
          "tab": "training",
          "images": [
            "12-training.png"
          ],
          "steps": [
            "Each plan names its outlet and says what it was built from — for example 38 responses, 9 of them mentioning the gap between courses.",
            "Steps are tagged Immediate, This week or Ongoing.",
            "Every plan names who is responsible for it. Choose a name from the dropdown and that person is emailed the outstanding steps straight away.",
            "An outlet that already nominates an owner for its case alerts has its plans assigned to them automatically. Anything else arrives marked Nobody yet.",
            "The Unassigned filter shows the plans nobody has picked up; Mine shows your own.",
            "Tick a step as the team completes it. The count in the plan header updates.",
            "Plans are written by the weekly analysis. An outlet with no responses that week gets no plan rather than an empty one.",
            "Remove plan clears a plan that has been overtaken or completed in full."
          ],
          "practice": "Four steps that get done beat twelve that do not. Check the Unassigned filter on a Friday: a plan belonging to nobody is the one everybody assumes somebody else is working."
        },
        {
          "n": "13",
          "title": "Coach with Server Performance",
          "purpose": "Use what members said and what the team said about the same shifts.",
          "where": "Overview → Server Performance",
          "tab": "staff",
          "images": [
            "13-staff.png"
          ],
          "steps": [
            "Choose the month at the top right of Server leaderboard.",
            "Read the composite score, which is NPS 30% + Overall 30% + Food 20% + Service 20%, and the survey count beside each name — a high score on six surveys is not yet a finding.",
            "Read Staff shift feedback underneath: how the shift went overall, whether the server felt supported, whether the workload was manageable and whether they had what they needed.",
            "Look for the places where the two move together. A room whose service scores dip in the same week its team reports an unmanageable workload is a staffing question, not a performance one.",
            "Select Generate analysis to produce the month’s actions. They come back in two lists — Needs improvement and Top performers.",
            "Assign an action to a manager and mark it complete when it has been done."
          ],
          "practice": "Use this as a coaching and recognition tool. It measures a period of service, not a person, and it should never be the only evidence in a formal conversation."
        },
        {
          "n": "14",
          "title": "Use Member Health",
          "purpose": "Find the members who have quietly stopped coming, before they resign.",
          "where": "People → Members (the panel above the member list)",
          "tab": "members",
          "images": [
            "04-member-health.png"
          ],
          "steps": [
            "Choose the window at the top right of the Member health panel.",
            "Read the four figures: Lapsed, At risk, Slipping, and the annualised revenue those first two represent.",
            "Every member is measured against their own rhythm, then adjusted for how the whole club moved over the same weeks — so a quiet August does not turn the list into noise.",
            "Work down Worth a call, in order. It is ranked by what the member is worth, not by how steep the drop looks.",
            "Each row shows how often they used to come, how often they come now, how long since their last visit, and how to reach them. A member who has opted out is marked, because a survey is not the way to reach them.",
            "Read the line under the list. It says how many members had enough history to score, how many were too new to judge, and whether a seasonal adjustment was applied."
          ],
          "practice": "This is a prompt for a conversation, not a conclusion. Check the member’s recent visits and any open case before you pick up the phone."
        },
        {
          "n": "15",
          "title": "Watch Outlets and Trends",
          "purpose": "Separate a bad week from a real movement.",
          "where": "Overview → Outlets and Overview → Trends",
          "tab": "trends",
          "images": [
            "24-trends.png",
            "25-outlets.png"
          ],
          "steps": [
            "Overview → Outlets scores each room over the current period and marks it Maintain, Watch, Critical or New.",
            "A room marked New has no scored responses yet — that is a coverage problem, not a service one.",
            "Overview → Trends charts CSAT, Food, Service and NPS month on month.",
            "Use the dropdown to switch between the property average and a single outlet.",
            "Each card leads with the latest figure and the change since the start of the window, so a flat month reads as flat.",
            "Select Show data under any chart to read the underlying numbers as a table."
          ],
          "practice": "Look at a trend before reacting to a score. One weak week in a rising line is usually one weak week."
        }
      ]
    },
    {
      "number": "4",
      "title": "Golf and events",
      "intro": "Post-round golf feedback, the crossover between golf and dining, and feedback from club functions.",
      "articles": [
        {
          "n": "16",
          "title": "Run golf surveys from the tee sheet",
          "purpose": "Measure the golf experience after play, from the sheet you already produce.",
          "where": "Overview → Golf",
          "tab": "golf",
          "images": [
            "14-golf.png",
            "16-teesheet.png"
          ],
          "steps": [
            "Read the top panel for Golf NPS, surveys sent, response rate and responses over the last 30 days.",
            "Average scores breaks the round into course conditions, pace of play, and pro shop and staff, each out of five.",
            "Recent responses shows the latest rounds with the member’s own comment.",
            "Scroll to Upload tee sheet and drop in the day’s sheet as PDF, CSV or Excel. Club Vero pulls out member numbers and names and detects the date itself.",
            "Use Override date only when the sheet’s own date is wrong or missing.",
            "Golf survey log shows who was sent a golf survey, whether it is completed or pending, and the three scores where they answered.",
            "Golf survey questions, at the bottom, is where the post-round questions are edited. Changes apply to future golf surveys, not to ones already sent."
          ],
          "practice": "Keep the core golf questions stable. Every time the wording changes, the trend before and after it stops being comparable."
        },
        {
          "n": "17",
          "title": "Use Golf & dining crossover",
          "purpose": "See how much golf converts into food and beverage, and where it stops.",
          "where": "Overview → Golf (the Golf & dining crossover panel)",
          "tab": "golf",
          "images": [
            "15-crossover.png"
          ],
          "steps": [
            "Choose the period at the top right of the panel.",
            "Golfers who dined is the headline: how many rounds were followed by food or drink at the club.",
            "A golfer’s spend compares what a golfer spends in the dining room against a member who did not play that day.",
            "Left on the table values the golf-only days at what the club already achieves when a golfer stays. It is an estimate and is labelled as one.",
            "Stayed to eat, by day shows which day of the week loses golfers between the eighteenth and the dining room.",
            "Where golfers eat shows which room they choose when they do stay.",
            "The list at the bottom names members who play regularly and never stay — the useful list to hand to the F&B team.",
            "The panel counts members only. A guest without a member number cannot be matched between the round and the meal, so counting them would invent crossover that did not happen."
          ],
          "practice": "A member who golfs and dines on the same day now receives one survey, alternating between golf and dining. This panel is the only place the full picture of that day is visible."
        },
        {
          "n": "18",
          "title": "Create an event and survey attendees",
          "purpose": "Collect feedback on a function without distorting the outlet scores.",
          "where": "Communications → Events",
          "tab": "events",
          "images": [
            "17-events.png"
          ],
          "steps": [
            "Read Events scorecard first — events carry their own NPS and CSAT, and golf events are scored apart from everything else.",
            "Select + New event and enter the name, the date, an optional description, the type (Event or Golf event) and which questions to ask.",
            "Select Create, then open the event.",
            "Add attendees by pasting member numbers, by uploading a CSV with a member_id column, or by adding guests individually with their name and contact details.",
            "Check the attendee list, then select Send surveys to all.",
            "The event page then tracks attendees, surveys sent, responses, NPS and CSAT.",
            "Select Analyse feedback to generate a written summary of what worked and what should change next time."
          ],
          "practice": "Event scores never move CHI, SSI or OHI. A wet marquee on one Saturday does not drag down the dining room’s operational health."
        }
      ]
    },
    {
      "number": "5",
      "title": "Setup and administration",
      "intro": "The configuration that decides who gets surveyed, what they are asked, who answers for it, and what it costs.",
      "articles": [
        {
          "n": "19",
          "title": "Build and maintain survey templates",
          "purpose": "Control what members are asked, without breaking the benchmarked indices.",
          "where": "Setup → Survey Builder",
          "tab": "builder",
          "images": [
            "18-builder.png"
          ],
          "steps": [
            "Each template is one of four types: Food & Bev, Golf, Events or Staff shift.",
            "Select + New template, name it, choose the type, and add the questions.",
            "Each question has a type — NPS 0–10, Stars 1–5, or free text — and can be required or optional.",
            "Only questions tagged to CHI, SSI or OHI move those indices. Anything else is marked not benchmarked: the answers are collected and reported, but the indices are unaffected.",
            "Select Preview to see the survey exactly as the member receives it.",
            "Edit changes the questions for future sends. Surveys already sent keep the questions they were sent with, which is why the Survey Log can label old answers correctly.",
            "A template is attached to an outlet in Setup → Settings, or left on the default for the visit type."
          ],
          "practice": "Add questions freely; change the benchmarked ones rarely. The index is only comparable over time if the questions behind it hold still."
        },
        {
          "n": "20",
          "title": "Configure the club, outlets and survey timing",
          "purpose": "Set the rules that decide who qualifies, who is told, and when anything sends.",
          "where": "Setup → Settings",
          "tab": "settings",
          "images": [
            "19-settings.png",
            "20-settings-timing.png"
          ],
          "steps": [
            "Check Club profile: club name, time zone and currency.",
            "For each outlet set the name, the minimum spend that qualifies for a survey, and how many days must pass before that member can be re-surveyed at that outlet.",
            "Leave Survey questions on Default for visit type for ordinary dining, or attach a template where a room needs its own.",
            "Set Alerts go to so a poor response from that outlet is assigned and emailed to the right manager straight away. Left on Nobody, the managers are notified instead. Outlet changes save as you leave the field.",
            "Under Survey delivery, set the time surveys go out. Nothing is ever sent between 8pm and 8am. Changing the time takes effect immediately — if the new time has already passed today, that batch goes within a minute.",
            "Under Weekly analysis, set the day and time AI Insights and Training Actions are written. Run now produces them on demand.",
            "Under How often one member can be surveyed, set the club-wide cap — at most so many surveys per member every so many days. Several cheques at the same outlet on the same day already count as one visit; this caps a member who used different outlets, and the highest-spend visit is the one surveyed.",
            "Under Staff shift surveys, switch the team’s own end-of-shift survey on or off and set its send time. Nothing sends between 11pm and 11am. Send now triggers it immediately."
          ],
          "practice": "These settings shape the data itself. Change them deliberately and note when you did — a threshold changed mid-quarter will show up as a trend that never happened."
        },
        {
          "n": "21",
          "title": "Manage team members, servers and logins",
          "purpose": "Keep dashboard access, alert ownership and the front-line roster correct.",
          "where": "Setup → Settings (Team members, Servers and User accounts)",
          "tab": "settings",
          "images": [
            "21-settings-team.png"
          ],
          "steps": [
            "Team members are the people who can be assigned a case alert and can sign in. Each one holds a role, which decides what they see.",
            "Servers are the people credited with cheques on a visit. They appear in the Server dropdown when a visit is logged, and they are who receives a shift survey.",
            "They are two different lists, and someone who does both belongs on both. A General Manager who never works the floor belongs only on Team members.",
            "Use Add a person and choose which list to add to.",
            "A server needs a phone number or an email address to be reachable. Anyone without either is still credited with their sales but is marked Unreachable and cannot be sent a shift survey. Phone and email are editable in place.",
            "Names credited with sales that have no server record are listed separately, so they can be added rather than quietly scored and never contacted.",
            "Use Upload a roster to add many people at once, pasted or as a CSV.",
            "Importing someone does not create a dashboard login. Use User accounts → Create login for that, one person at a time."
          ],
          "practice": "Check the Servers list after any POS change. A renamed server in the POS becomes an unmatched name here, and their scores stop accumulating against the right person."
        },
        {
          "n": "22",
          "title": "Keep SMS credit topped up",
          "purpose": "Stop text delivery from pausing because the balance reached zero.",
          "where": "Setup → SMS Credit",
          "tab": "billing",
          "images": [
            "22-billing.png"
          ],
          "steps": [
            "Read the balance, roughly how many more messages it buys, and whether automatic top-up is on.",
            "To top up now, choose $25, $50, $100 or $250 — or type another amount — then select Continue to payment. Payment is taken by Stripe on their own page; card details never reach the dashboard or the club’s server.",
            "Tick Save this card for automatic top-ups if you want the same card used automatically in future.",
            "Under Automatic top-up, set the balance that triggers a charge, how much to charge, and the level at which you want a warning. Tick Top up automatically and save.",
            "Payments lists every top-up, refund and adjustment with the balance after it.",
            "The daily spend chart and the table underneath show where the credit went, by day and by message type."
          ],
          "practice": "If credit runs out, text sending pauses — nothing is lost. Anyone who could not be reached is picked up by the next send once credit is restored. Email is unaffected."
        },
        {
          "n": "23",
          "title": "Produce the period report",
          "purpose": "Give the board or committee the same numbers the dashboard shows, in one document.",
          "where": "Setup → Reports",
          "tab": "reports",
          "images": [
            "23-reports.png"
          ],
          "steps": [
            "Choose the period: last 30 days, last quarter, last 6 months or last 12 months.",
            "Read the headline figures, each with its change against the previous period of the same length.",
            "Club indices gives CHI, SSI and OHI for the period.",
            "Month on month charts NPS across the period; By outlet gives response volume per room.",
            "The tables underneath rank servers and summarise case alerts raised, resolved and still open by severity.",
            "Check the figures on screen, then export: Excel for further analysis, PDF for a fixed management report.",
            "Anything with no data in the period is named under the period line rather than shown as a zero."
          ],
          "practice": "Send the report with a short note on what was done about it. A score without an action reads as a scoreboard; a score with an action reads as management."
        }
      ]
    }
  ],
  "faq": [
    {
      "question": "A member did not receive a survey",
      "answer": "People → Visits to confirm the visit qualified, then Communications → Survey Queue for a blocked reason, then Communications → Message Log for the delivery attempt. Why hasn’t anything sent? on the queue checks all of it at once."
    },
    {
      "question": "Nothing at all is sending",
      "answer": "Communications → Survey Queue → Why hasn’t anything sent?. It checks contact details, provider configuration, send time and SMS credit and names the one that is failing."
    },
    {
      "question": "A survey was sent but no response is showing",
      "answer": "Communications → Survey Log for the status, and Communications → Message Log for whether the message itself was delivered or failed."
    },
    {
      "question": "A poor score needs following up",
      "answer": "Intelligence → Case Alerts. Assign an owner, call the member, Log call, then Resolve once the action is complete."
    },
    {
      "question": "Case alerts are going to the wrong person",
      "answer": "Setup → Settings → Outlets, and set Alerts go to for that outlet."
    },
    {
      "question": "Golf surveys are not appearing",
      "answer": "Overview → Golf. Check the tee sheet upload read the member numbers and the date, then check the Golf survey log."
    },
    {
      "question": "A server is not receiving shift surveys",
      "answer": "Setup → Settings. Confirm Staff shift surveys is On, and that the server has a phone number or email — anyone without either shows as Unreachable."
    },
    {
      "question": "A server’s name is not on the leaderboard",
      "answer": "Setup → Settings → Servers. Names credited with sales but with no server record are listed there and can be added in one click."
    },
    {
      "question": "Someone cannot see a screen described here",
      "answer": "Setup → Settings → Team members, and check their role. Members, Survey Builder, Settings and SMS Credit are restricted below General Manager."
    },
    {
      "question": "SMS surveys have stopped",
      "answer": "Setup → SMS Credit. Check the balance and whether automatic top-up is switched on."
    },
    {
      "question": "A number in a report does not match the dashboard",
      "answer": "Check the period. The report is computed once on the server for the period chosen, and the dashboard defaults to the last 7 days."
    }
  ]
};
