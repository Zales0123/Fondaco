import type { APIRequestContext, BrowserContext, Page } from '@playwright/test'

export type SessionCookies = Awaited<ReturnType<APIRequestContext['storageState']>>['cookies']

/**
 * The shell floats a cookie notice, and in demo mode a demo notice, over the bottom of
 * every page until the visitor answers them. At phone height they cover whatever sits
 * there — the date picker's Apply button, for one — and a fresh browser context always
 * meets them again. Acknowledging them up front tests the feature rather than the
 * consent bar; that they obscure controls at that size is recorded as its own defect.
 */
const ACKNOWLEDGED_NOTICES = ['om_cookie_notice_ack', 'om_demo_notice_ack']

export async function adoptSession(context: BrowserContext, cookies: SessionCookies): Promise<void> {
  const [reference] = cookies
  if (!reference) throw new Error('The session has no cookies to adopt — did the login succeed?')
  await context.addCookies([
    ...cookies,
    ...ACKNOWLEDGED_NOTICES.map((name) => ({ name, value: 'ack', domain: reference.domain, path: '/' })),
  ])
}

/**
 * The dev server floats a runtime-diagnostics banner over the bottom of the page whenever
 * something unrelated logs an error, and it swallows clicks aimed at the controls beneath
 * it. It does not exist in the environments this app ships to, so it is hidden rather than
 * worked around.
 */
export async function hideDevDiagnostics(page: Page): Promise<void> {
  await page.addStyleTag({
    content: '[data-testid="dev-runtime-diagnostics-banner"] { display: none !important; }',
  })
}
