"use client"
import * as React from 'react'
import Link from 'next/link'
import { Button } from '@open-mercato/ui/primitives/button'
import { Alert, AlertDescription } from '@open-mercato/ui/primitives/alert'

/** Panel type scale, announced politely: a screen that is still loading is a status. */
export function ScreenMessage({ children }: { children: React.ReactNode }) {
  return (
    <p role="status" className="text-lg text-muted-foreground">
      {children}
    </p>
  )
}

export function ScreenError({ children }: { children: React.ReactNode }) {
  return (
    <Alert status="error">
      <AlertDescription className="text-lg">{children}</AlertDescription>
    </Alert>
  )
}

export function ScreenEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border p-4">
      <p className="text-lg font-medium">{title}</p>
      <p className="text-muted-foreground">{description}</p>
    </div>
  )
}

/** Every panel target is a glove target, link or not. */
export function PanelLinkButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Button asChild size="lg" variant="outline" className="h-16 w-full text-lg">
      <Link href={href}>{children}</Link>
    </Button>
  )
}
