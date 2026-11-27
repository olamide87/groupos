import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
const url = new URL(process.env.DATABASE_URL ?? '');
if (!/^groupos_test_[a-f0-9]{32}$/.test(process.env.GROUPOS_TEST_DATABASE ?? '') || url.pathname !== `/${process.env.GROUPOS_TEST_DATABASE}`) throw new Error('Use disposable dashboard runner');
const db = new PrismaClient();
test.afterAll(async () => db.$disconnect());
const password = 'Synthetic testing password 2468!';
async function register(page: Page) {
  const email = `${randomUUID()}@example.test`;
  await page.goto('/account'); await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Synthetic Organizer'); await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard$/); await expect(page.getByRole('heading', { name: 'Hello, Synthetic Organizer.' })).toBeVisible();
  return email;
}
async function createEvent(page: Page, title = 'Synthetic park outing') {
  await page.getByRole('button', { name: 'Create event', exact: true }).click();
  await page.getByLabel('Event title').fill(title); await page.getByLabel('Location', { exact: true }).fill('Synthetic park'); await page.getByLabel('Event status').selectOption('OPEN'); await page.getByRole('button', { name: 'Save event', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  return new URL(page.url()).searchParams.get('event')!;
}
async function createPoll(page: Page, kind: string, question: string) {
  await page.getByRole('button', { name: 'Create poll', exact: true }).click(); const form = page.getByRole('form', { name: 'Create poll', exact: true });
  await form.getByLabel('Poll question').fill(question); await form.getByLabel('Poll type').selectOption(kind);
  for (const [i, label] of ['Walk', 'Museum'].entries()) {
    const option = form.getByRole('group', { name: `Option ${i + 1}`, exact: true }); await option.getByLabel('Label', { exact: true }).fill(label);
    if (kind === 'BUDGET') await option.getByLabel('Amount', { exact: true }).fill(String((i + 1) * 25));
    if (kind === 'DATE') { const date = new Date(Date.now() + (i + 2) * 86400000).toISOString().slice(0, 10); await option.getByLabel('Starts at (UTC)').fill(`${date}T12:00`); await option.getByLabel('Ends at (UTC)').fill(`${date}T13:00`); }
  }
  await form.getByRole('button', { name: 'Save poll' }).click(); await expect(page.getByRole('article', { name: question, exact: true })).toBeVisible();
}

test('organizer and participant complete event, invitation, RSVP and poll flows in a real browser', async ({ page, browser, context }) => {
  await register(page); await expect(page.getByText('No events here yet')).toBeVisible(); const id = await createEvent(page);
  await page.getByRole('button', { name: 'Edit event', exact: true }).click(); await page.getByLabel('Description', { exact: true }).fill('Bring a picnic.'); await page.getByRole('button', { name: 'Save event' }).click(); await expect(page.getByText('Bring a picnic.', { exact: true })).toBeVisible();
  await page.getByLabel('Participant name').fill('Synthetic Guest');
  const issuance = page.waitForResponse(response => response.url().endsWith('/invitations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Generate invitation' }).click(); expect((await issuance).status()).toBe(201);
  const link = await page.getByLabel('Invitation link', { exact: true }).inputValue(); expect(link).toContain('/invite#event=');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']); await page.getByRole('button', { name: 'Copy invitation link' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.getByRole('button', { name: 'Polls & decisions' }).click(); await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(0);
  await createPoll(page, 'ACTIVITY', 'Which activity?');
  const card = page.getByRole('article', { name: 'Which activity?', exact: true }); await card.getByRole('button', { name: 'Edit poll' }).click(); await page.getByLabel('Poll question').fill('Choose an activity'); await page.getByRole('button', { name: 'Save poll' }).click();
  const guestContext = await browser.newContext(); const guest = await guestContext.newPage();
  try {
    await guest.goto(link); await guest.getByRole('button', { name: 'Accept invitation', exact: true }).click(); await expect(guest.getByText('Welcome, Synthetic Guest.')).toBeVisible();
    await guest.getByLabel('Response', { exact: true }).selectOption('YES'); await guest.getByRole('button', { name: 'Save RSVP' }).click(); await expect(guest.getByText('Your response is saved.')).toBeVisible();
    await guest.getByLabel('Walk', { exact: true }).check(); await guest.getByRole('button', { name: 'Save vote', exact: true }).click(); await expect(guest.getByText('Your vote is saved.')).toBeVisible();
    await page.getByRole('button', { name: 'Refresh polls', exact: true }).click(); const updated = page.getByRole('article', { name: 'Choose an activity', exact: true }); await expect(updated.getByText('1 of 1 responded', { exact: true })).toBeVisible();
    await updated.getByRole('button', { name: 'Close poll', exact: true }).click(); await updated.getByRole('button', { name: 'Confirm close poll', exact: true }).click(); await expect(page.getByText('ACTIVITY · CLOSED', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Participants & RSVPs' }).click(); await page.getByRole('button', { name: 'Refresh event' }).click(); await expect(page.getByText('100%', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Response history', exact: true }).click(); await expect(page.getByRole('region', { name: 'Response history' }).getByRole('listitem')).toContainText('YES');
    await page.getByRole('button', { name: 'Reissue for Synthetic Guest', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reissue for synthetic guest', exact: true }).click(); await expect(page.getByLabel('Invitation link', { exact: true })).toBeVisible();
    expect(await page.getByLabel('Invitation link', { exact: true }).inputValue()).not.toBe(link);
    await guest.getByRole('button', { name: 'Refresh polls' }).click(); await expect(guest.getByText(/Unable to load polls/)).toBeVisible();
    await page.getByRole('button', { name: 'Revoke for Synthetic Guest', exact: true }).click(); await page.getByRole('button', { name: 'Confirm revoke for synthetic guest', exact: true }).click(); await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(0); await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel event', exact: true }).click(); await page.getByRole('button', { name: 'Confirm cancel event', exact: true }).click(); await expect(page.getByText('CANCELLED', { exact: true })).toBeVisible();
    expect((await db.event.findUniqueOrThrow({ where: { id } })).status).toBe('CANCELLED');
    expect(await page.evaluate(() => Object.keys(localStorage).length + Object.keys(sessionStorage).length)).toBe(0);
    await page.screenshot({ path: '.local/dashboard-desktop.png', fullPage: true });
  } finally { await guestContext.close(); }
  await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page).toHaveURL(/\/account$/); await page.goto('/dashboard'); await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
});

test('mobile dashboard supports typed date and budget polls, cancellation, and keyboard navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await register(page); await createEvent(page, 'Mobile outing'); await page.getByRole('button', { name: 'Polls & decisions' }).click();
  await createPoll(page, 'DATE', 'Available times?'); await createPoll(page, 'BUDGET', 'Budget preference?');
  const budget = page.getByRole('article', { name: 'Budget preference?', exact: true }); await expect(budget.getByText(/25.00 USD/)).toBeVisible();
  await budget.getByRole('button', { name: 'Cancel poll', exact: true }).click(); await budget.getByRole('button', { name: 'Confirm cancel poll', exact: true }).click(); await expect(page.getByText('BUDGET · CANCELLED')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.keyboard.press('Control+Home'); await page.getByRole('link', { name: 'Skip to content' }).focus(); await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.screenshot({ path: '.local/dashboard-mobile.png', fullPage: true });
});

test('expired sessions clear private data and other organizers cannot open an event', async ({ page, browser }) => {
  const email = await register(page); const id = await createEvent(page, 'Private outing');
  const outsider = await browser.newContext(); const other = await outsider.newPage();
  try { await register(other); await other.goto(`/dashboard?event=${id}`); await expect(other.getByText('Event not found', { exact: true })).toBeVisible(); await expect(other.getByRole('heading', { name: 'Private outing', exact: true })).toHaveCount(0); } finally { await outsider.close(); }
  await db.authSession.updateMany({ where: { user: { email } }, data: { expiresAt: new Date(0) } });
  await page.getByRole('button', { name: 'Refresh event' }).click(); await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Private outing', exact: true })).toHaveCount(0);
});

test('loading, network failures and stale poll edits show recoverable states without silent retries', async ({ page }) => {
  await register(page); await createEvent(page, 'Error-state outing'); await page.getByRole('button', { name: 'Polls & decisions' }).click(); await createPoll(page, 'ACTIVITY', 'Original question?');
  await page.getByRole('button', { name: 'Edit poll' }).click(); const id = new URL(page.url()).searchParams.get('event')!; await db.poll.updateMany({ where: { eventId: id }, data: { version: { increment: 1 } } });
  await page.getByLabel('Poll question').fill('Stale question'); await page.getByRole('button', { name: 'Save poll' }).click(); await expect(page.getByText(/Poll changed; reload before editing/)).toBeVisible();
  await page.getByRole('button', { name: 'Discard poll edits' }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/v1/events/*/polls?*', async route => { await gate; await route.continue(); });
  try { await page.getByRole('button', { name: 'Refresh polls', exact: true }).click(); await expect(page.getByText('Loading polls…', { exact: true })).toBeVisible(); } finally { release(); }
  await expect(page.getByRole('article', { name: 'Original question?', exact: true })).toBeVisible(); await page.unroute('**/api/v1/events/*/polls?*');
  await page.route('**/api/v1/events/*/polls?*', route => route.abort()); await page.getByRole('button', { name: 'Refresh polls', exact: true }).click(); await expect(page.getByText('Unable to reach GroupOS. Check your connection and refresh.', { exact: true })).toBeVisible(); await page.unroute('**/api/v1/events/*/polls?*'); await page.getByRole('button', { name: 'Refresh polls', exact: true }).click(); await expect(page.getByRole('article', { name: 'Original question?', exact: true })).toBeVisible();
});

test('failed issuance retains input and failed reissue keeps confirmation open without success', async ({ page }) => {
  await register(page); const eventId = await createEvent(page);
  const endpoint = `**/api/v1/events/${eventId}/invitations`;
  await page.route(endpoint, route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Synthetic issuance failure' } }) : route.continue());
  await page.getByLabel('Participant name').fill('Retained guest'); await page.getByLabel('Link validity (hours)').fill('24');
  await page.getByRole('button', { name: 'Generate invitation' }).click();
  await expect(page.getByText(/Synthetic issuance failure/)).toBeVisible();
  await expect(page.getByLabel('Participant name')).toHaveValue('Retained guest'); await expect(page.getByLabel('Link validity (hours)')).toHaveValue('24');
  expect(await db.participant.count({ where: { eventId } })).toBe(0);
  await page.unroute(endpoint); await page.getByRole('button', { name: 'Generate invitation' }).click(); await expect(page.getByLabel('Invitation link', { exact: true })).toBeVisible();
  await page.route(endpoint, route => route.request().method() === 'POST' ? route.fulfill({ status: 503, json: { error: 'Synthetic reissue failure' } }) : route.continue());
  await page.getByRole('button', { name: 'Reissue for Retained guest', exact: true }).click(); await page.getByRole('button', { name: 'Confirm reissue for retained guest', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Confirm Reissue for Retained guest', exact: true });
  await expect(confirmation).toBeVisible(); await expect(confirmation.getByText(/Synthetic reissue failure/)).toBeVisible();
  await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(0);
  expect(await db.invitationToken.count({ where: { eventId } })).toBe(1);
});

test('revoked metadata clears invitation secrets and failed refreshes remove actionable stale state', async ({ page }) => {
  await register(page); const eventId = await createEvent(page, 'Refresh safety');
  await page.getByLabel('Participant name').fill('Refresh guest'); await page.getByRole('button', { name: 'Generate invitation' }).click(); await expect(page.getByLabel('Invitation link', { exact: true })).toBeVisible();
  await db.invitationToken.updateMany({ where: { eventId }, data: { revokedAt: new Date() } }); await page.getByRole('button', { name: 'Refresh event' }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible(); await expect(page.getByLabel('Invitation link', { exact: true })).toHaveCount(0);
  await page.route(`**/api/v1/events/${eventId}/invitations`, route => route.abort()); await page.getByRole('button', { name: 'Refresh event' }).click();
  await expect(page.getByText('Unable to reach GroupOS. Check your connection and refresh.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reissue for Refresh guest', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Generate invitation' })).toBeDisabled();
  await page.unroute(`**/api/v1/events/${eventId}/invitations`); await page.getByRole('button', { name: 'Refresh event' }).click(); await expect(page.getByRole('button', { name: 'Generate invitation' })).toBeEnabled();
  await page.getByRole('button', { name: 'Polls & decisions' }).click(); await createPoll(page, 'ACTIVITY', 'Fresh decisions');
  await page.route(`**/api/v1/events/${eventId}/polls?*`, route => route.abort()); await page.getByRole('button', { name: 'Refresh polls', exact: true }).click();
  await expect(page.getByText('Unable to reach GroupOS. Check your connection and refresh.', { exact: true })).toBeVisible();
  await expect(page.getByRole('article', { name: 'Fresh decisions' })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Create poll', exact: true })).toHaveCount(0);
  await page.unroute(`**/api/v1/events/${eventId}/polls?*`);
  await page.route(`**/api/v1/events/${eventId}`, route => route.fulfill({ status: 404, json: { error: 'Event not found' } })); await page.getByRole('button', { name: 'Refresh event' }).click();
  await expect(page.getByText('Event not found', { exact: true })).toBeVisible(); await expect(page.getByRole('heading', { name: 'Refresh safety', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel event', exact: true })).toHaveCount(0); await expect(page.getByRole('button', { name: 'Retry event' })).toBeVisible();
  const owner = await db.event.findUniqueOrThrow({ where: { id: eventId } });
  await db.event.createMany({ data: Array.from({ length: 20 }, (_, i) => ({ organizerId: owner.organizerId, title: `Pagination fixture ${i}` })) });
  await page.getByRole('button', { name: 'All events' }).click(); await expect(page.getByRole('button', { name: 'Open event', exact: true })).toHaveCount(20);
  await page.route('**/api/v1/events?limit=20&offset=20', route => route.abort()); await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry loading events' })).toBeVisible(); await expect(page.getByRole('button', { name: 'Open event', exact: true })).toHaveCount(0);
});

test('poll editing preserves UTC seconds and milliseconds, including the deadline', async ({ page }) => {
  await register(page); const eventId = await createEvent(page); await page.getByRole('button', { name: 'Polls & decisions' }).click(); await createPoll(page, 'DATE', 'Precise timing');
  const poll = await db.poll.findFirstOrThrow({ where: { eventId }, include: { options: { orderBy: { position: 'asc' } } } });
  const start = new Date(Date.now() + 5 * 86400000); start.setUTCSeconds(23, 456); const end = new Date(start.getTime() + 3600000); const deadline = new Date(start.getTime() - 86400000);
  await db.pollOption.update({ where: { id: poll.options[0].id }, data: { startsAt: start, endsAt: end } }); await db.poll.update({ where: { id: poll.id }, data: { closesAt: deadline } });
  await page.getByRole('button', { name: 'Refresh polls', exact: true }).click(); await page.getByRole('button', { name: 'Edit poll', exact: true }).click();
  const form = page.getByRole('form', { name: 'Edit poll', exact: true });
  await expect(form.getByLabel('Closing deadline (UTC, optional)')).toHaveValue(deadline.toISOString().slice(0, -1));
  await expect(form.getByRole('group', { name: 'Option 1', exact: true }).getByLabel('Starts at (UTC)')).toHaveValue(start.toISOString().slice(0, -1));
  await form.getByLabel('Poll question').fill('Precise timing updated'); await form.getByRole('button', { name: 'Save poll' }).click(); await expect(page.getByRole('heading', { name: 'Precise timing updated', exact: true })).toBeVisible();
  const updated = await db.poll.findUniqueOrThrow({ where: { id: poll.id }, include: { options: { orderBy: { position: 'asc' } } } });
  expect(updated.closesAt?.toISOString()).toBe(deadline.toISOString()); expect(updated.options[0].startsAt?.toISOString()).toBe(start.toISOString()); expect(updated.options[0].endsAt?.toISOString()).toBe(end.toISOString());
});
