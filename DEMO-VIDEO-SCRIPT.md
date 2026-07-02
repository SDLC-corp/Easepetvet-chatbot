# Ease Pet Vet Chatbot — Demo Video Script

Two chatbots run side by side on the same page (`frontend/widget/demo.html`):

- **LEFT bot** (bottom-left) = *intent-based*. Starts anonymously, no form. It learns who you
  are from the conversation and only asks for contact details when you show follow-up intent.
- **RIGHT bot** (bottom-right) = *form-first*. Shows an intro form up front and won't let you
  chat until name + email + audience are filled in.

Same backend, same knowledge base — the difference is *how each one captures the lead*.

Total runtime target: ~5-6 minutes.

---

## SCENE 0 — Intro (15-20 sec)

**On screen:** the demo page with both launcher buttons visible (one bottom-left, one bottom-right).

**Narration:**
> "This is the Ease Pet Vet assistant. We actually built two versions so you can see two
> different ways of turning a website visitor into a lead. On the right is the classic
> form-first chatbot — it asks who you are before you chat. On the left is a smarter,
> intent-based one — it just starts talking and only asks for your details when it makes
> sense to. Same answers, two very different first impressions. Let's start with the left."

---

## SCENE 1 — LEFT bot: capturing contact info through conversation (90 sec)

> Code reference: `frontend/widget/ease-chatbot-left.js`

**Step 1 — Open it. No form.**

Click the bottom-left launcher. It greets immediately:

> "Hi! I can help with Ease Pet Vet — pricing, how it works for vets and pet parents,
> behavior topics, and support. What can I help you with?"

**Narration:**
> "Notice there's no form. It just starts a conversation, anonymously."

**Step 2 — Show audience detection.** Type a pet-parent-style question:

> **You type:** `My dog has separation anxiety, can Ease help?`

The bot answers from the website content. Behind the scenes it has now silently tagged this
visitor as a **Pet Parent** (the word "dog" / "separation anxiety" triggers detection).

**Narration:**
> "I never told it I'm a pet parent — it figured that out from what I said. If I'd mentioned
> 'my clinic' or 'our patients', it would have tagged me as a Vet instead. That label follows
> the lead all the way into the admin panel."

**Step 3 — Trigger the contact ask with intent.** Type something that shows follow-up intent:

> **You type:** `I'd like someone to contact me about this`

Because this is a conversion intent (not a question), the bot doesn't run a search — it asks
for the email in plain chat:

> "Sure — please share your email so our team can follow up with helpful information.
> You can also add your contact number if you prefer a call."

**Narration:**
> "This is the key difference. It only asks for contact details once I show intent — when I
> say I want to be contacted, book a demo, get support, or need login help."

**Step 4 — Give the email inline.** Type it right in the chat (optionally with a phone):

> **You type:** `john@example.com, 555-0199`

The bot detects the email + phone in the message, saves it to this session, and confirms:

> "Thanks — our team can use this to follow up with helpful information."

**Narration:**
> "I just typed my email into the chat like a normal message. No popup, no form. The bot picks
> it out, attaches it to this conversation, and the lead is captured. That's it."

**(Optional aside — the soft ask):**
> "Even if I never showed intent, around the fifth question the bot gently weaves in 'by the
> way, if you'd like us to follow up, just share your email here' — so it always has a natural
> moment to ask, without ever blocking the conversation."

---

## SCENE 2 — RIGHT bot: capturing contact info through the form (60 sec)

> Code reference: `frontend/widget/ease-chatbot-widget.js`

**Step 1 — Open it. Form first.**

Click the bottom-right launcher. Instead of a chat, you get an intro card titled
**"Let's get started"** with:

- **Name** * (required)
- **Email** * (required)
- **Contact number** (optional)
- **I am a:** three buttons — **Pet Parent** / **Vet** / **Not sure** * (required)

**Narration:**
> "The right-hand bot takes the traditional approach. Before you can ask anything, it wants to
> know who you are. Name, email, and whether you're a pet parent or a vet."

**Step 2 — Show validation.** Click **Submit** with the email empty or malformed.

> Error appears: *"Please enter a valid email address (e.g. you@example.com)."*
> Try submitting without picking an audience: *"Please tell us if you are a pet parent or a vet."*

**Narration:**
> "It validates everything — a real email, and you have to pick who you are — before it lets you in."

**Step 3 — Fill it in and submit.**

> Name: `Sarah Lee` · Email: `sarah@example.com` · Contact: `555-0143` · I am a: **Vet**

Click **Submit**. The form disappears, the chat opens, and it greets by name:

> "Hi Sarah! I can answer questions about Ease Pet Vet — pricing, how it works for vets and
> pet parents, and support. How can I help?"

Now ask a question, e.g. `How does onboarding work for a clinic?` — it answers from the
website content.

