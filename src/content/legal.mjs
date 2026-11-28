// In-app legal pages.
//
// PRIVACY_HTML renders the current corrected privacy draft
// (QuotePilotAI_Privacy_Policy_DRAFT_2026-11-25.md, verified-facts pass
// 2026-11-27) verbatim in substance — including every remaining bracketed
// gate, which stays visible on the page exactly as it stands in the draft.
// The draft is NOT published policy: it carries its DRAFT banner, and final
// publication still requires counsel review + founder authorization.
//
// TERMS_HTML is a DRAFT authored 2026-11-27 only from facts verified in the
// deployment-readiness audit and the capability inventory (deterministic
// pricing, $19/mo via Gumroad, gated external actions, no AI). It is marked
// DRAFT on the page and requires founder/counsel review before reliance.

const page=(title,body)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${title} — QuotePilot</title><link rel="stylesheet" href="/app.css"/></head>
<body><div class="login-wrap"><section class="login-card" style="max-width:760px"><div class="eyebrow">THE RUSSELL MADISON GROUP, LLC</div>${body}<p class="fine"><a href="/">Back to QuotePilot</a></p></section></div></body></html>`;

export const PRIVACY_HTML=page('Privacy Policy (Draft)',`
<h1>QuotePilot AI — Privacy Policy <span>(DRAFT)</span></h1>
<p class="notice"><b>DRAFT — FOR COUNSEL REVIEW — NOT PUBLISHED — 2026-11-25.</b> Revised 2026-11-26 per in-house legal review memo. Verified-facts pass 2026-11-27: infrastructure providers named (hosting: Vercel; database/storage: Airtable; security-state database: Neon); AI processing and sharing statements removed — the audited codebase contains no AI integration and pricing is deterministic (founder ruling 2026-11-27). Operating entity: The Russell Madison Group LLC (New York) — "TRMG", "we", "us". Product: QuotePilot AI (SaaS) — RM Software. Price: $19/month (founder-ruled Nov 25, 2026). Status: PREDEPLOYMENT. Effective date: [TO SET AT FOUNDER-AUTHORIZED PUBLICATION — no date is in force for a draft].</p>
<p>This Privacy Policy describes how The Russell Madison Group, LLC handles information in connection with <b>QuotePilot AI</b>, quote and proposal drafting for the top 25 trades that would benefit from using the app. [TO SET — the list of the top 25 trades.]</p>
<h2>1. Information we process</h2>
<ul>
<li>Account data. Name, email address, and account identifiers for the customer account. [FOUNDER TO CONFIRM — exact account fields.]</li>
<li>Quote / proposal content data. Business details, line items, pricing figures, and draft quote or proposal text that the customer enters or that the product generates. Quotes are drafts; the customer verifies all pricing before sending.</li>
<li>Estimate processing data. Quote content is processed by QuotePilot's built-in pricing engine, which calculates estimates deterministically from the customer's own pricing rules. QuotePilot does not use third-party AI services. [CORRECTED 2026-11-27 per code audit — the production codebase contains no AI integration; founder ruled 2026-11-27 to launch as the deterministic quoting tool.]</li>
<li>Operational data. Internal task and workflow records created in the course of operating the service.</li>
</ul>
<h2>2. How we use information</h2>
<p>We use the information above solely to operate QuotePilot AI: creating and returning quote and proposal drafts to the customer, maintaining the customer's account, and reviewing the service's own performance. We do not sell personal information. We do not use customer data for third-party advertising, and we do not build profiles of third-party individuals named in customer content.</p>
<h2>3. Sharing</h2>
<p>We do not share account, content, or operational data with third parties, except (a) with Gumroad, the checkout of record, as required to process payment; and (b) with the infrastructure providers that host and run QuotePilot AI — Vercel (application hosting), Airtable (database and storage), and Neon (security-state database) — under their standard security terms, solely to run the product. QuotePilot does not send email and uses no email service provider. [Providers CONFIRMED 2026-11-27 per code audit.]</p>
<p class="fine">Note (2026-11-27 build): the statement "QuotePilot does not send email" described the pre-build product. The current build adds configuration-gated email/SMS capability; when a deployment enables a messaging provider, that provider also processes message content solely to deliver it. This sentence must be reconciled by counsel before publication.</p>
<h2>4. Security</h2>
<p>Access to QuotePilot AI is restricted to authorized users through authenticated sign-in. Passwords are stored only as salted scrypt hashes and are never displayed after they are saved. Sign-in sessions use signed session cookies protected by CSRF and origin checks, and sign-in is rate-limited to resist automated attacks. Customer data is scoped to the customer's own business account. Data is transmitted over encrypted (TLS) connections only. (Security controls confirmed against the production codebase by engineering audit, 2026-11-27.)</p>
<h2>5. Retention and deletion</h2>
<p>Account and content data are retained while the customer's account remains active. After an account is closed, or when the customer asks us to delete their data, we delete account and content data within 30 days, and from backups within 90 days, except for records we must keep by law. [COUNSEL TO CONFIRM — retention periods.] Customers may delete their own quotes and proposals inside the product, and may request deletion of their account and data by emailing the contact below. [FOUNDER TO CONFIRM — the in-product deletion mechanism.]</p>
<h2>6. Cookies</h2>
<p>QuotePilot AI uses only essential session cookies required to keep authorized users signed in. It does not use advertising or cross-site tracking cookies.</p>
<h2>7. Children</h2>
<p>QuotePilot AI is not directed to children. You must be 18 years or older to use it, and we do not knowingly collect information from anyone under 18. [COUNSEL TO CONFIRM — minimum user age.]</p>
<h2>8. Changes to this policy</h2>
<p>We may update this Privacy Policy from time to time. The effective date at the top will be revised when changes are made, and the current version will always be available at [TO SET AT PUBLICATION]. When we make a material change, we will tell users by posting a notice at the publication URL with a new effective date, and by email or in-product notice where the product has that channel.</p>
<h2>9. Contact</h2>
<p>The Russell Madison Group, LLC — Email: admin@therussellmadisongroup.com. Support for all products: admin@therussellmadisongroup.com.</p>`);

export const TERMS_HTML=page('Terms of Service (Draft)',`
<h1>QuotePilot — Terms of Service <span>(DRAFT)</span></h1>
<p class="notice"><b>DRAFT — FOUNDER/COUNSEL REVIEW REQUIRED — NOT IN FORCE.</b> This draft was prepared 2026-11-27 from product facts verified in the QuotePilot deployment-readiness audit and capability inventory. It has not been reviewed by counsel and must not be relied on until the founder authorizes publication.</p>
<h2>1. The service</h2>
<p>QuotePilot is an operator workspace for service businesses, provided by The Russell Madison Group, LLC ("TRMG"). It records customer inquiries, calculates estimates with a deterministic pricing engine using the business's own pricing rules, supports an internal approval workflow, records booking requests and — when the business enables it — booking confirmations, and prepares and — when the business enables it — sends customer follow-ups and estimates. QuotePilot does not use artificial intelligence; every price is computed from the business's own rules by a fixed formula.</p>
<h2>2. Accounts</h2>
<p>Accounts are issued per business. The business is responsible for its users' activity and for keeping credentials confidential. Self-serve signup, where enabled, creates an account in onboarding status; TRMG may suspend accounts that violate these terms.</p>
<h2>3. Pricing and payment</h2>
<p>QuotePilot is offered at $19 per month, billed through Gumroad, the checkout of record. Estimates QuotePilot calculates for a business's own customers are that business's responsibility: the business must verify pricing, scope, and availability before relying on or sending any estimate. A booking confirmation recorded in QuotePilot is the business's own confirmation to its customer; QuotePilot does not check any external availability system.</p>
<h2>4. Customer communications</h2>
<p>Customer messaging (email and SMS) is disabled unless the business's deployment enables it. When enabled, the business is responsible for having its customers' consent to be contacted and for honoring opt-outs; QuotePilot records consent and opt-out state on each lead and refuses sends that lack consent.</p>
<h2>5. Acceptable use</h2>
<p>Do not use QuotePilot to send unsolicited bulk messages, to upload executable or malicious files, or to store unlawful content. Uploads are limited to the file types and sizes the product accepts.</p>
<h2>6. Availability and liability</h2>
<p>[COUNSEL TO DRAFT — availability commitments, limitation of liability, indemnity, governing law, and dispute terms are legal provisions that require counsel; no statement in this draft creates any such commitment.]</p>
<h2>7. Changes</h2>
<p>TRMG may update these terms; the current version will be posted at this page with its effective date once published. [TO SET AT PUBLICATION — effective date.]</p>
<h2>8. Contact</h2>
<p>The Russell Madison Group, LLC — admin@therussellmadisongroup.com.</p>`);
