"use client"
import * as React from 'react'
import Link from 'next/link'
import { Loader2, PackageOpen } from 'lucide-react'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'
import { PANEL_ACTION } from './PanelUI'

/** Panel type scale, announced politely: a screen that is still loading is a status. */
export function ScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-3 text-lg text-muted-foreground">
      <Loader2 className="size-6 animate-spin" aria-hidden="true" />
      {children}
    </p>
  )
}

export function ScreenError({ children }: { children: React.ReactNode }) {
  return (
    <Alert status="error" className="border-2 border-status-error-border bg-status-error-bg">
      <AlertDescription className="text-lg">{children}</AlertDescription>
    </Alert>
  )
}

export function ScreenEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/60 bg-card px-4 py-8 text-center">
      <PackageOpen className="size-10 text-muted-foreground" aria-hidden="true" />
      <p className="text-xl font-bold">{title}</p>
      <p className="text-base text-muted-foreground">{description}</p>
    </div>
  )
}

/** Every panel target is a glove target, link or not. */
export function PanelLinkButton({
  href,
  children,
  icon,
}: {
  href: string
  children: React.ReactNode
  icon?: React.ReactNode
}) {
  return (
    <Button asChild variant="outline" className={`${PANEL_ACTION} border-2`}>
      <Link href={href}>
        {icon}
        {children}
      </Link>
    </Button>
  )
}
