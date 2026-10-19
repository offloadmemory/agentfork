import { type Page, expect } from '@playwright/test';
import { env } from '../config/env';
import { ROUTES } from '../constants/routes';

/**
 * Drives the Google OAuth SSO login and the in-app sign-out flow.
 * Credentials come from the typed env (E2E_SSO_EMAIL / E2E_SSO_PASSWORD);
 * gate specs with `hasSsoCreds()` so they skip when creds are absent.
 */
export class SsoFlow {
  constructor(private readonly page: Page) { }

  async login(): Promise<void> {
    await this.page.goto(ROUTES.home, { waitUntil: 'domcontentloaded' });
    await this.page.getByRole('link', { name: 'Sign in' }).click();
    await this.page.getByRole('button', { name: 'Sign in with Google' }).click();

    await this.page.getByRole('textbox', { name: 'name@host.com' }).fill(env.E2E_SSO_EMAIL);
    await this.page.getByRole('textbox', { name: 'Password' }).fill(env.E2E_SSO_PASSWORD);
    await this.page.getByRole('textbox', { name: 'Password' }).press('Enter');

    // Google may render a consent form or submit button before redirecting
    const submitBtn = this.page.getByRole('button', { name: 'submit' });
    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
    }

    await this.page.waitForURL(/localhost:3005/, { timeout: 30_000 });
  }

  async logout(): Promise<void> {
    await this.page.getByRole('button', { name: /User/i }).click();
    await this.page.getByRole('menuitem', { name: 'Sign out' }).click();
    await expect(this.page).toHaveURL(/login|signin/);
  }
}
