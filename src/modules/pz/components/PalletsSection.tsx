"use client"

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import type { LegacyColumnDef as ColumnDef } from '@tanstack/react-table/legacy'
import { DataTable } from '@open-mercato/ui/backend/DataTable'
import { LoadingMessage } from '@open-mercato/ui/backend/detail'
import { readApiResultOrThrow } from '@open-mercato/ui/backend/utils/apiCall'
import { StatusBadge } from '@open-mercato/ui/primitives/status-badge'
import { useT } from '@open-mercato/shared/lib/i18n/context'
import { useOrganizationScopeVersion } from '@open-mercato/shared/lib/frontend/useOrganizationScope'

type PalletRow = {
  id: string
  code: string
  label: string | null
  status: 'open' | 'closed'
  lineCount: number
  updatedAt: string
}

type PalletsResponse = { items: PalletRow[]; totalCount?: number; total?: number }
const PAGE_SIZE = 50

export function PalletsSection({ goodsReceiptId }: { goodsReceiptId: string }) {
  const t = useT()
  const scopeVersion = useOrganizationScopeVersion()
  const [page, setPage] = React.useState(1)
  React.useEffect(() => { setPage(1) }, [goodsReceiptId, scopeVersion])
  const { data, isLoading, error } = useQuery<PalletsResponse>({
    queryKey: ['pz.pallets', goodsReceiptId, page, scopeVersion],
    queryFn: () => readApiResultOrThrow<PalletsResponse>(
      `/api/pz/pallets?goodsReceiptId=${encodeURIComponent(goodsReceiptId)}&page=${page}&pageSize=${PAGE_SIZE}`,
    ),
  })
  const total = data?.totalCount ?? data?.total ?? 0
  const columns = React.useMemo<ColumnDef<PalletRow>[]>(() => [
    { accessorKey: 'code', header: t('pz.goodsReceipts.view.pallets.column.code') },
    { accessorKey: 'label', header: t('pz.goodsReceipts.view.pallets.column.label'), cell: ({ row }) => row.original.label || '—' },
    {
      accessorKey: 'status',
      header: t('pz.goodsReceipts.view.pallets.column.status'),
      cell: ({ row }) => (
        <StatusBadge variant={row.original.status === 'closed' ? 'success' : 'info'} dot>
          {t(`pz.pallets.status.${row.original.status}`)}
        </StatusBadge>
      ),
    },
    { accessorKey: 'lineCount', header: t('pz.goodsReceipts.view.pallets.column.lineCount') },
  ], [t])

  return (
    <section className="space-y-4 border-t pt-6" aria-labelledby="goods-receipt-pallets-heading">
      <h2 id="goods-receipt-pallets-heading" className="text-base font-semibold">
        {t('pz.goodsReceipts.view.section.pallets')}
      </h2>
      {isLoading ? <LoadingMessage label={t('pz.goodsReceipts.view.pallets.loading')} /> : (
        <div role="region" aria-label={t('pz.goodsReceipts.view.pallets.caption')}>
          <DataTable<PalletRow>
            columns={columns}
            data={data?.items ?? []}
            entityId="pz:pallet"
            extensionTableId="pz.pallets"
            error={error ? t('pz.goodsReceipts.view.pallets.error') : null}
            emptyState={t('pz.goodsReceipts.view.pallets.empty')}
            pagination={{
              page,
              pageSize: PAGE_SIZE,
              total,
              totalPages: Math.ceil(total / PAGE_SIZE),
              onPageChange: setPage,
            }}
          />
        </div>
      )}
    </section>
  )
}
