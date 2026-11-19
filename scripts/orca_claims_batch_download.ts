import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, Page } from '@playwright/test';
import { OrcaScreenManager } from '@pages/page-managers/orca-page-manager';
import { HamburgerMenuOptions } from '@pages/orca/common-section/menu-top-section';
import { TabClaimOptions } from '@pages/orca/claim/tabs-claim-detail-section';
import { loginToOrca } from '@utils/login-orca-util';
import { Role } from '@utils/user-credentials-util';

type AttachmentRecord = {
  claim_id: string;
  source_url: string;
  display_name: string;
  row_text: string;
  saved_path?: string;
  sha256?: string;
  content_type?: string;
  bytes?: number;
  status: string;
  reason?: string;
};

const BASE_URL = (process.env.ORCA_BASE_URL || 'https://orca.qas.petpartners.com').replace(/\/+$/, '');
const LOGIN_URL = process.env.ORCA_LOGIN_URL || `${BASE_URL}/account/login?returnUrl=%2F`;
const DOWNLOAD_DIR = path.resolve(process.env.ORCA_DOWNLOAD_DIR || 'download/orca-attachments');
const RAW_DIR = path.resolve(process.env.ORCA_RAW_ATTACHMENT_DIR || path.join(DOWNLOAD_DIR, '_all_downloads'));
const MANIFEST_PATH = path.resolve(process.env.ORCA_MANIFEST_PATH || 'batch_manifest.json');
const QUEUE_URL = process.env.ORCA_CLAIMS_INBOX_URL || '';
const SUPPORTED = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp']);
const ROLE_MAP: Record<string, Role> = {
  admin: Role.Admin,
  claim_specialist: Role.ClaimSpecialist,
  claim_admin: Role.ClaimAdmin,
  claim_auditor: Role.ClaimAuditor,
  finance: Role.Finance
};

