/* Local demo backend for screenshotting the real Club Vero dashboard UI.
   Serves the repo's static files and answers the dashboard's /api calls with
   representative demo data. Nothing here ships — it exists only so the help
   guide's screenshots show the real interface with plausible content. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PORT = 8900;

const OUTLETS = [
  { outlet_id: 'o1', name: 'Belmont Dining Room', min_spend_threshold: 75, frequency_limit_days: 30, template_id: null, owner_staff_id: 's2', active: true },
  { outlet_id: 'o2', name: 'Golf Patio', min_spend_threshold: 15, frequency_limit_days: 30, template_id: null, owner_staff_id: 's3', active: true },
  { outlet_id: 'o3', name: 'Belmont Poolside', min_spend_threshold: 20, frequency_limit_days: 30, template_id: null, owner_staff_id: null, active: true },
];

const STAFF = [
  { staff_id: 's1', name: 'Margaret Ellery', email: 'm.ellery@aronimink.org', role: 'general_manager', active: true },
  { staff_id: 's2', name: 'Daniel Okafor', email: 'd.okafor@aronimink.org', role: 'fb_director', active: true },
  { staff_id: 's3', name: 'Priya Raman', email: 'p.raman@aronimink.org', role: 'dept_head', active: true },
  { staff_id: 's4', name: 'Tom Whitfield', email: 't.whitfield@aronimink.org', role: 'shift_manager', active: true },
];

const SERVERS = [
  { server_id: 'v1', name: 'Jessica McGarrey', phone: '+16105550118', email: '', active: true },
  { server_id: 'v2', name: 'Andre Castillo', phone: '+16105550142', email: '', active: true },
  { server_id: 'v3', name: 'Nora Bennett', phone: '', email: 'n.bennett@aronimink.org', active: true },
  { server_id: 'v4', name: 'Liam Petrosyan', phone: '', email: '', active: true },
];

const MEMBERS = [
  ['A1042', 'Charles', 'Rutherford', '+16105550101', 'c.rutherford@example.com', 'sms', false, 'member'],
  ['A1088', 'Eleanor', 'Vance', '+16105550119', 'e.vance@example.com', 'email', false, 'member'],
  ['A1123', 'Marcus', 'Ainsworth', '+16105550164', '', 'sms', false, 'member'],
  ['A1190', 'Diane', 'Kowalski', '+16105550177', 'd.kowalski@example.com', 'sms', true, 'member'],
  ['A1206', 'Peter', 'Hollingsworth', '+16105550188', 'p.h@example.com', 'email', false, 'member'],
  ['A1241', 'Susan', 'Merriweather', '+16105550193', 's.merriweather@example.com', 'sms', false, 'member'],
  ['A1277', 'Gregory', 'Thorne', '+16105550204', '', 'sms', false, 'member'],
  ['A1310', 'Annabel', 'Fitzgerald', '+16105550211', 'a.fitz@example.com', 'email', false, 'member'],
  ['A1354', 'Robert', 'Ellsworth', '+16105550228', 'r.ellsworth@example.com', 'sms', false, 'member'],
  ['A1399', 'Katherine', 'Bly', '+16105550233', 'k.bly@example.com', 'email', false, 'member'],
  ['G0004', 'Nathan', 'Pryce', '+16105550240', 'n.pryce@example.com', 'sms', false, 'visitor'],
  ['C0011', 'Delaware Valley', 'Insurance', '+16105550255', 'events@dvins.example.com', 'email', false, 'commercial'],
].map(([member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out, member_type]) => ({
  member_id, first_name, last_name, phone_number, email_address, comm_preference, opt_out, member_type,
}));

const TEMPLATES = [
  {
    template_id: 't1', name: 'Dining — standard', survey_type: 'food_bev', active: true,
    created_at: '2026-05-04T10:00:00Z',
    questions: [
      { key: 'q1', title: 'How likely are you to recommend the club to a friend?', type: 'nps', required: true, index: 'CHI' },
      { key: 'q2', title: 'Overall, how was your visit?', type: 'stars', required: true, index: 'CHI' },
      { key: 'q3', title: 'How was the food?', type: 'stars', required: true, index: 'OHI' },
      { key: 'q4', title: 'How was the service?', type: 'stars', required: true, index: 'SSI' },
      { key: 'q5', title: 'Anything you would like us to know?', type: 'text', required: false },
    ],
  },
  {
    template_id: 't2', name: 'Golf — post round', survey_type: 'golf', active: true,
    created_at: '2026-05-11T10:00:00Z',
    questions: [
      { key: 'q1', title: 'How likely are you to recommend golf at the club?', type: 'nps', required: true, index: 'CHI' },
      { key: 'q2', title: 'Course conditions', type: 'stars', required: true, index: 'OHI' },
      { key: 'q3', title: 'Pace of play', type: 'stars', required: true, index: 'OHI' },
      { key: 'q4', title: 'Pro shop and starter', type: 'stars', required: true, index: 'SSI' },
      { key: 'q5', title: 'Anything about today’s round?', type: 'text', required: false },
    ],
  },
  {
    template_id: 't3', name: 'Events — member functions', survey_type: 'events', active: true,
    created_at: '2026-06-02T10:00:00Z',
    questions: [
      { key: 'q1', title: 'How likely are you to recommend a club event?', type: 'nps', required: true, index: 'CHI' },
      { key: 'q2', title: 'How was the event overall?', type: 'stars', required: true, index: 'CHI' },
      { key: 'q3', title: 'Food and beverage on the night', type: 'stars', required: true },
      { key: 'q4', title: 'Anything we should change next time?', type: 'text', required: false },
    ],
  },
  {
    template_id: 't4', name: 'Staff shift check-in', survey_type: 'staff', active: true,
    created_at: '2026-06-20T10:00:00Z',
    questions: [
      { key: 'q1', title: 'How did the shift go overall?', type: 'stars', required: true },
      { key: 'q2', title: 'Did you feel supported?', type: 'stars', required: true },
      { key: 'q3', title: 'Was the workload manageable?', type: 'stars', required: true },
      { key: 'q4', title: 'Did you have the tools you needed?', type: 'stars', required: true },
      { key: 'q5', title: 'Anything management should know?', type: 'text', required: false },
    ],
  },
];

const iso = (daysAgo, h = 14) => {
  const d = new Date('2026-08-10T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(h, 12, 0, 0);
  return d.toISOString();
};
const day = (daysAgo) => iso(daysAgo).split('T')[0];

const ALERTS = [
  {
    alert_id: 'al1', severity: 'high', status: 'open', created_at: iso(0, 9),
    outlets: { name: 'Belmont Dining Room' },
    ai_summary: 'Long wait between courses on a busy Friday; the member has raised pace before.',
    sla_state: 'urgent', remaining_label: '3h left to call',
    survey_responses: {
      q1_nps: 3, q2_overall_stars: 2, q5_comment: 'Forty minutes between the appetiser and the entrée, and nobody came to explain. Not what we expect on a Friday.',
      visits: { visit_date: day(1), member_id: 'A1042', members: { first_name: 'Charles', last_name: 'Rutherford' } },
    },
    case_resolutions: [],
  },
  {
    alert_id: 'al2', severity: 'high', status: 'assigned', assigned_to: 'Daniel Okafor', created_at: iso(1, 11),
    outlets: { name: 'Golf Patio' }, first_contact_at: iso(1, 16),
    ai_summary: 'Cold food at the turn — third mention of the halfway service this month.',
    sla_state: 'contacted',
    survey_responses: {
      q1_nps: 4, q2_overall_stars: 2, q5_comment: 'Burger was cold at the turn. Staff were apologetic but it took a while to sort out.',
      visits: { visit_date: day(2), member_id: 'A1123', members: { first_name: 'Marcus', last_name: 'Ainsworth' } },
    },
    case_resolutions: [],
  },
  {
    alert_id: 'al3', severity: 'medium', status: 'open', created_at: iso(2, 15),
    outlets: { name: 'Belmont Poolside' },
    sla_state: 'due', remaining_label: '19h left to call',
    survey_responses: {
      q1_nps: 5, q2_overall_stars: 3, q5_comment: 'Waited a long time for drinks by the pool on Sunday.',
      visits: { visit_date: day(3), member_id: 'A1241', members: { first_name: 'Susan', last_name: 'Merriweather' } },
    },
    case_resolutions: [],
  },
  {
    alert_id: 'al4', severity: 'high', status: 'resolved', created_at: iso(6, 10),
    outlets: { name: 'Belmont Dining Room' },
    survey_responses: {
      q1_nps: 2, q2_overall_stars: 2, q5_comment: 'Our table was given away even though we had booked two weeks earlier.',
      visits: { visit_date: day(7), member_id: 'A1206', members: { first_name: 'Peter', last_name: 'Hollingsworth' } },
    },
    case_resolutions: [{
      root_cause: 'reservation_error', action_taken: 'manager_apology', goodwill_amount: 60, goodwill_type: 'credit',
      resolved_by_name: 'Margaret Ellery', notes: 'Called Wednesday morning. Booking system double-entry — front desk retrained on the same day.',
      superseded_at: null,
    }],
  },
];

const QUEUE = [
  { visit_id: 'q1', visit_date: day(0), spend_amount: 128.4, status: 'ready', channel: 'sms', recipient: '+1 610 555 0101', member_id: 'A1042', members: { first_name: 'Charles', last_name: 'Rutherford' }, outlets: { name: 'Belmont Dining Room' } },
  { visit_id: 'q2', visit_date: day(0), spend_amount: 96.15, status: 'ready', channel: 'email', recipient: 'e.vance@example.com', member_id: 'A1088', members: { first_name: 'Eleanor', last_name: 'Vance' }, outlets: { name: 'Belmont Dining Room' } },
  { visit_id: 'q3', visit_date: day(0), spend_amount: 42.0, status: 'ready', channel: 'sms', recipient: '+1 610 555 0164', member_id: 'A1123', members: { first_name: 'Marcus', last_name: 'Ainsworth' }, outlets: { name: 'Golf Patio' } },
  { visit_id: 'q4', visit_date: day(0), spend_amount: 31.75, status: 'ready', channel: 'email', recipient: 'k.bly@example.com', member_id: 'A1399', members: { first_name: 'Katherine', last_name: 'Bly' }, outlets: { name: 'Belmont Poolside' } },
  { visit_id: 'q5', visit_date: day(0), spend_amount: 88.5, status: 'ready', channel: 'sms', recipient: '+1 610 555 0228', member_id: 'A1354', members: { first_name: 'Robert', last_name: 'Ellsworth' }, outlets: { name: 'Belmont Dining Room' } },
  { visit_id: 'q6', visit_date: day(0), spend_amount: 54.2, status: 'blocked', blocked_reason: 'Member has opted out of surveys', member_id: 'A1190', members: { first_name: 'Diane', last_name: 'Kowalski' }, outlets: { name: 'Belmont Dining Room' } },
  { visit_id: 'q7', visit_date: day(0), spend_amount: 22.0, status: 'blocked', blocked_reason: 'No phone or email on the member record', member_id: 'A1277', members: { first_name: 'Gregory', last_name: 'Thorne' }, outlets: { name: 'Golf Patio' } },
];

const VISITS = [
  { visit_id: 'v1', visit_date: day(0), visitor_type: 'member', member_id: 'A1042', members: { first_name: 'Charles', last_name: 'Rutherford' }, outlets: { name: 'Belmont Dining Room' }, spend_amount: 128.4, qualifies: true, survey_sent_at: null },
  { visit_id: 'v2', visit_date: day(0), visitor_type: 'member', member_id: 'A1088', members: { first_name: 'Eleanor', last_name: 'Vance' }, outlets: { name: 'Belmont Dining Room' }, spend_amount: 96.15, qualifies: true, survey_sent_at: null },
  { visit_id: 'v3', visit_date: day(0), visitor_type: 'golf', member_id: 'A1123', members: { first_name: 'Marcus', last_name: 'Ainsworth' }, outlets: { name: 'Golf Patio' }, spend_amount: 42.0, qualifies: true, survey_sent_at: null },
  { visit_id: 'v4', visit_date: day(1), visitor_type: 'member', member_id: 'A1206', members: { first_name: 'Peter', last_name: 'Hollingsworth' }, outlets: { name: 'Belmont Dining Room' }, spend_amount: 61.0, qualifies: false, survey_sent_at: null },
  { visit_id: 'v5', visit_date: day(1), visitor_type: 'visitor', guest_name: 'Nathan Pryce', outlets: { name: 'Belmont Poolside' }, spend_amount: 38.5, qualifies: true, survey_sent_at: iso(1, 19) },
  { visit_id: 'v6', visit_date: day(2), visitor_type: 'member', member_id: 'A1241', members: { first_name: 'Susan', last_name: 'Merriweather' }, outlets: { name: 'Belmont Poolside' }, spend_amount: 44.25, qualifies: true, survey_sent_at: iso(2, 19) },
  { visit_id: 'v7', visit_date: day(2), visitor_type: 'commercial', guest_name: 'Delaware Valley Insurance', outlets: { name: 'Belmont Dining Room' }, spend_amount: 1840.0, qualifies: true, survey_sent_at: iso(2, 19) },
  { visit_id: 'v8', visit_date: day(3), visitor_type: 'member', member_id: 'A1354', members: { first_name: 'Robert', last_name: 'Ellsworth' }, outlets: { name: 'Belmont Dining Room' }, spend_amount: 88.5, qualifies: true, survey_sent_at: iso(3, 19) },
];

const SURVEYS = [
  { response_id: 'r1', survey_token: 'tok1', created_at: iso(1, 19), submitted_at: iso(1, 21), q1_nps: 9, q2_overall_stars: 5, q3_food_stars: 5, q4_service_stars: 5, q5_comment: 'Nora looked after us beautifully. Best dinner we have had here this year.', survey_templates: TEMPLATES[0], answers: { q1: 9, q2: 5, q3: 5, q4: 5 }, visits: { visit_date: day(1), member_id: 'A1088', survey_sent_at: iso(1, 19), members: { first_name: 'Eleanor', last_name: 'Vance', comm_preference: 'email' }, outlets: { name: 'Belmont Dining Room' } } },
  { response_id: 'r2', survey_token: 'tok2', created_at: iso(1, 19), submitted_at: null, q1_nps: null, q2_overall_stars: null, visits: { visit_date: day(1), member_id: 'A1042', survey_sent_at: iso(1, 19), members: { first_name: 'Charles', last_name: 'Rutherford', comm_preference: 'sms' }, outlets: { name: 'Belmont Dining Room' } } },
  { response_id: 'r3', survey_token: 'tok3', created_at: iso(2, 19), submitted_at: iso(2, 20), q1_nps: 3, q2_overall_stars: 2, q3_food_stars: 2, q4_service_stars: 3, q5_comment: 'Forty minutes between courses and nobody explained why.', survey_templates: TEMPLATES[0], answers: { q1: 3, q2: 2, q3: 2, q4: 3 }, visits: { visit_date: day(2), member_id: 'A1241', survey_sent_at: iso(2, 19), members: { first_name: 'Susan', last_name: 'Merriweather', comm_preference: 'sms' }, outlets: { name: 'Belmont Poolside' } } },
  { response_id: 'r4', survey_token: 'tok4', created_at: iso(3, 19), submitted_at: iso(3, 20), q1_nps: 10, q2_overall_stars: 5, q3_food_stars: 4, q4_service_stars: 5, q5_comment: 'Andre remembered our anniversary. Small thing, made the evening.', survey_templates: TEMPLATES[0], answers: { q1: 10, q2: 5, q3: 4, q4: 5 }, visits: { visit_date: day(3), member_id: 'A1354', survey_sent_at: iso(3, 19), members: { first_name: 'Robert', last_name: 'Ellsworth', comm_preference: 'sms' }, outlets: { name: 'Belmont Dining Room' } } },
  { response_id: 'r5', survey_token: 'tok5', created_at: iso(4, 19), submitted_at: iso(4, 22), q1_nps: 8, q2_overall_stars: 4, q3_food_stars: 4, q4_service_stars: 4, q5_comment: 'Poolside service was quicker this week. Noticed and appreciated.', survey_templates: TEMPLATES[0], answers: { q1: 8, q2: 4, q3: 4, q4: 4 }, visits: { visit_date: day(4), member_id: 'A1399', survey_sent_at: iso(4, 19), members: { first_name: 'Katherine', last_name: 'Bly', comm_preference: 'email' }, outlets: { name: 'Belmont Poolside' } } },
  { response_id: 'r6', survey_token: 'tok6', created_at: iso(5, 19), submitted_at: null, q1_nps: null, q2_overall_stars: null, visits: { visit_date: day(5), member_id: 'A1310', survey_sent_at: iso(5, 19), members: { first_name: 'Annabel', last_name: 'Fitzgerald', comm_preference: 'email' }, outlets: { name: 'Golf Patio' } } },
];

const MESSAGES = [
  { created_at: iso(0, 19), member_id: 'A1042', members: { first_name: 'Charles', last_name: 'Rutherford' }, channel: 'sms', recipient: '+16105550101', status: 'sent', body: 'Charles, thanks for dining at Belmont Dining Room today. Two minutes to tell us how it went? https://clubvero.io/s/tok2' },
  { created_at: iso(0, 19), member_id: 'A1088', members: { first_name: 'Eleanor', last_name: 'Vance' }, channel: 'email', recipient: 'e.vance@example.com', status: 'sent', body: 'How was your visit to Belmont Dining Room? Your answers go straight to the management team.' },
  { created_at: iso(1, 19), member_id: 'A1277', members: { first_name: 'Gregory', last_name: 'Thorne' }, channel: 'sms', recipient: '+16105550204', status: 'failed', body: 'Gregory, thanks for visiting Golf Patio today…' },
  { created_at: iso(1, 19), member_id: 'A1241', members: { first_name: 'Susan', last_name: 'Merriweather' }, channel: 'sms', recipient: '+16105550193', status: 'sent', body: 'Susan, thanks for visiting Belmont Poolside today. Two minutes to tell us how it went?' },
  { created_at: iso(2, 8), member_id: 'A1354', members: { first_name: 'Robert', last_name: 'Ellsworth' }, channel: 'sms', recipient: '+16105550228', status: 'sent', body: 'A quick reminder — your Club Vero survey is still open.' },
  { created_at: iso(3, 19), member_id: 'A1399', members: { first_name: 'Katherine', last_name: 'Bly' }, channel: 'email', recipient: 'k.bly@example.com', status: 'sent', body: 'How was your visit to Belmont Poolside?' },
];

const EVENTS = [
  { event_id: 'e1', name: 'Member–Guest Invitational Dinner', description: 'Saturday evening, Belmont Dining Room', event_date: day(12), category: 'general', total_attendees: 96, surveys_sent: 96, responses_received: 41, scores: { nps: 68, csat: 4.4, csat_pct: 88 } },
  { event_id: 'e2', name: 'Independence Day Family Barbecue', description: 'Poolside lawn', event_date: day(37), category: 'general', total_attendees: 214, surveys_sent: 188, responses_received: 73, scores: { nps: 54, csat: 4.1, csat_pct: 82 } },
  { event_id: 'e3', name: 'Ladies’ Member–Member Golf Day', description: '18 holes plus lunch', event_date: day(54), category: 'golf', total_attendees: 64, surveys_sent: 64, responses_received: 29, scores: { nps: 72, csat: 4.5, csat_pct: 90 } },
];

const INSIGHTS = [
  {
    outlets: { name: 'Belmont Dining Room' }, urgency: 'watch', response_count: 38,
    headline: 'Pace between courses is the single recurring complaint, and it clusters on Friday and Saturday service.',
    themes: [
      { keyword: 'pace between courses', trend: 'rising', count: 9, sentiment: 'negative', example_quote: 'Forty minutes between the appetiser and the entrée, and nobody came to explain.' },
      { keyword: 'server warmth', trend: 'stable', count: 14, sentiment: 'positive', example_quote: 'Nora looked after us beautifully.' },
      { keyword: 'wine list', trend: 'stable', count: 4, sentiment: 'neutral', example_quote: 'Would like a few more by-the-glass options.' },
    ],
  },
  {
    outlets: { name: 'Golf Patio' }, urgency: 'critical', response_count: 22,
    headline: 'Food temperature at the turn is now the top negative theme three weeks running.',
    themes: [
      { keyword: 'cold food at the turn', trend: 'rising', count: 7, sentiment: 'negative', example_quote: 'Burger was cold at the turn.' },
      { keyword: 'starter friendliness', trend: 'rising', count: 6, sentiment: 'positive', example_quote: 'The starter could not have been more helpful.' },
    ],
  },
];

const TRAINING = [
  {
    plan_id: 'p1', outlets: { name: 'Belmont Dining Room' }, generated_at: iso(3),
    basis_summary: 'Built from 38 responses in the last week, 9 of which mention the gap between courses.',
    steps: [
      { text: 'Brief the Friday and Saturday floor teams on the two-minute check-back between courses.', priority: 'immediate', done: true },
      { text: 'Agree a kitchen signal for tables waiting more than 15 minutes on an entrée.', priority: 'this week', done: false },
      { text: 'Recognise Nora Bennett at the next team meeting — named positively five times.', priority: 'this week', done: false },
      { text: 'Review pace complaints again in four weeks before changing the covers cap.', priority: 'ongoing', done: false },
    ],
  },
  {
    plan_id: 'p2', outlets: { name: 'Golf Patio' }, generated_at: iso(3),
    basis_summary: 'Built from 22 responses, 7 mentioning food temperature at the turn.',
    steps: [
      { text: 'Check hot-hold temperatures at the halfway house before each morning wave.', priority: 'immediate', done: true },
      { text: 'Move burger assembly to order during peak tee times.', priority: 'this week', done: false },
    ],
  },
];

const LEADERBOARD = [
  { server_name: 'Nora Bennett', survey_count: 34, composite_score: 4.6, avg_nps: 9.1, avg_overall: 4.7, avg_food: 4.4, avg_service: 4.8 },
  { server_name: 'Andre Castillo', survey_count: 29, composite_score: 4.3, avg_nps: 8.6, avg_overall: 4.4, avg_food: 4.2, avg_service: 4.5 },
  { server_name: 'Jessica McGarrey', survey_count: 31, composite_score: 3.9, avg_nps: 7.8, avg_overall: 4.0, avg_food: 3.9, avg_service: 4.0 },
  { server_name: 'Liam Petrosyan', survey_count: 18, composite_score: 3.2, avg_nps: 6.4, avg_overall: 3.3, avg_food: 3.4, avg_service: 3.1 },
];

const SERVER_TASKS = [
  {
    task_id: 'st1', category: 'recognition', server_name: 'Nora Bennett', completed: false,
    title: 'Recognise at the next team meeting',
    description: 'Named positively in five comments this month, every one of them mentioning attentiveness without hovering.',
    key_metric: 'Composite 4.6 · service 4.8 across 34 surveys',
  },
  {
    task_id: 'st2', category: 'training', server_name: 'Liam Petrosyan', completed: false,
    title: 'Coach on check-backs during the first ten minutes',
    description: 'Three comments this month mention waiting to order. Pair with Nora for two Friday services and review again next month.',
    key_metric: 'Service 3.1 vs 4.3 room average · 18 surveys',
  },
];

const routes = {};
const J = (path, body) => { routes[path] = body; };

J('/api/club-config', {
  club_name: 'Aronimink Golf Club',
  person_types: [
    { value: 'member', label: 'Member' }, { value: 'visitor', label: 'Visitor / Guest' },
    { value: 'commercial', label: 'Commercial' }, { value: 'other', label: 'Other' },
  ],
  person_type_labels: { member: 'Member', visitor: 'Visitor / Guest', commercial: 'Commercial', golf: 'Golf', other: 'Other' },
});
J('/api/auth/me', { user: { name: 'Margaret Ellery', role: 'general_manager', email: 'm.ellery@aronimink.org' } });
J('/api/auth/users', { users: [
  { user_id: 'u1', name: 'Margaret Ellery', email: 'm.ellery@aronimink.org', role: 'general_manager' },
  { user_id: 'u2', name: 'Daniel Okafor', email: 'd.okafor@aronimink.org', role: 'fb_director' },
  { user_id: 'u3', name: 'Priya Raman', email: 'p.raman@aronimink.org', role: 'dept_head' },
] });

J('/api/scores', { overall: { CHI: 84.2, CHI_responses: 118, SSI: 79.4, SSI_responses: 118, OHI: 81.1, OHI_responses: 118 } });

J('/api/visits/overview-stats', {
  nps: 72, response_rate: 38, surveys_sent: 94, responses: 36, open_alerts: 3, warnings: [],
  outlets: [
    { name: 'Belmont Dining Room', nps: 76, responses: 18 },
    { name: 'Golf Patio', nps: 61, responses: 11 },
    { name: 'Belmont Poolside', nps: 74, responses: 7 },
  ],
  recent_comments: [
    { date: iso(1), outlet: 'Belmont Dining Room', overall: 5, sentiment: 'positive', tags: ['service'], comment: 'Nora looked after us beautifully. Best dinner we have had here this year.' },
    { date: iso(2), outlet: 'Belmont Poolside', overall: 3, sentiment: 'negative', tags: ['pace'], comment: 'Waited a long time for drinks by the pool on Sunday.' },
    { date: iso(2), outlet: 'Golf Patio', overall: 2, sentiment: 'negative', tags: ['food temperature'], comment: 'Burger was cold at the turn. Staff were apologetic but it took a while to sort out.' },
    { date: iso(3), outlet: 'Belmont Dining Room', overall: 5, sentiment: 'positive', tags: ['recognition'], comment: 'Andre remembered our anniversary. Small thing, made the evening.' },
  ],
  alerts: [
    { alert_id: 'al1', created_at: iso(0, 9), member_name: 'C. Rutherford', outlet: 'Belmont Dining Room', overall: 2, severity: 'high', comment: 'Forty minutes between the appetiser and the entrée, and nobody came to explain.' },
    { alert_id: 'al2', created_at: iso(1, 11), member_name: 'M. Ainsworth', outlet: 'Golf Patio', overall: 2, severity: 'high', comment: 'Burger was cold at the turn.' },
    { alert_id: 'al3', created_at: iso(2, 15), member_name: 'S. Merriweather', outlet: 'Belmont Poolside', overall: 3, severity: 'medium', comment: 'Waited a long time for drinks by the pool on Sunday.' },
  ],
});

J('/api/visits/trend-stats', {
  months: ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
  outlet_names: [{ key: 'o1', name: 'Belmont Dining Room' }, { key: 'o2', name: 'Golf Patio' }, { key: 'o3', name: 'Belmont Poolside' }],
  outlets: {
    all: { csat: [4.1, 4.0, 4.2, 4.3, 4.2, 4.4], food: [4.0, 4.1, 4.1, 4.2, 4.1, 4.3], service: [4.2, 4.1, 4.3, 4.4, 4.3, 4.5], nps: [58, 55, 63, 68, 66, 72] },
    o1: { csat: [4.2, 4.1, 4.3, 4.4, 4.3, 4.5], food: [4.1, 4.2, 4.2, 4.3, 4.2, 4.4], service: [4.3, 4.2, 4.4, 4.5, 4.4, 4.6], nps: [62, 60, 68, 73, 71, 76] },
    o2: { csat: [3.9, 3.8, 4.0, 4.0, 3.8, 3.9], food: [3.8, 3.7, 3.9, 3.9, 3.6, 3.7], service: [4.0, 4.0, 4.1, 4.2, 4.1, 4.2], nps: [52, 48, 57, 60, 54, 61] },
    o3: { csat: [4.0, 4.0, 4.1, 4.3, 4.3, 4.4], food: [4.0, 4.0, 4.1, 4.2, 4.2, 4.3], service: [4.1, 4.0, 4.2, 4.4, 4.4, 4.5], nps: [56, 54, 62, 70, 69, 74] },
  },
});

J('/api/visits/golf-stats', {
  period: '30d', nps_score: 64, surveys_sent: 118, response_rate: 41, responses_received: 48,
  avg_course_conditions: 4.4, avg_pace_of_play: 3.4, avg_pro_shop: 4.6,
  recent: [
    { name: 'Marcus Ainsworth', date: day(1), nps: 6, course_conditions: 4, pace_of_play: 2, comment: 'Course was superb. Five and a half hours is too long on a Saturday.' },
    { name: 'Annabel Fitzgerald', date: day(2), nps: 9, course_conditions: 5, pace_of_play: 4, comment: 'Greens were the best I have seen them.' },
    { name: 'Robert Ellsworth', date: day(3), nps: 8, course_conditions: 4, pace_of_play: 4, comment: '' },
    { name: 'Charles Rutherford', date: day(4), nps: 10, course_conditions: 5, pace_of_play: 5, comment: 'Starter was excellent, got us away on time.' },
  ],
});

J('/api/visits/golf-log', {
  visits: [
    { visit_date: day(1), members: { first_name: 'Marcus', last_name: 'Ainsworth' }, survey_sent_at: iso(1, 19), survey_responses: { is_complete: true, q1_nps: 6, q2_overall_stars: 4, q3_food_stars: 2 } },
    { visit_date: day(2), members: { first_name: 'Annabel', last_name: 'Fitzgerald' }, survey_sent_at: iso(2, 19), survey_responses: { is_complete: true, q1_nps: 9, q2_overall_stars: 5, q3_food_stars: 4 } },
    { visit_date: day(3), members: { first_name: 'Robert', last_name: 'Ellsworth' }, survey_sent_at: iso(3, 19), survey_responses: { is_complete: true, q1_nps: 8, q2_overall_stars: 4, q3_food_stars: 4 } },
    { visit_date: day(4), members: { first_name: 'Charles', last_name: 'Rutherford' }, survey_sent_at: iso(4, 19), survey_responses: { is_complete: true, q1_nps: 10, q2_overall_stars: 5, q3_food_stars: 5 } },
    { visit_date: day(0), members: { first_name: 'Katherine', last_name: 'Bly' }, survey_sent_at: iso(0, 19), survey_responses: null },
    { visit_date: day(0), members: { first_name: 'Peter', last_name: 'Hollingsworth' }, survey_sent_at: null, survey_responses: null },
  ],
});

J('/api/analytics/crossover', {
  golf_days: 486, both: 203, golf_only: 283, pct_golfers_who_dined: 42,
  avg_spend_golfer_who_dined: 61, spend_uplift: 14, estimated_missed_spend: 17263, missed_dining_days: 283,
  by_day_of_week: [
    { day: 'Monday', pct_dined: 31, both: 14, golf_days: 45 },
    { day: 'Tuesday', pct_dined: 38, both: 22, golf_days: 58 },
    { day: 'Wednesday', pct_dined: 47, both: 39, golf_days: 83 },
    { day: 'Thursday', pct_dined: 44, both: 31, golf_days: 70 },
    { day: 'Friday', pct_dined: 51, both: 46, golf_days: 90 },
    { day: 'Saturday', pct_dined: 39, both: 34, golf_days: 87 },
    { day: 'Sunday', pct_dined: 32, both: 17, golf_days: 53 },
  ],
  by_outlet: [
    { outlet: 'Golf Patio', pct_of_crossover: 64, golfer_days: 130 },
    { outlet: 'Belmont Dining Room', pct_of_crossover: 27, golfer_days: 55 },
    { outlet: 'Belmont Poolside', pct_of_crossover: 9, golfer_days: 18 },
  ],
  golfers_who_never_dine: [
    { member_id: 'A1277', name: 'G. Thorne', rounds: 21 },
    { member_id: 'A1190', name: 'D. Kowalski', rounds: 17 },
    { member_id: 'A1310', name: 'A. Fitzgerald', rounds: 14 },
    { member_id: 'A1206', name: 'P. Hollingsworth', rounds: 12 },
  ],
});

J('/api/analytics/member-health', {
  summary: { lapsed: 12, at_risk: 19, slipping: 27, value_at_risk: 84600 },
  club: { scored_members: 386, unscored_members: 74, seasonal_adjusted: true, seasonal_ratio: 0.91 },
  call_list: [
    { member_id: 'A1206', name: 'Peter Hollingsworth', band: 'lapsed', phone: '+16105550188', baseline_rate_30d: 6.2, recent_rate_30d: 0, days_since_last_visit: 96, value_at_risk: 9400 },
    { member_id: 'A1042', name: 'Charles Rutherford', band: 'at_risk', phone: '+16105550101', baseline_rate_30d: 8.1, recent_rate_30d: 2.0, days_since_last_visit: 21, value_at_risk: 7800 },
    { member_id: 'A1310', name: 'Annabel Fitzgerald', band: 'at_risk', email: 'a.fitz@example.com', baseline_rate_30d: 5.4, recent_rate_30d: 1.3, days_since_last_visit: 34, value_at_risk: 5100 },
    { member_id: 'A1277', name: 'Gregory Thorne', band: 'at_risk', opt_out: false, phone: '+16105550204', baseline_rate_30d: 4.8, recent_rate_30d: 1.0, days_since_last_visit: 41, value_at_risk: 4300 },
    { member_id: 'A1190', name: 'Diane Kowalski', band: 'slipping', opt_out: true, baseline_rate_30d: 3.9, recent_rate_30d: 2.1, days_since_last_visit: 18, value_at_risk: 2600 },
  ],
});

J('/api/alerts/severity-stats', {
  total: 27, open: 3,
  by_severity: [{ severity: 'high', count: 11 }, { severity: 'medium', count: 9 }, { severity: 'low', count: 7 }],
  open_by_severity: [{ severity: 'high', count: 2 }, { severity: 'medium', count: 1 }],
});

J('/api/alerts/recovery-stats', {
  pct_contacted_within_sla: 86, alerts_in_scope: 27, excluded_no_contact: 2, contacted_within_sla: 21,
  median_hours_to_contact: 6, contacted: 24, pct_recovered: 71, recovery_measurable: 17, recovery_improved: 12,
  awaiting_contact: 2, breached: 0,
});

J('/api/alerts/recovery-queue', { queue: [] });

J('/api/staff/leaderboard', { leaderboard: LEADERBOARD });
J('/api/staff/tasks', { tasks: SERVER_TASKS });
J('/api/staff', { staff: STAFF });
J('/api/servers', { servers: SERVERS });
J('/api/servers/unmatched', { unmatched: [{ name: 'K. Doyle', visits: 14 }, { name: 'M. Suarez', visits: 6 }] });
J('/api/outlets', { outlets: OUTLETS });
J('/api/survey-templates', { templates: TEMPLATES });
J('/api/insights', { insights: INSIGHTS });
J('/api/training', { plans: TRAINING, total: TRAINING.length });
J('/api/alerts', { alerts: ALERTS, total: ALERTS.length });
J('/api/visits/queue', {
  queue: QUEUE, send_time: '19:00',
  summary: { ready: 5, sms: 3, email: 2, blocked: 2, by_outlet: [{ outlet: 'Belmont Dining Room', count: 4 }, { outlet: 'Golf Patio', count: 2 }, { outlet: 'Belmont Poolside', count: 1 }] },
});
J('/api/visits', { visits: VISITS, total: VISITS.length });
J('/api/visits/outlets', OUTLETS);
J('/api/visits/pos-modules', { modules: [
  { id: 'northstar', label: 'NorthStar' }, { id: 'jonas', label: 'Jonas Club Software' },
  { id: 'lightspeed', label: 'Lightspeed' }, { id: 'clubv1', label: 'Club V1' }, { id: 'generic', label: 'Generic' },
] });
J('/api/surveys', { surveys: SURVEYS, total: SURVEYS.length });
J('/api/message-log', { messages: MESSAGES, total: MESSAGES.length });
J('/api/events', { events: EVENTS, total: EVENTS.length });
J('/api/events/scores', {
  overall: { events: 3, responses: 143, nps: 63, csat: 4.3, csat_pct: 86 },
  by_category: [
    { label: 'Events', events: 2, responses: 114, nps: 60, csat: 4.2, csat_pct: 84 },
    { label: 'Golf events', events: 1, responses: 29, nps: 72, csat: 4.5, csat_pct: 90 },
  ],
});
J('/api/staff-surveys/summary', { avg_shift_rating: 4.2, avg_support: 4.0, avg_workload: 3.5, avg_tools: 4.1, submitted: 34, response_rate: 61 });
J('/api/staff-surveys', { responses: [
  { shift_date: day(1), servers: { name: 'Nora Bennett' }, q1_shift_rating: 5, q2_support: 5, q3_workload: 4, q4_tools: 5, q5_comment: 'Good Friday. Two sections down but the team covered well.' },
  { shift_date: day(1), servers: { name: 'Jessica McGarrey' }, q1_shift_rating: 3, q2_support: 3, q3_workload: 2, q4_tools: 4, q5_comment: 'Too many covers for the number of runners on the floor.' },
  { shift_date: day(2), servers: { name: 'Andre Castillo' }, q1_shift_rating: 4, q2_support: 4, q3_workload: 4, q4_tools: 4, q5_comment: '' },
  { shift_date: day(3), servers: { name: 'Liam Petrosyan' }, q1_shift_rating: 3, q2_support: 3, q3_workload: 3, q4_tools: 3, q5_comment: 'Still learning the POS shortcuts.' },
] });

J('/api/settings', {
  survey_send_time: '19:00', analysis_day: '5', analysis_time: '07:00', analysis_last_run_at: iso(3, 7),
  member_survey_cap: '1', member_survey_cap_days: '30', staff_survey_enabled: 'true', staff_survey_send_time: '22:00',
});

J('/api/credit', {
  balance: '$248.60', balance_cents: 24860, currency: 'usd', state: 'healthy', configured: true, enforced: true,
  messages_remaining: 3108, low_balance_cents: 5000, rate_configured: true, stripe_ready: true,
  auto_topup: { enabled: true, amount_cents: 20000, threshold_cents: 5000, card: { brand: 'visa', last4: '4242' } },
});
J('/api/credit/history', {
  currency: 'usd',
  payments: [
    { created_at: iso(9), amount_cents: 20000, amount: '$200.00', balance_after: '$248.60', label: 'Automatic top-up', description: 'Balance fell below $50.00', actor: 'Automatic' },
    { created_at: iso(38), amount_cents: 20000, amount: '$200.00', balance_after: '$212.40', label: 'Top-up', description: 'Card ending 4242', actor: 'Margaret Ellery' },
  ],
  usage: [
    { date: day(6), amount_cents: 1840, amount: '$18.40', messages: 46, label: 'Survey' },
    { date: day(5), amount_cents: 2120, amount: '$21.20', messages: 53, label: 'Survey' },
    { date: day(4), amount_cents: 1560, amount: '$15.60', messages: 39, label: 'Survey' },
    { date: day(3), amount_cents: 2480, amount: '$24.80', messages: 62, label: 'Survey' },
    { date: day(2), amount_cents: 2040, amount: '$20.40', messages: 51, label: 'Survey' },
    { date: day(2), amount_cents: 560, amount: '$5.60', messages: 14, label: 'Reminder' },
    { date: day(1), amount_cents: 2760, amount: '$27.60', messages: 69, label: 'Survey' },
    { date: day(0), amount_cents: 1920, amount: '$19.20', messages: 48, label: 'Survey' },
    { date: day(0), amount_cents: 480, amount: '$4.80', messages: 12, label: 'Staff shift survey' },
  ],
});

J('/api/diagnostics/delivery', {
  checks: [
    { label: 'Member contact details', status: 'ok', detail: '441 of 460 members have a phone or email' },
    { label: 'SMS credit', status: 'ok', detail: '$248.60 — roughly 3,100 messages' },
    { label: 'Messaging provider', status: 'ok', detail: 'Sendly connected · from +1 610 555 0100' },
    { label: 'Email provider', status: 'ok', detail: 'SendGrid connected · surveys@aronimink.org' },
    { label: 'Survey delivery time', status: 'ok', detail: 'Sends daily at 7:00pm Eastern' },
  ],
});

J('/api/reports/summary', {
  period: { label: '12 May – 10 August 2026', days: 90 },
  empty_sections: [],
  headline: [
    { label: 'Property NPS', value: 72, format: 'number', delta: { direction: 'up', label: '+6' } },
    { label: 'Responses', value: 412, format: 'number', delta: { direction: 'up', label: '+58' } },
    { label: 'Response rate', value: 38, format: 'percent', delta: { direction: 'up', label: '+3 pts' } },
    { label: 'Case alerts raised', value: 27, format: 'number', delta: { direction: 'down', label: '−5' } },
  ],
  indices: [{ label: 'CHI · Club Health', value: 84 }, { label: 'SSI · Service Satisfaction', value: 79 }, { label: 'OHI · Operational Health', value: 81 }],
  months: [{ month: 'May', nps: 63 }, { month: 'Jun', nps: 68 }, { month: 'Jul', nps: 66 }, { month: 'Aug', nps: 72 }],
  outlets: [
    { outlet: 'Belmont Dining Room', responses: 214, nps: 76 },
    { outlet: 'Golf Patio', responses: 121, nps: 61 },
    { outlet: 'Belmont Poolside', responses: 77, nps: 74 },
  ],
  servers: LEADERBOARD.map((s, i) => ({ rank: i + 1, name: s.server_name, surveys: s.survey_count, composite: s.composite_score.toFixed(1), nps: s.avg_nps.toFixed(1), overall: s.avg_overall.toFixed(1), food: s.avg_food.toFixed(1), service: s.avg_service.toFixed(1) })),
  alerts: [
    { label: 'High', raised: 11, resolved: 9, open: 2 },
    { label: 'Medium', raised: 9, resolved: 8, open: 1 },
    { label: 'Low', raised: 7, resolved: 7, open: 0 },
  ],
});

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;

  if (p.startsWith('/api/')) {
    if (req.method !== 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    const ev = /^\/api\/events\/(e\d+)$/.exec(p);
    if (ev) {
      const found = EVENTS.find(e => e.event_id === ev[1]) || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(found));
    }
    if (p === '/api/members') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(MEMBERS));
    }
    // longest-prefix match so /api/visits/queue wins over /api/visits
    const key = Object.keys(routes).filter(k => p === k).sort((a, b) => b.length - a.length)[0];
    if (key) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(routes[key])); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }

  if (p === '/') p = '/vero-dashboard.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log('mock backend on http://127.0.0.1:' + PORT));
