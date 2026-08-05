# Keeping survey emails out of Junk

Most of what decides this is not in the code. A mail provider is asking three
questions: is this sender who they claim to be, do the people receiving it want
it, and does it look like the kind of mail that gets reported. The application
can answer the third and help with the second. The first is DNS, and nothing in
this repository can substitute for it.

What follows is ordered by how much difference it makes.

## 1. Authenticate the sending domain (the big one)

Without these, Gmail and Microsoft treat `clubvero.io` as unverified, and since
February 2024 both reject or junk unauthenticated bulk mail as policy. This is
almost certainly the main reason a survey landed in Junk.

**In SendGrid → Settings → Sender Authentication:**

- **Authenticate Your Domain** for `clubvero.io`. SendGrid gives you three
  CNAME records; add them at your DNS host. This is what produces a valid
  **DKIM** signature and an **SPF** alignment. Verify shows green when DNS has
  propagated.
- Choose **automated security** off if you want to manage DKIM keys yourself;
  on is fine and simpler.
- **Link Branding** for the click-tracking domain. This is the one currently
  serving a bad certificate — see section 4.

**Then add a DMARC record** at your DNS host, on `_dmarc.clubvero.io`:

```
v=DMARC1; p=none; rua=mailto:dmarc@clubvero.io; fo=1
```

Start at `p=none`, which asks for reports without affecting delivery. Read the
reports for a couple of weeks, confirm everything legitimate is passing, then
move to `p=quarantine` and eventually `p=reject`. Going straight to `reject`
before you know what is sending on your behalf will silently kill mail you
care about.

Check the result at https://www.mail-tester.com — send it a survey and it
scores the message out of 10 with the specific failures listed.

## 2. Send from a subdomain, not the root

Use `feedback.clubvero.io` or `mail.clubvero.io` for surveys rather than
`clubvero.io` itself. Reputation is tracked per subdomain, so a bad run of
survey sends cannot take your ordinary club correspondence down with it. Set
`SENDGRID_FROM_EMAIL` accordingly once the subdomain is authenticated.

## 3. Give the template a plain-text version

A dynamic template with only an HTML version is a strong spam signal — real
mail almost always carries both. SendGrid does **not** generate one for you.

In SendGrid → Email API → Dynamic Templates → your template → the version
editor, there is a **Plain Text** tab alongside Design/Code. Paste the contents
of `docs/sendgrid-survey-template.txt` into it. It uses the same substitution
tags, so it stays in step with the HTML.

## 4. The tracking domain

Click tracking rewrites every link through the branded domain, which is
currently serving a certificate that does not match — that is what produced
the `url6367.clubvero.io` warnings. A mismatched tracking domain is itself a
deliverability problem, because the URL a recipient sees no longer matches the
sender.

Click tracking is **off** in this application (`SENDGRID_CLICK_TRACKING`), so
this is not currently biting. If you want it back, fix Link Branding in Sender
Authentication first, confirm the certificate is valid in a browser, then set
`SENDGRID_CLICK_TRACKING=true`.

## 5. What the code already does

These are in place and need nothing from you:

- **`List-Unsubscribe` and `List-Unsubscribe-Post`** headers on every survey
  email, so a member can opt out from their mail client in one click. Their
  absence is one of the strongest junk signals for bulk mail, and the presence
  of a working unsubscribe is what stops somebody reporting you as spam
  instead — one complaint costs more than a hundred unsubscribes.
- **A real unsubscribe** at `/u/:token` that sets `members.opt_out`, which
  every send path honours. Providers do check that the link works.
- **The logo served over https.** An `http://` image is blocked outright by
  Outlook and Gmail, which is why it rendered as a broken placeholder, and
  mixed content counts against the message.
- **Per-message categories**, so SendGrid's engagement stats separate surveys
  from reminders and you can see which is dragging reputation.
- **Opt-out respected everywhere**, so nobody who has unsubscribed is ever sent
  another survey. Sending to someone who opted out is the fastest way to a
  complaint.

## 6. While reputation recovers

A domain that has been landing in Junk does not recover the moment DNS is
fixed. For the first few weeks:

- Send to people who will actually open it. Engagement is the strongest
  positive signal there is, and a club's own members are a good list.
- Do not send to addresses that bounce. Clean the member list of anything that
  has hard-bounced — SendGrid → Suppressions shows them.
- Keep volume steady rather than sending nothing for a fortnight and then
  three thousand at once.
- Ask a handful of members to mark the first one **Not Junk** and add
  `aronimink@clubvero.io` to their contacts. In Microsoft 365 an administrator
  can do this for everyone at once with a tenant allow-list entry, which is
  worth doing for the club's own staff addresses at minimum.

## 7. Checking it worked

- https://www.mail-tester.com — score out of 10, with each failure named.
- SendGrid → Activity Feed — shows delivered, deferred, bounced and spam
  reports per message.
- Google Postmaster Tools (postmaster.google.com) — domain reputation and spam
  rate as Gmail actually sees it. Worth setting up once the domain is
  authenticated; it is the only place you find out you have a problem before
  members tell you.
