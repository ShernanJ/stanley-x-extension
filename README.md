# stanley for x

## EDIT: THIS IS NOT THE SAME PROJECT THAT SOLVES VITALII'S 0->1000 PROBLEM, THIS IS THE PROJECT THAT LEAD TO HIM GIVING ME IT.

## I'm Building Something Better :)

this is a chrome extension that helps turn linkedin-style drafts into x-native posts.

the goal is simple:
- keep your core message
- remove the linkedin-coded tone
- make it feel like it belongs on x

## why i made this

i saw a post on x from emily about the stan hackathon and how she hired 4 engineers from it.

<p align="center">
  <img src=".github/images/screenshot-1.png" alt="screenshot 1" width="380" />
</p>

what caught my attention was a reply saying the hiring strategy was awesome, but they almost didn't read the post because of the linkedin formatting.

<p align="center">
  <img src=".github/images/screenshot-2.png" alt="screenshot 2" width="380" />
</p>

that was the unlock for me.

so i built this chrome extension to make the x version feel native while still fitting inside stanley by stan.store.

## what it does

- watches the draft inside stanley thread pages
- generates an x version side-by-side
- supports unverified (280 chars) and verified (25k chars) modes
- gives rewrite controls (shorter/longer + custom prompt)
- supports lowercase-only rewriting
- keeps revision history and lets you move between versions
- lets you edit the x text directly
- supports image attachments in x mode
- opens x compose and pre-fills the post text
- has an x-style preview modal so you can see the post before publishing

## features

### x mode ui
- linkedin/x mode toggle in the footer
- x-style header (name, handle, timestamp, x icon)
- compact toolbar with rewrite + revision navigation

### rewrite workflow
- quick chips for shorter and longer rewrites
- custom prompt input
- press enter to submit rewrite
- keeps output aligned to your current mode limits

### verified vs unverified
- unverified: `current/280 chars`
- verified: `current/25k chars`
- verified toggle updates the limit and generation behavior

### media + preview
- add up to 4 images
- remove images from the grid
- x preview modal shows text + attached images in tweet-like layout

### post handoff
- post button opens `https://x.com/compose/post`
- extension fills the compose textbox with your generated text
- it does not auto-post

## tradeoffs

- this is still limited because it does not truly understand your full x account context or post history the way stanley for linkedin understands linkedin context.
- on x, content quality usually matters more than formatting alone, so formatting fixes by themselves are not enough.
- x culture is very different from linkedin, and i am still actively learning and refining that translation layer.

## setup (local)

you only need 2 terminals: one for the extension and one for the backend.

### 1) install dependencies

```bash
pnpm install
```

### 2) add env file

create a `.env` in the project root:

```bash
GROQ_API_KEY=your_groq_key_here
```

optional:

```bash
GROQ_MODEL=llama-3.3-70b-versatile
PORT=8787
```

### 3) start backend

```bash
pnpm backend:dev
```

### 4) start extension dev server

in a new terminal:

```bash
pnpm dev
```

### 5) load extension in chrome

1. open `chrome://extensions`
2. enable developer mode
3. click "load unpacked"
4. select `.output/chrome-mv3-dev`

### 6) use it

1. go to <a href="https://stanley.stan.store" target="_blank">stanley.stan.store</a>
2. write or generate your linkedin draft
3. switch to x mode
4. review/edit/rewrite
5. preview post
6. click post to open x compose

## how to use it well

- start with your full linkedin draft in stanley
- switch to x mode and let it generate once
- use shorter/longer rewrite chips to tune voice
- use lowercase-only toggle when you want a more cracked style
- manually edit final lines before posting

## notes

- if you do not set `groq_api_key`, the app can still run in mock mode
- all x drafts are editable in-place
- refresh behavior uses saved draft/revision state per thread

<!-- add ui screenshots here -->
<!-- ![x mode ui](./images/x-mode-ui.png) -->
<!-- ![rewrite panel](./images/rewrite-panel.png) -->
<!-- ![preview modal](./images/preview-modal.png) -->
