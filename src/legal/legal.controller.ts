import { Controller, Get, Header } from '@nestjs/common';

const NAME = () => process.env.LEGAL_BUSINESS_NAME ?? 'Fabroniee';
const EMAIL = () => process.env.LEGAL_CONTACT_EMAIL ?? 'vivek.choudhary.0022@gmail.com';
const UPDATED = 'September 21, 2026';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(NAME())}</title>
<style>
  body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1a19; background: #fcfcfb; margin: 0; }
  main { max-width: 42rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.75rem; margin-bottom: .25rem; }
  h2 { font-size: 1.2rem; margin-top: 2rem; }
  .muted { color: #52514e; font-size: .9rem; }
  a { color: #2a78d6; }
  @media (prefers-color-scheme: dark) { body { background: #1a1a19; color: #f3f3f0; } .muted { color: #c3c2b7; } a { color: #6da7ec; } }
</style>
</head>
<body><main>
<h1>${esc(title)}</h1>
<p class="muted">${esc(NAME())} &middot; Last updated ${UPDATED}</p>
${body}
</main></body></html>`;
}

// Public pages that Meta asks for before an app can go Live.
@Controller()
export class LegalController {
  @Get('privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacy() {
    const n = esc(NAME());
    const e = esc(EMAIL());
    return page(
      'Privacy Policy',
      `
<p>This policy explains what information ${n} ("we", "us") handles when we manage our own Instagram business account through a private administration tool, and how you can ask us to delete it.</p>

<h2>Information we handle</h2>
<ul>
  <li><strong>Our Instagram business account data:</strong> profile details, posts, and account insights (such as reach and views), which we read to understand how our account is performing.</li>
  <li><strong>Direct messages sent to our account:</strong> when you send a message to our Instagram account, we receive your message text, any attachment, your Instagram username and your Instagram-scoped ID, so we can read and reply to it.</li>
  <li><strong>Photos and usernames you send us:</strong> if you send us a photo and your Instagram username for us to feature, we store the photo and username.</li>
  <li><strong>Access credentials:</strong> the access token that lets our tool act on our own Instagram account. It is stored encrypted.</li>
</ul>

<h2>How we use it</h2>
<ul>
  <li>To read and reply to messages you send us, including a thank-you message.</li>
  <li>To publish posts or stories, including featuring a photo you sent us and tagging your username, when you have sent it for that purpose.</li>
  <li>To review the performance of our own account.</li>
</ul>
<p>We do not sell your information, and we do not use it for advertising.</p>

<h2>Who can see it</h2>
<p>Only the people who operate our account. The data is stored on servers we control. Instagram and Meta process messages and posts under their own terms and privacy policies. Content you choose to have published on our Instagram account is public on Instagram.</p>
<p>If we use automated, AI-assisted replies, the text of your message or comment may be sent to an AI service provider (OpenRouter and the company that runs the model) so that a reply can be written. We give it only the text needed for that reply, and we do not use it for advertising.</p>

<h2>How long we keep it</h2>
<p>We keep messages and submitted photos for as long as needed to run our account and respond to you, and delete them on request.</p>

<h2>Your choices and deletion</h2>
<p>You can ask us to delete the information we hold about you at any time. See our <a href="/data-deletion">data deletion instructions</a> or email <a href="mailto:${e}">${e}</a>.</p>

<h2>Changes</h2>
<p>We may update this policy and will change the date above when we do.</p>

<h2>Contact</h2>
<p><a href="mailto:${e}">${e}</a></p>`,
    );
  }

  @Get('data-deletion')
  @Header('Content-Type', 'text/html; charset=utf-8')
  dataDeletion() {
    const n = esc(NAME());
    const e = esc(EMAIL());
    return page(
      'Data Deletion Instructions',
      `
<p>You can ask ${n} to delete the information we hold about you.</p>

<h2>How to request deletion</h2>
<ol>
  <li>Email <a href="mailto:${e}">${e}</a> with the subject <strong>"Delete my data"</strong>.</li>
  <li>Include your Instagram username, so we can find the messages, photos and other information linked to it.</li>
  <li>We will confirm by email and delete the information within 30 days.</li>
</ol>

<h2>What is deleted</h2>
<ul>
  <li>Messages you sent to our Instagram account, as stored in our administration tool.</li>
  <li>Photos and usernames you submitted to us.</li>
</ul>
<p class="muted">Content already published on Instagram, and messages stored by Instagram itself, are controlled by Instagram. You can manage those in the Instagram app. If you would like a post that features you removed from our account, tell us in your email and we will delete it.</p>

<p>Read our <a href="/privacy">Privacy Policy</a>.</p>`,
    );
  }
}
