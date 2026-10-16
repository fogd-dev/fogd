import { chromium, expect } from './guestbook-browser.mjs';

export async function accountsBrowser(url, email, password, launchOptions = {}) {
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  const page = await context.newPage();
  async function ready(expected) {
    await page.goto(url);
    await expect(async () => {
      await page.getByRole('button', { name: 'Check session' }).click();
      await expect(page.getByRole('status')).toHaveText(expected);
    }).toPass({ timeout: 30000 });
  }
  async function credentials(value) {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(value);
  }
  async function signIn(value = password) {
    await ready('Anonymous'); await credentials(value);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  }
  async function signedIn() { await expect(page.getByText(`Signed in as ${email}`, { exact: true })).toBeVisible({ timeout: 30000 }); }
  async function signOut() {
    await ready('Session active');
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }
  async function enroll() {
    await ready('Anonymous'); await credentials(password);
    await page.getByRole('button', { name: 'Create account' }).click();
    await signedIn();
    await signOut(); await signIn('incorrect-password');
    await expect(page.getByRole('status')).toHaveText(/invalid|incorrect/i, { timeout: 30000 });
    await signIn(); await signedIn();
  }
  return { browser, context, page, ready, enroll, signIn, signedIn, signOut };
}
