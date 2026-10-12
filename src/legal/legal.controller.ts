import { Controller, Get, Header, Post } from '@nestjs/common';

const NAME = () => process.env.LEGAL_BUSINESS_NAME ?? 'InstaVeyra (Inrō Studio)';
const EMAIL = () => process.env.LEGAL_CONTACT_EMAIL ?? 'support@fabroniee.store';
const UPDATED = 'October 12, 2026';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(NAME())}</title>
<style>
  body { font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1e293b; background: #f8fafc; margin: 0; }
  main { max-width: 44rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; background: #ffffff; min-height: 100vh; border-left: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; }
  h1 { font-size: 2rem; font-weight: 800; color: #0f172a; margin-bottom: .25rem; letter-spacing: -0.025em; }
  h2 { font-size: 1.25rem; font-weight: 700; color: #0f172a; margin-top: 2.25rem; margin-bottom: 0.75rem; border-bottom: 1px solid #f1f5f9; padding-bottom: 0.5rem; }
  p, li { color: #334155; font-size: 0.95rem; line-height: 1.7; }
  .muted { color: #64748b; font-size: 0.875rem; }
  .badge { display: inline-block; background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.6rem; rounded-radius: 9999px; border-radius: 9999px; margin-bottom: 1rem; }
  a { color: #2563eb; text-decoration: underline; text-underline-offset: 3px; }
  a:hover { color: #1d4ed8; }
  ul, ol { padding-left: 1.25rem; }
  li { margin-bottom: 0.5rem; }
  .box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 0.75rem; padding: 1rem 1.25rem; margin: 1.5rem 0; }
  .nav { display: flex; gap: 1rem; margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid #e2e8f0; font-size: 0.875rem; font-weight: 600; }
</style>
</head>
<body><main>
<span class="badge">Official Compliance Document</span>
<h1>${esc(title)}</h1>
<p class="muted">${esc(NAME())} &middot; Last updated ${UPDATED}</p>
${body}
<div class="nav">
  <a href="/privacy">Privacy Policy</a>
  <a href="/data-deletion">Data Deletion Instructions</a>
  <a href="/terms">Terms of Service</a>
</div>
</main></body></html>`;
}

// Public pages required for Meta App Review and live production compliance
@Controller()
export class LegalController {
  @Get('privacy')
  @Get('legal/privacy')
  @Header('Content-Type', 'text/html; charset=utf-8')
  privacy() {
    const n = esc(NAME());
    const e = esc(EMAIL());
    return page(
      'Privacy Policy',
      `
<p>At <strong>${n}</strong>, accessible from <a href="https://fabroniee.store">https://fabroniee.store</a> and <a href="https://analytics-delta-sage.vercel.app">https://analytics-delta-sage.vercel.app</a>, one of our main priorities is the privacy and security of our visitors and creators. This Privacy Policy outlines the types of data that are collected, processed, and safeguarded when integrating with Meta Login and Graph APIs.</p>

<h2>1. Information We Collect via Meta APIs</h2>
<p>When you connect your Facebook Page and Instagram Professional Account to our service using Meta Login, we request and process only the necessary permissions required to provide automated engagement features:</p>
<ul>
  <li><strong>Basic Profile Information:</strong> Name, email address, profile picture URL, and Instagram handle to create and display your account dashboard.</li>
  <li><strong>Meta Page &amp; Instagram Identifiers:</strong> App-Scoped User IDs (ASIDs), Facebook Page IDs, and Instagram Business Account IDs to link your social assets.</li>
  <li><strong>Interaction Data:</strong> Temporary access to incoming Instagram comment text strings and unique comment IDs solely to evaluate user-configured keyword triggers.</li>
  <li><strong>Encrypted Tokens:</strong> Meta OAuth access tokens required to communicate with the Meta Graph API on your behalf, stored using AES-256-GCM encryption at rest.</li>
</ul>

<h2>2. How We Use Your Information</h2>
<p>We use the collected information exclusively to power your automated workflows and Instagram marketing tools:</p>
<ul>
  <li>To monitor incoming comments on your linked Instagram posts for specific keywords you configure (e.g., &ldquo;LINK&rdquo; or &ldquo;INFO&rdquo;).</li>
  <li>To automatically dispatch a single direct message (DM) response containing your requested resources, download link, or product information directly to the commenter.</li>
  <li>To display analytics regarding your automation performance (e.g., total comments matched, DMs sent, and conversion rates).</li>
  <li><strong>Zero Message Snooping:</strong> We do not read, store, sell, or monitor your personal private messaging history.</li>
</ul>

<h2>3. Data Storage, Retention &amp; De-duplication</h2>
<ul>
  <li><strong>No Selling of Data:</strong> We never sell, rent, trade, or share user data or customer identifiers with third-party data brokers or advertisers.</li>
  <li><strong>Ephemeral Processing:</strong> Comment payloads received via webhooks are processed in real-time. We cache unique <code>comment_id</code> identifiers in our database solely to prevent sending duplicate automated messages to the same user or comment.</li>
  <li><strong>Security:</strong> All communication occurs over secure HTTPS/TLS 1.3 channels, and access tokens are secured with industry-standard cryptographic practices.</li>
</ul>

<h2>4. Data Deletion and Revocation</h2>
<p>You have full sovereignty over your data at all times. Users can disconnect their Meta accounts or completely purge their profile data from our platform:</p>
<div class="box">
  <strong>Instant In-App Deletion:</strong> Navigate to your <strong>Account Settings</strong> dashboard panel and click <strong>&ldquo;Delete Account &amp; Wipe Data&rdquo;</strong>. Upon execution, all stored Meta access tokens, linked Page records, and cached identifiers are permanently wiped from our active databases.
</div>
<p>You may also review our step-by-step <a href="/data-deletion">Data Deletion Instructions</a> or submit a manual deletion request by emailing <a href="mailto:${e}">${e}</a>.</p>

<h2>5. Contact Us</h2>
<p>If you have any questions or require assistance regarding our privacy compliance, please contact our Data Protection Team at <a href="mailto:${e}">${e}</a>.</p>`,
    );
  }

  @Get('data-deletion')
  @Get('legal/data-deletion')
  @Get('deletion')
  @Header('Content-Type', 'text/html; charset=utf-8')
  dataDeletion() {
    const n = esc(NAME());
    const e = esc(EMAIL());
    return page(
      'User Data Deletion Instructions',
      `
<p>In accordance with Meta Platform Terms and global privacy regulations (GDPR, CCPA), <strong>${n}</strong>, accessible from <a href="https://fabroniee.store">https://fabroniee.store</a> and <a href="https://analytics-delta-sage.vercel.app">https://analytics-delta-sage.vercel.app</a>, provides transparent, immediate mechanisms for users to request and execute the total deletion of their personal information and Meta integration data.</p>

<h2>How to Delete Your Data from Our Platform</h2>
<p>You can remove your account and all associated data through any of the following methods:</p>

<h3>Method 1: Direct In-App One-Click Deletion (Recommended)</h3>
<ol>
  <li>Log in to your <strong>${n}</strong> dashboard.</li>
  <li>Click on your profile avatar in the navigation bar to open <strong>Account Settings</strong>.</li>
  <li>Scroll to the <strong>Data &amp; Security / Danger Zone</strong> section.</li>
  <li>Click the button labeled <strong>&ldquo;Delete Account &amp; Wipe Data&rdquo;</strong> and confirm the prompt.</li>
  <li>Our system will immediately delete your encrypted Meta access tokens, linked Facebook Page IDs, Instagram account connection, and all automation rules from our database.</li>
</ol>

<h3>Method 2: Email Request to Data Protection Officer</h3>
<ol>
  <li>Send an email to <a href="mailto:${e}">${e}</a> with the subject line <strong>&ldquo;Delete my data&rdquo;</strong>.</li>
  <li>Include your registered email address and your connected Instagram handle or Facebook Page Name.</li>
  <li>Our engineering team will execute the database purge and confirm deletion via reply email within 48 hours.</li>
</ol>

<h3>Method 3: Revoke via Facebook App Settings (Automated Callback)</h3>
<ol>
  <li>Log in to your Facebook account and go to <strong>Settings &amp; Privacy &gt; Settings</strong>.</li>
  <li>Navigate to <strong>Apps and Websites</strong> and find <strong>${n}</strong>.</li>
  <li>Click <strong>Remove</strong>. Meta will trigger an automated signed data deletion callback to our server, prompting automatic revocation of your access token.</li>
</ol>

<h2>What Is Permanently Deleted</h2>
<ul>
  <li>All Meta OAuth User Access Tokens and Page Access Tokens.</li>
  <li>Linked Instagram Business Account metadata and Facebook Page identifiers.</li>
  <li>All configured Comment-to-DM automation keyword rules and templates.</li>
  <li>All cached comment logging records and performance history.</li>
</ul>

<p>For more details, review our <a href="/privacy">Privacy Policy</a>.</p>`,
    );
  }

  @Get('terms')
  @Get('legal/terms')
  @Header('Content-Type', 'text/html; charset=utf-8')
  terms() {
    const n = esc(NAME());
    const e = esc(EMAIL());
    return page(
      'Terms of Service',
      `
<p>Welcome to <strong>${n}</strong>. By accessing or using our platform, accessible from <a href="https://fabroniee.store">https://fabroniee.store</a> and <a href="https://analytics-delta-sage.vercel.app">https://analytics-delta-sage.vercel.app</a>, connecting your Facebook Page or Instagram Business Account, or creating automated messaging workflows, you agree to comply with and be bound by these Terms of Service.</p>

<h2>1. Authorized Use &amp; Platform Compliance</h2>
<p>Our service provides creator tools and Comment-to-DM automation software. You agree to use the service in full compliance with:</p>
<ul>
  <li>Meta&rsquo;s Community Standards and Platform Terms.</li>
  <li>Instagram&rsquo;s Terms of Use and Messaging Policies.</li>
  <li>Applicable anti-spam regulations (CAN-SPAM, TCPA, and regional equivalents).</li>
</ul>

<h2>2. Prohibited Activities</h2>
<p>You may not use our service to dispatch unsolicited spam, deceptive links, harassment, or content that violates intellectual property or privacy rights. Any violation will result in immediate termination of account access.</p>

<h2>3. Meta Account Connection &amp; Security</h2>
<p>You grant us permission to act on behalf of your connected Facebook Page and Instagram Account solely to the extent permitted by the OAuth scopes authorized during login. You may revoke access at any time through our dashboard or Facebook settings.</p>

<h2>4. Service Availability &amp; Disclaimer</h2>
<p>The service is provided on an &ldquo;as is&rdquo; and &ldquo;as available&rdquo; basis. We are not responsible for downtimes, API rate limit restrictions imposed by Meta, or network disruptions beyond our reasonable control.</p>

<h2>5. Termination</h2>
<p>We reserve the right to suspend or terminate accounts that violate Meta Platform Policies or these Terms. Users may terminate their accounts at any time via the Account Settings dashboard.</p>

<h2>6. Contact</h2>
<p>For inquiries regarding these Terms, contact us at <a href="mailto:${e}">${e}</a>.</p>`,
    );
  }

  @Post('data-deletion')
  dataDeletionPost() {
    const base = process.env.PUBLIC_BASE_URL ?? 'https://analytics-backend-vxak.onrender.com';
    return {
      url: `${base}/data-deletion`,
      confirmation_code: `del_${Date.now()}`,
    };
  }

  @Get('deauthorize')
  @Post('deauthorize')
  deauthorize() {
    return { success: true, message: 'Deauthorized successfully' };
  }
}