function safePart(value: string): string {
  return (value || 'attachment').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 110) || 'attachment';
}
function claimIdFromRow(html: string, text: string): string | null {
  const patterns = [
    /ClaimDetail(?:\/|%2f)[^"'<>]*?claimId[=%3D]+(\d+)/i,
    /[?&]claimId=(\d+)/i,
    /data-claim-id=["'](\d+)["']/i,
    /data-claimid=["'](\d+)["']/i,
    /name=["'](?:ClaimId|claimId)["'][^>]*value=["'](\d+)["']/i,
    /value=["'](\d+)["'][^>]*name=["'](?:ClaimId|claimId)["']/i
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  // Only accept a long numeric token when it is associated with a claim-labelled row.
  if (/\bclaim\b/i.test(text)) {
    const match = text.match(/\b(?:claim\s*(?:number|#|id)?\s*[:#-]?\s*)(\d{5,})\b/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function collectClaimIds(page: Page): Promise<string[]> {
  const table = page.locator('#claim-table');
  await table.waitFor({ state: 'visible', timeout: 60_000 });

  // Prefer the inbox's explicit "All Rows" page-size option when it exists.
  const sizeSelect = page.locator('select.pagesize, #claim-table_length select').first();
  if (await sizeSelect.count()) {
    const options = await sizeSelect.locator('option').allTextContents();
    const allIndex = options.findIndex(x => /all\s*rows|all/i.test(x.trim()));
    if (allIndex >= 0) {
      const values = await sizeSelect.locator('option').evaluateAll(opts => opts.map(o => (o as HTMLOptionElement).value));
      await sizeSelect.selectOption(values[allIndex]);
      await page.waitForTimeout(700);
    }
  }

  const found = new Set<string>();
  const visitedPageSignatures = new Set<string>();
  for (let pageNo = 0; pageNo < 1000; pageNo += 1) {
    const rows = table.locator('tbody tr');
    const rowCount = await rows.count();
    const signature = (await table.innerText()).slice(0, 4000);
    if (visitedPageSignatures.has(signature)) break;
    visitedPageSignatures.add(signature);

    for (let i = 0; i < rowCount; i += 1) {
      const row = rows.nth(i);
      const html = await row.evaluate(el => (el as HTMLElement).outerHTML);
      const text = (await row.innerText()).trim();
      const id = claimIdFromRow(html, text);
      if (id) found.add(id);
    }

    const next = page.locator(
      '#claim-table_next:not(.disabled) a, #claim-table_next:not(.disabled), ' +
      '.dataTables_paginate .paginate_button.next:not(.disabled), ' +
      'a[aria-label="Next"]:not([aria-disabled="true"])'
    ).first();
    if (!(await next.count()) || !(await next.isVisible().catch(() => false))) break;
    const before = signature;
    await next.click();
    await page.waitForTimeout(650);
    const after = (await table.innerText()).slice(0, 4000);
    if (!after || after === before) break;
  }
  return [...found];
}

async function collectAttachmentLinks(page: Page): Promise<Array<{href: string; name: string; rowText: string}>> {
  return await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'));
    const records: Array<{href: string; name: string; rowText: string}> = [];
    for (const a of anchors) {
      const href = a.href || '';
      if (!href || href.startsWith('javascript:') || href.endsWith('#')) continue;
      const row = a.closest('.row-fluid') as HTMLElement | null;
      const hasDocumentRow = !!row?.querySelector('.span2.edit, .span3.edit');
      const isTargetBlank = (a.target || '').toLowerCase() === '_blank';
      const extMatch = /\.(pdf|png|jpe?g|tiff?|webp|docx?|xlsx?|csv)(?:$|[?#])/i.test(href);
      if (!hasDocumentRow && !isTargetBlank && !extMatch) continue;
      const rowText = (row?.innerText || a.parentElement?.innerText || a.innerText || '').trim().replace(/\s+/g, ' ');
      const name = (a.innerText || a.getAttribute('title') || a.getAttribute('aria-label') || rowText || '').trim();
      records.push({ href, name, rowText });
    }
    const seen = new Set<string>();
    return records.filter(r => {
      if (seen.has(r.href)) return false;
      seen.add(r.href);
      return true;
    });
  });
}

async function visitAttachmentViews(page: Page, claimId: string): Promise<Array<{href: string; name: string; rowText: string}>> {
  const detailUrl = `${BASE_URL}/Claim/ClaimDetail?claimId=${encodeURIComponent(claimId)}`;
  const orca = new OrcaScreenManager(page);
  await page.goto(detailUrl, { waitUntil: 'domcontentloaded' });
  await orca.claimDetailPage.tabsClaimDetailSection.openTab(TabClaimOptions.attachmentTab);

  const combined = new Map<string, {href: string; name: string; rowText: string}>();
  const merge = async () => {
    for (const item of await collectAttachmentLinks(page)) combined.set(item.href, item);
  };

  // This is the attachment expansion used by the repository's existing single-claim test.
  const claimsResult = page.locator("a:has-text('Claims -')").first();
  if (await claimsResult.count() && await claimsResult.isVisible().catch(() => false)) {
    await claimsResult.click();
    await page.waitForTimeout(600);
  }
  await merge();

  // Also inspect the "Other" attachment view and any attachment placeholder views.
  const other = page.locator("a[data-placeholder-id='attachments-other']").first();
  if (await other.count() && await other.isVisible().catch(() => false)) {
    await other.click();
    await page.waitForTimeout(450);
    await merge();
  }
  const placeholderLinks = page.locator("a[data-placeholder-id$='-attachments']");
  const count = Math.min(await placeholderLinks.count(), 20);
  for (let i = 0; i < count; i += 1) {
    const link = placeholderLinks.nth(i);
    if (!(await link.isVisible().catch(() => false))) continue;
    await link.click().catch(() => undefined);
    await page.waitForTimeout(350);
    await merge();
  }
  return [...combined.values()];
}

function extensionFor(url: string, contentType: string, bytes: Buffer): string {
  const urlExt = path.extname(new URL(url).pathname).toLowerCase();
  if (bytes.subarray(0, 5).toString() === '%PDF-') return '.pdf';
  if (bytes[0] === 0x89 && bytes.subarray(1, 4).toString() === 'PNG') return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
  if (contentType.includes('tiff')) return '.tiff';
  if (contentType.includes('webp')) return '.webp';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (SUPPORTED.has(urlExt)) return urlExt;
  return urlExt || '.bin';
}

async function saveClaimAttachments(page: Page, claimId: string, records: AttachmentRecord[], hashes: Map<string, string>) {
  const links = await visitAttachmentViews(page, claimId);
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index];
    const absoluteUrl = new URL(link.href, page.url()).toString();
    try {
      const response = await page.request.get(absoluteUrl, { timeout: 60_000 });
      if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
      const bytes = Buffer.from(await response.body());
      if (!bytes.length) throw new Error('Empty attachment response');
      const contentType = (response.headers()['content-type'] || '').split(';')[0].toLowerCase();
      const ext = extensionFor(absoluteUrl, contentType, bytes);
      const sha = crypto.createHash('sha256').update(bytes).digest('hex');
      const duplicate = hashes.get(`${claimId}:${sha}`);
      const displayName = link.name || path.basename(new URL(absoluteUrl).pathname) || `attachment_${index + 1}`;
      const filename = `${safePart(claimId)}__${String(index + 1).padStart(3, '0')}__${safePart(path.parse(displayName).name)}${ext}`;
      const targetDir = SUPPORTED.has(ext) ? DOWNLOAD_DIR : RAW_DIR;
      await fs.mkdir(targetDir, { recursive: true });
      if (duplicate) {
        records.push({
          claim_id: claimId, source_url: absoluteUrl, display_name: displayName, row_text: link.rowText,
          sha256: sha, bytes: bytes.length, content_type: contentType, status: 'duplicate',
          reason: `Same content already downloaded for this claim: ${duplicate}`
        });
        continue;
      }
      const savedPath = path.join(targetDir, filename);
      await fs.writeFile(savedPath, bytes);
      hashes.set(`${claimId}:${sha}`, savedPath);
      const looksLikePdf = bytes.subarray(0, 5).toString() === '%PDF-';
      const looksLikeImage = ext !== '.pdf' && SUPPORTED.has(ext);
      if (ext === '.pdf' && !looksLikePdf) {
        records.push({
          claim_id: claimId, source_url: absoluteUrl, display_name: displayName, row_text: link.rowText,
          saved_path: savedPath, sha256: sha, bytes: bytes.length, content_type: contentType,
          status: 'downloaded_but_not_pdf', reason: 'URL/content type suggested PDF but PDF signature was absent'
        });
      } else {
        records.push({
          claim_id: claimId, source_url: absoluteUrl, display_name: displayName, row_text: link.rowText,
          saved_path: savedPath, sha256: sha, bytes: bytes.length, content_type: contentType,
          status: SUPPORTED.has(ext) && (looksLikePdf || looksLikeImage) ? 'downloaded_supported' : 'downloaded_unsupported',
          reason: SUPPORTED.has(ext) ? undefined : `File type ${ext} is archived but not supported by the existing OCR notebook`
        });
      }
    } catch (error) {
      records.push({
        claim_id: claimId, source_url: absoluteUrl, display_name: link.name, row_text: link.rowText,
        status: 'download_failed', reason: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function main() {
  await fs.mkdir(DOWNLOAD_DIR, { recursive: true });
  await fs.mkdir(RAW_DIR, { recursive: true });
  await fs.mkdir(path.dirname(MANIFEST_PATH), { recursive: true });

  const manifest: any = {
    started_at: new Date().toISOString(),
    base_url: BASE_URL,
    queue: QUEUE_URL || 'Claims Team Inbox',
    scope: 'all claims returned by Claims Team Inbox; all attachment views exposed by the claim Attachments tab',
    claims_discovered: [],
    claims_processed: [],
    attachments: [],
    claim_errors: []
  };

  const roleKey = (process.env.ORCA_ROLE || 'admin').toLowerCase();
  const role = ROLE_MAP[roleKey];
  if (!role) throw new Error(`Unsupported ORCA_ROLE "${roleKey}". Use one of: ${Object.keys(ROLE_MAP).join(', ')}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  });
  try {
    const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.setDefaultTimeout(45_000);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await loginToOrca(page, role);
    await page.waitForTimeout(900);

    const orca = new OrcaScreenManager(page);
    if (QUEUE_URL) {
      await page.goto(QUEUE_URL, { waitUntil: 'domcontentloaded' });
    } else {
      await orca.menuTopSection.chooseMenuEntry(HamburgerMenuOptions.Claims);
      if (!(await page.locator('#claim-table').count())) {
        const inboxButton = orca.claimDashboard.claimTeamInboxButton;
        if (!(await inboxButton.isDisplayed(10_000))) {
          throw new Error('Claims dashboard opened, but "Claims Team Inbox" was not visible. Set ORCA_CLAIMS_INBOX_URL to the verified inbox URL for this environment.');
        }
        await inboxButton.clickAndWait();
      }
    }

    const claimIds = await collectClaimIds(page);
    manifest.claims_discovered = claimIds;
    if (!claimIds.length) {
      throw new Error('No claim IDs could be read from #claim-table. No claims were processed; inspect the inbox DOM/permissions before retrying.');
    }

    const hashes = new Map<string, string>();
    for (const claimId of claimIds) {
      try {
        const before = manifest.attachments.length;
        await saveClaimAttachments(page, claimId, manifest.attachments, hashes);
        manifest.claims_processed.push({
          claim_id: claimId,
          attachment_records: manifest.attachments.length - before,
          downloaded_supported: manifest.attachments.filter((a: AttachmentRecord) => a.claim_id === claimId && a.status === 'downloaded_supported').length
        });
      } catch (error) {
        manifest.claim_errors.push({
          claim_id: claimId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    manifest.finished_at = new Date().toISOString();
    manifest.summary = {
      claims_discovered: claimIds.length,
      claims_processed: manifest.claims_processed.length,
      claim_errors: manifest.claim_errors.length,
      attachment_records: manifest.attachments.length,
      supported_downloads: manifest.attachments.filter((a: AttachmentRecord) => a.status === 'downloaded_supported').length,
      unsupported_downloads: manifest.attachments.filter((a: AttachmentRecord) => a.status === 'downloaded_unsupported').length,
      download_failures: manifest.attachments.filter((a: AttachmentRecord) => a.status === 'download_failed').length
    };
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    console.log(JSON.stringify(manifest.summary, null, 2));
    if (!manifest.claims_processed.length) throw new Error('Claims were discovered but no claim attachment page completed successfully. See manifest.');
  } catch (error) {
    manifest.finished_at = new Date().toISOString();
    manifest.fatal_error = error instanceof Error ? error.message : String(error);
    await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('[ORCA batch download failed]', error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