**Narration:**
> "Once the form's submitted, the lead is already captured — name, email, phone, and audience —
> and then the chat behaves just like the other one. The trade-off is simple: the right bot
> guarantees you get the contact details up front, but asks for commitment before any value.
> The left bot gives value first and earns the details through the conversation."

**(Optional):** Reload the page — the right bot remembers Sarah and skips straight to chat
(returning visitors don't see the form again).

---

## SCENE 3 — Admin panel: what it shows (90 sec)

> Open `frontend/admin/index.html` · Code: `backend/src/routes/admin.routes.js`,
> `backend/src/repositories/admin.repository.js`

**Step 1 — Sign in.** Show the login card, enter the admin token, **Sign in**.

**Step 2 — The header + stats row.**

Top bar reads **"Ease Pet Vet Chatbot Admin — Conversations & leads"**, with a **sync status
badge**, last-sync time, a **Sync Now** button, and **Logout**.

Below it, the **stats cards**: total conversations, total leads, total messages, plus the
knowledge-base size (pages and chunks indexed).

**Narration:**
> "This is the admin dashboard. Up top, the health of the knowledge base — how many pages and
> chunks we've indexed from the website, when it last synced, and a button to re-sync on demand.
> Then the totals: how many conversations, how many leads we've captured, how many messages."

**Step 3 — The Conversations table.** Walk across the columns:

> **Name · Email · Contact · Audience · Conversation (last-message preview) · Time (CST) · Msgs**

Point out the two leads we just created:
- **Sarah Lee** — `sarah@example.com` — Vet — from the right-hand form bot.
- The **left-bot lead** — `john@example.com` — Pet Parent — captured mid-conversation.

**Narration:**
> "Every conversation lands here. You can see both leads we just made — the vet who filled the
> form, and the pet parent who gave their email inside the chat. Same table, regardless of which
> bot captured them, with the audience the bots detected."

**Step 4 — Filters.** Demonstrate:
- **Search** box — type `sarah` or `dog` (it searches name, email, phone, *and* message text).
- **Audience** dropdown — filter to **Vet** only, then **Pet Parent**.
- **From / To** date filters — narrow to today. Click **Apply**.

**Narration:**
> "You can search across names, emails, phone numbers, and even the message text, filter by
> pet parent versus vet, or narrow down by date."

**Step 5 — Open a conversation.** Click Sarah's row. A drawer slides in showing the lead's
details and the **full transcript** — every user message and bot answer in order.

**Narration:**
> "Click any row and you get the full transcript — exactly what the visitor asked and what the
> bot answered, alongside their contact details."

---

## SCENE 4 — Exporting chats (45 sec)

> Code: `admin.routes.js` → `POST /api/admin/chats/export`

**Step 1 — Select.** Tick a few rows, or use the header checkbox / **Select all across pages**
to grab everything that matches the current filter.

**Narration:**
> "To hand leads off to the sales team, select the conversations you want — or select all that
> match your filter — and hit Export."

**Step 2 — Export.** Click **Export selected**. A CSV downloads named
`chat-users-export-YYYY-MM-DD.csv`.

**Step 3 — Open the CSV** (in Excel / Sheets). Show the contents — it is deliberately simple:

```
Email,Audience
"sarah@example.com","Vet"
"john@example.com","Pet Parent"
```

**Narration:**
> "The export is intentionally clean — just the email and whether they're a vet or a pet parent.
> Anyone in the conversation who never shared an email is automatically left out, so every row
> is a real, contactable lead ready to drop into a CRM or an email campaign."

**(Optional — Delete):** Mention the **Delete selected** button removes a conversation and its
lead permanently (good for clearing out test chats).

---

## SCENE 5 — Wrap-up (15 sec)

**Narration:**
> "So — two chatbots, same brain. The right one captures leads with a form before the
> conversation; the left one earns them naturally during it. Both feed the same admin dashboard,
> where you can read every conversation, filter and search them, and export your leads as a clean
> CSV. That's the Ease Pet Vet assistant."

---

## Quick reference — sample lines to type on camera

| Bot | Type this | What it demonstrates |
|-----|-----------|----------------------|
| LEFT | `My dog has separation anxiety, can Ease help?` | Audience auto-detected as Pet Parent |
| LEFT | `I'd like someone to contact me about this` | Intent triggers the contact ask |
| LEFT | `john@example.com, 555-0199` | Inline email + phone capture, no form |
| RIGHT | (form) `Sarah Lee` / `sarah@example.com` / `555-0143` / **Vet** | Form-first lead capture |
| RIGHT | `How does onboarding work for a clinic?` | Normal Q&A after the form |
| ADMIN | search `dog` / filter **Vet** / date = today | Filtering conversations |
| ADMIN | Select rows → **Export selected** | CSV of `Email, Audience` |

> Tip: record the LEFT and RIGHT bots in one continuous take on `demo.html` so viewers see them
> side by side, then cut to the admin panel for Scenes 3-4.
