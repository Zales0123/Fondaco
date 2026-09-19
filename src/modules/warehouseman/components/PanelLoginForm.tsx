"use client"
import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@open-mercato/ui/primitives/button'
import { EmailInput } from '@open-mercato/ui/primitives/email-input'
import { PasswordInput } from '@open-mercato/ui/primitives/password-input'
import { Label } from '@open-mercato/ui/primitives/label'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { apiCall } from '@open-mercato/ui/backend/utils/apiCall'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { PANEL_PRIMARY, PanelCard, PanelSurface } from './PanelUI'
import type { DemoCredentials } from '../lib/demoCredentials'

export const PANEL_HOME_PATH = '/warehouseman'

type LoginResponse = { ok?: boolean; error?: string; redirect?: string }

/**
 * The panel's own sign-in page. It authenticates against the installed auth API and
 * always lands on the panel home: which page you sign in on decides where you go, so
 * there is no capability sniffing or role precedence here. The admin login is
 * untouched and keeps sending office staff to the backend.
 */
export function PanelLoginForm({ demoCredentials }: { demoCredentials?: DemoCredentials | null }) {
  const t = useT()
  const router = useRouter()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [submitting, setSubmitting] = React.useState(false)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      // The installed login route parses urlencoded bodies or `req.formData()` only.
      // A JSON body makes that call throw, and the route answers 400 with "Invalid
      // email or password" for credentials that are in fact correct.
      const body = new URLSearchParams({ email, password, redirect: PANEL_HOME_PATH })
      const { ok, result } = await apiCall<LoginResponse>('/api/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Wrong credentials answer 401, and the shared client treats an unhandled 401
          // as an expired session and schedules a refresh redirect. On a login page that
          // throws the visitor out before the error can render.
          'x-om-unauthorized-redirect': '0',
        },
        body,
      })
      if (!ok) {
        setError(result?.error || t('warehouseman.login.failed'))
        return
      }
      router.replace(result?.redirect || PANEL_HOME_PATH)
    } catch {
      setError(t('warehouseman.login.failed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <PanelSurface className="justify-center px-4 py-8">
      <form onSubmit={onSubmit} className="mx-auto flex w-full max-w-md flex-col gap-4">
        <h1 className="text-3xl font-bold tracking-tight">{t('warehouseman.login.title')}</h1>
        {demoCredentials ? (
          <PanelCard className="bg-muted">
            <p className="text-lg font-bold">{t('warehouseman.login.demoTitle')}</p>
            <dl className="mt-2 flex flex-col gap-1 text-lg">
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground">{t('warehouseman.login.email')}</dt>
                <dd className="font-mono">{demoCredentials.email}</dd>
              </div>
              <div className="flex flex-wrap gap-2">
                <dt className="text-muted-foreground">{t('warehouseman.login.password')}</dt>
                <dd className="font-mono">{demoCredentials.password}</dd>
              </div>
            </dl>
          </PanelCard>
        ) : null}
        {error ? (
          <Alert status="error" className="border-2 border-status-error-border bg-status-error-bg">
            <AlertDescription className="text-lg">{error}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col gap-2">
          <Label htmlFor="warehouseman-email" className="text-lg font-semibold">{t('warehouseman.login.email')}</Label>
          <EmailInput
            id="warehouseman-email"
            name="email"
            autoComplete="username"
            required
            // The wrapper's borders come out of the inner element's height, so the box is
            // sized a step above the 64px glove target and `h-full` makes the input fill it
            // — a tap anywhere in the field focuses it rather than nothing.
            className="h-20 border-2 px-4"
            inputClassName="h-full text-xl"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="warehouseman-password" className="text-lg font-semibold">{t('warehouseman.login.password')}</Label>
          <PasswordInput
            id="warehouseman-password"
            name="password"
            autoComplete="current-password"
            required
            className="h-20 border-2 px-4"
            inputClassName="h-full text-xl"
            // The reveal toggle is a ~16px target sitting ~8px from the field, which no
            // gloved hand can hit without also hitting the input. Gloves lose the toggle.
            revealable={false}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <Button type="submit" className={PANEL_PRIMARY} disabled={submitting}>
          {submitting ? t('warehouseman.login.submitting') : t('warehouseman.login.submit')}
        </Button>
      </form>
    </PanelSurface>
  )
}

export default PanelLoginForm
